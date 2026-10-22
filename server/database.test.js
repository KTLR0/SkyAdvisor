const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');
const database = require('./database');
const { createTimelineService } = require('./timeline');
const { createMemoryDatabase } = require('./test-support/memory-db');
const { PLAYER_ID, PROFILE_A } = require('./fixtures/skyblock');

async function fakeConnection(t, failIndex = false) {
  const originalUri = process.env.MONGODB_URI;
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017';
  const memory = createMemoryDatabase();
  const indexWrites = [];
  const db = { collection(name) {
    return { ...memory.db.collection(name),
      listIndexes: () => ({ toArray: async () => [] }),
      createIndex: async (...args) => {
        indexWrites.push({ name, args });
        if (failIndex) throw new Error('Fixture index failure.');
      },
      dropIndex: async () => { throw new Error('Unexpected index removal.'); },
    };
  } };
  const connect = t.mock.method(MongoClient.prototype, 'connect', async function () { return this; });
  t.mock.method(MongoClient.prototype, 'db', () => db);
  const close = t.mock.method(MongoClient.prototype, 'close', async () => {});
  t.after(async () => {
    await database.closeDatabase();
    if (originalUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = originalUri;
  });
  return { memory, indexWrites, connect, close };
}

test('a cold timeline read connects without initializing indexes or writing records', async t => {
  const { memory, indexWrites, connect } = await fakeConnection(t);
  const timeline = createTimelineService();
  assert.deepEqual((await timeline.listSnapshots(PLAYER_ID, PROFILE_A)).snapshots, []);
  assert.deepEqual((await timeline.listSnapshots(PLAYER_ID, PROFILE_A)).snapshots, []);
  assert.equal(connect.mock.callCount(), 1);
  assert.deepEqual(indexWrites, []);
  assert.deepEqual(memory.writes, []);
});

test('normal startup still initializes the existing indexes once after a read-only connection', async t => {
  const { indexWrites, connect } = await fakeConnection(t);
  const readDb = await database.getReadDatabase();
  assert.deepEqual(indexWrites, []);
  assert.equal(await database.getDatabase(), readDb);
  assert.equal(await database.getDatabase(), readDb);
  assert.equal(connect.mock.callCount(), 1);
  assert.equal(indexWrites.length, 5);
  assert.deepEqual(indexWrites.find(write => write.name === 'players').args,
    [{ uuid: 1 }, { unique: true }]);
});

test('failed normal initialization closes its connection and permits a fresh read connection', async t => {
  const { connect, close } = await fakeConnection(t, true);
  await assert.rejects(database.getDatabase(), /Fixture index failure/);
  assert.equal(close.mock.callCount(), 1);
  await database.getReadDatabase();
  assert.equal(connect.mock.callCount(), 2);
});
