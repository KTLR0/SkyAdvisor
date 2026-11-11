# Collections view

Collections shows saved records in category groups with compact rows, name search,
and name/count sorting **within each category**. Search ignores case and surrounding
spaces. Unknown counts sort last in both count directions; genuine zero remains
zero. Searches with no results offer Clear search.

Category membership comes from a saved entry's explicit `category` when present,
otherwise the exact-ID manifest in `client/src/collection-categories.js`. Entries
without a known category appear under **Category unavailable**. Names and ID
prefixes are never used to guess category membership. Legacy IDs such as `LOG:2`,
`INK_SACK:3`, and `INK_SACK:4` retain their separate identities.

The bundled manifest was extracted from the official public resource on
2026-11-11, resource version `0.27.2.28`:
[Hypixel collection metadata](https://api.hypixel.net/v2/resources/skyblock/collections).
It contains category membership only, not tier targets, item images, or recipes.
New or moved collections require a manifest update unless their category is
already supplied in saved data. Browsing does not fetch metadata or player data.

## Images and reliable values

The small SVGs in `client/src/assets/collections/` are original generic category
symbols, not illustrations of specific game items or copied branding. Known
groups use their bundled category icon; unknown groups use a generic collection
grid. An image load failure falls back to an inline SVG grid, preserving names,
counts, and actions. There is no external image dependency or guessed filename.
The app has no verified exact collection-image mapping, so none is asserted.

The current saved collection contract supplies counts but no verified tier
thresholds. This view therefore displays counts only, with **no tier or percentage**.
A reliable count requires readable category data, an available entry, and a
finite nonnegative number. Private/missing categories display an explanatory
state; partial data keeps readable entries, and unavailable counts never become
zero or receive a planning action.

## Contextual planning

Every readable entry keeps **Plan next steps**, passing its unchanged exact ID to
the existing collection-specific planner. The chosen collection appears in the
planner heading and is validated by the existing backend. Search/sort state stays
when returning from a guide or another category, and resets when the selected
player/profile/snapshot changes. The current guide, follow-ups, and TXT export
remain available when reopening the same collection. No planner backend change
is part of this redesign.

## Checks

`npm test` includes focused tests for exact category variants, saved categories,
unknown groups, search, numeric sorting, zero, private and invalid counts, and
avoiding mutation of saved data. `node scripts/check-next-steps.cjs` exercises
search/sort/grouping, bundled and failed-image fallbacks, unavailable states,
filter preservation, exact-ID planning, follow-ups, and export at desktop/mobile
sizes with synthetic data and mocked services. Existing Skills/Timeline browser
checks also remain available. Run `npm run build` and `git diff --check`.
