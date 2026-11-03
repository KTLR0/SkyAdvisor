const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeItems, normalizeCollections, itemCandidates, collectionCandidates,
  createProgressionResources, petCandidates, textFromHtml } = require('./progression-resources');

test('public item normalization and ownership filtering are deterministic', () => {
  const source = { success: true, items: Array.from({ length: 30 }, (_, i) => ({
    id: `MINING_DRILL_${i}`, name: `Mining Drill ${i}`, category: 'DRILL', tier: 'RARE',
    stats: { MINING_SPEED: 100 },
  })) };
  const items = normalizeItems(source);
  assert.equal(items.length, 30);
  const pool = itemCandidates(items, 'mining', new Set(['MINING_DRILL_0']), new Set());
  assert.equal(pool.length, 20);
  assert.ok(!pool.some(entry => entry.id === 'MINING_DRILL_0'));
  assert.ok(pool.some(entry => entry.id === 'MINING_DRILL_1'));
});

test('collection tier computation uses resource thresholds and skips unknown amounts', () => {
  const collections = normalizeCollections({ success: true, collections: { MINING: { items: {
    COBBLESTONE: { name: 'Cobblestone', tiers: [
      { tier: 1, amountRequired: 50 }, { tier: 2, amountRequired: 500 },
    ] },
  } } } });
  const next = collectionCandidates(collections, 'mining', new Map([['COBBLESTONE', 100]]));
  assert.equal(next[0].nextTier, 2);
  assert.equal(next[0].remaining, 400);
  assert.deepEqual(collectionCandidates(collections, 'mining', new Map()), []);
});

test('Wiki API response is used as plain text and cached, never treated as HTML instructions', async () => {
  let calls = 0;
  const resources = createProgressionResources({ request: async url => {
    calls++;
    assert.ok(url.startsWith('https://wiki.hypixel.net/api.php?'));
    return { ok: true, json: async () => ({ parse: { title: 'Mining Drill',
      text: '<p>The drill is an item used for mining.</p><h2>Obtaining</h2><p>To obtain this mining drill, collect the specific materials indicated on the official Wiki page and follow the stated in-game crafting instructions.</p>' } }) };
  } });
  const first = await resources.wiki('Mining Drill');
  const second = await resources.wiki('Mining Drill');
  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.ok(first.text.includes('Obtaining'));
  assert.ok(!first.text.includes('<h2>'));
  assert.ok(first.url.startsWith('https://wiki.hypixel.net/'));
});

test('Wiki article page is a fallback when the MediaWiki API rejects the request', async () => {
  let calls = 0;
  const resources = createProgressionResources({ request: async url => {
    calls++;
    if (url.includes('api.php')) return { ok: false };
    assert.equal(url, 'https://wiki.hypixel.net/Mining_Drill');
    return { ok: true, text: async () => `<main><div class="mw-parser-output">
      <h1>Mining Drill</h1><h2>Obtaining</h2><p>Gather the stated materials and meet the documented collection tier requirements before crafting the mining drill on the relevant workbench as described by the Wiki.</p></div></main>` };
  } });
  assert.ok((await resources.wiki('Mining Drill')).text.includes('Obtaining'));
  assert.equal(calls, 2);
});

test('Wiki text strips scripts and decodes entities', () => {
  const result = textFromHtml('<h2>A &amp; B</h2><script>attack();</script><p>Mining &lt; Farming</p>');
  assert.ok(result.includes('A & B'));
  assert.ok(!result.includes('attack'));
  assert.ok(result.includes('Mining < Farming'));
});

test('pet candidates omit species recorded in the saved pet inventory', () => {
  const candidates = petCandidates('mining', new Set(['SILVERFISH']));
  assert.ok(!candidates.some(entry => entry.name === 'Silverfish Pet'));
  assert.ok(candidates.some(entry => entry.name === 'Mithril Golem Pet'));
  assert.ok(candidates.every(entry => entry.id.startsWith('PET:')));
});
