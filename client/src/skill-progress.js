// These are conservative guaranteed caps, not XP curves. XP thresholds always
// come from Hypixel. Above these points, personal unlock/rank data is required.
const UNLOCK_DEPENDENT_CAPS = { farming: 50, taming: 50, foraging: 50, runecrafting: 3 };

function unavailable(reason) {
  return { status: 'unavailable', reason, level: null, percent: null, xpRemaining: null };
}

export function calculateSkillProgress(entry, definition, categoryStatus = 'available') {
  if (['private', 'missing', 'unavailable', 'empty'].includes(categoryStatus)
      || entry?.status !== 'available' || typeof entry.xp !== 'number'
      || !Number.isFinite(entry.xp) || entry.xp < 0) {
    return unavailable(entry?.reason || 'Reliable XP was not provided for this skill.');
  }
  const levels = definition?.levels;
  if (!Number.isInteger(definition?.maxLevel) || definition.maxLevel < 1 || !Array.isArray(levels)
      || levels.length !== definition.maxLevel || levels.some((item, index) => item.level !== index + 1
        || typeof item.totalXp !== 'number' || !Number.isFinite(item.totalXp)
        || item.totalXp <= (index ? levels[index - 1].totalXp : 0))) {
    return unavailable('Official level thresholds are unavailable for this skill.');
  }
  let cap = definition.maxLevel;
  const guaranteedCap = UNLOCK_DEPENDENT_CAPS[entry.id];
  if (entry.levelCap !== undefined && entry.levelCap !== null) {
    if (!Number.isInteger(entry.levelCap) || entry.levelCap < 1 || entry.levelCap > definition.maxLevel) {
      return unavailable('This snapshot contains an unverified level cap.');
    }
    cap = entry.levelCap;
  } else if (guaranteedCap !== undefined) {
    const boundary = levels[guaranteedCap - 1];
    if (!boundary || entry.xp >= boundary.totalXp) {
      return unavailable('Personal level-cap unlocks are not recorded in this snapshot. Further progress cannot be verified.');
    }
    // Below this point every possible personal cap has the same next level.
    cap = Math.min(guaranteedCap, definition.maxLevel);
  }
  if (entry.xp >= levels[cap - 1].totalXp) {
    return { status: 'max', level: cap, nextLevel: null, percent: 100, xpRemaining: 0, cap };
  }
  let level = 0;
  while (level < cap && entry.xp >= levels[level].totalXp) level++;
  const previousXp = level === 0 ? 0 : levels[level - 1].totalXp;
  const nextXp = levels[level].totalXp;
  const xpIntoLevel = entry.xp - previousXp;
  const xpForLevel = nextXp - previousXp;
  return {
    status: 'progress', level, nextLevel: level + 1,
    percent: Math.max(0, Math.min(100, xpIntoLevel / xpForLevel * 100)),
    xpRemaining: Math.max(0, nextXp - entry.xp), xpIntoLevel, xpForLevel,
    cap: entry.levelCap ?? (guaranteedCap ? null : cap),
  };
}

// Rounding must not claim 100% before the next boundary is actually reached.
export function displayPercent(percent) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
    Math.min(99.9, Math.max(0, percent)),
  );
}
