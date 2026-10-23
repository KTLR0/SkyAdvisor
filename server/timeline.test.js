const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ObjectId } = require('mongodb');
const { createTimelineService } = require('./timeline');
const { createMemoryDatabase } = require('./test-support/memory-db');
const { createApp } = require('./app');
const { PLAYER_ID, PROFILE_A, PROFILE_B } = require('./fixtures/skyblock');
const { timelineRows } = require('./fixtures/timeline');

function setup() {
  const memory = createMemoryDatabase();
  memory.rows('skyblockSnapshots').push(...timelineRows());
  let reads = 0;
  const readonly = { collection(name) {
    assert.equal(name, 'skyblockSnapshots');
    const collection = memory.db.collection(name);
    // The service cannot resolve names, fetch resources, or mutate records.
    return {
      find(...args) { reads++; return collection.find(...args); },
      findOne(...args) { reads++; return collection.findOne(...args); },
    };
  } };
  const options = { getDatabase: async () => readonly };
  return { memory, service: createTimelineService(options), options, reads: () => reads };
}
const list = (service, options) => service.listSnapshots(PLAYER_ID, PROFILE_A, options);
const detail = (service, id) => service.loadSnapshot(PLAYER_ID, PROFILE_A, id);
const xp = result => result.snapshot.data.Skills.entries.find(e => e.id === 'mining').xp;

test('cursor pages cover every snapshot once with stable date and mixed BSON ID ordering', async () => {
  const { service, memory, options } = setup();
  const before = JSON.stringify(memory.rows('skyblockSnapshots'));
  let cursor;
  const ids = []; const values = []; const sizes = [];
  do {
    const page = await list(service, { limit: 2, cursor });
    sizes.push(page.snapshots.length);
    for (const row of page.snapshots) {
      assert.deepEqual(Object.keys(row).sort(), ['fetchedAt', 'snapshotId', 'sourceSchemaVersion']);
      ids.push(row.snapshotId);
      values.push(xp(await detail(service, row.snapshotId)));
    }
    assert.equal(page.page.hasMore, page.page.nextCursor !== null);
    cursor = page.page.nextCursor;
  } while (cursor);
  assert.deepEqual(sizes, [2, 2, 1]);
  assert.equal(new Set(ids).size, 5);
  assert.deepEqual(values, [200, 150, 100, 50, null]);
  assert.deepEqual((await list(createTimelineService(options), { limit: 50 })).snapshots.map(s => s.snapshotId), ids);
  assert.equal(JSON.stringify(memory.rows('skyblockSnapshots')), before);
  assert.deepEqual(memory.writes, []);
});

test('pagination handles an exact final page, a cursor at the end, defaults, and empty history', async () => {
  const { service } = setup();
  const full = await list(service, { limit: 5 });
  assert.equal(full.page.hasMore, false);
  assert.equal(full.page.nextCursor, null);
  const end = await list(service, { cursor: full.snapshots.at(-1).snapshotId, limit: 1 });
  assert.deepEqual(end.snapshots, []);
  assert.equal(end.page.nextCursor, null);
  assert.equal((await list(service)).page.limit, 20);
  const empty = await service.listSnapshots('3'.repeat(32), PROFILE_A);
  assert.deepEqual(empty.snapshots, []);
});

test('a new fetch inserted before a cursor does not repeat or skip the remaining saved page', async () => {
  const { service, memory } = setup();
  const first = await list(service, { limit: 2 });
  const newest = memory.rows('skyblockSnapshots')[4];
  memory.rows('skyblockSnapshots').push({ ...newest, _id: 'new-fetch', fetchedAt: new Date('2026-10-24T00:00:00Z') });
  const next = await list(service, { limit: 50, cursor: first.page.nextCursor });
  assert.equal(next.snapshots.length, 3);
  assert.ok(next.snapshots.every(s => !first.snapshots.some(a => a.snapshotId === s.snapshotId)));
});

test('legacy ObjectIds and string IDs with identical text have distinct stable tokens and tie boundaries', async () => {
  const { service, memory } = setup();
  const stringId = '000000000000000000000003';
  const legacy = memory.rows('skyblockSnapshots')[3];
  memory.rows('skyblockSnapshots').push({ ...legacy, _id: stringId, data: { Skills: { mining: 125 } } });
  const page = await list(service, { limit: 50 });
  const sameTime = page.snapshots.filter(s => s.fetchedAt === legacy.fetchedAt.toISOString());
  assert.equal(new Set(sameTime.map(s => s.snapshotId)).size, 3);
  const values = await Promise.all(sameTime.map(async s => xp(await detail(service, s.snapshotId))));
  assert.deepEqual(values, [150, 100, 125]);
  const afterObjectId = await list(service, { limit: 1, cursor: sameTime[0].snapshotId });
  assert.equal(afterObjectId.snapshots[0].snapshotId, sameTime[1].snapshotId);
  assert.equal((await detail(service, sameTime[1].snapshotId)).previousSnapshot.snapshotId, sameTime[2].snapshotId);
});

test('previous snapshot is immediate even across pages, ties, and schema transitions', async () => {
  const { service } = setup();
  const first = await list(service, { limit: 1 });
  const selected = await detail(service, first.snapshots[0].snapshotId);
  const second = await list(service, { limit: 1, cursor: first.page.nextCursor });
  assert.equal(selected.previousSnapshot.snapshotId, second.snapshots[0].snapshotId);
  assert.equal(selected.previousSnapshot.sourceSchemaVersion, 1);
  assert.equal(selected.changes.Skills.entries.find(e => e.id === 'mining').delta, 50);
  assert.deepEqual(Object.keys(selected.snapshot.data), ['Skills', 'Collections']);
  const tied = await detail(service, second.snapshots[0].snapshotId);
  assert.equal(tied.previousSnapshot.fetchedAt, tied.snapshot.fetchedAt);
  assert.equal(tied.previousSnapshot.sourceSchemaVersion, 2);
  assert.equal(tied.changes.Skills.entries.find(e => e.id === 'mining').delta, 50);
});

test('an unavailable immediate predecessor is not skipped for an older reliable baseline', async () => {
  const { service, memory } = setup();
  memory.rows('skyblockSnapshots')[3].data.Skills = {};
  const selected = await detail(service, (await list(service)).snapshots[0].snapshotId);
  assert.equal(selected.previousSnapshot.fetchedAt, '2026-10-17T00:00:00.000Z');
  assert.equal(selected.changes.Skills.entries.find(e => e.id === 'mining').status, 'unavailable');
  assert.equal(selected.changes.Skills.entries.find(e => e.id === 'mining').delta, null);
});

test('oldest snapshot has no predecessor and does not turn ambiguous legacy zero into progress', async () => {
  const { service } = setup();
  const page = await list(service);
  const oldest = await detail(service, page.snapshots.at(-1).snapshotId);
  assert.equal(oldest.previousSnapshot, null);
  assert.equal(oldest.changes.Skills.reason, 'No previous snapshot.');
  assert.ok(oldest.changes.Skills.entries.every(e => e.delta === null));
  const next = await detail(service, page.snapshots.at(-2).snapshotId);
  const mining = next.changes.Skills.entries.find(e => e.id === 'mining');
  assert.equal(mining.current, 50);
  assert.equal(mining.previous, null);
  assert.equal(mining.reason, 'Comparison unavailable.');
});

test('scope isolates player and profile for listing, cursor anchors, selected and previous snapshots', async () => {
  const { service } = setup();
  const own = await list(service, { limit: 1 });
  const otherProfile = await service.listSnapshots(PLAYER_ID, PROFILE_B);
  const otherPlayer = await service.listSnapshots('2'.repeat(32), PROFILE_A);
  for (const foreign of [otherProfile, otherPlayer]) {
    const id = foreign.snapshots[0].snapshotId;
    await assert.rejects(detail(service, id), { status: 404 });
    await assert.rejects(list(service, { cursor: id }), { status: 400 });
    assert.equal(foreign.snapshots.length, 1);
    const loaded = await service.loadSnapshot(foreign.playerUuid, foreign.profileId, id);
    assert.equal(loaded.previousSnapshot, null);
  }
  const loaded = await detail(service, own.snapshots[0].snapshotId);
  assert.equal(loaded.playerUuid, PLAYER_ID);
  assert.equal(loaded.profileId, PROFILE_A);
  const dashed = PROFILE_A.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5').toUpperCase();
  assert.deepEqual(await service.listSnapshots(PLAYER_ID, dashed, { limit: 1 }), own);
});

test('missing and malformed snapshot IDs, cursor IDs, limits and scope return deliberate errors', async () => {
  const { service, reads } = setup();
  for (const limit of [0, -1, 51, 1.5, '', '1.0', '01', ['1'], {}, null, Infinity]) {
    await assert.rejects(list(service, { limit }), { status: 400 });
  }
  for (const token of ['', 'not-a-token', 's1_abc', [], {}, null, 's1_' + 'a'.repeat(1600)]) {
    await assert.rejects(detail(service, token), { status: 400 });
    await assert.rejects(list(service, { cursor: token }), { status: 400 });
  }
  await assert.rejects(service.listSnapshots('invalid', PROFILE_A), { status: 400 });
  await assert.rejects(service.listSnapshots(PLAYER_ID, '.*'), { status: 400 });
  assert.equal(reads(), 0);
  const missing = `s1_${Buffer.from(JSON.stringify(['objectId', new ObjectId().toHexString()])).toString('base64url')}`;
  await assert.rejects(detail(service, missing), { status: 404 });
  await assert.rejects(list(service, { cursor: missing }), { status: 400 });
});

test('timeline HTTP routes paginate and select saved data with no external calls or writes', async t => {
  const { service, memory } = setup();
  const before = JSON.stringify(memory.rows('skyblockSnapshots'));
  let externalCalls = 0;
  const forbidden = async () => { externalCalls++; throw new Error('External call forbidden.'); };
  const app = createApp({ timelineService: service, resolveMinecraftPlayer: forbidden,
    loadSkillResource: forbidden, getApiKey: forbidden,
    service: { fetchSkyBlockData: forbidden, loadLatestSkyBlockData: forbidden,
      loadSkyBlockHistory: forbidden, loadSkyBlockSnapshot: forbidden } });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = path => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: server.address().port, path }, response => {
      let text = '';
      response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, cache: response.headers['cache-control'], data: JSON.parse(text) }));
    }).on('error', reject);
  });
  const base = `/api/players/${PLAYER_ID}/profiles/${PROFILE_A}/snapshots`;
  const first = await request(`${base}?limit=1`);
  assert.equal(first.status, 200); assert.equal(first.cache, 'no-store');
  const second = await request(`${base}?limit=1&cursor=${first.data.page.nextCursor}`);
  assert.equal(second.status, 200);
  const selected = await request(`${base}/${first.data.snapshots[0].snapshotId}`);
  assert.equal(selected.status, 200);
  assert.equal(selected.data.previousSnapshot.snapshotId, second.data.snapshots[0].snapshotId);
  const wrongProfile = await request(`${base.replace(PROFILE_A, PROFILE_B)}/${first.data.snapshots[0].snapshotId}`);
  assert.equal(wrongProfile.status, 404);
  assert.equal((await request(`${base}?limit=0`)).status, 400);
  assert.equal((await request(`${base}?limit=1&limit=2`)).status, 400);
  assert.equal((await request(`${base}/malformed`)).status, 400);
  assert.equal(externalCalls, 0);
  assert.deepEqual(memory.writes, []);
  assert.equal(JSON.stringify(memory.rows('skyblockSnapshots')), before);
});
