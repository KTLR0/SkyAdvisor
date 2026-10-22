const { randomUUID } = require('node:crypto');
const database = require('./database');
const { resolvePlayer } = require('./minecraft');
const { buildProfileData, normalizeStoredData, parseNbtContainer } = require('./normalize');

const ONE_HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * ONE_HOUR_MS;
const canonicalId = (id) => typeof id === 'string' ? id.replaceAll('-', '').toLowerCase() : '';
const validId = (id) => /^[a-f0-9]{32}$/.test(canonicalId(id));
const validName = (name) => typeof name === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(name);
const formatTimestamp = (date = new Date()) => date.toISOString();
const failure = (code, message) => Object.assign(new Error(message), { code });

// Dependencies can be replaced by fixtures in tests without contacting external services.
function createSkyBlockService({
  getDatabase = database.getDatabase,
  withDatabaseTransaction = database.withDatabaseTransaction,
  resolveMinecraftPlayer = resolvePlayer,
  request = (...args) => globalThis.fetch(...args),
  now = () => new Date(),
} = {}) {
  async function getPlayerFetchTimestamps(uuid, time = now().getTime()) {
    const db = await getDatabase();
    const events = await db.collection('fetchEvents')
      .find({ playerUuid: canonicalId(uuid), fetchedAt: { $gt: new Date(time - DAY_MS) } })
      .sort({ fetchedAt: -1 }).project({ fetchedAt: 1, _id: 0 }).toArray();
    return events.map((event) => new Date(event.fetchedAt).getTime());
  }

  async function getFetchEligibility(uuid, time = now().getTime()) {
    const timestamps = await getPlayerFetchTimestamps(uuid, time);
    const newestTimestamp = timestamps[0] ?? null;
    const common = { newestTimestamp, fetchesLast24Hours: timestamps.length };
    if (newestTimestamp !== null && time - newestTimestamp < ONE_HOUR_MS) {
      return { ...common, allowed: false, reason: 'hour', retryAfterMs: ONE_HOUR_MS - (time - newestTimestamp) };
    }
    if (timestamps.length >= 4) {
      return { ...common, allowed: false, reason: 'daily', retryAfterMs: DAY_MS - (time - timestamps.at(-1)) };
    }
    return { ...common, allowed: true, reason: null, retryAfterMs: 0 };
  }

  async function fetchSkyBlockData({ username, uuid, apiKey }) {
    if (!validName(username)) throw new Error('Invalid Minecraft username.');
    if (!validId(uuid)) throw new Error('Invalid Minecraft UUID.');
    if (!apiKey) throw new Error('Hypixel API key is not configured.');
    // Verify the pair server-side; an arbitrary submitted UUID must never be saved under another name.
    const identity = await resolveMinecraftPlayer(username);
    const playerUuid = canonicalId(identity.uuid);
    if (playerUuid !== canonicalId(uuid)) {
      throw failure('PLAYER_MISMATCH', 'The username and UUID do not match. Look up the player again.');
    }
    username = identity.name;
    const db = await getDatabase();
    const locks = db.collection('fetchLocks');
    const fetchId = randomUUID();
    try {
      await locks.insertOne({ _id: playerUuid, fetchId, createdAt: now() });
    } catch (error) {
      if (error.code === 11000) throw failure('FETCH_IN_PROGRESS', 'A SkyBlock fetch is already in progress for this player.');
      throw error;
    }
    try {
      const eligibility = await getFetchEligibility(playerUuid);
      if (!eligibility.allowed) {
        throw Object.assign(failure(eligibility.reason === 'hour' ? 'FETCH_TOO_SOON' : 'FETCH_DAILY_LIMIT',
          eligibility.reason === 'hour' ? 'This player was fetched less than one hour ago.'
            : 'This player has already been fetched four times within the last 24 hours.'), eligibility);
      }
      let response;
      try {
        response = await request(`https://api.hypixel.net/v2/skyblock/profiles?uuid=${playerUuid}`, {
          headers: { 'API-Key': apiKey, 'User-Agent': 'SkyAdvisor/1.0' },
          signal: AbortSignal.timeout(10000),
        });
      } catch (error) {
        const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
        throw failure(timeout ? 'HYPIXEL_TIMEOUT' : 'HYPIXEL_NETWORK',
          timeout ? 'Hypixel API request timed out.' : 'Could not reach the Hypixel API.');
      }
      let body;
      try { body = await response.json(); } catch {
        throw failure('HYPIXEL_INVALID_RESPONSE', 'Hypixel returned invalid JSON.');
      }
      if (!response.ok || body?.success !== true) {
        const cause = typeof body?.cause === 'string' ? body.cause : 'Hypixel API request failed.';
        const code = [401, 403].includes(response.status) ? 'HYPIXEL_AUTH'
          : response.status === 429 ? 'HYPIXEL_RATE_LIMIT' : 'HYPIXEL_API_ERROR';
        throw Object.assign(failure(code, cause), { httpStatus: response.status });
      }
      if (!Array.isArray(body.profiles) || !body.profiles.length) {
        throw failure('NO_PROFILES', 'No SkyBlock profiles were found for this player.');
      }
      // Deduplicate by stable profile UUID, never by display name.
      const profiles = new Map();
      for (const profile of body.profiles) {
        if (!validId(profile?.profile_id)) throw failure('HYPIXEL_INVALID_RESPONSE', 'Hypixel returned a profile without a valid ID.');
        profiles.set(canonicalId(profile.profile_id), profile);
      }
      const fetchedAt = now();
      const timestamp = formatTimestamp(fetchedAt);
      const documents = [];
      for (const [profileId, profile] of profiles) {
        const member = Object.entries(profile.members ?? {}).find(([id]) => canonicalId(id) === playerUuid)?.[1];
        if (!member || typeof member !== 'object') {
          throw failure('HYPIXEL_INVALID_RESPONSE', 'Hypixel did not include this player in the returned profile.');
        }
        documents.push({
          _id: `${fetchId}:${profileId}`, fetchId, playerUuid, username, profileId,
          profileName: profile.cute_name || profileId, selected: profile.selected === true,
          fetchedAt, timestamp, schemaVersion: 2, data: await buildProfileData(member),
        });
      }
      // All profiles, player identity, and the rate-limit event succeed or fail together.
      await withDatabaseTransaction(async (transactionDb, session) => {
        const options = { session, upsert: true };
        await transactionDb.collection('players').updateOne({ uuid: playerUuid }, {
          $set: { username, lastFetchedAt: fetchedAt },
          $setOnInsert: { uuid: playerUuid, createdAt: fetchedAt },
        }, options);
        for (const document of documents) {
          await transactionDb.collection('skyblockSnapshots').updateOne({ _id: document._id },
            { $setOnInsert: document }, options);
        }
        await transactionDb.collection('fetchEvents').updateOne({ _id: fetchId }, {
          $setOnInsert: { playerUuid, username, fetchedAt, profileCount: documents.length },
        }, options);
      });
      return {
        username, uuid: playerUuid, fetchedAt: timestamp, timestamp,
        profiles: documents.map((entry) => ({ profile: entry.profileName, profileId: entry.profileId, timestamp })),
        fetchesLast24Hours: (await getPlayerFetchTimestamps(playerUuid)).length,
      };
    } finally {
      // Only release our own lock; never another request's replacement lock.
      await locks.deleteOne({ _id: playerUuid, fetchId }).catch(() => {});
    }
  }

  async function findPlayer(db, username, uuid) {
    if (!validName(username)) throw new Error('Invalid Minecraft username.');
    if (uuid !== undefined && !validId(uuid)) throw new Error('Invalid Minecraft UUID.');
    return db.collection('players').findOne(uuid ? { uuid: canonicalId(uuid) }
      : { username: { $regex: `^${username}$`, $options: 'i' } });
  }

  function viewProfile(snapshot) {
    const fetchedAt = new Date(snapshot.fetchedAt);
    return {
      profile: snapshot.profileName, profileId: canonicalId(snapshot.profileId),
      playerUuid: canonicalId(snapshot.playerUuid), selected: snapshot.selected === true,
      fetchedAt: Number.isFinite(fetchedAt.getTime()) ? fetchedAt.toISOString() : null,
      timestamp: snapshot.timestamp, timestampMs: Number.isFinite(fetchedAt.getTime()) ? fetchedAt.getTime() : null,
      schemaVersion: 2, sourceSchemaVersion: snapshot.schemaVersion ?? 1,
      data: normalizeStoredData(snapshot.data, snapshot.schemaVersion),
    };
  }

  async function loadLatestSkyBlockData(username, uuid) {
    const db = await getDatabase();
    const player = await findPlayer(db, username, uuid);
    if (!player) return { username, uuid: uuid ? canonicalId(uuid) : null, profiles: [] };
    const latest = await db.collection('skyblockSnapshots').aggregate([
      { $match: { playerUuid: player.uuid } },
      { $sort: { fetchedAt: -1, _id: -1 } },
      { $group: { _id: '$profileId', snapshot: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$snapshot' } },
      { $sort: { profileName: 1 } },
    ]).toArray();
    const byId = new Map();
    for (const snapshot of latest) {
      const profile = viewProfile(snapshot);
      const previous = byId.get(profile.profileId);
      if (!previous || profile.timestampMs > previous.timestampMs) byId.set(profile.profileId, profile);
    }
    return { username: player.username, uuid: player.uuid,
      profiles: [...byId.values()].sort((a, b) => a.profile.localeCompare(b.profile)) };
  }

  async function loadSkyBlockHistory(username) {
    const db = await getDatabase();
    const player = await findPlayer(db, username);
    if (!player) return { username, snapshots: [] };
    const snapshots = await db.collection('skyblockSnapshots').find({ playerUuid: player.uuid })
      .sort({ fetchedAt: -1, profileId: 1 })
      .project({ _id: 0, playerUuid: 1, profileId: 1, profileName: 1, timestamp: 1, fetchedAt: 1, schemaVersion: 1 }).toArray();
    return { username: player.username, uuid: player.uuid, snapshots: snapshots.map((entry) => ({
      ...entry, fetchedAt: new Date(entry.fetchedAt).toISOString(),
    })) };
  }

  async function loadSkyBlockSnapshot(username, timestamp, profileId) {
    // Keep old minute-based history URLs readable alongside new precise ISO timestamps.
    if (typeof timestamp !== 'string' || !(/^\d{4}-\d{2}-\d{2}--\d{2}--\d{2}$/.test(timestamp)
        || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp))) {
      throw new Error('Invalid snapshot timestamp.');
    }
    const db = await getDatabase();
    const player = await findPlayer(db, username);
    if (!player) return { username, timestamp, snapshots: [] };
    const filter = { playerUuid: player.uuid, timestamp };
    if (profileId) {
      if (!validId(profileId)) throw new Error('Invalid profile ID.');
      filter.profileId = canonicalId(profileId);
    }
    const snapshots = await db.collection('skyblockSnapshots').find(filter).sort({ profileId: 1 }).toArray();
    return { username: player.username, uuid: player.uuid, timestamp,
      snapshots: snapshots.map((entry) => ({ ...viewProfile(entry), profileName: entry.profileName })) };
  }
  return { fetchSkyBlockData, getFetchEligibility, getPlayerFetchTimestamps,
    loadLatestSkyBlockData, loadSkyBlockHistory, loadSkyBlockSnapshot };
}

module.exports = { ...createSkyBlockService(), createSkyBlockService, parseNbtContainer, formatTimestamp };
