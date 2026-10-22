const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSkillResource } = require('./skill-resource');
const { officialSkillsFixture } = require('./fixtures/skill-resource');
const definitions = normalizeSkillResource(officialSkillsFixture()).skills;
let calculate, displayPercent;
before(async () => {
  ({ calculateSkillProgress: calculate, displayPercent } = await import('../client/src/skill-progress.js'));
});
const entry = (id, xp, extra = {}) => ({ id, xp, status: 'available', ...extra });

test('zero XP is level zero with zero next-level progress, not unavailable', () => {
  const result = calculate(entry('mining', 0), definitions.mining);
  assert.equal(result.level, 0);
  assert.equal(result.percent, 0);
  assert.equal(result.nextLevel, 1);
  assert.equal(result.xpRemaining, 50);
});

test('exact level boundaries advance the level and reset progress', () => {
  for (const threshold of definitions.mining.levels.slice(0, -1)) {
    const result = calculate(entry('mining', threshold.totalXp), definitions.mining);
    assert.equal(result.level, threshold.level);
    assert.equal(result.percent, 0);
    assert.equal(result.nextLevel, threshold.level + 1);
  }
});

test('partial and fractional progress use the XP span of the next level', () => {
  const result = calculate(entry('mining', 112.5), definitions.mining);
  assert.equal(result.level, 1);
  assert.equal(result.xpIntoLevel, 62.5);
  assert.equal(result.xpForLevel, 125);
  assert.equal(result.percent, 50);
  assert.equal(result.xpRemaining, 62.5);
});

test('different skills use their own official curves', () => {
  assert.equal(calculate(entry('mining', 100), definitions.mining).percent, 40);
  assert.equal(calculate(entry('runecrafting', 100, { levelCap: 25 }), definitions.runecrafting).percent, 50);
  assert.equal(calculate(entry('social', 225), definitions.social).percent, 50);
});

test('the applicable cap is maxed at and beyond its exact threshold', () => {
  for (const xp of [111672425, 111672425 + 1000000]) {
    const result = calculate(entry('mining', xp), definitions.mining);
    assert.equal(result.status, 'max');
    assert.equal(result.level, 60);
    assert.equal(result.percent, 100);
    assert.equal(result.xpRemaining, 0);
    assert.equal(result.nextLevel, null);
  }
  const result = calculate(entry('farming', 55172425, { levelCap: 50 }), definitions.farming);
  assert.equal(result.level, 50);
  assert.equal(result.status, 'max');
});

test('unknown personal unlocks do not become zero upgrades or an assumed global cap', () => {
  assert.equal(calculate(entry('farming', 0), definitions.farming).status, 'progress');
  for (const id of ['farming', 'taming', 'foraging']) {
    const result = calculate(entry(id, definitions[id].levels[49].totalXp), definitions[id]);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.percent, null);
  }
  assert.equal(calculate(entry('runecrafting', 275), definitions.runecrafting).status, 'unavailable');
  assert.equal(calculate(entry('farming', 55172425, { levelCap: 60 }), definitions.farming).status, 'progress');
});

test('invalid, missing, private, and legacy-unreliable XP never produce percentages', () => {
  for (const xp of [null, undefined, NaN, Infinity, -1, '50']) {
    assert.equal(calculate(entry('mining', xp), definitions.mining).percent, null);
  }
  for (const status of ['missing', 'private', 'unavailable']) {
    const result = calculate(entry('mining', 0, { status }), definitions.mining);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.percent, null);
  }
  assert.equal(calculate(entry('mining', 50), definitions.mining, 'private').percent, null);
});

test('missing or malformed thresholds/caps are not interpolated or guessed', () => {
  for (const definition of [undefined, { ...definitions.mining, levels: [] },
    { ...definitions.mining, levels: [{ level: 1, totalXp: 0 }] }]) {
    assert.equal(calculate(entry('mining', 20), definition).percent, null);
  }
  for (const levelCap of [0, 61, 1.5, '50']) {
    assert.equal(calculate(entry('mining', 20, { levelCap }), definitions.mining).percent, null);
  }
});

test('percentages stay bounded and just-below-boundary text does not round up to 100%', () => {
  const result = calculate(entry('mining', 49.9999), definitions.mining);
  assert.ok(result.percent >= 0 && result.percent < 100);
  assert.equal(displayPercent(result.percent), '99.9');
  assert.ok(result.xpRemaining > 0);
});

test('switching profile XP recalculates the same skill without retained progress state', () => {
  const apple = calculate(entry('mining', 100), definitions.mining);
  const banana = calculate(entry('mining', 150), definitions.mining);
  assert.equal(apple.percent, 40);
  assert.equal(banana.percent, 80);
  assert.equal(calculate(entry('mining', null, { status: 'missing' }), definitions.mining).percent, null);
});
