const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSkyBlockService } = require('./skyblock');
const { createMemoryDatabase } = require('./test-support/memory-db');
const { PLAYER, PLAYER_ID, PROFILE_A, PROFILE_B, FETCHED_AT, profilesReply } = require('./fixtures/skyblock');

function setup(overrides = {}) {
  const memory = createMemoryDatabase();
  const requests = [];
  let time = new Date(FETCHED_AT);
  const service = createSkyBlockService({
    getDatabase: async () => memory.db,
    withDatabaseTransaction: memory.transaction,
    resolveMinecraftPlayer: async () => PLAYER,
    request: async (url, options) => { requests.push({ url, options }); return Response.json(profilesReply()); },
    now: () => time,
    ...overrides,
  });
  return { service, memory, requests, setTime: (value) => { time = new Date(value); } };
}
const args = { username: 'fixtureplayer', uuid: PLAYER_ID, apiKey: 'fixture-key-not-a-credential' };

test('fetch, normalize, transactionally save, and read the same player/profile values', async () => {
  const { service, memory, requests } = setup();
  const saved = await service.fetchSkyBlockData(args);
  assert.equal(saved.username, PLAYER.name);
  assert.equal(saved.fetchedAt, FETCHED_AT);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).searchParams.get('uuid'), PLAYER_ID);
  assert.equal(requests[0].options.headers['API-Key'], args.apiKey);
  assert.equal(memory.rows('players')[0].uuid, PLAYER_ID);
  assert.equal(memory.rows('skyblockSnapshots').length, 2);
  assert.equal(memory.rows('fetchEvents').length, 1);
  assert.equal(memory.rows('fetchLocks').length, 0);
  assert.ok(memory.writes.every((write) => write.session?.fixtureSession));
  for (const document of memory.rows('skyblockSnapshots')) {
    assert.equal(document.playerUuid, PLAYER_ID);
    assert.ok([PROFILE_A, PROFILE_B].includes(document.profileId));
    assert.equal(document.fetchedAt.toISOString(), FETCHED_AT);
    assert.equal(document.schemaVersion, 2);
  }
  const loaded = await service.loadLatestSkyBlockData('FixturePlayer', PLAYER_ID);
  const apple = loaded.profiles.find((profile) => profile.profileId === PROFILE_A);
  assert.equal(loaded.uuid, PLAYER_ID);
  assert.equal(apple.fetchedAt, FETCHED_AT);
  assert.equal(apple.data.Skills.entries.find((entry) => entry.id === 'farming').xp, 0);
  assert.equal(apple.data.Skills.entries.find((entry) => entry.id === 'mining').xp, 12345.5);
  assert.equal(apple.data.Collections.entries.find((entry) => entry.id === 'COBBLESTONE').amount, 1456);
  assert.equal(apple.data.Inventory.items[0].count, 3);
  assert.equal(loaded.profiles.find((profile) => profile.profileId === PROFILE_B).data.Inventory.status, 'private');
  assert.deepEqual(apple.data, memory.rows('skyblockSnapshots').find((row) => row.profileId === PROFILE_A).data);
});

test('rejects a mismatched identity before writing or contacting Hypixel', async () => {
  const { service, memory, requests } = setup();
  await assert.rejects(service.fetchSkyBlockData({ ...args, uuid: '2'.repeat(32) }), { code: 'PLAYER_MISMATCH' });
  assert.equal(memory.rows('players').length, 0);
  assert.equal(requests.length, 0);
});

test('accepts canonicalized UUIDs and deduplicates repeated profile IDs and retried transaction writes', async () => {
  const memory = createMemoryDatabase();
  const body = profilesReply();
  body.profiles.push(structuredClone(body.profiles[0]));
  body.profiles[0].profile_id = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA';
  const { service } = setup({
    getDatabase: async () => memory.db,
    withDatabaseTransaction: async (work) => { await memory.transaction(work); return memory.transaction(work); },
    request: async () => Response.json(body),
  });
  await service.fetchSkyBlockData(args);
  assert.equal(memory.rows('skyblockSnapshots').length, 2);
  assert.equal(memory.rows('fetchEvents').length, 1);
});

test('rolls back snapshots, identity, and rate-limit accounting if a write fails', async () => {
  const { service, memory } = setup();
  memory.failOn('fetchEvents');
  await assert.rejects(service.fetchSkyBlockData(args), /Simulated storage failure/);
  for (const name of ['players', 'skyblockSnapshots', 'fetchEvents', 'fetchLocks']) assert.equal(memory.rows(name).length, 0);
});

test('enforces hourly and daily limits without repeated Hypixel calls', async () => {
  const { service, memory, requests, setTime } = setup();
  await service.fetchSkyBlockData(args);
  await assert.rejects(service.fetchSkyBlockData(args), { code: 'FETCH_TOO_SOON' });
  assert.equal(requests.length, 1);
  for (let hour = 1; hour <= 3; hour++) {
    setTime(new Date(new Date(FETCHED_AT).getTime() + hour * 3600000));
    await service.fetchSkyBlockData(args);
  }
  setTime(new Date(new Date(FETCHED_AT).getTime() + 4 * 3600000));
  await assert.rejects(service.fetchSkyBlockData(args), { code: 'FETCH_DAILY_LIMIT' });
  assert.equal(memory.rows('fetchEvents').length, 4);
  setTime(new Date(new Date(FETCHED_AT).getTime() + 24 * 3600000));
  assert.equal((await service.getFetchEligibility(PLAYER_ID)).allowed, true);
});

test('keeps multiple fetches while reading only the latest version per profile and reading by UUID after a rename', async () => {
  const { service, memory, setTime } = setup();
  await service.fetchSkyBlockData(args);
  setTime('2026-10-22T14:34:56.789Z');
  await service.fetchSkyBlockData(args);
  assert.equal(memory.rows('skyblockSnapshots').length, 4);
  const loaded = await service.loadLatestSkyBlockData('ChangedName', PLAYER_ID);
  assert.equal(loaded.profiles.length, 2);
  assert.equal(loaded.profiles[0].fetchedAt, '2026-10-22T14:34:56.789Z');
  assert.equal((await service.loadSkyBlockHistory(PLAYER.name)).snapshots.length, 4);
  assert.equal((await service.loadSkyBlockSnapshot(PLAYER.name, FETCHED_AT, PROFILE_A)).snapshots.length, 1);
});

test('a concurrent fetch receives a conflict rather than bypassing the controls', async () => {
  const { service, memory, requests } = setup();
  memory.rows('fetchLocks').push({ _id: PLAYER_ID, fetchId: 'other-request' });
  await assert.rejects(service.fetchSkyBlockData(args), { code: 'FETCH_IN_PROGRESS' });
  assert.equal(requests.length, 0);
  assert.equal(memory.rows('fetchLocks').length, 1);
});

test('upstream failures and missing members never save invented empty profile records', async () => {
  for (const [reply, status, code] of [
    [{ success: false, cause: 'Rejected' }, 403, 'HYPIXEL_AUTH'],
    [{ success: false }, 429, 'HYPIXEL_RATE_LIMIT'],
    [{ success: true, profiles: [] }, 200, 'NO_PROFILES'],
    [{ success: true, profiles: [{ profile_id: PROFILE_A, members: {} }] }, 200, 'HYPIXEL_INVALID_RESPONSE'],
  ]) {
    const { service, memory } = setup({ request: async () => Response.json(reply, { status }) });
    await assert.rejects(service.fetchSkyBlockData(args), { code });
    assert.equal(memory.rows('skyblockSnapshots').length, 0);
    assert.equal(memory.rows('fetchEvents').length, 0);
    assert.equal(memory.rows('fetchLocks').length, 0);
  }
});

test('readback collapses legacy profile-ID casing variants onto the latest stable profile ID', async () => {
  const { service, memory } = setup();
  await service.fetchSkyBlockData(args);
  const original = memory.rows('skyblockSnapshots').find((entry) => entry.profileId === PROFILE_A);
  memory.rows('skyblockSnapshots').push({ ...structuredClone(original), _id: 'legacy-duplicate',
    profileId: PROFILE_A.toUpperCase(), fetchedAt: new Date('2026-10-20T12:00:00Z') });
  const loaded = await service.loadLatestSkyBlockData(PLAYER.name, PLAYER_ID);
  assert.equal(loaded.profiles.length, 2);
  assert.equal(loaded.profiles.find((entry) => entry.profileId === PROFILE_A).fetchedAt, FETCHED_AT);
});

function snapshotReadSetup() {
  const forbidden = async () => { throw new Error('Snapshot reads must not fetch or write.'); };
  const fixture = setup({ request: forbidden, resolveMinecraftPlayer: forbidden,
    withDatabaseTransaction: forbidden });
  fixture.memory.rows('players').push({ uuid: PLAYER_ID, username: PLAYER.name });
  const legacy = {
    _id: 'legacy-snapshot', playerUuid: PLAYER_ID, profileId: PROFILE_A.toUpperCase(),
    profileName: 'Apple', timestamp: '2026-10-17--00--16',
    fetchedAt: new Date('2026-10-17T00:16:27.832Z'), data: { Skills: { mining: 100 } },
  };
  const current = {
    _id: `fixture-fetch:${PROFILE_A}`, fetchId: 'fixture-fetch', schemaVersion: 2,
    playerUuid: PLAYER_ID, profileId: PROFILE_A, profileName: 'Apple',
    timestamp: FETCHED_AT, fetchedAt: new Date(FETCHED_AT),
    data: { Skills: { status: 'available', entries: [
      { id: 'mining', label: 'Mining', xp: 200, status: 'available' },
    ] } },
  };
  fixture.memory.rows('skyblockSnapshots').push(legacy, current);
  return { ...fixture, legacy, current };
}

const dashedProfileA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
for (const [kind, storedId] of [
  ['legacy', PROFILE_A.toUpperCase()],
  ['legacy', dashedProfileA],
  ['legacy', dashedProfileA.toUpperCase()],
  ['current', PROFILE_A],
]) {
  const format = `${storedId.includes('-') ? 'dashed' : 'undashed'} ${storedId === storedId.toUpperCase() ? 'uppercase' : 'lowercase'}`;
  test(`snapshot detail reads ${kind} ${format} IDs without rewriting records`, async () => {
    const { service, memory, [kind]: snapshot } = snapshotReadSetup();
    snapshot.profileId = storedId;
    const before = structuredClone(memory.rows('skyblockSnapshots'));
    for (const profileId of [PROFILE_A, PROFILE_A.toUpperCase(), dashedProfileA, dashedProfileA.toUpperCase()]) {
      const result = await service.loadSkyBlockSnapshot(PLAYER.name, snapshot.timestamp, profileId);
      assert.equal(result.snapshots.length, 1);
      assert.equal(result.snapshots[0].profileId, PROFILE_A);
      assert.equal(result.snapshots[0].playerUuid, PLAYER_ID);
      assert.equal(result.snapshots[0].timestamp, snapshot.timestamp);
      assert.equal(result.snapshots[0].sourceSchemaVersion, kind === 'legacy' ? 1 : 2);
      assert.equal(result.snapshots[0].data.Skills.entries.find(e => e.id === 'mining').xp,
        kind === 'legacy' ? 100 : 200);
    }
    assert.deepEqual(memory.rows('skyblockSnapshots'), before);
    assert.deepEqual(memory.writes, []);
  });
}

test('missing snapshot details stay empty rather than falling back to a different date or profile', async () => {
  const { service, legacy, current } = snapshotReadSetup();
  for (const [username, timestamp, profileId] of [
    [PLAYER.name, '2026-10-18--00--16', PROFILE_A],
    [PLAYER.name, '2026-10-23T12:34:56.789Z', PROFILE_A],
    [PLAYER.name, legacy.timestamp, PROFILE_B],
    [PLAYER.name, current.timestamp, PROFILE_B],
    ['UnknownPlayer', current.timestamp, PROFILE_A],
  ]) {
    assert.deepEqual((await service.loadSkyBlockSnapshot(username, timestamp, profileId)).snapshots, []);
  }
});

test('snapshot detail queries isolate profiles that share the same timestamp', async () => {
  const { service, memory, legacy, current } = snapshotReadSetup();
  for (const snapshot of [legacy, current]) {
    memory.rows('skyblockSnapshots').push({ ...structuredClone(snapshot),
      _id: `${snapshot._id}-other-profile`, profileId: PROFILE_B.toUpperCase(), profileName: 'Banana' });
    for (const profileId of [PROFILE_A, PROFILE_B]) {
      const result = await service.loadSkyBlockSnapshot(PLAYER.name, snapshot.timestamp, profileId);
      assert.equal(result.snapshots.length, 1);
      assert.equal(result.snapshots[0].profileId, profileId);
      assert.equal(result.snapshots[0].profileName, profileId === PROFILE_A ? 'Apple' : 'Banana');
    }
  }
});

test('snapshot detail queries isolate players sharing a profile ID and timestamp', async () => {
  const { service, memory, legacy, current } = snapshotReadSetup();
  const otherPlayer = { username: 'OtherPlayer', uuid: '2'.repeat(32) };
  memory.rows('players').push(otherPlayer);
  for (const snapshot of [legacy, current]) {
    memory.rows('skyblockSnapshots').push({ ...structuredClone(snapshot),
      _id: `${snapshot._id}-other-player`, playerUuid: otherPlayer.uuid, profileName: 'Other player data' });
    for (const player of [{ username: PLAYER.name, uuid: PLAYER_ID }, otherPlayer]) {
      const result = await service.loadSkyBlockSnapshot(player.username, snapshot.timestamp, PROFILE_A);
      assert.equal(result.snapshots.length, 1);
      assert.equal(result.snapshots[0].playerUuid, player.uuid);
    }
  }
});

test('an explicitly empty or malformed profile ID cannot broaden a snapshot detail query', async () => {
  const { service, current } = snapshotReadSetup();
  for (const profileId of ['', null, '.*', PROFILE_A.slice(1), [PROFILE_A]]) {
    await assert.rejects(service.loadSkyBlockSnapshot(PLAYER.name, current.timestamp, profileId),
      /Invalid profile ID/);
  }
});
