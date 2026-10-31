# AI recommendations: saved input and backend service

Part 1 prepares saved evidence. Part 2 adds an explicit server recommendation
request using Gemini 3.8 Flash, validates its plan, and renders factual values
from that evidence. Part 3 adds dashboard controls and saved-evidence cards.
There is no background generation.

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

Before calling Gemini, `buildPlanSchema(input)` narrows the base response schema
to the requested goal and contract version. The schema stays the same size as
profile evidence grows; it does not embed fact-ID enums or per-fact `anyOf`
branches. Full-sized synthetic profiles reproduced HTTP 400 with the former
fact-dependent schema, while the same evidence succeeded with a small schema.

`buildAllowedActions(input)` sends eligible kind/reason/focus-ID groups as separate
prompt data, using the same evidence rules as the validator. Missing level or
collection thresholds never offer a next-level/tier reason. A specific goal
offers only its own skill for training; repeated stacks offer one review focus
per item type. These groups describe eligible options; the model still chooses
the focuses, reasons, count, and priorities. Supporting IDs must exist in the
saved input. The full validator still independently checks every returned plan,
including after correction, and rejects unsupported facts and numerical claims.
If a plan fails only because it repeats otherwise individually valid actions,
the service asks Gemini once for a corrected plan. The correction is a fixed
server-authored instruction; no raw invalid model response is sent back. Both
generations share the original deadline. The corrected plan must pass the full
validator; otherwise the service returns fallback. Unknown evidence, unsupported
numbers, incorrect goals, and malformed plans do not trigger this correction.

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
failure, invalid output, or a 45-second model deadline returns one deterministic
fallback action from the first supported skill, then collection, then Inventory
fact. No supported facts means an empty fallback and no model call. Fallback
codes include `not_configured`, `model_failed`, `invalid_response`, `timeout`,
`insufficient_evidence`, `model_unavailable`, `model_access_denied`, `model_quota`,
`model_not_found`, and `model_request_invalid`. Valid model plans can also contain no actions.
All actions, including fallback, use the same verified renderer. The service
aborts timed-out calls, including retry waits. Each generation's HTTP 500/502/503/504 can retry
twice, with exponential backoff and jitter, only within the original 45-second
request deadline. `Retry-After` is honored; waits beyond the deadline return
fallback immediately. Access, quota, model-not-found, and invalid-request errors
do not retry. Upstream error bodies are neither logged nor returned.
Malformed input is HTTP 400; no saved player/profile
snapshot is 404; storage failures return a generic 500. Responses use `no-store`.

## Dashboard recommendations (Part 3)

The selected profile's dashboard has a separate **Recommendations** section below
the existing data views. Choose General progress, Farming, Mining, or Combat,
then click **Get recommendations**. Only that action, or a manual **Try again**,
sends the recommendation POST, containing just the goal. Opening the dashboard,
switching profiles/goals, inspecting Inventory, and browsing Timeline do not
generate recommendations. Timeline date selection does not change the latest
saved snapshot used by the recommendation endpoint.

Up to three ordered cards show priority, what to do, why it fits the goal, and
readable saved facts. Skill/collection zero values are preserved; unknown item
counts stay explicitly unrecorded. Each result shows **AI** or **Basic fallback**
and its own snapshot fetch time in the browser's local time zone. Saved data is
identified as historical rather than current progress.

The section handles loading, insufficient saved data, failed requests, and manual
retry. A pending request disables duplicate submission. A basic fallback explains whether AI was temporarily
unavailable, timed out, rejected access, reached a usage limit, or returned
unverifiable advice, without showing provider error bodies or credentials.
A player/profile/snapshot change remounts the section and cancels the old request; changing goals cancels
and clears it immediately. Late responses are ignored even if network cancellation
does not stop them. Response identity and goal must match the current selection
before cards are shown. Existing category and Timeline views remain independent.
On desktop the cards fit across the section; on mobile controls and cards stack.

## Configuration and checks

Set `GEMINI_API_KEY` privately in the root `.env` or server environment.
`GEMINI_MODEL` defaults to `gemini-3.8-flash` and can be overridden. The existing
server bootstrap loads `.env`; do not use a `VITE_` variable or expose the key
to the client. `.env.example` contains only an empty key variable. No key is
required to serve fallback results. A later synthetic check with a locally
configured key reached the model-list endpoint, but generation on
`gemini-3.8-flash` returned HTTP 503 on all three bounded attempts, including a
separate minimal request. With user approval, alternate-model checks found
`gemini-3.7-flash` also returned 503, while `gemini-3.6-flash` returned HTTP 200
and a nonempty plan that passed evidence validation using synthetic data. The
local model override was set to `gemini-3.6-flash`; the source default remains
`gemini-3.8-flash`. No credentials or real player data were included in the test output.
A later synthetic Farming check with skill levels, collections, and Inventory
returned two evidence-validated AI actions in about eight seconds using the
revised low-thinking setting. Another synthetic response was rejected by
validation, so availability and valid output still cannot be guaranteed per call.
A follow-up Combat/Mining validation fix added the goal-scoped generation schema
and synthetic regression coverage. Its live verification was blocked by HTTP 429
from the configured model; no quota or billing settings were changed.
After the user requested 3.1/3.5 alternatives, 3.1 Flash-Lite returned 503 and
3.5 Flash returned 429. A 3.5 Flash-Lite response exposed duplicate training
actions with different reasons. The bounded correction path and clearer prompt
were added without relaxing validation. Subsequent synthetic live checks on
3.5 Flash-Lite returned two valid Combat actions in about 18 seconds and three
valid Mining actions in about 20 seconds. The local model override is now
`gemini-3.5-flash-lite`; the key and all other local settings were preserved.
The later full-profile HTTP 400 fix was checked with 11 skills, 100 collections,
and 40 Inventory facts. Keeping the schema small and moving eligible combinations
into prompt data returned validated AI results for all four goals on the same
configured model: General (three actions, about 13 seconds), Farming (one, 16
seconds), Mining (three, 11 seconds), and Combat (two, 30 seconds including one
duplicate correction). These explicit checks used synthetic saved records only.

`server/gemini.js` calls the fixed Google `generateContent` REST endpoint with
the compact summary and v2 structured-output schema. Credentials are sent only
in `x-goog-api-key`. Model configuration cannot change the destination host.
The request omits `candidateCount`, which Gemini 3 does not support, and allows
4096 output tokens. Gemini 3 models use `thinkingLevel: LOW` for this bounded
selection task. The browser waits up to 60 seconds, leaving room for the saved
snapshot read and the server's full 45-second model deadline. The loading message
explains this wait. There are no tools, search, automatic generation, or startup calls.
Only an explicit POST invokes the model. Dashboard GETs do not generate plans.

References: [Gemini 3.8 Flash model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash),
[structured REST output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output?hl=en).

Run `npm test` and `npm run build`. Synthetic tests mock the model and database;
no real API credentials, live services, or saved player files are needed. Tests
cover valid selections/order, shape and priority violations, duplicate actions,
unknown evidence, invented numbers (digits and words), transport failures,
timeouts/abort, missing configuration, profile isolation, read-only behavior,
and the absence of model calls during browsing.

Run `node scripts/check-recommendations.cjs` for Chrome checks using mocked endpoint
responses and synthetic saved records. It checks the four backend-supported goals,
click-only POSTs and duplicate-click prevention, loading, all three cards, readable
evidence and confirmed zero, AI/basic labels, no usable data, failure/retry,
malformed or wrong-profile responses, and stale responses across goal/profile/
player changes. It also checks the existing data views and captures desktop/mobile
previews in the OS temporary directory. It needs installed Chrome/Chromium
(`CHROME_BIN` can override the default macOS location). It does not load `.env`,
call live Gemini/Hypixel, or connect to Atlas. Separate synthetic live checks
verified generation and evidence validation with the configured models; they do not
guarantee availability or valid output for every future player request.
