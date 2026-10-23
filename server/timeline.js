const { ObjectId } = require('mongodb');
const database = require('./database');
const { normalizeStoredData } = require('./normalize');
const { compareSnapshots } = require('./snapshot-changes');

const SORT = { fetchedAt: -1, _id: -1 };
const METADATA = { _id: 1, fetchedAt: 1, schemaVersion: 1 };
const DETAIL = { ...METADATA, 'data.Skills': 1, 'data.Collections': 1 };
const badRequest = message => Object.assign(new Error(message), { status: 400 });
const notFound = () => Object.assign(new Error('Saved snapshot not found for this player and profile.'), { status: 404 });

function idVariants(value, label) {
  if (typeof value !== 'string') throw badRequest(`Invalid ${label}.`);
  if (!/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value)) {
    throw badRequest(`Invalid ${label}.`);
  }
  const id = value.replaceAll('-', '').toLowerCase();
  const dashed = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  return [...new Set([id, id.toUpperCase(), dashed, dashed.toUpperCase()])];
}

// Versioned, typed tokens preserve ObjectId vs string identity across restarts.
// These are opaque API identifiers, not secrets or authorization credentials.
function snapshotId(id) {
  let payload;
  if (id instanceof ObjectId) payload = ['objectId', id.toHexString()];
  else if (typeof id === 'string' && id.length > 0 && id.length <= 512) payload = ['string', id];
  else throw new Error('Unsupported saved snapshot ID type.');
  return `s1_${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

function storedId(token) {
  if (typeof token !== 'string' || token.length > 1500 || !/^s1_[A-Za-z0-9_-]+$/.test(token)) {
    throw badRequest('Invalid snapshot ID.');
  }
  try {
    const parts = JSON.parse(Buffer.from(token.slice(3), 'base64url').toString('utf8'));
    if (!Array.isArray(parts) || parts.length !== 2 || typeof parts[1] !== 'string') throw new Error();
    const [type, value] = parts;
    let id;
    if (type === 'objectId' && /^[a-f0-9]{24}$/.test(value)) id = new ObjectId(value);
    else if (type === 'string' && value.length > 0 && value.length <= 512) id = value;
    else throw new Error();
    if (snapshotId(id) !== token) throw new Error();
    return id;
  } catch {
    throw badRequest('Invalid snapshot ID.');
  }
}

function metadata(document) {
  if (!(document.fetchedAt instanceof Date) || !Number.isFinite(document.fetchedAt.getTime())) {
    throw new Error('Saved snapshot has an invalid fetch time.');
  }
  return { snapshotId: snapshotId(document._id), fetchedAt: document.fetchedAt.toISOString(),
    sourceSchemaVersion: document.schemaVersion ?? 1 };
}

function categories(document) {
  const data = normalizeStoredData(document.data, document.schemaVersion);
  return { Skills: data.Skills, Collections: data.Collections };
}

function olderThan(document) {
  // $expr uses BSON sort order across ObjectId and string IDs. A plain query
  // $lt on _id uses type bracketing and would skip another type at the same time.
  return { $or: [
    { fetchedAt: { $lt: document.fetchedAt } },
    { fetchedAt: document.fetchedAt, $expr: { $lt: ['$_id', { $literal: document._id }] } },
  ] };
}

function createTimelineService({ getDatabase = database.getReadDatabase } = {}) {
  function scope(playerUuid, profileId) {
    const players = idVariants(playerUuid, 'player UUID');
    const profiles = idVariants(profileId, 'profile ID');
    return {
      filter: { playerUuid: { $in: players }, profileId: { $in: profiles } },
      identity: { playerUuid: players[0], profileId: profiles[0] },
    };
  }

  async function listSnapshots(playerUuid, profileId, { limit = 20, cursor } = {}) {
    const { filter, identity } = scope(playerUuid, profileId);
    if (!['string', 'number'].includes(typeof limit) || !/^[1-9]\d*$/.test(String(limit))
        || !Number.isInteger(Number(limit)) || Number(limit) > 50) {
      throw badRequest('Limit must be an integer from 1 to 50.');
    }
    limit = Number(limit);
    const cursorId = cursor === undefined ? null : storedId(cursor);
    const db = await getDatabase();
    const snapshots = db.collection('skyblockSnapshots');
    let pageFilter = filter;
    if (cursorId !== null) {
      const anchor = await snapshots.findOne({ ...filter, _id: cursorId }, { projection: METADATA });
      if (!anchor) throw badRequest('Cursor not found for this player and profile.');
      metadata(anchor);
      pageFilter = { ...filter, ...olderThan(anchor) };
    }
    const rows = await snapshots.find(pageFilter).project(METADATA).sort(SORT).limit(limit + 1).toArray();
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(metadata);
    return { ...identity, snapshots: page,
      page: { limit, hasMore, nextCursor: hasMore ? page.at(-1).snapshotId : null } };
  }

  async function loadSnapshot(playerUuid, profileId, token) {
    const { filter, identity } = scope(playerUuid, profileId);
    const id = storedId(token);
    const db = await getDatabase();
    const snapshots = db.collection('skyblockSnapshots');
    const selected = await snapshots.findOne({ ...filter, _id: id }, { projection: DETAIL });
    if (!selected) throw notFound();
    const selectedMetadata = metadata(selected);
    const [previous] = await snapshots.find({ ...filter, ...olderThan(selected) })
      .project(DETAIL).sort(SORT).limit(1).toArray();
    const data = categories(selected);
    return { ...identity, snapshot: { ...selectedMetadata, data },
      previousSnapshot: previous ? metadata(previous) : null,
      changes: compareSnapshots(data, previous ? categories(previous) : null) };
  }

  return { listSnapshots, loadSnapshot };
}

module.exports = { ...createTimelineService(), createTimelineService };
