# Snapshot and dashboard data contract

New snapshots use `schemaVersion: 2`. Each fetch has a unique `fetchId`; each
profile document has a deterministic ID for that fetch and profile. A transaction
writes the player, all profile snapshots, and one fetch event together. Repeated
transaction callbacks upsert the same IDs. Historical snapshots remain intact.
The existing UUID lock and hourly/daily controls still apply.

## Identity and time

The server resolves the submitted username again and checks the submitted UUID
before requesting Hypixel. Player and profile UUIDs are stored as lowercase,
undashed strings. A missing/invalid profile ID or missing player member aborts the
fetch. Duplicate profile entries in one upstream reply are deduplicated by ID.
`fetchedAt` is a MongoDB Date and an ISO UTC string in JSON; every profile in a
fetch has the same time. New `timestamp` values are precise ISO UTC strings.
Old minute-based history identifiers remain accepted.

`GET /api/player/:username/skyblock?uuid=<resolved UUID>` returns:

```text
{ username, uuid, profiles: [
  { profile, profileId, playerUuid, selected, fetchedAt, timestamp, timestampMs,
    schemaVersion, sourceSchemaVersion, data }
] }
```

Read by UUID when available, so a changed player name does not select another
player's data. Profile switching uses `profileId`, not the display name. The UI
retains the selected ID when reloading; otherwise it chooses Hypixel's selected
profile, then the first saved profile. Reads never trigger Hypixel fetching.

## Category shapes

Every category has `status` and nullable `reason`:

- `available`: all represented values were provided.
- `partial`: some values were provided, others are unavailable.
- `empty`: the API explicitly supplied an empty list/object/container.
- `missing`: the API omitted a value; privacy is not assumed.
- `private`: an explicit API-sharing setting disabled the category.
- `unavailable`: decoding failed or an older snapshot is ambiguous.

`Skills`: `{ status, reason, entries: [{ id, label, xp, status, reason }] }`.
XP is a finite nonnegative number or `null`; a confirmed zero is kept as zero.
These are XP totals, not calculated skill levels. Current and older skill-field
layouts are supported. A missing individual skill is never inferred to be zero.

`Collections`: `{ status, reason, entries: [{ id, label, amount, status }] }`.
Amounts are personal counts, not tiers. Current `member.collection` and older
`member.collection_data.collection` layouts are accepted. Missing keys are not
invented. Zero counts are retained.

Inventory, Armor, Equipment, Enderchest, Talismans, and Backpacks:
`{ status, reason, items: [{ slot, id, minecraftId, name, count, lore, container, raw }] }`.
Items are decoded from gzip/uncompressed NBT on the server. Display names/lore
have Minecraft formatting codes removed. Count is numeric or `null`. `raw`
preserves item NBT solely for the optional advanced item inspector. Backpack
items retain their container labels. Missing containers differ from empty ones.

`Pets`: `{ status, reason, entries: [{ id, name, rarity, xp, active }] }`.

Schema-1 snapshots are adapted only when read; no old records are rewritten.
Old skill zeros and empty Collections are ambiguous because the old normalizer
replaced missing values with zeros/empty objects. They are shown as unavailable;
only a fresh on-demand fetch can recover reliable availability information.

## Verification

`npm test` covers normalization, representative compressed inventory fixtures,
Express lookup/fetch/readback, stable IDs, duplicate/retried writes, rollback,
profile selection data, history compatibility, and fetch limits. Database fixtures
are in memory and are not proof of a live Atlas connection. A real database check
must separately verify the driver, transaction support, stored records, and API
credentials. Atlas transactions require a replica set (as provided by Atlas).

API reference: https://api.hypixel.net/ (profiles endpoint, UUID formats, API-Key
header, and base64/gzip NBT encoding). Member data availability varies by player.
