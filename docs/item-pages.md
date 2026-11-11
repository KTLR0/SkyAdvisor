# Item pages and mobile navigation

Inventory, Armor, Equipment, Backpacks, Ender chest, Talismans, and Pets share a
card layout: a consistent visual frame, readable wrapping name, separate badge,
and saved location/details. Count badges never overlap item names; a missing
count stays “Count not recorded,” and a real zero remains zero. Item cards retain
the lore/raw-NBT inspector and its Close/Escape actions.

## Images and saved locations

The existing `mcasset.cloud` base-Minecraft texture resolver is preserved only
when a saved `minecraftId` is present and valid. No image is guessed from a
SkyBlock ID/name, and no new image provider, custom-head resolver, or item artwork
is introduced. Missing/failed textures use a local inline grid icon. Names,
counts, and locations remain readable regardless of image availability. A base
Minecraft texture does not establish a custom SkyBlock item's exact appearance.
Pets use a generic inline pet symbol rather than an invented portrait.

A normalized `slot` can come from explicit NBT `Slot` or from the saved array
index. The UI calls it **Slot N** only when the raw NBT value matches the saved
slot. Otherwise an available index is shown as **Saved position N** (one-based).
Unknown positions stay unrecorded. Armor and Equipment list explicit slots first
in numeric order, retaining unknown-position order afterward. Body parts and
necklace/cloak/belt/glove types are not inferred from item names or list indexes.
Backpack container labels are preserved.

Pets with saved `active: true` appear first with a text badge and distinct border.
Other pets are not given an inferred inactive state. Rarity and saved XP remain
visible; missing XP stays unrecorded, and no pet level is guessed.

## States and navigation

Private/missing/unavailable categories explain the saved-data limitation without
showing a false empty inventory. Empty means an explicitly empty saved list.
Partial categories retain readable entries and explain that missing containers
or pet details cannot be assumed empty/zero. Fetching remains a separate manual
action; no polling or new player/resource requests are added.

At widths up to 700px, one labeled native **Section** selector replaces the
horizontal button strip. Desktop keeps category buttons. The selected source
category remains visible while a contextual planner is open; its existing Back
to Skills/Collections action returns to the entry page. Collections filters,
planner guide state, follow-ups/export, profile switching, and skill bars retain
their existing behavior.

Timeline uses **Older snapshot** and **Newer snapshot**, with actual destination
dates/times from the loaded saved list. When the next older date is not loaded,
the control says **Load older saved dates**. Boundary controls explain that no
older snapshot exists or that the selected record is the latest. Pagination and
comparison semantics are unchanged.

## Verification and limitations

Run `npm test`, `npm run build`, `git diff --check`, and the browser checks
`node scripts/check-next-steps.cjs`, `node scripts/check-skill-progress.cjs`, and
`node scripts/check-timeline.cjs`. They cover consistent card layout, image
failures, count/XP zero and missing states, slot labels/order, inspector actions,
partial/private/empty data, active Pets, actual mobile section selection, target
dates, and existing contextual planning/Collections/Timeline flows.

The repeatable browser scripts use synthetic snapshots and mocked services.
Separately, a desktop/mobile check on November 11, 2026 used one existing Atlas
profile through the real saved-data and Timeline read services. Overview, 11
saved skill entries, 79 collection counts, 18 inventory stacks, 30 pets, and the
saved Timeline values matched those reads. Missing data, blocked-image fallbacks,
and the mobile Section selector remained readable. The collection action's
heading and POST carried the exact selected saved collection ID.

That check allowed no Atlas writes or Hypixel requests. Identity labels were
redacted; no player records were added to this repository. Skill thresholds came
from the frozen official test fixture. Guide generation was disabled after
inspecting the collection request, so follow-ups/export and other availability
states are covered by the synthetic checks rather than live model generation.
Live texture delivery and custom item art are not verified. Semantic
armor/equipment slots remain unavailable when the saved data does not prove
them; no backend change is needed.
