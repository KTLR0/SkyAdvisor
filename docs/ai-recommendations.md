# AI recommendations: Part 1 contract

Part 1 prepares saved evidence and defines the model response. It does not choose
actions, fetch Hypixel data, call an AI, write to the database, or add UI/jobs.

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

## Expected response

`server/recommendation-response.schema.json` defines the versioned JSON Schema;
it is also exported as `RECOMMENDATION_RESPONSE_SCHEMA` for Part 2. A response
contains the input goal and zero to three actions. Each action has priority,
title, what to do, why it fits the goal, and at least one supporting fact ID.
An empty actions array is valid when evidence is insufficient.

Alongside schema validation, future claim checking must require the same goal
and version, contiguous priorities `1..N` in array order, trimmed nonempty text,
and fact IDs that actually exist in the exact input. Every player-specific claim
must be supported by the cited fields. A citation's existence alone does not
verify the text. Unknown XP/targets/ownership, current-state claims from old
snapshots, item absence, fabricated rewards/stats, and unsupported requirements
must not be accepted. Those semantic checks and fallback recommendations belong
to later parts; Part 1 includes no model client, validator, or fallback actions.

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

Illustrative response shape (documentation only, never a hard-coded choice):

```json
{
  "contractVersion": 1,
  "goal": "mining",
  "actions": [{
    "priority": 1,
    "title": "Work toward Mining 2",
    "whatToDo": "Earn the remaining Mining XP toward level 2.",
    "whyItFitsGoal": "The saved snapshot records Mining 1 with 62.5 XP remaining to level 2, giving this mining goal a measurable next step.",
    "supportingFactIds": ["skill:mining", "snapshot:time"]
  }]
}
```

Run `node --test server/ai-recommendations.test.js` for focused synthetic checks,
then `npm test` and `npm run build`. No live services or saved player files are
needed. The preparation module is not wired into existing routes in Part 1.
