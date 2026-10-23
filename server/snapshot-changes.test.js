const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareSnapshots } = require('./snapshot-changes');
const { normalizeStoredData } = require('./normalize');
const { skill, collection } = require('./fixtures/timeline');

const data = (xp, amount) => ({ Skills: skill(xp), Collections: collection(amount) });
const entry = (result, category) => result[category].entries[0];

test('confirmed zero is a valid baseline or unchanged total for XP and collection counts', () => {
  const increased = compareSnapshots(data(12.5, 3), data(0, 0));
  assert.equal(entry(increased, 'Skills').delta, 12.5);
  assert.equal(entry(increased, 'Collections').delta, 3);
  const unchanged = compareSnapshots(data(0, 0), data(0, 0));
  for (const name of ['Skills', 'Collections']) {
    assert.equal(entry(unchanged, name).status, 'available');
    assert.equal(entry(unchanged, name).delta, 0);
    assert.equal(entry(unchanged, name).unexpectedDecrease, false);
  }
});

test('missing, private, empty and unavailable categories do not permit arithmetic in either direction', () => {
  for (const name of ['Skills', 'Collections']) {
    for (const status of ['missing', 'private', 'empty', 'unavailable', undefined]) {
      const unreliable = data(100, 10);
      unreliable[name].status = status;
      for (const [current, previous] of [[unreliable, data(0, 0)], [data(0, 0), unreliable]]) {
        const change = entry(compareSnapshots(current, previous), name);
        assert.equal(change.delta, null);
        assert.equal(change.status, 'unavailable');
        assert.equal(change.reason, 'Comparison unavailable.');
      }
    }
  }
});

test('individual missing and invalid values stay unavailable, including in a partial category', () => {
  for (const value of [null, undefined, '0', -1, NaN, Infinity]) {
    const current = data(value, value);
    const changes = compareSnapshots(current, data(0, 0));
    assert.equal(entry(changes, 'Skills').delta, null);
    assert.equal(entry(changes, 'Collections').delta, null);
  }
  const current = data(20, 20);
  current.Skills.status = 'partial';
  current.Skills.entries.push({ id: 'farming', label: 'Farming', xp: null, status: 'missing' });
  const previous = data(10, 10);
  previous.Skills.entries.push({ id: 'farming', label: 'Farming', xp: 1, status: 'available' });
  const changes = compareSnapshots(current, previous);
  assert.equal(changes.Skills.status, 'partial');
  assert.equal(changes.Skills.entries.find(e => e.id === 'mining').delta, 10);
  assert.equal(changes.Skills.entries.find(e => e.id === 'farming').delta, null);
});

test('entries omitted at either date are included as unavailable rather than zero', () => {
  const current = data(20, 20); const previous = data(10, 10);
  current.Collections.entries.push({ id: 'DIAMOND', label: 'Diamond', amount: 5, status: 'available' });
  previous.Collections.entries.push({ id: 'LOG:2', label: 'Birch Log', amount: 8, status: 'available' });
  const changes = compareSnapshots(current, previous);
  assert.equal(changes.Collections.entries.find(e => e.id === 'DIAMOND').delta, null);
  assert.equal(changes.Collections.entries.find(e => e.id === 'LOG:2').delta, null);
  assert.equal(changes.Collections.entries.find(e => e.id === 'WHEAT').delta, 10);
});

test('normalization preserves reliable schema transitions while suppressing ambiguous legacy zero', () => {
  const legacy = normalizeStoredData({ Skills: { mining: 100, farming: 0 }, Collections: { WHEAT: 0 } }, 1);
  const current = normalizeStoredData(data(125, 10), 2);
  current.Skills.entries.push({ id: 'farming', xp: 0, status: 'available' });
  const changes = compareSnapshots(current, legacy);
  assert.equal(changes.Skills.entries.find(e => e.id === 'mining').delta, 25);
  assert.equal(changes.Skills.entries.find(e => e.id === 'farming').delta, null);
  assert.equal(entry(changes, 'Collections').delta, 10);
  const emptyLegacy = normalizeStoredData({ Collections: {} }, 1);
  assert.equal(entry(compareSnapshots(current, emptyLegacy), 'Collections').delta, null);
});

test('decreases retain their signed delta and are explicitly flagged instead of called progress', () => {
  const changes = compareSnapshots(data(0, 5), data(10, 20));
  for (const [name, expected] of [['Skills', -10], ['Collections', -15]]) {
    assert.equal(entry(changes, name).delta, expected);
    assert.equal(entry(changes, name).status, 'decrease');
    assert.equal(entry(changes, name).unexpectedDecrease, true);
    assert.match(entry(changes, name).reason, /Unexpected decrease/);
    assert.equal(changes[name].hasUnexpectedDecreases, true);
  }
});

test('no previous snapshot and duplicate entry IDs cannot produce invented changes', () => {
  const first = compareSnapshots(data(20, 20), null);
  assert.equal(first.Skills.reason, 'No previous snapshot.');
  assert.equal(entry(first, 'Skills').delta, null);
  const duplicated = data(20, 20);
  duplicated.Skills.entries.push({ id: 'mining', xp: 30, status: 'available' });
  assert.equal(entry(compareSnapshots(duplicated, data(10, 10)), 'Skills').delta, null);
  // A third occurrence must remain ambiguous too.
  duplicated.Skills.entries.push({ id: 'mining', xp: 40, status: 'available' });
  assert.equal(entry(compareSnapshots(duplicated, data(10, 10)), 'Skills').delta, null);
});
