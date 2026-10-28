const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRecommendationService } = require('./recommendation-service');
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
