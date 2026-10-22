const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./app');
const { createSkyBlockService } = require('./skyblock');
const { createMemoryDatabase } = require('./test-support/memory-db');
const { PLAYER, PLAYER_ID, PROFILE_A, FETCHED_AT, profilesReply } = require('./fixtures/skyblock');

async function fixtureServer(t) {
  const memory = createMemoryDatabase();
  let upstreamCalls = 0;
  const resolveMinecraftPlayer = async () => PLAYER;
  const service = createSkyBlockService({ getDatabase: async () => memory.db,
    withDatabaseTransaction: memory.transaction, resolveMinecraftPlayer,
    request: async () => { upstreamCalls++; return Response.json(profilesReply()); },
    now: () => new Date(FETCHED_AT),
  });
  const app = createApp({ service, resolveMinecraftPlayer, getApiKey: () => 'fixture-key' });
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { memory, calls: () => upstreamCalls, request: (path, options) => fetch(base + path, options) };
}

test('Express lookup → manual fetch → saved dashboard response matches persisted fixture values', async (t) => {
  const fixture = await fixtureServer(t);
  const identity = await (await fixture.request('/api/player/fixtureplayer')).json();
  assert.deepEqual(identity, PLAYER);
  const before = await (await fixture.request(`/api/player/FixturePlayer/skyblock?uuid=${PLAYER_ID}`)).json();
  assert.deepEqual(before.profiles, []);
  const response = await fixture.request('/api/player/FixturePlayer/skyblock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uuid: identity.uuid }),
  });
  assert.equal(response.status, 200);
  const saved = await response.json();
  const loaded = await (await fixture.request(`/api/player/FixturePlayer/skyblock?uuid=${PLAYER_ID}`)).json();
  assert.equal(saved.fetchedAt, FETCHED_AT);
  assert.equal(loaded.profiles.length, 2);
  const apple = loaded.profiles.find((entry) => entry.profileId === PROFILE_A);
  const persisted = fixture.memory.rows('skyblockSnapshots').find((entry) => entry.profileId === PROFILE_A);
  assert.deepEqual(apple.data, persisted.data);
  assert.equal(apple.data.Skills.entries.find((entry) => entry.id === 'farming').xp, 0);
  assert.equal(apple.data.Skills.entries.find((entry) => entry.id === 'fishing').xp, null);
  assert.equal(apple.data.Inventory.items[0].name, 'Fixture Diamond');
  assert.equal(fixture.calls(), 1);
  const limited = await fixture.request('/api/player/FixturePlayer/skyblock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uuid: PLAYER_ID }),
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '3600');
  assert.equal(fixture.calls(), 1);
});

test('Express rejects mismatched identities, invalid read IDs, and invalid historical profile IDs', async (t) => {
  const fixture = await fixtureServer(t);
  const mismatch = await fixture.request('/api/player/FixturePlayer/skyblock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uuid: '2'.repeat(32) }),
  });
  assert.equal(mismatch.status, 409);
  const invalid = await fixture.request('/api/player/FixturePlayer/skyblock?uuid=invalid');
  assert.equal(invalid.status, 400);
  assert.equal(fixture.calls(), 0);
  assert.equal(fixture.memory.rows('skyblockSnapshots').length, 0);
  await fixture.request('/api/player/FixturePlayer/skyblock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uuid: PLAYER_ID }),
  });
  const invalidProfile = await fixture.request(`/api/player/FixturePlayer/skyblock/history/${FETCHED_AT}?profileId=invalid`);
  assert.equal(invalidProfile.status, 400);
});
