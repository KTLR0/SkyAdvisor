// Pure preparation only: no API clients, database access, or recommendation choices.
const { calculateSkillProgress } = require('../client/src/skill-progress.js');
const RECOMMENDATION_RESPONSE_SCHEMA = require('./recommendation-response.schema.json');

const GOALS = Object.freeze(['general', 'farming', 'mining', 'combat']);
const CONTAINERS = ['Inventory', 'Armor', 'Equipment', 'Enderchest', 'Talismans', 'Backpacks'];
const SKILLS = new Set(['farming', 'mining', 'combat', 'foraging', 'fishing', 'enchanting',
  'alchemy', 'taming', 'carpentry', 'runecrafting', 'social']);
const STATUSES = new Set(['available', 'partial', 'empty', 'missing', 'private', 'unavailable']);
const LIMITS = Object.freeze({ collections: 100, inventory: 40 });
const usable = category => ['available', 'partial'].includes(category?.status);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const resourceId = id => typeof id === 'string' && /^[A-Z][A-Z0-9_:]{0,79}$/.test(id);
const status = category => STATUSES.has(category?.status) ? category.status : 'unavailable';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function uniqueEntries(category) {
  if (!usable(category) || !Array.isArray(category.entries)) return [];
  const entries = new Map();
  for (const entry of category.entries) {
    if (typeof entry?.id !== 'string') continue;
    // Repeated IDs are ambiguous, even when their values happen to agree.
    entries.set(entry.id, entries.has(entry.id) ? null : entry);
  }
  return [...entries.values()].filter(entry => entry?.status === 'available')
    .sort((a, b) => compare(a.id, b.id));
}

function collectionTarget(amount, definition) {
  const tiers = definition?.tiers;
  // Optional trusted offline metadata, never thresholds inferred from player counts.
  if (!Array.isArray(tiers) || !tiers.length || tiers.some((entry, index) =>
    entry?.tier !== index + 1 || !number(entry.amountRequired)
      || entry.amountRequired <= (index ? tiers[index - 1].amountRequired : 0))) return {};
  const next = tiers.find(entry => entry.amountRequired > amount);
  return next ? { nextTier: next.tier, targetAmount: next.amountRequired,
    remaining: next.amountRequired - amount } : { atMaxTier: true };
}

function inventoryFacts(data) {
  return CONTAINERS.flatMap(categoryName => {
    const category = data[categoryName];
    if (!usable(category) || !Array.isArray(category.items)) return [];
    const slots = new Map();
    for (const item of category.items) {
      const container = categoryName === 'Backpacks' ? item?.container : categoryName;
      if (categoryName === 'Backpacks' && !/^Backpack \d+$/.test(container)) continue;
      if (!Number.isInteger(item?.slot) || item.slot < 0) continue;
      const key = `${container}:${item.slot}`;
      slots.set(key, slots.has(key) ? null : { item, container });
    }
    return [...slots.values()].filter(Boolean).flatMap(({ item, container }) => {
      if (!resourceId(item.id) && !(typeof item.id === 'string'
          && /^minecraft:[a-z0-9_]{1,80}$/.test(item.id))) return [];
      // Names, lore, raw NBT, and arbitrary extra fields never enter the prompt.
      return [{ factId: `inventory:${encodeURIComponent(container)}:${item.slot}:${encodeURIComponent(item.id)}`,
        itemId: item.id, container, slot: item.slot,
        ...(number(item.count) && Number.isInteger(item.count) ? { count: item.count } : {}) }];
    });
  }).sort((a, b) => compare(a.factId, b.factId));
}

/**
 * Accept one normalized saved profile, never the player's profiles array.
 * Metadata is optional, trusted offline data; this function never loads it.
 */
function buildRecommendationInput(selectedProfile, goal, { skillDefinitions = {}, collectionDefinitions = {} } = {}) {
  if (!GOALS.includes(goal)) throw new TypeError('Unsupported recommendation goal.');
  if (!object(selectedProfile) || !object(selectedProfile.data)) {
    throw new TypeError('A single normalized saved profile is required.');
  }
  const data = selectedProfile.data;
  const time = selectedProfile.fetchedAt;
  const parsed = time instanceof Date || (typeof time === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(time))
    ? new Date(time) : null;
  const fetchedAt = parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  const skills = uniqueEntries(data.Skills).flatMap(entry => {
    if (!SKILLS.has(entry.id) || !number(entry.xp)
        || (selectedProfile.sourceSchemaVersion === 1 && entry.xp === 0)) return [];
    const progress = calculateSkillProgress(entry, skillDefinitions[entry.id], data.Skills.status);
    return [{ factId: `skill:${entry.id}`, skill: entry.id, xp: entry.xp,
      ...(['progress', 'max'].includes(progress.status) ? {
        level: progress.level, nextLevel: progress.nextLevel,
        xpRemaining: progress.xpRemaining, atCap: progress.status === 'max',
      } : {}) }];
  });
  const collections = uniqueEntries(data.Collections).flatMap(entry =>
    resourceId(entry.id) && number(entry.amount) ? [{
      factId: `collection:${encodeURIComponent(entry.id)}`, collectionId: entry.id, amount: entry.amount,
      ...collectionTarget(entry.amount, collectionDefinitions[entry.id]),
    }] : []);
  const inventory = inventoryFacts(data);
  return {
    contractVersion: 1, goal,
    snapshot: fetchedAt ? { factId: 'snapshot:time', fetchedAt } : { fetchedAt: null },
    coverage: {
      skills: status(data.Skills), collections: status(data.Collections),
      inventory: Object.fromEntries(CONTAINERS.map(name => [name, status(data[name])])),
      collectionsTruncated: collections.length > LIMITS.collections,
      inventoryTruncated: inventory.length > LIMITS.inventory,
      inventoryAbsenceSupported: false,
    },
    skills, collections: collections.slice(0, LIMITS.collections), inventory: inventory.slice(0, LIMITS.inventory),
  };
}

module.exports = { buildRecommendationInput, GOALS, RECOMMENDATION_RESPONSE_SCHEMA };
