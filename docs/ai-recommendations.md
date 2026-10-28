# AI recommendations: saved input and backend service

Part 1 prepares saved evidence. Part 2 adds an explicit server recommendation
request using Gemini 3.8 Flash, validates its plan, and renders factual values
from that evidence. There is no recommendation UI or background generation.

## Input preparation

`server/ai-recommendations.js` exports:

```js
buildRecommendationInput(selectedProfile, goal, {
  skillDefinitions,       // optional: validated offline skills resource's .skills
  collectionDefinitions, // optional: trusted offline collection thresholds
})
```

Pass **one explicitly selected normalized saved profile**, as returned by the
saved dashboard reader: `{ data, fetchedAt, schemaVersion: 2,
sourceSchemaVersion }`. Use the existing normalizer before passing raw stored
records. The function never selects a profile from a player's list. It neither
mutates inputs nor retains state across calls. Supported goals are exactly
`general`, `farming`, `mining`, and `combat`; invalid goals throw. The goal travels
with the evidence. All goals receive the same verified context, allowing Part 2
to choose relevant actions without Part 1 prescribing priorities or item roles.

Skills include available finite nonnegative XP. Optional level/next-level/distance
fields reuse the dashboard's pure skill calculator and personal-cap guards.
Supply only already available, validated metadata in the shape returned by
`normalizeSkillResource(...).skills`; **do not invoke the resource loader** to
prepare this input. Without it, XP remains useful but level fields are omitted.
At a verified cap, `atCap: true`, `nextLevel: null`, and `xpRemaining: 0` mean
there is no next level, rather than a zero-cost upgrade.

Collections include explicit reliable counts, including zero. Existing saved
records contain no tier thresholds, so targets are omitted by default. Optional
trusted offline `collectionDefinitions` has this shape (synthetic numbers):

```js
{ WHEAT: { tiers: [
  { tier: 1, amountRequired: 50 },
  { tier: 2, amountRequired: 100 },
] } }
```

Tier tables must be complete from tier 1, consecutive and strictly increasing.
The next target is the first threshold above the count; `remaining` is its exact
distance. Reaching the final threshold yields `atMaxTier: true`. These fields
describe only the supplied table; they never imply a recipe or reward unlock.
No runtime collection table or guessed targets are bundled in Part 1.

Inventory context contains recognized-format saved item IDs, locations, slots,
and known integer counts from Inventory, Armor, Equipment, Enderchest, Talismans,
and readable Backpacks. Names, lore, numeric-only/unknown item IDs, raw NBT,
credentials, identifiers for the player/profile, and arbitrary fields are
excluded. No item statistics, usability, or upgrade requirements are inferred.
Unknown counts are omitted; explicit zero counts remain recorded counts, not
proof that an item is absent elsewhere. Duplicate skill/collection IDs and
duplicate Inventory locations are ambiguous and excluded.

Only `available`/`partial` categories and `available` skill/collection entries
support facts. Private, missing, invalid, and ambiguous legacy values never
become zero. Legacy skill zeros remain excluded. `coverage` carries source
availability states, not claims about omitted entries. The summary retains at
most 100 collection and 40 Inventory facts in deterministic ID order, with
truncation flags. Omission never proves absence. In this contract,
`inventoryAbsenceSupported` is always false, even for a decoded empty container:
other containers/storage and truncated items may be unknown.

`snapshot.fetchedAt` preserves the saved UTC time; it is never refreshed to now.
An unavailable time becomes null without a time fact ID. Older snapshots remain
historical evidence, not assertions about current ownership/progress. There is
no arbitrary freshness cutoff and no refresh side effect.

Fact IDs are deterministic semantic keys: `skill:<id>`, `collection:<encoded-id>`,
`inventory:<encoded-container>:<slot>:<encoded-item-id>`, and `snapshot:time`.
They survive entry reordering but are **local to the supplied summary**. Part 2
must keep the selected profile/snapshot and metadata associated with each request
outside the model payload. Never resolve evidence against another profile, goal,
snapshot, or an updated summary. Timeline detail reads contain no Inventory;
that missing evidence must remain unavailable rather than being supplemented
from a different snapshot.

## Model response and verified rendering

`server/recommendation-response.schema.json` defines model plan **v2**, exported
as `RECOMMENDATION_RESPONSE_SCHEMA`. The compact input stays at v1. Part 2
replaces the original v1 model prose contract because arbitrary prose cannot be
reliably checked for invented quantities, including numbers written as words.

Gemini chooses and orders zero to three distinct action focuses from the input.
It selects `kind` (`train_skill`, `grow_collection`, or `review_inventory`),
`focusFactId`, an evidence-backed `reason`, and supporting fact IDs. This is not
a server-selected checklist: different valid model selections and priorities
are preserved. Broad action kinds are limited to what the saved data supports;
recipes, prices, rates, unlocks, and item statistics lack verified metadata.

The validator enforces the exact shape, version and requested goal; at most
three actions; consecutive priorities `1..N` in array order; distinct action
focuses (including repeated item types across Inventory locations); unique,
existing fact IDs; and inclusion of the focus among the cited
facts. No unknown properties, free prose, or model-supplied quantities are
accepted. Action and reason must match the fact:

- `train_skill`: a skill not at a verified cap, matching a specific goal (or any
  skill for `general`). `goal_alignment` additionally requires a specific matching
  goal. `next_level` requires verified positive XP distance.
- `grow_collection`: a collection not at its verified maximum tier.
  `next_collection_tier` requires a verified target and positive distance.
- `recorded_progress`: a skill or collection total that survived input checks.
- `review_inventory` / `known_item`: a known item record whose count is not zero.
  It never asserts current ownership, effectiveness, usability, or absence.

The server generates `title`, `whatToDo`, and `whyItFitsGoal` from the selected
action/reason and verified fields. It adds the cited fact objects as `evidence`.
All displayed numbers come from those facts; none come from model prose. Counts
and XP are explicitly described as saved records, so older snapshots do not
become current-state claims. The returned snapshot time identifies their age.
The response is advisory: collection/equipment focuses for a goal are suggested
planning steps, not verified game mechanics or guaranteed gains.

## Synthetic, redacted example

All values below are synthetic; player/profile identifiers and item text are
excluded. The optional skill table is already available offline. No collection
table was supplied, so the zero count has no invented target.

Input summary:

```json
{
  "contractVersion": 1,
  "goal": "mining",
  "snapshot": { "factId": "snapshot:time", "fetchedAt": "2026-10-28T12:00:00.000Z" },
  "coverage": {
    "skills": "partial",
    "collections": "available",
    "inventory": {
      "Inventory": "available", "Armor": "missing", "Equipment": "missing",
      "Enderchest": "missing", "Talismans": "missing", "Backpacks": "missing"
    },
    "collectionsTruncated": false,
    "inventoryTruncated": false,
    "inventoryAbsenceSupported": false
  },
  "skills": [{
    "factId": "skill:mining", "skill": "mining", "xp": 112.5,
    "level": 1, "nextLevel": 2, "xpRemaining": 62.5, "atCap": false
  }],
  "collections": [{ "factId": "collection:COBBLESTONE", "collectionId": "COBBLESTONE", "amount": 0 }],
  "inventory": [{
    "factId": "inventory:Inventory:0:DIAMOND_PICKAXE", "itemId": "DIAMOND_PICKAXE",
    "container": "Inventory", "slot": 0, "count": 1
  }]
}
```

Illustrative model plan (documentation only, never a hard-coded choice):

```json
{
  "contractVersion": 2,
  "goal": "mining",
  "actions": [{
    "priority": 1,
    "kind": "train_skill",
    "focusFactId": "skill:mining",
    "reason": "next_level",
    "supportingFactIds": ["skill:mining", "snapshot:time"]
  }]
}
```

The server renders that action as title `Train Mining`, instruction
`Work toward Mining level 2.`, and explanation:
`The verified next level provides a measurable focus for mining. The saved
snapshot records 112.5 Mining XP. Verified level: 1; XP to next level: 62.5.`
Those numerical values come from `skill:mining` in this example.

## Endpoint and fallback

Explicit request:

```text
POST /api/players/:playerUuid/profiles/:profileId/recommendations
Content-Type: application/json

{ "goal": "mining" }
```

Only `goal` is accepted in the body. Player and profile UUIDs must be explicit;
canonical and supported legacy dashed/case variants match saved data. The
service uses `getReadDatabase()` and reads the latest snapshot for **both** IDs,
ordered by `(fetchedAt descending, _id descending)`. It normalizes that snapshot
and calls `buildRecommendationInput`. Browser-supplied data is rejected. It
does not resolve Minecraft identities, contact Hypixel, initialize indexes,
refresh skill metadata, write records, or traverse other profiles.

If the existing skill cache contains metadata within its supported seven-day
window, a read-only `peek()` supplies levels/distances. A cold or expired cache
leaves XP only; recommendations never call its network loader. No new collection
threshold data is collected. No recommendation results are cached or persisted.

A successful HTTP 200 response has this shape:

```text
{ contractVersion: 2, playerUuid, profileId, goal,
  source: "ai" | "fallback", fallbackReason?: code,
  snapshot: { fetchedAt, factId? },
  actions: [{ priority, kind, focusFactId, reason, supportingFactIds,
    title, whatToDo, whyItFitsGoal, evidence }] }
```

The schema file describes the model plan; these server-rendered fields and
source/snapshot metadata belong to the endpoint envelope. Missing key, model
failure, invalid output, or a 15-second deadline returns one deterministic
fallback action from the first supported skill, then collection, then Inventory
fact. No supported facts means an empty fallback and no model call. Fallback
codes are `not_configured`, `model_failed`, `invalid_response`, `timeout`, and
`insufficient_evidence`. Valid model plans can also contain no actions.
All actions, including fallback, use the same verified renderer. The service
aborts timed-out calls and does not retry. Upstream error bodies are neither
logged nor returned. Malformed input is HTTP 400; no saved player/profile
snapshot is 404; storage failures return a generic 500. Responses use `no-store`.

## Configuration and checks

Set `GEMINI_API_KEY` privately in the root `.env` or server environment.
`GEMINI_MODEL` defaults to `gemini-3.8-flash` and can be overridden. The existing
server bootstrap loads `.env`; do not use a `VITE_` variable or expose the key
to the client. `.env.example` contains only an empty key variable. No key is
required to serve fallback results. No local key was configured during this
implementation, so no live Gemini request was made.

`server/gemini.js` calls the fixed Google `generateContent` REST endpoint with
the compact summary and v2 structured-output schema. Credentials are sent only
in `x-goog-api-key`. Model configuration cannot change the destination host.
There are no tools, search, automatic generation, startup calls, or retries.
Only an explicit POST invokes the model. Dashboard GETs do not generate plans.

References: [Gemini 3.8 Flash model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash),
[structured REST output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output?hl=en).

Run `npm test` and `npm run build`. Synthetic tests mock the model and database;
no real API credentials, live services, or saved player files are needed. Tests
cover valid selections/order, shape and priority violations, duplicate actions,
unknown evidence, invented numbers (digits and words), transport failures,
timeouts/abort, missing configuration, profile isolation, read-only behavior,
and the absence of model calls during browsing.
