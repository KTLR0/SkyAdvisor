const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recordedSlot, itemLocation, orderedItems, itemTexture, savedNumber } = require('../client/src/item-display.js');

test('item slot labels distinguish explicit NBT slots from derived saved positions', () => {
  const item = { container: 'Armor', slot: 0, raw: { Slot: 0 } };
  assert.equal(recordedSlot(item), 0);
  assert.equal(itemLocation(item), 'Armor · Slot 0');
  assert.equal(itemLocation({ ...item, raw: {} }), 'Armor · Saved position 1');
  assert.equal(itemLocation({ container: 'Enderchest' }), 'Ender chest · Slot not recorded');
  assert.equal(itemLocation({}), 'Location not recorded · Slot not recorded');
  assert.equal(itemLocation({ slot: 2, raw: { Slot: 3 } }, 'Equipment'), 'Equipment · Saved position 3');
});

test('Armor and Equipment use recorded slot order without mutating source data or inventing slot types', () => {
  const items = [{ id: 'unknown', slot: 0, raw: {} }, { id: 'later', slot: 3, raw: { Slot: 3 } },
    { id: 'first', slot: 0, raw: { Slot: 0 } }];
  const before = structuredClone(items);
  for (const category of ['Armor', 'Equipment']) {
    assert.deepEqual(orderedItems(items, category).map(row => row.id), ['first', 'later', 'unknown']);
  }
  assert.deepEqual(orderedItems(items, 'Inventory'), before);
  assert.deepEqual(items, before);
});

test('item images retain the existing explicit base-ID source and do not guess from names or SkyBlock IDs', () => {
  assert.equal(itemTexture({ minecraftId: 'DIAMOND' }), 'https://mcasset.cloud/1.21.4/assets/minecraft/textures/item/diamond.png');
  for (const minecraftId of [undefined, null, 1, '../diamond', 'https://example.com/item', 'minecraft:diamond']) {
    assert.equal(itemTexture({ minecraftId, name: 'Diamond', id: 'DIAMOND' }), null);
  }
});

test('item counts and pet XP keep real zero without defaulting missing or invalid values', () => {
  assert.equal(savedNumber(0), 0);
  assert.equal(savedNumber(1), 1);
  for (const value of [null, undefined, '0', NaN, Infinity, -1]) assert.equal(savedNumber(value), null);
});
