const { MongoClient } = require('mongodb');

let client;
let database;
let connecting;
let initializing;
let indexesReady = false;

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

// Connecting for a saved-data read must not create/drop indexes or write records.
function getReadDatabase() {
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
    database = client.db(dbName);
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

// Existing startup/manual-save initialization stays separate from timeline reads.
function getDatabase() {
  if (indexesReady) return getReadDatabase();
  if (initializing) return initializing;
  initializing = (async () => {
    const db = await getReadDatabase();
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
    indexesReady = true;
    return db;
  })().catch(async (error) => {
    // Preserve startup failure cleanup; a failed initializer must not keep the
    // process alive or leave a stale connection cached for the next attempt.
    await closeDatabase();
    throw error;
  });

  return initializing;
}

async function closeDatabase() {
  try {
    if (client) await client.close();
  } finally {
    client = null;
    database = null;
    connecting = null;
    initializing = null;
    indexesReady = false;
  }
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

module.exports = { getDatabase, getReadDatabase, closeDatabase, buildMongoUri, withDatabaseTransaction };
