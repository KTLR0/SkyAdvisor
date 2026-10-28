const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRecommendationService, buildPlanSchema, validatePlan } = require('./recommendation-service');
const { buildRecommendationInput, RECOMMENDATION_RESPONSE_SCHEMA } = require('./ai-recommendations');
const { createGeminiClient } = require('./gemini');
const { randomUUID } = require('node:crypto');
const { createApp } = require('./app');
const { createMemoryDatabase } = require('./test-support/memory-db');
const { timelineRows } = require('./fixtures/timeline');
const { PLAYER_ID, PROFILE_A, PROFILE_B } = require('./fixtures/skyblock');
const { normalizeSkillResource } = require('./skill-resource');
const { officialSkillsFixture } = require('./fixtures/skill-resource');

const action = (extra = {}) => ({ priority: 1, kind: 'train_skill', focusFactId: 'skill:mining',
  reason: 'goal_alignment', supportingFactIds: ['skill:mining'], ...extra });
const plan = (actions = [action()], extra = {}) => ({ contractVersion: 2, goal: 'mining', actions, ...extra });
async function fixture(options = {}) {
  const memory = createMemoryDatabase();
  for (const row of timelineRows()) await memory.db.collection('skyblockSnapshots').insertOne(row);
  let calls = 0, summary, signal;
  const service = createRecommendationService({ getDatabase: async () => memory.db,
    getMetadata: () => ({ skillDefinitions: normalizeSkillResource(officialSkillsFixture()).skills }),
    modelClient: { isConfigured: () => true, generate: async request => {
      calls++; summary = structuredClone(request.input); signal = request.signal;
      assert.equal(request.schema.properties.contractVersion.const, 2);
      return plan();
    } }, ...options });
  return { memory, service, calls: () => calls, input: () => summary, signal: () => signal,
    request: (goal = 'mining', player = PLAYER_ID, profile = PROFILE_A) => service.recommend(player, profile, goal) };
}

test('valid model selection and ordering survive while displayed factual values come from the saved input', async () => {
  const f = await fixture();
  const result = await f.request();
  assert.equal(result.source, 'ai');
  assert.equal(result.contractVersion, 2);
  assert.equal(result.actions[0].title, 'Train Mining');
  assert.match(result.actions[0].whyItFitsGoal, /200 Mining XP/);
  assert.equal(result.actions[0].evidence[0].xp, 200);
  assert.equal(result.snapshot.fetchedAt, '2026-10-22T00:00:00.000Z');
  assert.equal(f.calls(), 1);
  assert.equal(f.input().skills[0].xp, 200);
  assert.ok(!JSON.stringify(f.input()).includes(PLAYER_ID));
  assert.ok(!JSON.stringify(f.input()).includes(PROFILE_A));
  assert.equal(f.signal().aborted, true);
  const chosen = await fixture({ modelClient: { isConfigured: () => true, generate: async () => plan([
    action({ kind: 'grow_collection', focusFactId: 'collection:WHEAT', reason: 'recorded_progress',
      supportingFactIds: ['collection:WHEAT'] }),
    action({ priority: 2, reason: 'next_level' }),
  ]) } });
  const reordered = await chosen.request();
  assert.equal(reordered.source, 'ai');
  assert.deepEqual(reordered.actions.map(entry => entry.kind), ['grow_collection', 'train_skill']);
});

test('each goal gets only eligible action/reason/fact combinations and its own evidence IDs', () => {
  const data = {
    Skills: { status: 'available', entries: ['farming', 'mining', 'combat'].map(id => ({ id, xp: 100, status: 'available' })) },
    Collections: { status: 'available', entries: [{ id: 'WHEAT', amount: 0, status: 'available' }] },
    Inventory: { status: 'available', items: [0, 1].map(slot => ({ id: 'DIAMOND_SWORD', slot, count: 1, container: 'Inventory' })) },
  };
  const originalSchema = structuredClone(RECOMMENDATION_RESPONSE_SCHEMA);
  const metadata = { skillDefinitions: normalizeSkillResource(officialSkillsFixture()).skills };
  for (const goal of ['general', 'farming', 'mining', 'combat']) {
    const input = buildRecommendationInput({ data, fetchedAt: '2026-10-28T12:00:00Z' }, goal, metadata);
    const before = structuredClone(input);
    const schema = buildPlanSchema(input);
    assert.deepEqual(schema.properties.goal.enum, [goal]);
    assert.deepEqual(schema.properties.contractVersion.enum, [2]);
    const item = schema.properties.actions.items;
    assert.ok(!item.properties.supportingFactIds.items.enum.includes('skill:missing'));
    const focuses = item.anyOf.flatMap(branch => branch.properties.focusFactId.enum);
    assert.ok(focuses.includes(`skill:${goal === 'general' ? 'mining' : goal}`));
    if (goal !== 'general') assert.deepEqual(focuses.filter(id => id.startsWith('skill:')), [`skill:${goal}`]);
    assert.equal(focuses.filter(id => id.startsWith('inventory:')).length, 1);
    for (const branch of item.anyOf) {
      for (const focusFactId of branch.properties.focusFactId.enum) {
        for (const reason of branch.properties.reason.enum) {
          const candidate = plan([action({ kind: branch.properties.kind.enum[0], reason, focusFactId,
            supportingFactIds: [focusFactId] })], { goal });
          assert.equal(validatePlan(candidate, input), true);
        }
      }
    }
    const collection = item.anyOf.find(branch => branch.properties.kind.enum[0] === 'grow_collection');
    assert.deepEqual(collection.properties.reason.enum, ['recorded_progress']);
    assert.deepEqual(input, before);
  }
  assert.deepEqual(RECOMMENDATION_RESPONSE_SCHEMA, originalSchema);
  const input = buildRecommendationInput({ data }, 'mining');
  const schema = buildPlanSchema(input);
  assert.ok(schema.properties.actions.items.anyOf.filter(branch => branch.properties.kind.enum[0] === 'train_skill')
    .every(branch => !branch.properties.reason.enum.includes('next_level')));
  const empty = buildPlanSchema(buildRecommendationInput({ data: {} }, 'combat'));
  assert.equal(empty.properties.actions.maxItems, 0);
});

test('the model receives a goal-scoped schema before selection and invalid model combinations still fail', async () => {
  for (const goal of ['combat', 'mining']) {
    let receivedSchema;
    const f = await fixture({ modelClient: { isConfigured: () => true, generate: async ({ input, schema }) => {
      receivedSchema = schema;
      const branch = schema.properties.actions.items.anyOf.find(item => item.properties.kind.enum[0] === 'grow_collection');
      return plan([action({ kind: 'grow_collection', reason: 'recorded_progress',
        focusFactId: branch.properties.focusFactId.enum[0], supportingFactIds: [branch.properties.focusFactId.enum[0]] })], { goal: input.goal });
    } } });
    assert.equal((await f.request(goal)).source, 'ai');
    assert.deepEqual(receivedSchema.properties.goal.enum, [goal]);
  }
  const invalid = await fixture({ modelClient: { isConfigured: () => true, generate: async () => plan([
    action({ kind: 'grow_collection', reason: 'goal_alignment', focusFactId: 'collection:WHEAT', supportingFactIds: ['collection:WHEAT'] }),
  ]) } });
  assert.equal((await invalid.request()).fallbackReason, 'invalid_response');
});

test('duplicate-only plans get one model correction and the corrected choices are validated', async () => {
  let calls = 0;
  const f = await fixture({ modelClient: { isConfigured: () => true, generate: async request => {
    calls++;
    if (calls === 1) {
      assert.equal(request.correction, undefined);
      return plan([action(), action({ priority: 2, reason: 'next_level' })]);
    }
    assert.match(request.correction, /each focusFactId used only once/);
    return plan([action({ reason: 'next_level' })]);
  } } });
  const result = await f.request();
  assert.equal(result.source, 'ai');
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].reason, 'next_level');
  assert.equal(calls, 2);
});

test('correction is bounded and never repairs unsupported evidence or numerical claims locally', async () => {
  for (const [response, expectedCalls] of [
    [plan([action(), action({ priority: 2 })]), 2],
    [plan([action({ supportingFactIds: ['skill:unknown'] })]), 1],
    [plan([action({ whatToDo: 'Earn 999999 XP' }), action({ priority: 2 })]), 1],
  ]) {
    let calls = 0;
    const f = await fixture({ modelClient: { isConfigured: () => true, generate: async () => { calls++; return response; } } });
    assert.equal((await f.request()).fallbackReason, 'invalid_response');
    assert.equal(calls, expectedCalls);
  }
});

test('a late duplicate response cannot trigger a correction after the deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0, finish;
  const f = await fixture({ timeoutMs: 5, modelClient: { isConfigured: () => true, generate: () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  } } });
  const pending = f.request();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(5);
  assert.equal((await pending).fallbackReason, 'timeout');
  finish(plan([action(), action({ priority: 2 })]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('invalid shape, goal, evidence, priorities, duplicate actions, and invented numbers all use fallback', async () => {
  const invalid = [null, [], {}, plan([], { extra: true }), plan([], { contractVersion: 1 }),
    plan([], { goal: 'combat' }), plan([action({ priority: 2 })]), plan([action({ priority: '1' })]),
    plan([action(), action({ priority: 2 })]), plan(Array.from({ length: 4 }, (_, i) => action({ priority: i + 1 }))),
    plan([action({ focusFactId: 'skill:combat', supportingFactIds: ['skill:combat'] })]),
    plan([action({ supportingFactIds: ['skill:mining', 'inventory:missing'] })]),
    plan([action({ supportingFactIds: ['snapshot:time'] })]),
    plan([action({ supportingFactIds: ['skill:mining', 'skill:mining'] })]),
    plan([action({ kind: 'buy_item' })]), plan([action({ reason: 'known_item' })]),
    plan([action({ title: 'Earn 999999 XP' })]), plan([action({ whatToDo: 'Buy ten thousand items' })]),
    plan([action({ xpRemaining: 999999 })]),
  ];
  for (const response of invalid) {
    const f = await fixture({ modelClient: { isConfigured: () => true, generate: async () => response } });
    const result = await f.request();
    assert.equal(result.source, 'fallback');
    assert.equal(result.fallbackReason, 'invalid_response');
    assert.match(result.actions[0].whyItFitsGoal, /200 Mining XP/);
    assert.ok(!JSON.stringify(result).includes('999999'));
    assert.ok(!JSON.stringify(result).includes('ten thousand'));
  }
});

test('missing key, model failures and timeout return deterministic safe results without error details', async () => {
  let calls = 0;
  const missing = await fixture({ modelClient: { isConfigured: () => false,
    generate: async () => { calls++; throw new Error('must not run'); } } });
  const a = await missing.request();
  const b = await missing.request();
  assert.deepEqual(a, b);
  assert.equal(a.fallbackReason, 'not_configured');
  assert.equal(calls, 0);
  const failed = await fixture({ modelClient: { isConfigured: () => true,
    generate: async () => { throw new Error('Private upstream failure details'); } } });
  const failure = await failed.request();
  assert.equal(failure.fallbackReason, 'model_failed');
  assert.ok(!JSON.stringify(failure).includes('Private'));
  let signal;
  const timeout = await fixture({ timeoutMs: 5, modelClient: { isConfigured: () => true,
    generate: request => { signal = request.signal; return new Promise(() => {}); } } });
  const result = await timeout.request();
  assert.equal(result.source, 'fallback');
  assert.equal(result.fallbackReason, 'timeout');
  assert.equal(signal.aborted, true);
});

test('uses the latest snapshot for exactly the selected player/profile, including legacy ID spellings', async () => {
  const f = await fixture();
  const before = JSON.stringify(f.memory.rows('skyblockSnapshots'));
  const dashed = id => id.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5').toUpperCase();
  assert.equal((await f.request('mining', dashed(PLAYER_ID), dashed(PROFILE_A))).actions[0].evidence[0].xp, 200);
  assert.equal((await f.request('mining', PLAYER_ID, PROFILE_B)).actions[0].evidence[0].xp, 999);
  assert.equal((await f.request('mining', '2'.repeat(32), PROFILE_A)).actions[0].evidence[0].xp, 888);
  assert.equal((await f.request()).actions[0].evidence[0].xp, 200);
  assert.equal(JSON.stringify(f.memory.rows('skyblockSnapshots')), before);
  assert.equal(f.memory.writes.length, 0);
  assert.deepEqual(f.memory.rows('fetchEvents'), []);
  await assert.rejects(f.request('mining', PLAYER_ID, '3'.repeat(32)), { status: 404 });
  await assert.rejects(f.request('mining', 'bad', PROFILE_A), { status: 400 });
  await assert.rejects(f.request('mining', PLAYER_ID, 'bad'), { status: 400 });
  await assert.rejects(f.request('unknown'), { status: 400 });
  assert.equal(f.calls(), 4);
});

test('provider failures return specific safe fallback reasons without raw upstream details', async () => {
  for (const [code, reason] of [['GEMINI_UNAVAILABLE', 'model_unavailable'], ['GEMINI_ACCESS', 'model_access_denied'],
    ['GEMINI_QUOTA', 'model_quota'], ['GEMINI_MODEL', 'model_not_found'], ['GEMINI_REQUEST', 'model_request_invalid'],
    ['GEMINI_INVALID_RESPONSE', 'invalid_response']]) {
    const f = await fixture({ modelClient: { isConfigured: () => true,
      generate: async () => { throw Object.assign(new Error('Private provider details'), { code }); },
    } });
    const result = await f.request();
    assert.equal(result.source, 'fallback');
    assert.equal(result.fallbackReason, reason);
    assert.ok(!JSON.stringify(result).includes('Private provider'));
  }
});

test('one recommendation deadline cancels Gemini backoff without another network attempt', async () => {
  let attempts = 0;
  const client = createGeminiClient({ getApiKey: () => randomUUID(), request: async () => {
    attempts++;
    return new Response(null, { status: 503 });
  } });
  const f = await fixture({ timeoutMs: 5, modelClient: client });
  const result = await f.request();
  assert.equal(result.fallbackReason, 'timeout');
  assert.equal(attempts, 1);
});

test('valid responses after the old 15-second limit succeed; the new 45-second deadline still aborts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish, signal;
  const f = await fixture({ modelClient: { isConfigured: () => true, generate: request => {
    signal = request.signal;
    return new Promise(resolve => { finish = resolve; });
  } } });
  const slowResponse = f.request();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(16000);
  assert.equal(signal.aborted, false);
  finish(plan());
  assert.equal((await slowResponse).source, 'ai');

  const stalledResponse = f.request();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(45000);
  assert.equal((await stalledResponse).fallbackReason, 'timeout');
  assert.equal(signal.aborted, true);
});

test('unknown thresholds cannot support a next-level claim; no evidence yields an empty fallback', async () => {
  const f = await fixture({ getMetadata: () => ({}), modelClient: { isConfigured: () => true,
    generate: async () => plan([action({ reason: 'next_level' })]) } });
  assert.equal((await f.request()).fallbackReason, 'invalid_response');
  const rows = f.memory.rows('skyblockSnapshots');
  for (const row of rows) row.data = { Skills: { status: 'private', entries: [] } };
  const result = await f.request();
  assert.equal(result.fallbackReason, 'insufficient_evidence');
  assert.deepEqual(result.actions, []);
});

test('accepts three distinct actions but rejects repeated item reviews across stack locations', async () => {
  let duplicate = false;
  const f = await fixture({ modelClient: { isConfigured: () => true, generate: async ({ input }) => {
    const review = (index, priority) => action({ priority, kind: 'review_inventory', reason: 'known_item',
      focusFactId: input.inventory[index].factId, supportingFactIds: [input.inventory[index].factId] });
    return duplicate ? plan([review(0, 1), review(1, 2)]) : plan([
      action(), action({ priority: 2, kind: 'grow_collection', reason: 'recorded_progress',
        focusFactId: 'collection:WHEAT', supportingFactIds: ['collection:WHEAT'] }), review(0, 3),
    ]);
  } } });
  const latest = f.memory.rows('skyblockSnapshots').find(row => row._id === 'fetch-b:profile-a');
  latest.data.Inventory = { status: 'available', items: [0, 1].map(slot => ({
    id: 'DIAMOND_PICKAXE', slot, count: 1, container: 'Inventory',
  })) };
  const valid = await f.request();
  assert.equal(valid.source, 'ai');
  assert.equal(valid.actions.length, 3);
  assert.match(valid.actions[2].whyItFitsGoal, /count 1/);
  duplicate = true;
  assert.equal((await f.request()).fallbackReason, 'invalid_response');
});

test('explicit endpoint accepts only goal and browsing never triggers model generation', async t => {
  const f = await fixture();
  const app = createApp({ recommendationService: f.service,
    service: { loadLatestSkyBlockData: async () => ({ profiles: [] }) },
    resolveMinecraftPlayer: async () => { throw new Error('No lookup allowed'); },
    loadSkillResource: async () => { throw new Error('No resource fetch allowed'); } });
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve(listener));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const path = `/api/players/${PLAYER_ID}/profiles/${PROFILE_A}/recommendations`;
  for (const route of ['/api/health', '/api/player/Synthetic/skyblock', path]) await fetch(base + route);
  assert.equal(f.calls(), 0);
  const request = (body, route = path) => fetch(base + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const response = await request({ goal: 'mining' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).source, 'ai');
  assert.equal(f.calls(), 1);
  for (const body of [{ goal: 'mining', data: { xp: 99999 } }, {}, [], { goal: 'bad' }, { goal: null }]) {
    assert.equal((await request(body)).status, 400);
  }
  const missing = path.replace(PROFILE_A, '3'.repeat(32));
  assert.equal((await request({ goal: 'mining' }, missing)).status, 404);
  assert.equal(f.calls(), 1);
  assert.equal(f.memory.writes.length, 0);
});

test('database failures stay generic at the recommendation endpoint', async t => {
  const app = createApp({ recommendationService: createRecommendationService({
    getDatabase: async () => { throw new Error('Private storage details'); },
  }) });
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve(listener));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/players/${PLAYER_ID}/profiles/${PROFILE_A}/recommendations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal: 'mining' }),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Saved recommendation data could not be loaded.' });
});
