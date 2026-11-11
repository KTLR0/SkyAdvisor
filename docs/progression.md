# Wiki-backed skill progression (contract v1)

The existing `/recommendations` API (contract v2) remains available but has no
player-facing dashboard panel. A contextual planner opens from Skills or Collections;
it has no separate main-navigation item or generic skill picker.

## Player workflow

1. Select **Plan next steps** on a Skills card or a Collections row. The heading
   identifies the clicked skill or collection.
2. For a skill, choose **Find my next item** or **Choose my next collection**. A
   collection entry already targets that exact collection; it has no route picker.
3. Press **Build step-by-step guide**.
4. For skill requests, Gemini picks one objective from official Hypixel public
   resource candidates using the latest stored snapshot, and the server verifies
   the ID. For a collection-specific request, the server binds the exact selected
   ID to its saved count and official next-tier metadata, bypassing model selection.
   Pet recommendations may use a small curated species list whose selected Wiki
   page must exist; `PET:` IDs are internal species keys, not Hypixel item IDs.
5. The server retrieves the corresponding official Hypixel SkyBlock Wiki article.
   Gemini uses that article, the selected candidate's verified metadata, and the
   saved snapshot to write 2–6 actionable steps and exactly three choices.
6. Each selected choice becomes a new turn, carrying the original objective and
   prior steps. **Download steps (.txt)** exports all accumulated steps locally.

There is a single planner for the current player/profile/snapshot and chosen target.
**Back to Skills** or **Back to Collections** returns to the entry page. Navigating
away and reopening the same target restores its current guide, follow-ups, and
export. Selecting a different skill/collection resets the guide. Player, profile,
or snapshot changes reset it and cancel pending work; late responses cannot fill
a new selection. Opening the planner does not generate advice until **Build
step-by-step guide** is pressed. Buttons are offered only for reliable saved values.

## API

All requests have `Cache-Control: no-store`; bodies accept only the named fields.

`POST /api/players/:playerUuid/profiles/:profileId/progression`

```json
{ "skill": "mining", "mode": "item" }
```

Or target a specific collection, preserving legacy variants such as `LOG:2`:

```json
{ "collectionId": "LOG:2" }
```

These are exclusive request shapes: collection requests do not accept browser
counts, skill/category guesses, mode, history, or other facts. The server requires
reliable progress for this exact ID in this player/profile's latest snapshot,
looks up official metadata, derives the skill category, and fixes the objective.
No saved skill XP is required for this path; absent XP remains unknown. Missing or
unsupported collection data and a collection without a next tier return 422,
rather than substituting another collection. Public metadata outages return 503.
The response and follow-up contract remain v1; `objective.id` must match the
requested collection, and subsequent turns retain that verified objective.

For skill requests, `mode` is `item` or `collection`, and `skill` must be present in the selected
profile's latest saved Skills data. The server never trusts browser-provided
player facts, candidates, or Wiki content. Results include `sessionId`, `skill`,
`mode`, `objective` (including official Wiki link and verification status),
`snapshot`, and an array of turns. Each turn has a heading, summary, steps,
three options with ids `"1"`..`"3"`, and the chosen prior option if applicable.

`POST /api/players/:playerUuid/profiles/:profileId/progression/:sessionId/continue`

```json
{ "optionId": "2" }
```

Only the **last** turn's three options may be selected. The server looks up the
stored option; client text or history is never accepted. Sessions are held in
MongoDB `progressionSessions` with a two-hour expiry and at most 12 turns. An
optimistic revision check prevents concurrent updates from overwriting another
turn. `database.getDatabase()` creates an expiry index during normal server
initialization. Sessions are scoped to their player and profile UUIDs.

## Sources and accuracy

- Official, no-key public item and collection metadata:
  `https://api.hypixel.net/v2/resources/skyblock/items` and
  `https://api.hypixel.net/v2/resources/skyblock/collections`.
- Official Wiki article: retrieved via MediaWiki's `api.php?action=parse`
  endpoint; a direct article HTML fallback is used when that API is unavailable.
  One article is retrieved at the start of each new objective and reused for
  follow-up choices. Responses have timeouts and in-memory caching.
- Player facts: latest `skyblockSnapshots` document for the supplied UUID and
  profile. No Hypixel player API requests or automatic polling are performed.

Items already recorded in readable inventory, armor, equipment, ender chest,
accessories, backpacks, or pets are excluded from item candidates. If *every*
container is readable, the item is marked absent from the saved containers. If
some containers are hidden/partial, it is merely **not found in readable
containers**; the UI displays that warning. With no readable inventory the item
path refuses to make a recommendation. Missing collection counts are never
interpreted as zero. Collection-tier targets come from official metadata.

## Operational requirements

- Root `.env` needs `GEMINI_API_KEY`, `GEMINI_MODEL`, and the existing MongoDB
  settings; the model must support Gemini structured JSON outputs.
- Two Gemini calls per skill-chosen objective (selection + guide), one per
  explicitly selected collection guide, and one per follow-up;
  failed guide validation may require one additional call. Consider account
  quota/rate limiting and cost controls before public deployment.
- The official Wiki may temporarily block API and page requests. The server
  returns a safe error instead of generating ungrounded crafting instructions.
- A linked article and supported item ID do **not** prove that the model's
  suggested item is globally optimal. Full optimization would require additional
  verified resource data (e.g., economy, unlocked areas, game mode, prices).
- Wiki-derived prose may be imperfect or outdated: review the linked source.
- Existing endpoints are not authenticated by this feature. Add server-side
  authentication, per-account rate limiting, and abuse protection before opening
  paid Gemini access to arbitrary public traffic.

## Verification

Run from the root: `npm test`, `npm run build`, and
`node scripts/check-next-steps.cjs`. Exercise both
starting modes, several successive follow-up choices, storage-unavailable
warnings, profile switching, Wiki downtime, and TXT export in the browser.
