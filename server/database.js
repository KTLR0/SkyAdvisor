const { MongoClient } = require('mongodb');

let client;
let database;
let connecting;

function buildMongoUri(env = process.env) {
  let uri = (env.MONGODB_URI || '').trim();
  const username = env.MONGODB_USERNAME;
  const password = env.MONGODB_PASSWORD;

  if (!uri) {
    throw new Error('MONGODB_URI is not configured.');
  }

  if (username && password) {
    uri = uri
      .replaceAll('<username>', encodeURIComponent(username))
      .replaceAll('<password>', encodeURIComponent(password));

    // Support an Atlas URI without embedded credentials as well as the usual
    // mongodb+srv://<username>:<password>@... template.
    const schemeEnd = uri.indexOf('://');
    const authorityStart = schemeEnd + 3;
    const authorityEnd = uri.indexOf('/', authorityStart);
    const end = authorityEnd === -1 ? uri.length : authorityEnd;
    const authority = uri.slice(authorityStart, end);
    if (!authority.includes('@') && !uri.includes('<username>')) {
      uri = `${uri.slice(0, authorityStart)}${encodeURIComponent(username)}:${encodeURIComponent(password)}@${uri.slice(authorityStart)}`;
    }
  }

  return uri;
}

function getDatabase() {
  if (database) return Promise.resolve(database);
  if (connecting) return connecting;

  connecting = (async () => {
    const uri = buildMongoUri();
    client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
    });
    await client.connect();
    const dbName = process.env.MONGODB_DATABASE || 'skyadvisor';
    const db = client.db(dbName);
    const snapshots = db.collection('skyblockSnapshots');

    let existingSnapshotIndexes = [];
    try {
      existingSnapshotIndexes = await snapshots.listIndexes().toArray();
    } catch (error) {
      if (error.code !== 26 && error.codeName !== 'NamespaceNotFound') throw error;
    }
    for (const index of existingSnapshotIndexes) {
      const keys = Object.keys(index.key || {});
      const isUniquePlayerOnlyIndex = index.unique === true
        && keys.length === 1
        && index.key.playerUuid === 1;
      if (isUniquePlayerOnlyIndex && index.name !== '_id_') {
        await snapshots.dropIndex(index.name);
        console.warn(`Removed obsolete unique snapshot index: ${index.name}`);
      }
    }

    await Promise.all([
      db.collection('players').createIndex({ uuid: 1 }, { unique: true }),
      snapshots.createIndex({ playerUuid: 1, profileId: 1, fetchedAt: -1 }),
      snapshots.createIndex({ playerUuid: 1, timestamp: 1, profileId: 1 }),
      db.collection('fetchEvents').createIndex({ playerUuid: 1, fetchedAt: -1 }),
      db.collection('fetchLocks').createIndex({ createdAt: 1 }, { expireAfterSeconds: 120 }),
    ]);
    database = db;
    return database;
  })().catch(async (error) => {
    await client?.close().catch(() => {});
    connecting = null;
    client = null;
    database = null;
    throw error;
  });

  return connecting;
}

async function closeDatabase() {
  if (client) await client.close();
  client = null;
  database = null;
  connecting = null;
}

async function withDatabaseTransaction(work) {
  const db = await getDatabase();
  const session = client.startSession();
  try {
    return await session.withTransaction(() => work(db, session));
  } finally {
    await session.endSession();
  }
}

module.exports = { getDatabase, closeDatabase, buildMongoUri, withDatabaseTransaction };
