const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRecommendationInput, GOALS } = require('./ai-recommendations');
const { buildProfileData, normalizeStoredData } = require('./normalize');
const { normalizeSkillResource } = require('./skill-resource');
const { officialSkillsFixture } = require('./fixtures/skill-resource');

const metadata = { skillDefinitions: normalizeSkillResource(officialSkillsFixture()).skills,
  collectionDefinitions: { WHEAT: { tiers: [{ tier: 1, amountRequired: 50 }, { tier: 2, amountRequired: 100 }] } } };
const skill = (id, xp, extra = {}) => ({ id, xp, status: 'available', ...extra });
const collection = (id, amount, extra = {}) => ({ id, amount, status: 'available', ...extra });
const category = entries => ({ status: 'available', entries });
const item = (id, slot = 0, extra = {}) => ({ id, slot, count: 1, container: 'Inventory', ...extra });
function profile(extra = {}) {
  return { profileId: 'redacted-profile', playerUuid: 'redacted-player', schemaVersion: 2,
    sourceSchemaVersion: 2, fetchedAt: '2026-10-28T12:00:00.000Z', data: {
      Skills: category([skill('mining', 112.5), skill('farming', 0)]),
      Collections: category([collection('WHEAT', 0)]),
      Inventory: { status: 'available', items: [item('DIAMOND_PICKAXE')] },
    }, ...extra };
}

test('accepts exactly the four goals and leaves action selection to the future model', () => {
  const saved = profile();
  const before = structuredClone(saved);
  for (const goal of GOALS) {
    const summary = buildRecommendationInput(saved, goal, metadata);
    assert.equal(summary.goal, goal);
    assert.equal(summary.contractVersion, 1);
    assert.equal(summary.actions, undefined);
    assert.deepEqual(summary.skills.map(entry => entry.skill), ['farming', 'mining']);
  }
  for (const goal of [undefined, '', 'Farming', 'fishing', null]) {
    assert.throws(() => buildRecommendationInput(saved, goal), /Unsupported/);
  }
  assert.deepEqual(saved, before);
});

test('uses only the selected profile and binds facts to that snapshot without leaking identity or raw data', () => {
  const a = profile();
  const b = profile({ profileId: 'other-profile', fetchedAt: '2026-10-27T12:00:00Z', data: {
    Skills: category([skill('mining', 0)]), Collections: category([collection('COBBLESTONE', 25)]),
    Inventory: { status: 'empty', items: [] },
  } });
  const secret = 'MUST_NOT_APPEAR';
  Object.assign(a.data.Inventory.items[0], { raw: { password: secret }, lore: [secret], name: secret });
  a.credentials = secret;
  a.profiles = [b]; // Even an accidental sibling field is never traversed.
  const first = buildRecommendationInput(a, 'mining', metadata);
  const second = buildRecommendationInput(b, 'mining', metadata);
  assert.equal(first.skills.find(entry => entry.skill === 'mining').xp, 112.5);
  assert.equal(second.skills[0].xp, 0);
  assert.equal(second.collections[0].collectionId, 'COBBLESTONE');
  assert.deepEqual(second.inventory, []);
  assert.equal(second.snapshot.fetchedAt, '2026-10-27T12:00:00.000Z');
  assert.deepEqual(buildRecommendationInput(a, 'mining', metadata), first);
  const json = JSON.stringify(first);
  for (const value of [secret, a.profileId, a.playerUuid, 'credentials', 'raw', 'lore', 'name']) {
    assert.ok(!json.includes(value), value);
  }
  for (const invalid of [null, [a, b], { profiles: [a, b] }]) {
    assert.throws(() => buildRecommendationInput(invalid, 'general'), /single normalized saved profile/);
  }
});

test('preserves confirmed zero and derives exact levels and targets only from supplied offline metadata', async () => {
  const saved = profile({ data: await buildProfileData({ player_data: { experience: { SKILL_FARMING: 0 } },
    collection: { WHEAT: 0 } }) });
  const summary = buildRecommendationInput(saved, 'farming', metadata);
  assert.deepEqual(summary.skills[0], { factId: 'skill:farming', skill: 'farming', xp: 0,
    level: 0, nextLevel: 1, xpRemaining: 50, atCap: false });
  assert.deepEqual(summary.collections[0], { factId: 'collection:WHEAT', collectionId: 'WHEAT',
    amount: 0, nextTier: 1, targetAmount: 50, remaining: 50 });
  const withoutMetadata = buildRecommendationInput(saved, 'farming');
  assert.deepEqual(withoutMetadata.skills[0], { factId: 'skill:farming', skill: 'farming', xp: 0 });
  assert.deepEqual(withoutMetadata.collections[0], { factId: 'collection:WHEAT', collectionId: 'WHEAT', amount: 0 });
  const fractional = buildRecommendationInput(profile(), 'mining', metadata).skills[1];
  assert.equal(fractional.level, 1);
  assert.equal(fractional.xpRemaining, 62.5);
});

test('excludes private, missing, unavailable, invalid and duplicate data without inventing zeros', () => {
  for (const state of ['private', 'missing', 'unavailable', 'empty', 'unexpected']) {
    const saved = profile();
    for (const entry of Object.values(saved.data)) entry.status = state;
    const summary = buildRecommendationInput(saved, 'general', metadata);
    assert.deepEqual([summary.skills, summary.collections, summary.inventory], [[], [], []]);
  }
  const saved = profile({ data: {
    Skills: { status: 'partial', entries: [skill('mining', 1), skill('mining', 2), skill('combat', -1),
      skill('farming', '0'), skill('fishing', 0, { status: 'missing' }), skill('social', 0)] },
    Collections: { status: 'partial', entries: [collection('WHEAT', 0), collection('WHEAT', 0),
      collection('IRON_INGOT', Infinity), collection('COBBLESTONE', 0)] },
    Inventory: { status: 'partial', items: [item('DIAMOND_PICKAXE'), item('STONE_PICKAXE'),
      item('unknown', 1), item('123', 2), item('DIAMOND', 3, { count: null })] },
  } });
  const summary = buildRecommendationInput(saved, 'general', metadata);
  assert.deepEqual(summary.skills.map(entry => entry.skill), ['social']);
  assert.deepEqual(summary.collections.map(entry => entry.collectionId), ['COBBLESTONE']);
  assert.deepEqual(summary.inventory, [{ factId: 'inventory:Inventory:3:DIAMOND', itemId: 'DIAMOND',
    container: 'Inventory', slot: 3 }]);
  assert.equal(summary.coverage.inventoryAbsenceSupported, false);
});

test('older snapshots retain their time and reliable facts, but not ambiguous legacy zeros or cap guesses', () => {
  const saved = profile({ sourceSchemaVersion: 1, fetchedAt: new Date('2020-01-01T00:00:00Z'),
    data: normalizeStoredData({ Skills: { farming: 0, mining: 80 }, Collections: { WHEAT: 0 } }, 1) });
  const summary = buildRecommendationInput(saved, 'general', metadata);
  assert.equal(summary.snapshot.fetchedAt, '2020-01-01T00:00:00.000Z');
  assert.deepEqual(summary.skills.map(entry => entry.skill), ['mining']);
  assert.equal(summary.collections[0].amount, 0);
  const capped = profile({ data: { Skills: category([skill('farming', 55172425),
    skill('mining', 111672425)]) } });
  const result = buildRecommendationInput(capped, 'general', metadata);
  assert.equal(result.skills[0].xp, 55172425);
  assert.equal(result.skills[0].level, undefined);
  assert.equal(result.skills[1].atCap, true);
  assert.equal(result.skills[1].xpRemaining, 0);
  assert.equal(result.skills[1].nextLevel, null);
  for (const fetchedAt of [undefined, null, '', 0, 'invalid']) {
    assert.deepEqual(buildRecommendationInput(profile({ fetchedAt }), 'general').snapshot, { fetchedAt: null });
  }
});

test('bounds inventory context, marks truncation, and never turns empty or partial inventory into absence', () => {
  const saved = profile();
  saved.data.Inventory.items = Array.from({ length: 50 }, (_, slot) => item('DIAMOND', slot));
  const summary = buildRecommendationInput(saved, 'general');
  assert.equal(summary.inventory.length, 40);
  assert.equal(summary.coverage.inventoryTruncated, true);
  const reordered = structuredClone(saved);
  reordered.data.Inventory.items.reverse();
  assert.deepEqual(buildRecommendationInput(reordered, 'combat').inventory, summary.inventory);
  for (const state of ['empty', 'partial', 'missing', 'private']) {
    saved.data.Inventory = { status: state, items: [] };
    const result = buildRecommendationInput(saved, 'general');
    assert.deepEqual(result.inventory, []);
    assert.equal(result.coverage.inventory.Inventory, state);
    assert.equal(result.coverage.inventoryAbsenceSupported, false);
  }
});

test('collection boundaries and malformed metadata do not fabricate targets', () => {
  for (const [amount, expected] of [[50, { nextTier: 2, targetAmount: 100, remaining: 50 }],
    [100, { atMaxTier: true }]]) {
    const saved = profile();
    saved.data.Collections.entries[0].amount = amount;
    const fact = buildRecommendationInput(saved, 'farming', metadata).collections[0];
    assert.deepEqual(fact, { factId: 'collection:WHEAT', collectionId: 'WHEAT', amount, ...expected });
  }
  for (const tiers of [[], [{ tier: 2, amountRequired: 50 }], [{ tier: 1, amountRequired: 0 }],
    [{ tier: 1, amountRequired: 50 }, { tier: 2, amountRequired: 40 }]]) {
    const result = buildRecommendationInput(profile(), 'general', { collectionDefinitions: { WHEAT: { tiers } } });
    assert.equal(result.collections[0].targetAmount, undefined);
  }
});
