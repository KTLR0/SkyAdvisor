# Personal skill level progress

Work starts from merged `main` on `feature/skill-progress-bars`. No scores,
leaderboards, background polling, or extra player fetches are introduced.

## Threshold source and formula

Runtime thresholds come exclusively from the public official resource:
https://api.hypixel.net/v2/resources/skyblock/skills

The resource's `totalExpRequired` is **cumulative XP**, not XP per level. Each
skill has its own table and `maxLevel`; Runecrafting and Social must not reuse the
normal skill curve. The server validates a complete consecutive table with
strictly increasing finite thresholds before exposing it through
`GET /api/resources/skills`. No gaps are interpolated and no guessed curve is used.

For total player XP `x`, let `C[L]` be the cumulative threshold of the highest
completed level `L`, and `C[L+1]` the next threshold. At level zero, `C[0] = 0`.

```text
progress = 100 × (x - C[L]) / (C[L+1] - C[L])
remaining XP = C[L+1] - x
```

At an exact boundary, the new level starts at 0%. At a verified cap, the card says
**Max level** and has a full bar. Percentages are clamped into 0–100. Displayed
active progress is limited to 99.9% so rounding cannot say 100% prematurely.
Remaining XP is rounded upward to whole XP for display, never to a false zero.
Calculations retain the original fractional XP.

## Personal caps and unavailable values

Fixed-cap skills use the official resource maximum. Farming, Taming, Foraging,
and Runecrafting can have personal unlock/rank restrictions. XP alone does not
prove those unlocks. Known conservative boundaries are 50 for Farming/Taming/
Foraging and 3 for Runecrafting; below those thresholds the next-level calculation
is the same for all possible personal caps. At or beyond an unknown boundary,
level progress becomes **Unavailable**, without a percentage or progress bar.
A resource cap smaller than a guard is also treated as unverified.

Fresh normalization records Farming's explicit
`jacobs_contest.perks.farming_level_cap` as an additive cap upgrade from 50;
**zero upgrades are distinct from missing upgrades**. Old snapshots are not
rewritten. The current snapshot contract does not record Taming/Foraging unlocks
or Runecrafting rank; these remain unknown beyond their conservative boundaries.
No additional rank/player API request is added to fill those gaps.

Cap mapping references: the player-data mapping in
https://github.com/SkyCryptWebsite/SkyCrypt/blob/development/src/stats/skills.js
and base-cap constants in
https://github.com/SkyCryptWebsite/SkyCrypt/blob/development/src/constants/leveling.js .
These references describe cap restrictions only; none of their XP curves are used.
Official Taming unlock announcement:
https://hypixel.net/threads/skyblock-patch-notes-0-19-9-pet-training-and-bestiary-changes.5555803/ .

Missing/private/unreliable XP, malformed thresholds, invalid caps, or unavailable
metadata never become zero. Reliable total XP can still be displayed when the
level itself cannot be verified. Profile changes derive new bars directly from
that profile's entries; percentages are not stored in MongoDB.

## Caching and failures

The server holds one in-memory cache per process for 12 hours. Concurrent requests
share one fetch. Expiry refreshes only when an API request arrives. There are no
timers or background jobs. A validated cached table can be used for up to seven
days if refresh fails; the response is marked `stale` and the UI shows a warning.
Failed refreshes have a one-minute backoff. After seven days, or without any valid
cache, the endpoint returns 503; the UI hides percentages and offers manual retry.
A server restart starts with an empty metadata cache. No API key is needed.

## Verification and preview

`npm test` includes frozen official resource fixtures (version 0.27.2.12, retrieved
2026-10-22) plus tests for boundaries, fractional/zero XP, skill-specific curves,
max/personal caps, unavailable values, resource validation/cache/backoff, and the
Express metadata endpoint. Fixtures are test inputs, never runtime fallbacks.

For an installed Chrome/Chromium browser:

```sh
node scripts/check-skill-progress.cjs
```

On non-macOS systems set `CHROME_BIN` to the browser executable. This script starts
an isolated fixture-backed API and Vite, checks real rendered bars/accessibility,
profile switching, privacy, error/retry states, and mobile overflow, then shuts
those test processes down. It does not connect to Atlas or live player APIs.
Desktop/mobile screenshots are written to the system temporary directory; their
player values are entirely synthetic. Public live metadata can be checked
separately without refreshing any player snapshots.
