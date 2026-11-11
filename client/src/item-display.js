export const categoryLabel = category => category === 'Enderchest' ? 'Ender chest' : category;
export const savedNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function recordedSlot(item) {
  return Number.isInteger(item.slot) && item.slot >= 0 && item.raw?.Slot === item.slot ? item.slot : null;
}

export function itemLocation(item, category = null) {
  const container = typeof item.container === 'string' && item.container.trim() ? categoryLabel(item.container)
    : category ? categoryLabel(category) : 'Location not recorded';
  const slot = recordedSlot(item);
  const position = slot !== null ? `Slot ${slot}` : Number.isInteger(item.slot) && item.slot >= 0
    ? `Saved position ${item.slot + 1}` : 'Slot not recorded';
  return `${container} · ${position}`;
}

export function orderedItems(items, category) {
  if (!['Armor', 'Equipment'].includes(category)) return items;
  return [...items].sort((a, b) => {
    const left = recordedSlot(a), right = recordedSlot(b);
    return left === null ? right === null ? 0 : 1 : right === null ? -1 : left - right;
  });
}

export function itemTexture(item) {
  // Preserve the existing base-Minecraft texture source; never derive art from SkyBlock names/IDs.
  return typeof item.minecraftId === 'string' && /^[a-z0-9_]+$/i.test(item.minecraftId)
    ? `https://mcasset.cloud/1.21.4/assets/minecraft/textures/item/${item.minecraftId.toLowerCase()}.png` : null;
}
