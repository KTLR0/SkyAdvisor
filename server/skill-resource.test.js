const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSkillResourceCache, normalizeSkillResource, CACHE_MS, MAX_STALE_MS, RETRY_MS } = require('./skill-resource');
const { officialSkillsFixture } = require('./fixtures/skill-resource');

test('keeps only complete, strictly increasing official per-skill XP tables', () => {
  const body = officialSkillsFixture();
  body.skills.MINING.levels[2].totalExpRequired = null;
  body.skills.COMBAT.levels[1].level = 1;
  body.skills.FISHING.levels[1].totalExpRequired = 50;
  const resource = normalizeSkillResource(body);
  assert.equal(resource.skills.mining, undefined);
  assert.equal(resource.skills.combat, undefined);
  assert.equal(resource.skills.fishing, undefined);
  assert.equal(resource.skills.foraging.maxLevel, 57);
  assert.equal(resource.skills.runecrafting.levels[1].totalXp, 150);
  assert.throws(() => normalizeSkillResource({ success: true, skills: {} }));
});

test('simultaneous requests share one fetch and valid resource remains cached for 12 hours', async () => {
  let calls = 0, release;
  let time = 1000;
  const cache = createSkillResourceCache({ now: () => time, request: async () => {
    calls++;
    await new Promise(resolve => { release = resolve; });
    return Response.json(officialSkillsFixture());
  } });
  const first = cache.load();
  const second = cache.load();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, await second);
  time += CACHE_MS - 1;
  await cache.load();
  assert.equal(calls, 1);
});

test('expiry refresh is on demand and failure uses bounded, marked-stale cache with retry backoff', async () => {
  let calls = 0, time = 1000;
  const cache = createSkillResourceCache({ now: () => time, request: async () => {
    calls++;
    if (calls > 1) throw new Error('Offline');
    return Response.json(officialSkillsFixture());
  } });
  assert.equal((await cache.load()).stale, false);
  time += CACHE_MS;
  assert.equal(calls, 1, 'No timer fetches data');
  assert.equal((await cache.load()).stale, true);
  assert.equal(calls, 2);
  await cache.load();
  assert.equal(calls, 2);
  time += RETRY_MS;
  await cache.load();
  assert.equal(calls, 3);
  time = 1000 + MAX_STALE_MS + 1;
  await assert.rejects(cache.load(), /temporarily unavailable/);
});

test('an unavailable or invalid first response never manufactures thresholds', async () => {
  for (const response of [new Response(null, { status: 503 }), Response.json({ success: false }),
    Response.json({ success: true, skills: {} })]) {
    const cache = createSkillResourceCache({ request: async () => response });
    await assert.rejects(cache.load(), /temporarily unavailable/);
  }
});

test('an expired resource is replaced only by a successful validated refresh', async () => {
  let time = 1000, calls = 0;
  const cache = createSkillResourceCache({ now: () => time, request: async () => {
    calls++;
    const body = officialSkillsFixture();
    body.version = calls === 1 ? 'fixture-first' : 'fixture-next';
    return Response.json(body);
  } });
  assert.equal((await cache.load()).version, 'fixture-first');
  time += CACHE_MS;
  assert.equal((await cache.load()).version, 'fixture-next');
  assert.equal(calls, 2);
});
