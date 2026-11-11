const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProgressionService, validGuide } = require('./progression-service');
const { createMemoryDatabase } = require('./test-support/memory-db');
const { PLAYER_ID, PROFILE_A, PROFILE_B } = require('./fixtures/skyblock');
const { buildProfileData } = require('./normalize');

const guide = (title = 'Obtain the target') => ({ heading: title,
  summary: 'Follow these actions using the provided Wiki reference.',
  steps: [{ title: 'Review requirements', detail: 'Open the linked Wiki and identify the requirements for this item.' },
    { title: 'Gather materials', detail: 'Use the listed location and collection unlocks before crafting.' }],
  options: [{ label: 'Explore the necessary unlocks' }, { label: 'Compare different approaches' },
    { label: 'Plan what to do afterward' }] });

async function setup(mode = 'item', modelImplementation) {
  const memory = createMemoryDatabase();
  const empty = () => ({ status: 'empty', items: [] });
  const data = {
    Skills: { status: 'available', entries: [{ id: 'mining', label: 'Mining', xp: 1000, status: 'available' }] },
    Collections: { status: 'available', entries: [{ id: 'COBBLESTONE', label: 'Cobblestone', amount: 100,
      status: 'available' }] },
    Inventory: { status: 'available', items: [{ id: 'OWNED_PICKAXE', name: 'Owned Pickaxe', slot: 0, count: 1 }] },
    Armor: empty(), Equipment: empty(), Enderchest: empty(), Talismans: empty(), Backpacks: empty(),
    Pets: { status: 'empty', entries: [] },
  };
  await memory.db.collection('skyblockSnapshots').insertOne({ _id: 'latest', playerUuid: PLAYER_ID,
    profileId: PROFILE_A, fetchedAt: new Date('2026-10-23T00:00:00Z'), schemaVersion: 2, data });
  const calls = [];
  const modelClient = { isConfigured: () => true, generate: async input => {
    calls.push(input);
    if (modelImplementation) return modelImplementation(input);
    return input.schema === undefined ? null
      : input.schema.required.includes('targetId') ? { targetId: mode === 'item' ? 'NEW_DRILL' : 'COBBLESTONE' }
        : guide(calls.length > 2 ? 'Explore the selected topic' : 'Start the step-by-step plan');
  } };
  const resources = {
    items: async () => [{ id: 'OWNED_PICKAXE', name: 'Owned Pickaxe', category: 'PICKAXE' },
      { id: 'NEW_DRILL', name: 'Mining Drill', category: 'DRILL', tier: 'RARE', stats: {} }],
    collections: async () => [{ id: 'COBBLESTONE', name: 'Cobblestone', category: 'MINING',
      tiers: [{ tier: 1, amountRequired: 50 }, { tier: 2, amountRequired: 500 }] }],
    wiki: async name => ({ title: name, url: 'https://wiki.hypixel.net/Mining_Drill',
      text: 'The Hypixel SkyBlock Wiki provides detailed prerequisites, crafting methods, and the required items.' }),
  };
  const service = createProgressionService({ getDatabase: async () => memory.db, modelClient, resources });
  return { service, memory, calls, data, resources };
}

test('item start excludes owned gear and records a Wiki-grounded, three-choice guide', async () => {
  const { service, calls } = await setup();
  const result = await service.start(PLAYER_ID, PROFILE_A, 'mining', 'item');
  assert.equal(result.objective.id, 'NEW_DRILL');
  assert.equal(result.objective.verification, 'not_in_complete_saved_inventory');
  assert.equal(result.turns.length, 1);
  assert.deepEqual(result.turns[0].options.map(option => option.id), ['1', '2', '3']);
  assert.ok(!calls[0].input.candidates.some(candidate => candidate.id === 'OWNED_PICKAXE'));
  assert.ok(calls[1].input.wikiExcerpt.includes('Wiki'));
  assert.equal(result.snapshot.skillXp, 1000);
  assert.equal(result.mode, 'item');
});

test('collection start uses verified collection amount and authoritative next tier', async () => {
  const { service } = await setup('collection');
  const result = await service.start(PLAYER_ID, PROFILE_A, 'mining', 'collection');
  assert.equal(result.objective.currentAmount, 100);
  assert.equal(result.objective.nextTier, 2);
  assert.equal(result.objective.targetAmount, 500);
  assert.equal(result.objective.remaining, 400);
});

test('specific collection preserves the exact legacy ID, saved zero, and objective through follow-ups', async () => {
  const { service, memory, calls, resources } = await setup('collection');
  memory.rows('skyblockSnapshots')[0].data.Collections.entries.push({
    id: 'LOG:2', label: 'Birch Log', amount: 0, status: 'available',
  });
  resources.collections = async () => [
    { id: 'LOG', name: 'Oak Wood', category: 'FORAGING', tiers: [{ tier: 1, amountRequired: 10 }] },
    { id: 'LOG:2', name: 'Birch Wood', category: 'FORAGING', tiers: [{ tier: 1, amountRequired: 50 }] },
  ];
  const started = await service.startCollection(PLAYER_ID, PROFILE_A, 'LOG:2');
  assert.equal(started.skill, 'foraging', 'Category comes from official metadata, even without saved skill XP');
  assert.equal(started.mode, 'collection');
  assert.equal(started.objective.id, 'LOG:2');
  assert.equal(started.objective.name, 'Birch Wood');
  assert.equal(started.objective.currentAmount, 0);
  assert.equal(started.objective.remaining, 50);
  assert.equal(started.snapshot.skillXp, null);
  assert.equal(calls.length, 1, 'An explicitly selected objective skips model selection');
  assert.equal(calls[0].input.objective.id, 'LOG:2');
  assert.equal(calls[0].input.objective.targetAmount, 50);
  assert.ok(!Object.hasOwn(calls[0].input, 'candidates'));
  const continued = await service.continueSession(PLAYER_ID, PROFILE_A, started.sessionId, '1');
  assert.deepEqual(continued.objective, started.objective);
  assert.equal(calls[1].input.objective.id, 'LOG:2');
  assert.equal(continued.turns.length, 2);
});

test('specific collections reject malformed or unsupported IDs and never substitute another objective', async () => {
  const { service, calls } = await setup('collection');
  for (const id of ['', 'log:2', '../WHEAT', 12, {}, null]) {
    await assert.rejects(service.startCollection(PLAYER_ID, PROFILE_A, id), { status: 400 });
  }
  await assert.rejects(service.startCollection(PLAYER_ID, PROFILE_A, 'UNKNOWN'), { status: 422 });
  await assert.rejects(service.startCollection(PLAYER_ID, PROFILE_B, 'COBBLESTONE'), { status: 404 });
  assert.equal(calls.length, 0);
});

test('specific collections require reliable saved progress and a published next tier', async () => {
  for (const change of [
    data => { data.Collections.status = 'private'; },
    data => { data.Collections.entries[0].amount = null; },
    data => { data.Collections.entries[0].status = 'unavailable'; },
    data => { data.Collections.entries[0].amount = 500; },
  ]) {
    const { service, memory, calls } = await setup('collection');
    change(memory.rows('skyblockSnapshots')[0].data);
    await assert.rejects(service.startCollection(PLAYER_ID, PROFILE_A, 'COBBLESTONE'), { status: 422 });
    assert.equal(calls.length, 0);
    assert.equal(memory.rows('progressionSessions').length, 0);
  }
});

test('specific collections reject missing metadata and return a safe error during resource outages', async () => {
  const { service, memory, resources, calls } = await setup('collection');
  memory.rows('skyblockSnapshots')[0].data.Collections.entries.push({ id: 'UNKNOWN', amount: 1, status: 'available' });
  await assert.rejects(service.startCollection(PLAYER_ID, PROFILE_A, 'UNKNOWN'), { status: 422 });
  resources.collections = async () => { throw new Error('Provider details'); };
  await assert.rejects(service.startCollection(PLAYER_ID, PROFILE_A, 'COBBLESTONE'), {
    status: 503, safe: true, message: 'Hypixel public collection metadata is temporarily unavailable.',
  });
  assert.equal(calls.length, 0);
});

test('normalized saved multiword pets are excluded before objective selection', async () => {
  const { service, memory, calls } = await setup();
  const normalized = await buildProfileData({ pets_data: { pets: [
    { uuid: 'synthetic-pet', type: 'MITHRIL_GOLEM', tier: 'RARE', exp: 0 },
  ] } });
  const saved = memory.rows('skyblockSnapshots')[0];
  saved.data.Pets = normalized.Pets;
  await service.start(PLAYER_ID, PROFILE_A, 'mining', 'item');
  const candidates = calls[0].input.candidates;
  assert.ok(!candidates.some(candidate => candidate.id === 'PET:MITHRIL_GOLEM'));
  assert.ok(candidates.some(candidate => candidate.id === 'PET:SILVERFISH'));
  // The exclusion must also hold when the player changes the selected profile.
  memory.rows('skyblockSnapshots').push({ ...structuredClone(saved), _id: 'other-profile',
    profileId: PROFILE_B, data: { ...structuredClone(saved.data), Pets: { status: 'empty', entries: [] } } });
  await service.start(PLAYER_ID, PROFILE_B, 'mining', 'item');
  assert.ok(calls[2].input.candidates.some(candidate => candidate.id === 'PET:MITHRIL_GOLEM'));
});

test('follow-up accepts only the last recorded option and preserves prior guide', async () => {
  const { service, calls } = await setup();
  const started = await service.start(PLAYER_ID, PROFILE_A, 'mining', 'item');
  const continued = await service.continueSession(PLAYER_ID, PROFILE_A, started.sessionId, '2');
  assert.equal(continued.turns.length, 2);
  assert.deepEqual(continued.turns[0], started.turns[0]);
  assert.equal(continued.turns[1].choice, 'Compare different approaches');
  assert.equal(calls[2].input.selectedOption, 'Compare different approaches');
  assert.equal(calls[2].input.history.length, 1);
  await assert.rejects(service.continueSession(PLAYER_ID, PROFILE_B, started.sessionId, '1'), { status: 404 });
  await assert.rejects(service.continueSession(PLAYER_ID, PROFILE_A, started.sessionId, 'malicious'), { status: 400 });
});

test('invalid or repeated options fail validation', () => {
  assert.equal(validGuide(guide()), true);
  const duplicate = guide();
  duplicate.options[1].label = duplicate.options[0].label;
  assert.equal(validGuide(duplicate), false);
  assert.equal(validGuide({ ...guide(), options: [] }), false);
});

test('an unavailable inventory does not assert an item is missing', async () => {
  const { service, data } = await setup();
  const memory = createMemoryDatabase();
  const hidden = structuredClone(data);
  for (const name of ['Inventory', 'Armor', 'Equipment', 'Enderchest', 'Talismans', 'Backpacks']) {
    hidden[name] = { status: 'unavailable', reason: 'Not shared', items: [] };
  }
  await memory.db.collection('skyblockSnapshots').insertOne({ _id: 'hidden', playerUuid: PLAYER_ID,
    profileId: PROFILE_A, fetchedAt: new Date(), schemaVersion: 2, data: hidden });
  const replacement = createProgressionService({ getDatabase: async () => memory.db,
    resources: { items: async () => { throw Error('Should not be called.'); } },
    modelClient: { isConfigured: () => true } });
  await assert.rejects(replacement.start(PLAYER_ID, PROFILE_A, 'mining', 'item'), { status: 422 });
  assert.ok(service);
});
