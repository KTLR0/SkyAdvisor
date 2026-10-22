// Compare normalized totals only. Missing entries are never a zero baseline.
const validValue = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function entryMap(category) {
  const entries = new Map();
  for (const entry of category?.entries || []) {
    if (typeof entry?.id !== 'string' || !entry.id) continue;
    // A duplicate ID is ambiguous; do not silently choose one value.
    entries.set(entry.id, entries.has(entry.id) ? { id: entry.id, status: 'unavailable' } : entry);
  }
  return entries;
}

function reliable(category, entry, field) {
  return ['available', 'partial'].includes(category?.status)
    && entry?.status === 'available' && validValue(entry[field]);
}

function compareCategory(current, previous, field, unit, hasPrevious) {
  const currentEntries = entryMap(current);
  const previousEntries = entryMap(previous);
  const entries = [...new Set([...currentEntries.keys(), ...previousEntries.keys()])].sort().map(id => {
    const a = previousEntries.get(id);
    const b = currentEntries.get(id);
    const previousValue = reliable(previous, a, field) ? a[field] : null;
    const currentValue = reliable(current, b, field) ? b[field] : null;
    const available = hasPrevious && previousValue !== null && currentValue !== null;
    const delta = available ? currentValue - previousValue : null;
    const decrease = available && delta < 0;
    return {
      id, label: b?.label || a?.label || id, unit,
      current: currentValue, previous: previousValue, delta,
      status: !available ? 'unavailable' : decrease ? 'decrease' : 'available',
      unexpectedDecrease: decrease,
      reason: !available ? 'Comparison unavailable.'
        : decrease ? 'Unexpected decrease; do not treat as earned progress.' : null,
    };
  });
  const comparable = entries.filter(entry => entry.status !== 'unavailable').length;
  return {
    status: !comparable ? 'unavailable' : comparable === entries.length ? 'available' : 'partial',
    reason: !hasPrevious ? 'No previous snapshot.'
      : !comparable ? 'Comparison unavailable.' : comparable < entries.length ? 'Some comparisons are unavailable.' : null,
    hasUnexpectedDecreases: entries.some(entry => entry.unexpectedDecrease), entries,
  };
}

function compareSnapshots(current, previous) {
  return {
    Skills: compareCategory(current?.Skills, previous?.Skills, 'xp', 'XP', Boolean(previous)),
    Collections: compareCategory(current?.Collections, previous?.Collections, 'amount', 'items', Boolean(previous)),
  };
}

module.exports = { compareSnapshots };
