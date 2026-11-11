import metadata from './collection-categories.js';

const byId = new Map(Object.entries(metadata.categories).flatMap(([key, category]) =>
  category.ids.map(id => [id, { key, name: category.name }])));
const readable = data => ['available', 'partial'].includes(data?.status);

export function savedCount(entry, data) {
  return readable(data) && entry.status === 'available' && typeof entry.amount === 'number'
    && Number.isFinite(entry.amount) && entry.amount >= 0 ? entry.amount : null;
}

export function collectionCategory(entry) {
  const saved = typeof entry.category === 'string' ? entry.category.trim() : '';
  if (saved) {
    const key = saved.toUpperCase();
    return { key, name: metadata.categories[key]?.name || saved };
  }
  return byId.get(entry.id) || { key: '', name: 'Category unavailable' };
}

export function groupCollections(data, query = '', sort = 'name-asc') {
  if (!readable(data)) return [];
  const search = query.trim().toLowerCase();
  const entries = (data.entries || []).filter(entry => entry.label.toLowerCase().includes(search));
  const nameOrder = (a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
  entries.sort((a, b) => {
    if (sort.startsWith('count-')) {
      const left = savedCount(a, data), right = savedCount(b, data);
      if (left === null || right === null) return left === right ? nameOrder(a, b) : left === null ? 1 : -1;
      return (sort === 'count-desc' ? right - left : left - right) || nameOrder(a, b);
    }
    return (sort === 'name-desc' ? -1 : 1) * nameOrder(a, b);
  });
  const groups = new Map();
  for (const entry of entries) {
    const category = collectionCategory(entry);
    if (!groups.has(category.key)) groups.set(category.key, { ...category, entries: [] });
    groups.get(category.key).entries.push(entry);
  }
  return [...groups.values()].sort((a, b) => !a.key ? 1 : !b.key ? -1 : a.name.localeCompare(b.name));
}
