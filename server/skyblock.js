const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const nbt = require('prismarine-nbt');

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
function getPlayerFetchTimestamps(username) {
  const playerDirectory = path.join(
    PLAYER_DATA_ROOT,
    safePathComponent(username),
  );

  if (!fs.existsSync(playerDirectory)) {
    return [];
  }

  const timestamps = new Set();

  for (const profileName of fs.readdirSync(playerDirectory, {
    withFileTypes: true,
  })) {
    if (!profileName.isDirectory()) {
      continue;
    }

    const profileDirectory = path.join(
      playerDirectory,
      profileName.name,
    );

    for (const timestampDirectory of fs.readdirSync(profileDirectory, {
      withFileTypes: true,
    })) {
      if (!timestampDirectory.isDirectory()) {
        continue;
      }

      const timestamp = parseTimestampDirectory(timestampDirectory.name);

      if (timestamp !== null) {
        timestamps.add(timestamp);
      }
    }
  }

  return [...timestamps].sort((a, b) => b - a);
}

function getFetchEligibility(username, now = Date.now()) {
  const timestamps = getPlayerFetchTimestamps(username);

  const recentTimestamps = timestamps.filter(
    (timestamp) => now - timestamp < TWENTY_FOUR_HOURS_MS,
  );

  const newestTimestamp = recentTimestamps[0] ?? null;

  if (newestTimestamp !== null) {
    const age = now - newestTimestamp;

    if (age < ONE_HOUR_MS) {
      return {
        allowed: false,
        reason: 'hour',
        newestTimestamp,
        fetchesLast24Hours: recentTimestamps.length,
        retryAfterMs: ONE_HOUR_MS - age,
      };
    }
  }

  if (recentTimestamps.length >= MAX_FETCHES_PER_24_HOURS) {
    const oldestRecentTimestamp =
      recentTimestamps[recentTimestamps.length - 1];

    return {
      allowed: false,
      reason: 'daily',
      newestTimestamp,
      fetchesLast24Hours: recentTimestamps.length,
      retryAfterMs:
        TWENTY_FOUR_HOURS_MS -
        (now - oldestRecentTimestamp),
    };
  }

  return {
    allowed: true,
    reason: null,
    newestTimestamp,
    fetchesLast24Hours: recentTimestamps.length,
    retryAfterMs: 0,
  };
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

  const eligibility = getFetchEligibility(username);

  if (!eligibility.allowed) {
    const error = new Error(
      eligibility.reason === 'hour'
        ? 'This player was fetched less than one hour ago.'
        : 'This player has already been fetched four times within the last 24 hours.',
    );

    error.code =
      eligibility.reason === 'hour'
        ? 'FETCH_TOO_SOON'
        : 'FETCH_DAILY_LIMIT';

    error.retryAfterMs = eligibility.retryAfterMs;
    error.fetchesLast24Hours = eligibility.fetchesLast24Hours;

    throw error;
  }

  const hypixelUrl =
    `https://api.hypixel.net/v2/skyblock/profiles` +
    `?key=${encodeURIComponent(apiKey)}` +
    `&uuid=${encodeURIComponent(uuid)}`;

  let response;

  try {
    response = await fetch(hypixelUrl, {
      headers: {
        'User-Agent': 'SkyAdvisor/1.0',
      },
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    if (
      error.name === 'TimeoutError' ||
      error.name === 'AbortError'
    ) {
      const timeoutError = new Error(
        'Hypixel API request timed out.',
      );

      timeoutError.code = 'HYPIXEL_TIMEOUT';
      throw timeoutError;
    }

    const networkError = new Error(
      'Could not reach the Hypixel API.',
    );

    networkError.code = 'HYPIXEL_NETWORK';
    throw networkError;
  }

  const contentType =
    response.headers.get('content-type') || '';

  if (!contentType.includes('application/json')) {
    const error = new Error(
      'Hypixel returned an unexpected response.',
    );

    error.code = 'HYPIXEL_INVALID_RESPONSE';
    throw error;
  }

  let body;

  try {
    body = await response.json();
  } catch {
    const error = new Error(
      'Hypixel returned invalid JSON.',
    );

    error.code = 'HYPIXEL_INVALID_RESPONSE';
    throw error;
  }

  if (!response.ok || body.success !== true) {
    const error = new Error(
      body.cause || 'Hypixel API request failed.',
    );

    error.code = 'HYPIXEL_API_ERROR';
    throw error;
  }

  if (!Array.isArray(body.profiles)) {
    const error = new Error(
      'Hypixel returned no SkyBlock profiles.',
    );

    error.code = 'NO_PROFILES';
    throw error;
  }

  const timestamp = formatTimestamp();
  const playerDirectory = path.join(
    PLAYER_DATA_ROOT,
    safePathComponent(username),
  );

  const savedProfiles = [];

  for (const profile of body.profiles) {
    const profileName = safePathComponent(
      profile.cute_name || profile.profile_id || 'Unknown',
    );

    const profileDirectory = path.join(
      playerDirectory,
      profileName,
      timestamp,
    );

    const memberData = profile.members?.[uuid];

    const normalized = await buildProfileData(memberData);

    fs.mkdirSync(profileDirectory, {
      recursive: true,
    });

    for (const filename of DATA_FILES) {
      writeJson(
        profileDirectory,
        filename,
        normalized[filename],
      );
    }

    savedProfiles.push({
      profile: profile.cute_name || profile.profile_id || 'Unknown',
      timestamp,
      directory: path.relative(
        path.join(__dirname, '..'),
        profileDirectory,
      ),
    });
  }

  return {
    username,
    uuid,
    timestamp,
    profiles: savedProfiles,
    fetchesLast24Hours:
      getPlayerFetchTimestamps(username).filter(
        (value) => Date.now() - value < TWENTY_FOUR_HOURS_MS,
      ).length,
  };
}

function getLatestTimestampForProfile(profileDirectory) {
  if (!fs.existsSync(profileDirectory)) {
    return null;
  }

  const timestamps = fs.readdirSync(profileDirectory, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      timestamp: parseTimestampDirectory(entry.name),
    }))
    .filter((entry) => entry.timestamp !== null)
    .sort((a, b) => b.timestamp - a.timestamp);

  return timestamps[0] || null;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {
      error: `Could not read ${path.basename(filePath)}`,
    };
  }
}

function loadSnapshot(profileDirectory, timestampName) {
  const timestampDirectory = path.join(
    profileDirectory,
    timestampName,
  );

  const data = {};

  for (const filename of DATA_FILES) {
    const filePath = path.join(
      timestampDirectory,
      `${filename}.json`,
    );

    if (fs.existsSync(filePath)) {
      data[filename] = readJsonFile(filePath);
    } else {
      data[filename] = {};
    }
  }

  return data;
}

function loadLatestSkyBlockData(username) {
  if (!validateUsername(username)) {
    throw new Error('Invalid Minecraft username.');
  }

  const playerDirectory = path.join(
    PLAYER_DATA_ROOT,
    safePathComponent(username),
  );

  if (!fs.existsSync(playerDirectory)) {
    return {
      username,
      profiles: [],
    };
  }

  const profiles = [];

  for (const profileEntry of fs.readdirSync(playerDirectory, {
    withFileTypes: true,
  })) {
    if (!profileEntry.isDirectory()) {
      continue;
    }

    const profileDirectory = path.join(
      playerDirectory,
      profileEntry.name,
    );

    const latest = getLatestTimestampForProfile(
      profileDirectory,
    );

    if (!latest) {
      continue;
    }

    profiles.push({
      profile: profileEntry.name,
      timestamp: latest.name,
      timestampMs: latest.timestamp,
      data: loadSnapshot(
        profileDirectory,
        latest.name,
      ),
    });
  }

  profiles.sort(
    (a, b) => b.timestampMs - a.timestampMs,
  );

  return {
    username,
    profiles,
  };
}



module.exports = {
  fetchSkyBlockData,
  getFetchEligibility,
  getPlayerFetchTimestamps,
  parseNbtContainer,
  formatTimestamp,
  loadLatestSkyBlockData,
};