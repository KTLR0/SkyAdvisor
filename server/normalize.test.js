const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildProfileData, normalizeStoredData, parseNbtContainer } = require('./normalize');
const { profilesReply, PLAYER_ID, encodedInventory } = require('./fixtures/skyblock');

const skill = (data, id) => data.Skills.entries.find((entry) => entry.id === id);

test('normalizes the current skills/collection mapping without inventing zero', async () => {
  const data = await buildProfileData(profilesReply().profiles[0].members[PLAYER_ID]);
  assert.equal(skill(data, 'farming').xp, 0);
  assert.equal(skill(data, 'farming').status, 'available');
  assert.equal(skill(data, 'mining').xp, 12345.5);
  assert.equal(skill(data, 'fishing').xp, null);
  assert.equal(skill(data, 'fishing').status, 'missing');
  assert.equal(data.Collections.entries.find((entry) => entry.id === 'WHEAT').amount, 0);
  assert.equal(data.Collections.entries.find((entry) => entry.id === 'COBBLESTONE').amount, 1456);
  assert.equal(data.Pets.entries[0].xp, 0);
});

test('supports nested collection and legacy skill fields and malformed scalar values', async () => {
  const data = await buildProfileData({ collection_data: { collection: { WHEAT: 32, BAD: '42' } },
    experience_skill_farming: 0, player_data: { experience: { SKILL_MINING: -1, SKILL_COMBAT: NaN } } });
  assert.equal(data.Collections.status, 'partial');
  assert.equal(data.Collections.entries.find((entry) => entry.id === 'WHEAT').amount, 32);
  assert.equal(data.Collections.entries.find((entry) => entry.id === 'BAD').amount, null);
  assert.equal(skill(data, 'farming').xp, 0);
  assert.equal(skill(data, 'mining').xp, null);
  assert.equal(skill(data, 'combat').xp, null);
});

test('distinguishes private, missing, empty, and undecodable inventories', async () => {
  const missing = await buildProfileData({});
  assert.equal(missing.Inventory.status, 'missing');
  assert.equal(missing.Collections.status, 'missing');
  const privateData = await buildProfileData({ api_settings: { skills: false, collection: false, inv_contents: false } });
  assert.equal(privateData.Skills.status, 'private');
  assert.equal(privateData.Collections.status, 'private');
  assert.equal(privateData.Inventory.status, 'private');
  const empty = await buildProfileData({ collection: {}, inventory: { inv_contents: { data: encodedInventory(false) } } });
  assert.equal(empty.Collections.status, 'empty');
  assert.equal(empty.Inventory.status, 'empty');
  const malformed = await parseNbtContainer(Buffer.from('not NBT').toString('base64'));
  assert.equal(malformed.status, 'unavailable');
});

test('decodes compressed item NBT and preserves slot, count, lore, and advanced details', async () => {
  const data = await buildProfileData(profilesReply().profiles[0].members[PLAYER_ID]);
  const item = data.Inventory.items[0];
  assert.equal(item.name, 'Fixture Diamond');
  assert.equal(item.id, 'DIAMOND');
  assert.equal(item.minecraftId, 'diamond');
  assert.equal(item.count, 3);
  assert.equal(item.slot, 0);
  assert.deepEqual(item.lore, ['A representative test item']);
  assert.equal(item.raw.Count, 3);
  assert.equal(data.Backpacks.items[0].container, 'Backpack 0');
});

test('old snapshots are adapted without rewriting them or trusting ambiguous zeros', () => {
  const old = { Skills: { farming: 0, mining: 80 }, Collections: {}, Inventory: { i: [] } };
  const before = structuredClone(old);
  const data = normalizeStoredData(old, 1);
  assert.equal(skill(data, 'farming').xp, null);
  assert.equal(skill(data, 'farming').status, 'unavailable');
  assert.equal(skill(data, 'mining').xp, 80);
  assert.equal(data.Collections.status, 'unavailable');
  assert.equal(data.Inventory.status, 'empty');
  assert.deepEqual(old, before);
});

test('an incomplete v2 record still has predictable category lists and availability states', () => {
  const data = normalizeStoredData({ Skills: null }, 2);
  assert.equal(data.Skills.status, 'unavailable');
  assert.deepEqual(data.Skills.entries, []);
  assert.deepEqual(data.Inventory.items, []);
  assert.deepEqual(data.Collections.entries, []);
});

test('distinct legacy wood collections retain their IDs, amounts, and unambiguous names on fresh and saved reads', async () => {
  const data = await buildProfileData({ collection: { 'LOG:2': 10, LOG_2: 20 } });
  const birch = data.Collections.entries.find((entry) => entry.id === 'LOG:2');
  const acacia = data.Collections.entries.find((entry) => entry.id === 'LOG_2');
  assert.equal(birch.label, 'Birch Log');
  assert.equal(acacia.label, 'Acacia Log');
  assert.equal(birch.amount, 10);
  assert.equal(acacia.amount, 20);
  const oldV2 = { Collections: { status: 'available', reason: null, entries: [
    { id: 'LOG:2', label: 'Log 2', amount: 10 }, { id: 'LOG_2', label: 'Log 2', amount: 20 },
  ] } };
  const read = normalizeStoredData(oldV2, 2);
  assert.deepEqual(read.Collections.entries.map((entry) => entry.label), ['Birch Log', 'Acacia Log']);
  assert.deepEqual(read.Collections.entries.map((entry) => entry.amount), [10, 20]);
  assert.equal(oldV2.Collections.entries[0].label, 'Log 2');
});
