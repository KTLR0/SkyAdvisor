const database = require('./database');
const { normalizeStoredData } = require('./normalize');
const { peekSkillResource } = require('./skill-resource');
const { buildRecommendationInput, GOALS, RECOMMENDATION_RESPONSE_SCHEMA: SCHEMA } = require('./ai-recommendations');
const { createGeminiClient, RECOMMENDATION_TIMEOUT_MS } = require('./gemini');

const failure = (status, message) => Object.assign(new Error(message), { status });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const label = id => id[0].toUpperCase() + id.slice(1);
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const MODEL_FAILURE_REASONS = {
  MODEL_TIMEOUT: 'timeout', GEMINI_UNAVAILABLE: 'model_unavailable', GEMINI_ACCESS: 'model_access_denied',
  GEMINI_QUOTA: 'model_quota', GEMINI_MODEL: 'model_not_found', GEMINI_REQUEST: 'model_request_invalid',
  GEMINI_INVALID_RESPONSE: 'invalid_response',
};

function idVariants(value, name) {
  if (typeof value !== 'string'
      || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value)) {
    throw failure(400, `Invalid ${name}.`);
  }
  const id = value.replaceAll('-', '').toLowerCase();
  const dashed = id.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  return [...new Set([id, id.toUpperCase(), dashed, dashed.toUpperCase()])];
}

function factsById(input) {
  return new Map([input.snapshot, ...input.skills, ...input.collections, ...input.inventory]
    .filter(fact => fact.factId).map(fact => [fact.factId, fact]));
}

function supported(action, fact, goal) {
  const skill = action.kind === 'train_skill' && fact.skill && !fact.atCap
    && (goal === 'general' || fact.skill === goal);
  const collection = action.kind === 'grow_collection' && fact.collectionId && !fact.atMaxTier;
  const inventory = action.kind === 'review_inventory' && fact.itemId && fact.count !== 0;
  if (!skill && !collection && !inventory) return false;
  return (action.reason === 'goal_alignment' && skill && goal !== 'general' && fact.skill === goal)
    || (action.reason === 'next_level' && skill && positive(fact.xpRemaining))
    || (action.reason === 'next_collection_tier' && collection && positive(fact.remaining) && positive(fact.targetAmount))
    || (action.reason === 'recorded_progress' && (skill || collection))
    || (action.reason === 'known_item' && inventory);
}

// Constrain generation with the same rules used to verify it. This lists eligible
// combinations, not final recommendations: the model still chooses and ranks them.
function buildPlanSchema(input) {
  const schema = structuredClone(SCHEMA);
  schema.properties.contractVersion.enum = [SCHEMA.properties.contractVersion.const];
  schema.properties.goal.enum = [input.goal];
  const item = schema.properties.actions.items;
  const facts = [...factsById(input).values()].filter(fact => fact.factId.length <= item.properties.focusFactId.maxLength);
  item.properties.supportingFactIds.items.enum = facts.map(fact => fact.factId);
  const groups = new Map();
  const inventoryItems = new Set();
  for (const fact of facts) {
    if (fact.itemId) {
      if (fact.count === 0 || inventoryItems.has(fact.itemId)) continue;
      inventoryItems.add(fact.itemId);
    }
    for (const kind of item.properties.kind.enum) {
      const reasons = item.properties.reason.enum.filter(reason => supported({ kind, reason }, fact, input.goal));
      if (!reasons.length) continue;
      const key = `${kind}:${reasons.join(',')}`;
      if (!groups.has(key)) groups.set(key, { kind, reasons, ids: [] });
      groups.get(key).ids.push(fact.factId);
    }
  }
  if (!groups.size) {
    schema.properties.actions.maxItems = 0;
    // Empty enum arrays are invalid JSON Schema; no actions can reference facts.
    delete item.properties.supportingFactIds.items.enum;
  } else {
    item.anyOf = [...groups.values()].map(group => ({ type: 'object', properties: {
      kind: { type: 'string', enum: [group.kind] },
      reason: { type: 'string', enum: group.reasons },
      focusFactId: { type: 'string', enum: group.ids },
    } }));
  }
  return schema;
}

function validatePlan(plan, input) {
  const actionSchema = SCHEMA.properties.actions;
  if (!exactKeys(plan, SCHEMA.required) || plan.contractVersion !== SCHEMA.properties.contractVersion.const
      || plan.goal !== input.goal || !Array.isArray(plan.actions) || plan.actions.length > actionSchema.maxItems) return false;
  const facts = factsById(input);
  const seen = new Set();
  return plan.actions.every((action, index) => {
    if (!exactKeys(action, actionSchema.items.required) || action.priority !== index + 1
        || !actionSchema.items.properties.kind.enum.includes(action.kind)
        || !actionSchema.items.properties.reason.enum.includes(action.reason)
        || typeof action.focusFactId !== 'string' || !action.focusFactId.length
        || action.focusFactId.length > actionSchema.items.properties.focusFactId.maxLength) return false;
    const ids = action.supportingFactIds;
    const bounds = actionSchema.items.properties.supportingFactIds;
    if (!Array.isArray(ids) || ids.length < bounds.minItems || ids.length > bounds.maxItems
        || new Set(ids).size !== ids.length || !ids.includes(action.focusFactId)
        || ids.some(id => typeof id !== 'string' || id.length > bounds.items.maxLength || !facts.has(id))) return false;
    const focus = facts.get(action.focusFactId);
    if (!focus || !supported(action, focus, input.goal)) return false;
    // Repeated stacks/storage locations must not become repeated item actions.
    const key = `${action.kind}:${focus.itemId || action.focusFactId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function onlyDuplicateActions(plan, input) {
  return exactKeys(plan, SCHEMA.required) && plan.contractVersion === SCHEMA.properties.contractVersion.const
    && plan.goal === input.goal && Array.isArray(plan.actions)
    && plan.actions.length > 1 && plan.actions.length <= SCHEMA.properties.actions.maxItems
    && plan.actions.every((action, index) => action?.priority === index + 1
      && validatePlan({ ...plan, actions: [{ ...action, priority: 1 }] }, input));
}

function fallbackPlan(input) {
  const candidates = [
    ...input.skills.map(fact => ({ fact, kind: 'train_skill', reason: 'recorded_progress' })),
    ...input.collections.map(fact => ({ fact, kind: 'grow_collection', reason: 'recorded_progress' })),
    ...input.inventory.map(fact => ({ fact, kind: 'review_inventory', reason: 'known_item' })),
  ];
  const candidate = candidates.find(({ fact, kind, reason }) => supported({ kind, reason }, fact, input.goal));
  return candidate ? [{ priority: 1, kind: candidate.kind, reason: candidate.reason,
    focusFactId: candidate.fact.factId, supportingFactIds: [candidate.fact.factId] }] : [];
}

function renderAction(action, input) {
  const facts = factsById(input);
  const fact = facts.get(action.focusFactId);
  const goalText = input.goal === 'general' ? 'general progress' : input.goal;
  let title, whatToDo, recorded;
  if (action.kind === 'train_skill') {
    title = `Train ${label(fact.skill)}`;
    whatToDo = fact.nextLevel != null ? `Work toward ${label(fact.skill)} level ${fact.nextLevel}.`
      : `Focus your next session on earning ${label(fact.skill)} XP.`;
    recorded = `The saved snapshot records ${fact.xp} ${label(fact.skill)} XP.`;
    if (fact.level !== undefined) recorded += ` Verified level: ${fact.level}; XP to next level: ${fact.xpRemaining}.`;
  } else if (action.kind === 'grow_collection') {
    title = `Grow the ${fact.collectionId} collection`;
    whatToDo = fact.targetAmount !== undefined ? `Work toward the verified target of ${fact.targetAmount} collected items.`
      : `Focus on increasing the recorded ${fact.collectionId} collection count.`;
    recorded = `The saved snapshot records ${fact.amount} collected items for ${fact.collectionId}.`;
    if (fact.remaining !== undefined) recorded += ` Remaining to the next recorded tier: ${fact.remaining}.`;
  } else {
    title = `Review ${fact.itemId}`;
    whatToDo = `Review the recorded ${fact.itemId} in ${fact.container} before planning your next session.`;
    recorded = `The saved snapshot contains this item record${fact.count === undefined ? '.' : ` with count ${fact.count}.`}`;
  }
  const reasons = {
    goal_alignment: `This skill directly matches your ${goalText} goal.`,
    next_level: `The verified next level provides a measurable focus for ${goalText}.`,
    next_collection_tier: `The verified collection target provides a measurable next step to consider for ${goalText}.`,
    recorded_progress: `This recorded progress provides a starting point for planning ${goalText}.`,
    known_item: `Reviewing saved item records can help you plan ${goalText}.`,
  };
  return { ...action, title, whatToDo, whyItFitsGoal: `${reasons[action.reason]} ${recorded}`,
    evidence: action.supportingFactIds.map(id => facts.get(id)) };
}

async function generateWithDeadline(client, input, timeoutMs) {
  const controller = new AbortController();
  const schema = buildPlanSchema(input);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        const plan = await client.generate({ input, schema, signal: controller.signal });
        controller.signal.throwIfAborted();
        if (!validatePlan(plan, input) && onlyDuplicateActions(plan, input)) {
          return client.generate({ input, schema, signal: controller.signal,
            correction: 'The last plan repeated an action. Return a corrected plan with each focusFactId used only once. '
              + 'Different reasons for training the same skill describe ONE action, not separate actions. '
              + 'Review each item type at most once. Use consecutive priorities and choose fewer actions if needed.' });
        }
        return plan;
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error('Recommendation timeout.'), { code: 'MODEL_TIMEOUT' }));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function createRecommendationService({ getDatabase = database.getReadDatabase,
  modelClient = createGeminiClient(), timeoutMs = RECOMMENDATION_TIMEOUT_MS,
  getMetadata = () => ({ skillDefinitions: peekSkillResource()?.skills || {} }) } = {}) {
  async function recommend(playerUuid, profileId, goal) {
    const players = idVariants(playerUuid, 'player UUID');
    const profiles = idVariants(profileId, 'profile ID');
    if (!GOALS.includes(goal)) throw failure(400, 'Invalid recommendation goal.');
    const db = await getDatabase();
    const projection = Object.fromEntries(['_id', 'fetchedAt', 'schemaVersion', 'data.Skills', 'data.Collections',
      'data.Inventory', 'data.Armor', 'data.Equipment', 'data.Enderchest', 'data.Talismans', 'data.Backpacks'].map(key => [key, 1]));
    const [saved] = await db.collection('skyblockSnapshots')
      .find({ playerUuid: { $in: players }, profileId: { $in: profiles } })
      .project(projection).sort({ fetchedAt: -1, _id: -1 }).limit(1).toArray();
    if (!saved) throw failure(404, 'No saved snapshot exists for this player and profile.');
    const input = buildRecommendationInput({ fetchedAt: saved.fetchedAt,
      sourceSchemaVersion: saved.schemaVersion ?? 1,
      data: normalizeStoredData(saved.data, saved.schemaVersion ?? 1) }, goal, getMetadata());
    const fallback = fallbackPlan(input);
    let source = 'fallback', fallbackReason, actions = fallback;
    if (!fallback.length) fallbackReason = 'insufficient_evidence';
    else if (!modelClient.isConfigured()) fallbackReason = 'not_configured';
    else {
      try {
        const plan = await generateWithDeadline(modelClient, input, timeoutMs);
        if (validatePlan(plan, input)) { actions = plan.actions; source = 'ai'; }
        else fallbackReason = 'invalid_response';
      } catch (error) {
        fallbackReason = Object.hasOwn(MODEL_FAILURE_REASONS, error?.code)
          ? MODEL_FAILURE_REASONS[error.code] : 'model_failed';
      }
    }
    return { contractVersion: 2, playerUuid: players[0], profileId: profiles[0], goal, source,
      ...(fallbackReason ? { fallbackReason } : {}), snapshot: input.snapshot,
      actions: actions.map(action => renderAction(action, input)) };
  }
  return { recommend };
}

module.exports = { ...createRecommendationService(), createRecommendationService, validatePlan, buildPlanSchema };
