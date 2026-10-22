const nbt = require('prismarine-nbt');

const SKILLS = ['farming', 'mining', 'combat', 'foraging', 'fishing', 'enchanting',
  'alchemy', 'taming', 'carpentry', 'runecrafting', 'social'];
const INVENTORIES = {
  Armor: 'inv_armor', Equipment: 'equipment_contents', Inventory: 'inv_contents',
  Enderchest: 'ender_chest_contents', Talismans: 'talisman_bag',
};
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = (id) => String(id).replaceAll('_', ' ').replaceAll(':', ' ')
  .toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
const cleanText = (value) => String(value ?? '').replace(/§[0-9a-fk-or]/gi, '');
// Legacy wood IDs are distinct items, not interchangeable spelling variants.
// Names verified against Hypixel's public SkyBlock collection definitions.
const COLLECTION_LABELS = {
  LOG: 'Oak Log', 'LOG:1': 'Spruce Log', 'LOG:2': 'Birch Log', 'LOG:3': 'Jungle Log',
  LOG_2: 'Acacia Log', 'LOG_2:1': 'Dark Oak Log',
};
const collectionLabel = (id) => COLLECTION_LABELS[id] || (String(id).includes(':')
  ? `${label(String(id).split(':')[0])} (variant ${String(id).split(':').slice(1).join(':')})` : label(id));

function section(status, reason = null, entries = []) {
  return { status, reason, entries };
}

function normalizeSkills(member, legacy = false) {
  if (member.api_settings?.skills === false) return section('private', 'Skill API sharing is disabled.');
  const experience = member.player_data?.experience;
  const entries = SKILLS.map((id) => {
    const value = experience?.[`SKILL_${id.toUpperCase()}`] ?? member[`experience_skill_${id}`];
    const ambiguous = legacy && value === 0;
    return {
      id, label: label(id), xp: number(value) && !ambiguous ? value : null,
      status: ambiguous ? 'unavailable' : number(value) ? 'available' : 'missing',
      reason: ambiguous ? 'This older snapshot cannot distinguish zero from missing XP.'
        : number(value) ? null : 'XP was not provided by the API.',
    };
  });
  const available = entries.filter((entry) => entry.status === 'available').length;
  return section(available === entries.length ? 'available' : available ? 'partial' : 'missing',
    available === entries.length ? null : 'Some skill XP is unavailable. Missing XP is not counted as zero.', entries);
}

function normalizeCollections(member) {
  if (member.api_settings?.collection === false || member.api_settings?.collections === false) {
    return section('private', 'Collection API sharing is disabled.');
  }
  // Support the current member field and the nested shape used by older exports.
  const source = member.collection ?? member.collection_data?.collection;
  if (!object(source)) return section('missing', 'Collection counts were not provided by the API.');
  const entries = Object.entries(source).map(([id, value]) => ({
    id, label: collectionLabel(id), amount: number(value) ? value : null,
    status: number(value) ? 'available' : 'unavailable',
  })).sort((a, b) => a.label.localeCompare(b.label));
  return section(!entries.length ? 'empty' : entries.some((entry) => entry.amount === null)
    ? 'partial' : 'available', null, entries);
}

function normalizeItem(raw, index, container) {
  const vanillaId = raw.id ?? raw.ID ?? raw.item_id;
  const id = raw.tag?.ExtraAttributes?.id ?? vanillaId;
  let name = raw.tag?.display?.Name ?? raw.display?.Name ?? raw.name ?? id ?? 'Unknown item';
  // Newer Minecraft text components may be JSON; keep ordinary legacy names too.
  if (typeof name === 'string' && name.startsWith('{')) {
    try { const text = JSON.parse(name); name = text.text || name; } catch { /* Plain name. */ }
  }
  return {
    slot: Number.isInteger(raw.Slot) ? raw.Slot : index,
    id: String(id ?? 'unknown'),
    minecraftId: typeof vanillaId === 'string' ? vanillaId.replace(/^minecraft:/, '') : null,
    name: cleanText(name), count: number(raw.Count ?? raw.count) ? (raw.Count ?? raw.count) : null,
    lore: Array.isArray(raw.tag?.display?.Lore) ? raw.tag.display.Lore.map(cleanText) : [],
    container, raw,
  };
}

function inventorySection(status, reason = null, items = []) {
  return { status, reason, items };
}

function normalizeDecodedInventory(decoded, container = 'Inventory') {
  if (!object(decoded) || !Array.isArray(decoded.i)) {
    return inventorySection('unavailable', 'The saved inventory could not be decoded.');
  }
  const items = decoded.i.flatMap((raw, index) => {
    if (!object(raw) || !Object.keys(raw).length || raw.id === 0 || raw.id === 'minecraft:air') return [];
    return [normalizeItem(raw, index, container)];
  });
  return inventorySection(items.length ? 'available' : 'empty', null, items);
}

async function parseNbtContainer(encoded, container = 'Inventory') {
  if (typeof encoded !== 'string' || !encoded) {
    return inventorySection('missing', 'This inventory was not provided. API sharing may be disabled.');
  }
  try {
    // prismarine-nbt detects gzip as well as uncompressed NBT.
    const { parsed } = await nbt.parse(Buffer.from(encoded, 'base64'));
    return normalizeDecodedInventory(nbt.simplify(parsed), container);
  } catch {
    return inventorySection('unavailable', 'This inventory could not be decoded. Try fetching fresh data.');
  }
}

function normalizePets(source) {
  if (!Array.isArray(source)) return section('missing', 'Pet data was not provided.');
  return section(source.length ? 'available' : 'empty', null, source.map((pet, index) => ({
    id: String(pet.uuid ?? index), name: label(pet.type ?? 'Unknown pet'),
    rarity: typeof pet.tier === 'string' ? label(pet.tier) : 'Unknown',
    xp: number(pet.exp) ? pet.exp : null, active: pet.active === true,
  })));
}

async function buildProfileData(member) {
  const data = {
    Skills: normalizeSkills(member ?? {}), Collections: normalizeCollections(member ?? {}),
    Pets: normalizePets(member?.pets_data?.pets ?? member?.pet_data?.pets),
  };
  await Promise.all(Object.entries(INVENTORIES).map(async ([name, field]) => {
    data[name] = member?.api_settings?.inv_contents === false || member?.api_settings?.inventory === false
      ? inventorySection('private', 'Inventory API sharing is disabled.')
      : await parseNbtContainer(member?.inventory?.[field]?.data ?? member?.[field]?.data, name);
  }));
  const backpacks = member?.inventory?.backpack_contents ?? member?.backpack_contents;
  if (member?.api_settings?.inv_contents === false || member?.api_settings?.inventory === false) {
    data.Backpacks = inventorySection('private', 'Inventory API sharing is disabled.');
  } else if (!object(backpacks)) {
    data.Backpacks = inventorySection('missing', 'Backpack data was not provided.');
  } else {
    const containers = await Promise.all(Object.entries(backpacks).map(([id, value]) =>
      parseNbtContainer(value?.data, `Backpack ${id}`)));
    const items = containers.flatMap((entry) => entry.items);
    const incomplete = containers.some((entry) => !['available', 'empty'].includes(entry.status));
    data.Backpacks = inventorySection(incomplete ? (items.length ? 'partial' : 'unavailable')
      : items.length ? 'available' : 'empty', incomplete ? 'Some backpacks could not be read.' : null, items);
  }
  return data;
}

// Adapt old records on read; do not rewrite or guess missing values in MongoDB.
function normalizeStoredData(data = {}, schemaVersion = 1) {
  if (schemaVersion === 2) {
    return Object.fromEntries(['Skills', 'Collections', 'Pets', ...Object.keys(INVENTORIES), 'Backpacks'].map((name) => {
      const saved = data?.[name];
      const list = name in INVENTORIES || name === 'Backpacks' ? 'items' : 'entries';
      return [name, object(saved) && Array.isArray(saved[list]) ? name === 'Collections'
        ? { ...saved, entries: saved.entries.map((entry) => ({ ...entry, label: collectionLabel(entry.id) })) } : saved
        : { status: 'unavailable', reason: 'This saved category is incomplete. Fetch fresh data.', [list]: [] }];
    }));
  }
  const experience = Object.fromEntries(Object.entries(data.Skills ?? {}).map(([key, value]) =>
    [`SKILL_${key.toUpperCase()}`, value]));
  const result = {
    Skills: normalizeSkills({ player_data: { experience } }, true),
    Collections: object(data.Collections) && Object.keys(data.Collections).length
      ? normalizeCollections({ collection: data.Collections })
      : section('unavailable', 'This older snapshot has no reliable collection availability. Fetch fresh data.'),
    Pets: normalizePets(data.Pets),
  };
  for (const name of Object.keys(INVENTORIES)) {
    result[name] = normalizeDecodedInventory(data[name], name);
  }
  const containers = Object.entries(data.Backpacks ?? {}).map(([id, value]) =>
    normalizeDecodedInventory(value, id));
  const items = containers.flatMap((entry) => entry.items);
  result.Backpacks = inventorySection(containers.length && containers.every((entry) =>
    ['available', 'empty'].includes(entry.status)) ? (items.length ? 'available' : 'empty') : 'unavailable',
  items.length ? null : 'Backpack availability was not recorded in this older snapshot.', items);
  return result;
}

module.exports = { buildProfileData, normalizeStoredData, parseNbtContainer };
