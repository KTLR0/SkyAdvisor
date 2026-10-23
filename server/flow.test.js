const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./app');
const { createSkyBlockService } = require('./skyblock');
const { createMemoryDatabase } = require('./test-support/memory-db');
const { PLAYER, PLAYER_ID, PROFILE_A, PROFILE_B, FETCHED_AT, profilesReply } = require('./fixtures/skyblock');

async function fixtureServer(t, appOptions = {}) {
  const memory = createMemoryDatabase();
  let upstreamCalls = 0;
  const resolveMinecraftPlayer = async () => PLAYER;
  const service = createSkyBlockService({ getDatabase: async () => memory.db,
    withDatabaseTransaction: memory.transaction, resolveMinecraftPlayer,
    request: async () => { upstreamCalls++; return Response.json(profilesReply()); },
    now: () => new Date(FETCHED_AT),
  });
  const app = createApp({ service, resolveMinecraftPlayer, getApiKey: () => 'fixture-key', ...appOptions });
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

test('public skill thresholds are served without fetching or saving player data', async (t) => {
  const { normalizeSkillResource } = require('./skill-resource');
  const { officialSkillsFixture } = require('./fixtures/skill-resource');
  const resource = { ...normalizeSkillResource(officialSkillsFixture()), fetchedAt: FETCHED_AT, stale: false };
  const fixture = await fixtureServer(t, { loadSkillResource: async () => resource });
  const response = await fixture.request('/api/resources/skills');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.skills.mining.levels[1].totalXp, 175);
  assert.equal(body.skills.runecrafting.levels[1].totalXp, 150);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(fixture.calls(), 0);
  assert.equal(fixture.memory.rows('skyblockSnapshots').length, 0);
});

test('threshold endpoint failures return a useful 503 without fabricated curves', async (t) => {
  const fixture = await fixtureServer(t, { loadSkillResource: async () => { throw new Error('Offline'); } });
  const response = await fixture.request('/api/resources/skills');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '60');
  const body = await response.json();
  assert.match(body.error, /temporarily unavailable/);
  assert.equal(body.skills, undefined);
});

test('Express history details select only the requested legacy or current profile without fetching or writing', async (t) => {
  const fixture = await fixtureServer(t);
  fixture.memory.rows('players').push({ uuid: PLAYER_ID, username: PLAYER.name });
  const legacyTimestamp = '2026-10-17--00--16';
  for (const timestamp of [legacyTimestamp, FETCHED_AT]) {
    const legacy = timestamp === legacyTimestamp;
    for (const profileId of [PROFILE_A, PROFILE_B]) {
      fixture.memory.rows('skyblockSnapshots').push({
        _id: `${timestamp}:${profileId}`, playerUuid: PLAYER_ID,
        profileId: legacy ? profileId.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5') : profileId,
        profileName: profileId === PROFILE_A ? 'Apple' : 'Banana', timestamp,
        fetchedAt: new Date(legacy ? '2026-10-17T00:16:27.832Z' : FETCHED_AT),
        schemaVersion: legacy ? 1 : 2,
        data: legacy ? { Skills: { mining: 100 } }
          : { Skills: { status: 'available', entries: [{ id: 'mining', xp: 200, status: 'available' }] } },
      });
    }
  }
  const before = structuredClone(fixture.memory.rows('skyblockSnapshots'));
  const history = await (await fixture.request('/api/player/FixturePlayer/skyblock/history')).json();
  assert.equal(history.snapshots.length, 4);
  for (const snapshot of history.snapshots) {
    const response = await fixture.request(`/api/player/FixturePlayer/skyblock/history/${snapshot.timestamp}?profileId=${snapshot.profileId}`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.snapshots.length, 1);
    assert.equal(result.snapshots[0].profileId, snapshot.profileId.replaceAll('-', '').toLowerCase());
    assert.equal(result.snapshots[0].timestamp, snapshot.timestamp);
  }
  const missing = await fixture.request(`/api/player/FixturePlayer/skyblock/history/2026-10-18--00--16?profileId=${PROFILE_A}`);
  assert.equal(missing.status, 200);
  assert.deepEqual((await missing.json()).snapshots, []);
  const emptyProfile = await fixture.request(`/api/player/FixturePlayer/skyblock/history/${FETCHED_AT}?profileId=`);
  assert.equal(emptyProfile.status, 400);
  assert.equal(fixture.calls(), 0);
  assert.deepEqual(fixture.memory.writes, []);
  assert.deepEqual(fixture.memory.rows('skyblockSnapshots'), before);
});
