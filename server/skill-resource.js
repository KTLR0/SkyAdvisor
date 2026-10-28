const SOURCE = 'https://api.hypixel.net/v2/resources/skyblock/skills';
const CACHE_MS = 12 * 60 * 60 * 1000;
const MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;

function normalizeSkillResource(body) {
  if (body?.success !== true || !body.skills || typeof body.skills !== 'object') {
    throw new Error('Invalid Hypixel Skills resource.');
  }
  const skills = {};
  for (const [id, skill] of Object.entries(body.skills)) {
    if (!Number.isInteger(skill?.maxLevel) || skill.maxLevel < 1 || skill.maxLevel > 1000
        || !Array.isArray(skill.levels)) continue;
    const levels = skill.levels.map((entry) => ({ level: entry.level, totalXp: entry.totalExpRequired }))
      .sort((a, b) => a.level - b.level);
    // Reject gaps/duplicates and non-increasing or missing thresholds. Never interpolate them.
    if (levels.length !== skill.maxLevel || levels.some((entry, index) => entry.level !== index + 1
        || typeof entry.totalXp !== 'number' || !Number.isFinite(entry.totalXp)
        || entry.totalXp <= (index ? levels[index - 1].totalXp : 0))) continue;
    skills[id.toLowerCase()] = { name: skill.name, maxLevel: skill.maxLevel, levels };
  }
  if (!Object.keys(skills).length) throw new Error('No valid skill thresholds were provided.');
  return { source: SOURCE, version: typeof body.version === 'string' ? body.version : null,
    lastUpdated: Number.isFinite(body.lastUpdated) ? body.lastUpdated : null, skills };
}

function createSkillResourceCache({ request = (...args) => globalThis.fetch(...args), now = Date.now } = {}) {
  let cached = null;
  let fetchedAt = 0;
  let retryAt = 0;
  let pending = null;
  const result = () => ({ ...cached, fetchedAt: new Date(fetchedAt).toISOString(), stale: now() - fetchedAt >= CACHE_MS });

  async function load() {
    if (cached && now() - fetchedAt < CACHE_MS) return result();
    if (pending) return pending;
    if (now() < retryAt) {
      if (cached && now() - fetchedAt <= MAX_STALE_MS) return result();
      throw new Error('Skill thresholds are temporarily unavailable.');
    }
    pending = (async () => {
      try {
        const response = await request(SOURCE, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error('Hypixel Skills resource request failed.');
        const next = normalizeSkillResource(await response.json());
        cached = next;
        fetchedAt = now();
        retryAt = 0;
        return result();
      } catch {
        retryAt = now() + RETRY_MS;
        if (cached && now() - fetchedAt <= MAX_STALE_MS) return result();
        throw new Error('Skill thresholds are temporarily unavailable.');
      }
    })();
    try { return await pending; } finally { pending = null; }
  }
  // Recommendations may reuse existing metadata, but must never fetch it.
  function peek() {
    return cached && now() - fetchedAt <= MAX_STALE_MS ? result() : null;
  }
  return { load, peek };
}

const cache = createSkillResourceCache();
module.exports = { getSkillResource: cache.load, peekSkillResource: cache.peek, createSkillResourceCache, normalizeSkillResource,
  CACHE_MS, MAX_STALE_MS, RETRY_MS };
