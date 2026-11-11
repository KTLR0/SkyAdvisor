const { test } = require('node:test');
const assert = require('node:assert/strict');
const { collectionCategory, groupCollections, savedCount } = require('../client/src/collection-groups.js');

const entry = (id, label, amount, extra = {}) => ({ id, label, amount, status: 'available', ...extra });
const data = entries => ({ status: 'available', entries });

test('Collections grouping uses exact verified variants and preserves saved categories', () => {
  assert.equal(collectionCategory(entry('LOG:2', 'Birch Log', 0)).key, 'FORAGING');
  assert.equal(collectionCategory(entry('INK_SACK:3', 'Cocoa Beans', 0)).key, 'FARMING');
  assert.equal(collectionCategory(entry('INK_SACK:4', 'Lapis Lazuli', 0)).key, 'MINING');
  assert.equal(collectionCategory(entry('INK_SACK', 'Ink Sac', 0)).key, 'FISHING');
  assert.equal(collectionCategory(entry('LOG:99', 'Birch Log', 0)).key, '', 'Names and prefixes cannot guess category membership');
  assert.deepEqual(collectionCategory(entry('CUSTOM', 'Custom', 0, { category: 'Building' })), { key: 'BUILDING', name: 'Building' });
});

test('Collections search is case insensitive and name-based without mutating saved entries', () => {
  const saved = data([entry('LOG:1', 'Spruce Log', 5), entry('LOG:2', 'Birch Log', 0)]);
  const before = structuredClone(saved);
  assert.deepEqual(groupCollections(saved, ' BIRCH ')[0].entries.map(row => row.id), ['LOG:2']);
  assert.deepEqual(groupCollections(saved, 'LOG:2'), [], 'Search matches names, not internal IDs');
  assert.deepEqual(saved, before);
});

test('Collections count sorting is numeric, preserves zero and places unknown counts last', () => {
  const saved = data([entry('COAL', 'Coal', 9), entry('DIAMOND', 'Diamond', 100), entry('EMERALD', 'Emerald', 0),
    entry('IRON_INGOT', 'Iron Ingot', null, { status: 'unavailable' })]);
  assert.deepEqual(groupCollections(saved, '', 'count-desc')[0].entries.map(row => row.amount), [100, 9, 0, null]);
  assert.deepEqual(groupCollections(saved, '', 'count-asc')[0].entries.map(row => row.amount), [0, 9, 100, null]);
  assert.deepEqual(groupCollections(saved, '', 'name-desc')[0].entries.map(row => row.label), ['Iron Ingot', 'Emerald', 'Diamond', 'Coal']);
});

test('Collections sort within real groups and place unclassified entries last', () => {
  const saved = data([entry('UNKNOWN', 'Unknown', 999), entry('WHEAT', 'Wheat', 0), entry('DIAMOND', 'Diamond', 9)]);
  assert.deepEqual(groupCollections(saved, '', 'count-desc').map(group => group.name), ['Farming', 'Mining', 'Category unavailable']);
});

test('Collections never turn private, missing or unreliable counts into zero', () => {
  const row = entry('WHEAT', 'Wheat', 0);
  assert.equal(savedCount(row, data([row])), 0);
  for (const status of ['private', 'missing', 'unavailable', 'empty']) {
    const saved = { status, entries: [row] };
    assert.equal(savedCount(row, saved), null);
    assert.deepEqual(groupCollections(saved), []);
  }
  for (const amount of [null, undefined, NaN, Infinity, -1, '0']) {
    assert.equal(savedCount({ ...row, amount }, data([row])), null);
  }
  assert.equal(savedCount({ ...row, status: 'unavailable' }, data([row])), null);
});
