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
    database = client.db(dbName);
    await Promise.all([
      database.collection('players').createIndex({ uuid: 1 }, { unique: true }),
      database.collection('skyblockSnapshots').createIndex({ playerUuid: 1, fetchedAt: -1 }),
      database.collection('fetchEvents').createIndex({ playerUuid: 1, fetchedAt: -1 }),
      database.collection('fetchLocks').createIndex({ createdAt: 1 }, { expireAfterSeconds: 120 }),
    ]);
    return database;
  })().catch((error) => {
    connecting = null;
    client = null;
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

module.exports = { getDatabase, closeDatabase, buildMongoUri };
