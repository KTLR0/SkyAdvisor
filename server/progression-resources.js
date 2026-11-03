// Public Hypixel metadata and official Wiki reference text. All network access is
// triggered by an explicit progression request; there is no scheduled polling.
const ITEMS_URL = 'https://api.hypixel.net/v2/resources/skyblock/items';
const COLLECTIONS_URL = 'https://api.hypixel.net/v2/resources/skyblock/collections';
const WIKI_API = 'https://wiki.hypixel.net/api.php';
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const WIKI_AGE_MS = 6 * 60 * 60 * 1000;
const validId = id => typeof id === 'string' && /^[A-Z0-9:_-]{1,100}$/.test(id);
const clean = value => typeof value === 'string' ? value.replace(/§[0-9A-FK-OR]/gi, '').trim().slice(0, 120) : '';
const number = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function normalizeItems(body) {
  if (body?.success !== true || !Array.isArray(body.items)) throw new Error('Hypixel item metadata is unavailable.');
  const entries = body.items.filter(item => validId(item?.id) && clean(item?.name)).map(item => ({
    id: item.id, name: clean(item.name), category: clean(item.category).toUpperCase(),
    tier: clean(item.tier).toUpperCase(),
    stats: Object.fromEntries(Object.entries(item.stats || {}).filter(([key, value]) =>
      /^[A-Z_]{1,40}$/.test(key) && number(value)).slice(0, 12)),
  }));
  if (entries.length < 20) throw new Error('Hypixel item metadata is incomplete.');
  return entries;
}

function normalizeCollections(body) {
  if (body?.success !== true || !body.collections || typeof body.collections !== 'object') {
    throw new Error('Hypixel collection metadata is unavailable.');
  }
  const entries = [];
  for (const [category, group] of Object.entries(body.collections)) {
    for (const [id, entry] of Object.entries(group?.items || {})) {
      if (!validId(id)) continue;
      const tiers = (entry.tiers || []).filter(tier => Number.isInteger(tier?.tier)
        && number(tier?.amountRequired)).map(tier => ({ tier: tier.tier, amountRequired: tier.amountRequired }));
      tiers.sort((a, b) => a.tier - b.tier);
      if (!tiers.length || tiers.some((tier, i) => tier.tier !== i + 1
        || tier.amountRequired <= (i ? tiers[i - 1].amountRequired : 0))) continue;
      entries.push({ id, name: clean(entry.name) || id.replaceAll('_', ' '), category, tiers });
    }
  }
  if (!entries.length) throw new Error('Hypixel collection metadata is incomplete.');
  return entries;
}

const KEYWORDS = {
  farming: /FARM|HOE|DICER|CROP|HARVEST|RANCHER|MELON|PUMPKIN|WHEAT|POTATO|CARROT|SUGAR.CANE|GARDEN/,
  mining: /MINING|PICKAXE|DRILL|GAUNTLET|ORE|GEMSTONE|MITHRIL|TITANIUM|MINERAL|GOBLIN|GLACITE/,
  combat: /COMBAT|SWORD|BOW|DAGGER|KATANA|ARMOR|HELMET|CHESTPLATE|LEGGINGS|BOOTS|SLAYER|DUNGEON/,
  fishing: /FISH|ROD|ANGLER|SHARK|SEA.CREATURE|LAVA|TROPHY/,
  foraging: /FORAG|TREE|WOOD|AXE|JUNGLE|LUMBER|FLOWER/,
  enchanting: /ENCHANT|EXPERIMENT|BOOK|MAGIC/,
  alchemy: /ALCHEMY|POTION|BREW|ELIXIR|GOD.POT/,
  taming: /PET|TAMING|BEAST/,
  carpentry: /CARPENTRY|FURNITURE|CRAFT|WORKBENCH/,
  runecrafting: /RUNE|RUNECRAFT/,
  social: /SOCIAL|ISLAND|GUEST|VISITOR/,
  hunting: /HUNT|TRAP|SNARE|BEAST/,
};

function itemCandidates(items, skill, ownedIds, ownedPets) {
  const pattern = KEYWORDS[skill] || new RegExp(skill.toUpperCase());
  const groups = new Map();
  for (const item of items) {
    if (ownedIds.has(item.id.toUpperCase()) || ownedIds.has(item.name.toUpperCase())
        || ownedPets.has(item.id.toUpperCase()) || ownedPets.has(item.name.toUpperCase())) continue;
    if (/SKIN|DYE|FURNITURE|COSMETIC|FIRE_SALE/.test(`${item.id} ${item.category}`)) continue;
    const text = `${item.name} ${item.id} ${item.category}`.toUpperCase();
    const matched = pattern.test(text) || (skill === 'mining' && number(item.stats.MINING_SPEED))
      || (skill === 'farming' && number(item.stats.FARMING_FORTUNE))
      || (skill === 'fishing' && number(item.stats.SEA_CREATURE_CHANCE));
    if (!matched) continue;
    const group = /PET/.test(text) ? 'pet' : /ARMOR|HELMET|CHESTPLATE|LEGGINGS|BOOTS/.test(text) ? 'armor'
      : /NECKLACE|CLOAK|BELT|GLOVES|BRACELET/.test(text) ? 'equipment'
        : /PICKAXE|HOE|DRILL|ROD|SWORD|BOW|AXE|DAGGER|GAUNTLET|DICER/.test(text) ? 'tool' : 'other';
    const score = (pattern.test(item.id.toUpperCase()) ? 4 : 0)
      + (pattern.test(item.name.toUpperCase()) ? 3 : 0)
      + (group === 'tool' ? 2 : 0) + (item.tier === 'COMMON' ? 1 : 0);
    const current = groups.get(group) || [];
    current.push({ ...item, score });
    groups.set(group, current);
  }
  const out = [];
  for (const group of ['tool', 'armor', 'equipment', 'pet', 'other']) {
    const options = (groups.get(group) || []).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    out.push(...options.slice(0, 20).map(({ score, ...rest }) => rest));
  }
  return out.slice(0, 80);
}

// Wiki-verified pet page candidates. Pet species are not consistently present
// as standalone inventory items in the public items resource. Their objective
// IDs are local candidate keys, NOT asserted Hypixel item IDs.
const PETS_BY_SKILL = Object.freeze({
  farming: ['RABBIT', 'ELEPHANT', 'MOOSHROOM_COW'],
  mining: ['SILVERFISH', 'MITHRIL_GOLEM', 'BAL', 'ARMADILLO', 'SCATHA'],
  combat: ['WOLF', 'TIGER', 'LION', 'ENDER_DRAGON'],
  fishing: ['SQUID', 'DOLPHIN', 'FLYING_FISH', 'AMMONITE'],
  foraging: ['OCELOT', 'MONKEY'],
  enchanting: ['GUARDIAN'],
  alchemy: ['SHEEP'],
  taming: ['ROCK', 'BEE', 'SHEEP'],
  hunting: ['LION', 'TIGER'],
});
function petCandidates(skill, ownedPets, ownedItems = new Set()) {
  return (PETS_BY_SKILL[skill] || []).filter(id => !ownedPets.has(id)
    && !ownedPets.has(`${id.replaceAll('_', ' ')} PET`)
    && !ownedItems.has(`PET:${id}`)
    && !ownedItems.has(`${id.replaceAll('_', ' ')} PET`)).map(id => ({
    id: `PET:${id}`, name: `${id.split('_').map(part => part[0] + part.slice(1).toLowerCase()).join(' ')} Pet`,
    category: 'PET', tier: 'VARIES', source: 'wiki_pet', stats: {},
  }));
}

function collectionCandidates(collections, skill, savedAmounts) {
  const own = collections.filter(entry => entry.category.toLowerCase() === skill);
  // Skills without their own collection group may still benefit from other collections.
  const pool = own.length ? own : collections;
  return pool.filter(entry => savedAmounts.has(entry.id)).map(entry => {
    const amount = savedAmounts.get(entry.id);
    const next = entry.tiers.find(tier => tier.amountRequired > amount);
    return next ? { id: entry.id, name: entry.name, category: entry.category,
      amount, nextTier: next.tier, targetAmount: next.amountRequired, remaining: next.amountRequired - amount } : null;
  }).filter(Boolean).sort((a, b) => a.remaining - b.remaining).slice(0, 65);
}

function textFromHtml(html) {
  return html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h[1-6]>|<\/tr>/gi, '\n')
    .replace(/<[^>]*>/g, ' ').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|nbsp|apos);/gi, (_, entity) => {
      const special = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', apos: "'" };
      if (special[entity.toLowerCase()]) return special[entity.toLowerCase()];
      const hex = entity.toLowerCase().startsWith('#x');
      const n = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
    }).replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim().slice(0, 18000);
}

function createProgressionResources({ request = (...args) => globalThis.fetch(...args), now = Date.now } = {}) {
  const cache = new Map();
  const wikiCache = new Map();
  async function load(key, url, normalize) {
    const previous = cache.get(key);
    if (previous && now() - previous.at < MAX_AGE_MS) return previous.value;
    if (previous?.pending) return previous.pending;
    const pending = (async () => {
      try {
        const response = await request(url, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('Hypixel resource request failed.');
        const value = normalize(await response.json());
        cache.set(key, { value, at: now() });
        return value;
      } catch (error) {
        if (previous?.value && now() - previous.at < STALE_MS) return previous.value;
        throw error;
      }
    })();
    cache.set(key, { ...previous, pending });
    try { return await pending; } finally {
      if (cache.get(key)?.pending === pending) cache.set(key, previous || {});
    }
  }
  async function wiki(title) {
    if (typeof title !== 'string' || title.length < 2 || title.length > 100
        || /[\u0000-\u001f<>{}]/.test(title)) throw new Error('Invalid Wiki title.');
    if (wikiCache.has(title) && now() - wikiCache.get(title).at < WIKI_AGE_MS) return wikiCache.get(title).value;
    const articleUrl = `https://wiki.hypixel.net/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
    const parsed = new URL(WIKI_API);
    parsed.search = new URLSearchParams({ action: 'parse', page: title, prop: 'text', format: 'json', formatversion: '2', redirects: '1' }).toString();
    let content = '', actualTitle = title;
    try {
      const response = await request(parsed.toString(), { signal: AbortSignal.timeout(9000),
        headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Wiki API unavailable.');
      const body = await response.json();
      if (body.error || typeof body.parse?.text !== 'string') throw new Error('Wiki article unavailable.');
      content = textFromHtml(body.parse.text);
      actualTitle = body.parse.title || title;
    } catch {
      // Some installations limit MediaWiki API requests, while their public
      // article pages remain accessible. Both requests use the fixed Wiki host.
      const response = await request(articleUrl, { signal: AbortSignal.timeout(9000),
        headers: { Accept: 'text/html' } });
      if (!response.ok) throw new Error('Hypixel Wiki is temporarily unavailable.');
      const html = await response.text();
      if (!/mw-parser-output|mw-content-text|<article\b/i.test(html)) {
        throw new Error('The official Wiki article could not be verified.');
      }
      const start = html.search(/mw-parser-output|mw-content-text|<article\b/i);
      content = textFromHtml(html.slice(Math.max(0, start - 100)));
    }
    if (content.length < 120) throw new Error('The Wiki article does not contain enough readable guidance.');
    const value = { title: actualTitle,
      url: `https://wiki.hypixel.net/${encodeURIComponent(actualTitle.replaceAll(' ', '_'))}`,
      text: content, source: 'Hypixel SkyBlock Wiki' };
    wikiCache.set(title, { value, at: now() });
    if (wikiCache.size > 100) wikiCache.delete(wikiCache.keys().next().value);
    return value;
  }
  return { items: () => load('items', ITEMS_URL, normalizeItems),
    collections: () => load('collections', COLLECTIONS_URL, normalizeCollections), wiki };
}

module.exports = { createProgressionResources, normalizeItems, normalizeCollections,
  itemCandidates, petCandidates, collectionCandidates, textFromHtml };
