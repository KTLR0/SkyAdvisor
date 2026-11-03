# Wiki-backed skill progression (contract v1)

The existing `/recommendations` API (contract v2) is unchanged. The branching
progression workflow starts from a skill card on the Skills dashboard.

## Player workflow

1. Select **Plan next steps** on a saved skill card.
2. Choose **Find my next item** or **Choose my next collection**.
3. Press **Build step-by-step guide**.
4. Gemini picks exactly one objective from official Hypixel public resource
   candidates, using the latest stored snapshot. The server verifies the ID.
   Pet recommendations may use a small curated species list whose selected Wiki
   page must exist; `PET:` IDs are internal species keys, not Hypixel item IDs.
5. The server retrieves the corresponding official Hypixel SkyBlock Wiki article.
   Gemini uses that article, the selected candidate's verified metadata, and the
   saved snapshot to write 2–6 actionable steps and exactly three choices.
6. Each selected choice becomes a new turn, carrying the original objective and
   prior steps. **Download steps (.txt)** exports all accumulated steps locally.

## API

All requests have `Cache-Control: no-store`; bodies accept only the named fields.

`POST /api/players/:playerUuid/profiles/:profileId/progression`

```json
{ "skill": "mining", "mode": "item" }
```

`mode` is `item` or `collection`. `skill` must be present in the selected
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
- Two Gemini calls per new objective (selection + guide) and one per follow-up;
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

Run from the root: `npm install`, `npm test`, `npm run build`. Exercise both
starting modes, several successive follow-up choices, storage-unavailable
warnings, profile switching, Wiki downtime, and TXT export in the browser.
