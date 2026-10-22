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

## Saved timeline reads

Timeline routes use UUIDs directly; no Minecraft lookup or Hypixel request is made.
They use `getReadDatabase()`, which connects without creating/dropping indexes.
Normal server startup/manual-save initialization retains its existing indexes.
No timeline read writes records, fetch events, or locks. No new indexes or data
migrations are required. The timestamp-based history routes remain compatible.

`GET /api/players/:playerUuid/profiles/:profileId/snapshots?limit=20&cursor=<token>`:

```text
{ playerUuid, profileId,
  snapshots: [{ snapshotId, fetchedAt, sourceSchemaVersion }],
  page: { limit, hasMore, nextCursor }
}
```

`limit` is 1–50, default 20. `nextCursor` is null on the final page; otherwise pass
it unchanged as `cursor`. Records sort by `(fetchedAt descending, _id descending)`.
Cursor anchors are looked up within the requested player/profile, so a cursor
cannot select another profile's history. A newly saved latest snapshot does not
shift remaining cursor pages. A deleted cursor anchor returns 400; there is no
cross-request database snapshot/transaction. Same-time snapshots are ordered by
ID, not inferred gameplay chronology. Existing indexes narrow player/profile/time
reads; very large histories may eventually need a compound index including `_id`
for sorting. This step does not create it.

`snapshotId` is a versioned opaque token derived from the immutable document `_id`.
It distinguishes legacy ObjectIds from schema-2 string IDs and remains stable
across reads and server restarts. Clients must not parse it. Tokens are not secrets
or authorization credentials. Both dashed/undashed and uppercase/lowercase UUID
representations are matched without rewriting records. Only existing ObjectId and
string document IDs are supported.

`GET /api/players/:playerUuid/profiles/:profileId/snapshots/:snapshotId`:

```text
{ playerUuid, profileId,
  snapshot: { snapshotId, fetchedAt, sourceSchemaVersion, data: { Skills, Collections } },
  previousSnapshot: { snapshotId, fetchedAt, sourceSchemaVersion } | null,
  changes: { Skills, Collections }
}
```

Details and their immediate predecessor are scoped to the same player and profile.
The predecessor is independently queried using the same ordering, even across
page boundaries. An unavailable predecessor is never skipped for an older usable
baseline. These detail reads project only Skills/Collections; the original
timestamp route still provides the other saved dashboard categories.

Each changes category has `status` (`available`, `partial`, `unavailable`), nullable
`reason`, `hasUnexpectedDecreases`, and `entries`:

```text
{ id, label, unit: "XP" | "items", current: number | null,
  previous: number | null, delta: number | null,
  status: "available" | "unavailable" | "decrease",
  unexpectedDecrease: boolean, reason: string | null }
```

Compare normalized totals by entry ID only when both categories are `available`
or `partial`, both entries are `available`, and both totals are finite and
nonnegative. Confirmed zero is valid. Missing entries, privacy/unavailability,
invalid values, ambiguous legacy skill zeros, and duplicate entry IDs return null
delta and “Comparison unavailable.” Empty collections never imply all counts are
zero. With no predecessor, the category reason is “No previous snapshot.” Signed
negative deltas are retained with `decrease` status and a warning; they are not
earned progress. No skill levels, threshold resources, or XP interpolation are
needed. Legacy nonempty collection dictionaries retain their explicit counts.

Malformed UUIDs/tokens/limits, or missing/out-of-scope cursors, return 400. A valid
snapshot token absent from the player/profile returns 404. Unknown player/profile
lists are empty. Database failures return a generic 500. Timeline responses use
`Cache-Control: no-store`.

Mixed ObjectId/string tie pagination uses expression `$lt`, which compares BSON
types in the same order as sorting, rather than query `$lt` type bracketing:
https://www.mongodb.com/docs/manual/reference/operator/aggregation/lt/

## Latest dashboard reads

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

`Skills`: `{ status, reason, entries: [{ id, label, xp, status, reason, levelCap }] }`.
XP is a finite nonnegative number or `null`; a confirmed zero is kept as zero.
Stored values are XP totals; the UI derives level progress from the cached
official Hypixel resource. `levelCap` is nullable and records an explicitly known
personal cap (currently Farming upgrades). It is never defaulted from missing
unlock metadata. See `skill-progress.md`. Current and older skill-field
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
