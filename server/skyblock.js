const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const nbt = require('prismarine-nbt');
const { getDatabase } = require('./database');

const PLAYER_DATA_ROOT = path.join(__dirname, '..', 'PlayerData');

const ONE_HOUR_MS = 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * ONE_HOUR_MS;
const MAX_FETCHES_PER_24_HOURS = 4;

const UUID_PATTERN = /^[a-f0-9]{32}$/i;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

const DATA_FILES = [
  'Armor',
  'Backpacks',
  'Collections',
  'Enderchest',
  'Equipment',
  'Inventory',
  'Skills',
  'Talismans',
  'Pets',
];

function validateUuid(uuid) {
  return typeof uuid === 'string' && UUID_PATTERN.test(uuid);
}

function validateUsername(username) {
  return typeof username === 'string' && USERNAME_PATTERN.test(username);
}

function safePathComponent(value) {
  return String(value)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+$/, '_');
}

function formatTimestamp(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');

  return `${year}-${month}-${day}--${hour}--${minute}`;
}

function parseTimestampDirectory(name) {
  const match = /^(\d{4})-(\d{2})-(\d{2})--(\d{2})--(\d{2})$/.exec(name);

  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute] = match;

  const timestamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return timestamp;
}

/**
 * Find all unique fetch timestamps belonging to a player.
 *
 * Timestamps are stored once per profile, so we deduplicate them here.
 * This makes the four-fetch limit apply to the player rather than
 * accidentally counting a single fetch multiple times because the
 * player has multiple SkyBlock profiles.
 */
async function getPlayerFetchTimestamps(uuid) {
  const db = await getDatabase();
  const events = await db.collection('fetchEvents')
    .find({ playerUuid: uuid, fetchedAt: { $gte: new Date(Date.now() - TWENTY_FOUR_HOURS_MS) } })
    .sort({ fetchedAt: -1 })
    .project({ fetchedAt: 1, _id: 0 })
    .toArray();
  return events.map((event) => event.fetchedAt.getTime());
}

async function getFetchEligibility(uuid, now = Date.now()) {
  const db = await getDatabase();
  const recentTimestamps = await db.collection('fetchEvents')
    .find({ playerUuid: uuid, fetchedAt: { $gte: new Date(now - TWENTY_FOUR_HOURS_MS) } })
    .sort({ fetchedAt: -1 })
    .project({ fetchedAt: 1, _id: 0 })
    .toArray();
  const timestamps = recentTimestamps.map((event) => event.fetchedAt.getTime());
  const newestTimestamp = timestamps[0] ?? null;

  if (newestTimestamp !== null && now - newestTimestamp < ONE_HOUR_MS) {
    return { allowed: false, reason: 'hour', newestTimestamp, fetchesLast24Hours: timestamps.length, retryAfterMs: ONE_HOUR_MS - (now - newestTimestamp) };
  }
  if (timestamps.length >= MAX_FETCHES_PER_24_HOURS) {
    const oldest = timestamps[timestamps.length - 1];
    return { allowed: false, reason: 'daily', newestTimestamp, fetchesLast24Hours: timestamps.length, retryAfterMs: TWENTY_FOUR_HOURS_MS - (now - oldest) };
  }
  return { allowed: true, reason: null, newestTimestamp, fetchesLast24Hours: timestamps.length, retryAfterMs: 0 };
}

/**
 * Hypixel returns NBT containers encoded as base64.
 *
 * Most SkyBlock containers are gzip-compressed. A raw NBT fallback is
 * included so the parser is not unnecessarily dependent on gzip.
 */
async function parseNbtContainer(base64String) {
  if (!base64String) {
    return {};
  }

  try {
    const buffer = Buffer.from(base64String, 'base64');

    let decoded;

    try {
      decoded = zlib.gunzipSync(buffer);
    } catch {
      decoded = buffer;
    }

    const { parsed } = await nbt.parse(decoded);

    return nbt.simplify(parsed);
  } catch (error) {
    return {
      error: 'Failed to decode NBT container',
      message: error.message,
    };
  }
}

async function parseInventoryContainer(container) {
  return parseNbtContainer(container?.data);
}

function createEmptyProfileData() {
  return {
    Armor: {},
    Backpacks: {},
    Collections: {},
    Enderchest: {},
    Equipment: {},
    Inventory: {},
    Skills: {},
    Talismans: {},
    Pets: {},
  };
}

function buildProfileData(memberData) {
  const data = createEmptyProfileData();

  if (!memberData) {
    return data;
  }

  return Promise.all([
    parseInventoryContainer(memberData.inventory?.inv_armor)
      .then((value) => {
        data.Armor = value;
      }),

    parseInventoryContainer(memberData.inventory?.equipment_contents)
      .then((value) => {
        data.Equipment = value;
      }),

    parseInventoryContainer(memberData.inventory?.inv_contents)
      .then((value) => {
        data.Inventory = value;
      }),

    parseInventoryContainer(memberData.inventory?.ender_chest_contents)
      .then((value) => {
        data.Enderchest = value;
      }),

    parseInventoryContainer(memberData.inventory?.talisman_bag)
      .then((value) => {
        data.Talismans = value;
      }),

    (async () => {
      const backpacks = {};

      if (memberData.inventory?.backpack_contents) {
        for (const [slot, container] of Object.entries(
          memberData.inventory.backpack_contents,
        )) {
          backpacks[`backpack_${slot}`] =
            await parseInventoryContainer(container);
        }
      }

      data.Backpacks = backpacks;
    })(),

    (async () => {
      const experience =
        memberData.player_data?.experience || {};

      data.Skills = {
        farming: experience.SKILL_FARMING || 0,
        mining: experience.SKILL_MINING || 0,
        combat: experience.SKILL_COMBAT || 0,
        foraging: experience.SKILL_FORAGING || 0,
        fishing: experience.SKILL_FISHING || 0,
        enchanting: experience.SKILL_ENCHANTING || 0,
        alchemy: experience.SKILL_ALCHEMY || 0,
        taming: experience.SKILL_TAMING || 0,
      };
    })(),

    (async () => {
      data.Collections =
        memberData.collection_data?.collection || {};
    })(),

    (async () => {
      data.Pets =
        memberData.pets_data?.pets ||
        memberData.pet_data?.pets ||
        [];
    })(),
  ]).then(() => data);
}

function writeJson(directory, filename, value) {
  fs.writeFileSync(
    path.join(directory, `${filename}.json`),
    JSON.stringify(value, null, 2),
    'utf8',
  );
}

async function fetchSkyBlockData({
  username,
  uuid,
  apiKey,
}) {
  if (!validateUsername(username)) {
    throw new Error('Invalid Minecraft username.');
  }

  if (!validateUuid(uuid)) {
    throw new Error('Invalid Minecraft UUID.');
  }

  if (!apiKey) {
    throw new Error('Hypixel API key is not configured.');
  }

  const db = await getDatabase();
  const players = db.collection('players');
  const snapshots = db.collection('skyblockSnapshots');
  const events = db.collection('fetchEvents');
  const locks = db.collection('fetchLocks');
  const playerUuid = uuid.toLowerCase();

  // A unique per-player lock prevents concurrent requests from bypassing the
  // fetch limit. Expiration is a crash-recovery backstop, not polling.
  try {
    await locks.insertOne({ _id: playerUuid, createdAt: new Date() });
  } catch (error) {
    if (error.code === 11000) {
      const locked = new Error('A SkyBlock fetch is already in progress for this player.');
      locked.code = 'FETCH_IN_PROGRESS';
      throw locked;
    }
    throw error;
  }

  try {
    const eligibility = await getFetchEligibility(playerUuid);
    if (!eligibility.allowed) {
      const error = new Error(
        eligibility.reason === 'hour'
          ? 'This player was fetched less than one hour ago.'
          : 'This player has already been fetched four times within the last 24 hours.',
      );
      error.code = eligibility.reason === 'hour' ? 'FETCH_TOO_SOON' : 'FETCH_DAILY_LIMIT';
      error.retryAfterMs = eligibility.retryAfterMs;
      error.fetchesLast24Hours = eligibility.fetchesLast24Hours;
      throw error;
    }

    const hypixelUrl = `https://api.hypixel.net/v2/skyblock/profiles?key=${encodeURIComponent(apiKey)}&uuid=${encodeURIComponent(uuid)}`;
    let response;
    try {
      response = await fetch(hypixelUrl, {
        headers: { 'User-Agent': 'SkyAdvisor/1.0' },
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      const wrapped = new Error(error.name === 'TimeoutError' || error.name === 'AbortError' ? 'Hypixel API request timed out.' : 'Could not reach the Hypixel API.');
      wrapped.code = error.name === 'TimeoutError' || error.name === 'AbortError' ? 'HYPIXEL_TIMEOUT' : 'HYPIXEL_NETWORK';
      throw wrapped;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const error = new Error('Hypixel returned an unexpected response.');
      error.code = 'HYPIXEL_INVALID_RESPONSE';
      throw error;
    }

    let body;
    try { body = await response.json(); } catch {
      const error = new Error('Hypixel returned invalid JSON.');
      error.code = 'HYPIXEL_INVALID_RESPONSE';
      throw error;
    }
    if (!response.ok || body.success !== true) {
      const error = new Error(body.cause || 'Hypixel API request failed.');
      error.code = 'HYPIXEL_API_ERROR';
      throw error;
    }
    if (!Array.isArray(body.profiles) || body.profiles.length === 0) {
      const error = new Error('Hypixel returned no SkyBlock profiles.');
      error.code = 'NO_PROFILES';
      throw error;
    }

    const fetchedAt = new Date();
    const timestamp = formatTimestamp(fetchedAt);
    const savedProfiles = [];
    const snapshotDocuments = [];

    for (const profile of body.profiles) {
      const profileId = String(profile.profile_id || profile.cute_name || 'Unknown');
      const profileName = String(profile.cute_name || profile.profile_id || 'Unknown');
      const normalized = await buildProfileData(profile.members?.[uuid] || profile.members?.[playerUuid]);
      const document = {
        playerUuid,
        username,
        profileId,
        profileName,
        fetchedAt,
        timestamp,
        schemaVersion: 1,
        data: normalized,
      };
      snapshotDocuments.push(document);
      savedProfiles.push({ profile: profileName, profileId, timestamp });
    }

    await players.updateOne(
      { uuid: playerUuid },
      { $set: { username, lastFetchedAt: fetchedAt }, $setOnInsert: { uuid: playerUuid, createdAt: fetchedAt } },
      { upsert: true },
    );
    await snapshots.insertMany(snapshotDocuments);
    await events.insertOne({ playerUuid, username, fetchedAt, profileCount: snapshotDocuments.length });

    return {
      username,
      uuid: playerUuid,
      timestamp,
      profiles: savedProfiles,
      fetchesLast24Hours: (await getPlayerFetchTimestamps(playerUuid)).length,
    };
  } finally {
    await locks.deleteOne({ _id: playerUuid }).catch(() => {});
  }
}

async function loadLatestSkyBlockData(username) {
  if (!validateUsername(username)) throw new Error('Invalid Minecraft username.');
  const db = await getDatabase();
  const players = db.collection('players');
  const snapshots = db.collection('skyblockSnapshots');
  const player = await players.findOne({ username: { $regex: `^${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
  if (!player) return { username, profiles: [] };

  const latestByProfile = await snapshots.aggregate([
    { $match: { playerUuid: player.uuid } },
    { $sort: { fetchedAt: -1 } },
    { $group: { _id: '$profileId', snapshot: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$snapshot' } },
    { $sort: { fetchedAt: -1 } },
  ]).toArray();

  return {
    username: player.username,
    profiles: latestByProfile.map((snapshot) => ({
      profile: snapshot.profileName,
      profileId: snapshot.profileId,
      timestamp: snapshot.timestamp,
      timestampMs: snapshot.fetchedAt.getTime(),
      data: snapshot.data,
    })),
  };
}

async function loadSkyBlockHistory(username) {
  if (!validateUsername(username)) throw new Error('Invalid Minecraft username.');
  const db = await getDatabase();
  const player = await db.collection('players').findOne({ username: { $regex: `^${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
  if (!player) return { username, snapshots: [] };
  const snapshots = await db.collection('skyblockSnapshots')
    .find({ playerUuid: player.uuid })
    .sort({ fetchedAt: -1 })
    .project({ _id: 0, profileId: 1, profileName: 1, timestamp: 1, fetchedAt: 1 })
    .toArray();
  return { username: player.username, snapshots: snapshots.map((snapshot) => ({ ...snapshot, fetchedAt: snapshot.fetchedAt.toISOString() })) };
}

module.exports = {
  fetchSkyBlockData,
  getFetchEligibility,
  getPlayerFetchTimestamps,
  loadSkyBlockHistory,
  parseNbtContainer,
  formatTimestamp,
  loadLatestSkyBlockData,
};