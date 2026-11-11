# SkyAdvisor

A JavaScript React/Vite dashboard with an Express API and MongoDB Atlas snapshots.
Look up a Minecraft Java username, manually fetch its Hypixel SkyBlock profiles,
and switch between saved profiles to view skill XP, collection counts, and items.

## Setup

Install Node.js 24 or newer, including npm. On macOS with Homebrew:

```sh
brew install node@24
export PATH="$(brew --prefix node@24)/bin:$PATH"
```

From the repository root:

```sh
npm install
test -f .env || cp .env.example .env
```

Configure these names in the root `.env` (never commit credentials):

- `MONGODB_URI`: required; use your MongoDB Atlas connection URI.
- `MONGODB_USERNAME` and `MONGODB_PASSWORD`: needed if the URI uses credential
  placeholders or does not already contain credentials.
- `MONGODB_DATABASE`: optional database name.
- `HYPIXEL_API_KEY`: required for fresh Hypixel fetches, not for reading saved data.
- `GEMINI_API_KEY`: optional, server-only; enables explicit AI recommendation requests.
- `GEMINI_MODEL`: optional, defaults to `gemini-3.8-flash`.
- `PORT`: optional Express port, also used by Vite's API proxy.

Allow your machine's network address in Atlas and give the database user read/write
and index permissions. The server connects to MongoDB and initializes indexes
before listening. Atlas transactions are used to keep snapshots and fetch accounting
consistent; a standalone MongoDB instance without replica-set support is insufficient.

```sh
npm run dev
```

Open **http://127.0.0.1:5173**. Vite forwards `/api` requests to Express (default
**http://127.0.0.1:3001**). Stop both processes with **Ctrl+C**. If a port is occupied,
stop that process or change `PORT` for Express, then restart both apps.

## Use the dashboard

1. Enter a Minecraft Java username and choose **Find player**.
2. Choose **Continue to SkyBlock data**. Previously saved profiles load from MongoDB
   and **Overview** opens first. It previews two saved skills, reliable collection
   counts, and a Timeline shortcut. Use **View Skills** or **View Collections**
   to open the full category; Overview has no generic planning action.
3. Use **Fetch fresh data** to request and save this one player's profiles.
4. Use the header’s **Profile** selector to switch saved profiles and the category
   navigation to browse their data. On narrow screens, scroll the category strip
   horizontally. Skills show personal level progress, Collections show item counts,
   and Inventory shows item cards with count, location, lore, and optional NBT details.
5. Choose **Timeline** to browse this profile's saved snapshots. Scroll the dated
   buttons, select a date, or use **Previous** (older) / **Next** (newer).
   **Load older snapshots** reads the next saved page. Skills XP and Collections
   counts show changes from the immediate predecessor, with explicit unavailable
   and unexpected decrease labels. The first snapshot has no comparison baseline.
6. Use **Plan next steps** on a Skills card or Collections row. The planner opens
   with that skill or exact collection selected. Skill plans offer **Find my next
   item** and **Choose my next collection**; collection plans target the clicked
   collection’s next verified tier. Press **Build step-by-step guide**, continue
   with the three follow-up choices, and **Download steps (.txt)** to export.
   Use **Back to Skills** or **Back to Collections** to return. Reopening the same
   button restores the current guide; selecting a different target resets it.
   Player/profile/snapshot changes also reset and cancel pending work. Browsing or
   opening a planner does not generate advice.

Timeline browsing only calls saved-snapshot GET routes. It does not fetch Hypixel
data or skill thresholds, refresh the player, or write to MongoDB. Profile changes
reset its dates and selection. Snapshot times are shown in your browser's local
time zone. To see newly saved records, reopen Timeline after an explicit refresh.

The compact header shows the selected player/profile and the saved snapshot time.
**Change player** returns to lookup. **Data details & fetch limits** contains the
optional UUIDs and manual-fetch limits. **Fetch fresh data** saves new data;
**Reload saved data** reads existing snapshots. Neither action is automatic.
A real zero is shown as zero. Missing, private, empty, and undecodable data have
separate states. Existing schema-1 snapshots remain readable but ambiguous older
zeros are marked unavailable until a fresh fetch. Skill levels use the official
Hypixel Skills resource, cached for 12 hours without polling. Missing or
unverified personal level caps suppress progress rather than guessing. See
`docs/skill-progress.md` for formulas, caps, and caching behavior.

Fetches are manual only: once per hour and at most four per rolling 24 hours per
player. A database lock prevents overlapping requests. Reloading saved data and
switching profiles do not request new player data from Hypixel or consume the
player fetch allowance.

## Checks

```sh
npm test
npm run build
node scripts/check-timeline.cjs
node scripts/check-next-steps.cjs
```

Tests use synthetic fixtures and local HTTP; they need no live API or database.
They cover lookup/errors, normalization, NBT items, save/readback, duplicates,
transaction rollback, and rate limits. These fixture checks do not prove live
Atlas/Hypixel connectivity. Build output goes into `client/dist/`; production
hosting is not configured by this project.

The timeline browser check uses synthetic records and temporary local servers;
it checks paging, selection, missing values, decreases, errors/retries, profile
switching, mobile layout, and that browsing sends only saved-snapshot GETs. It
requires an installed Chrome/Chromium browser (set `CHROME_BIN` if not at the
default macOS Chrome path). Preview screenshots are written to the OS temporary
directory. It does not read `.env` or connect to Atlas/Hypixel.

The dashboard browser check uses synthetic saved profiles, mocked model/resources,
and in-memory planner sessions. It covers the initial Overview, first-screen layout,
profile switching, missing/private values, category shortcuts, and skill and collection
entry points and both skill paths, follow-ups, TXT export, profile/skill/snapshot resets,
request cancellation, unavailable skills, and the absence of the old Recommendations
panel or automatic generation requests. It does not use credentials or live services.

## Important files

- `client/src/App.jsx`: username lookup and dashboard navigation.
- `client/src/SkyblockPage.jsx`: profile selection and category displays.
- `client/src/ProgressionChat.jsx`: the contextual skill/collection planner.
- `server/app.js`: health, identity, snapshots/history, and manual fetch routes.
- `server/minecraft.js`: canonical Minecraft username/UUID resolution.
- `server/normalize.js`: predictable, availability-aware category objects.
- `server/skill-resource.js`: validated, cached official skill thresholds.
- `client/src/OverviewView.jsx`: saved Skills/Collections previews and a Timeline shortcut.
- `client/src/SkillsView.jsx` and `skill-progress.js`: accessible personal progress cards and calculations.
- `client/src/useSkillResource.js`: one shared threshold loader for Overview and Skills.
- `server/skyblock.js`: identity checks, fetching, atomic persistence, and readback.
- `server/database.js`: MongoDB setup and transaction lifecycle.
- `docs/data-contract.md`: stored/API shapes and legacy compatibility.
- `server/ai-recommendations.js`, `server/recommendation-service.js`, and
  `docs/ai-recommendations.md`: saved-only AI input, explicit backend recommendation
  requests, verified text rendering, and deterministic fallback behavior.

`test.js`, `cache.json`, and tracked `PlayerData/` files are preserved legacy export
experiments. The app does not use them as a database fallback. `test.js` is not a
test suite and still has an incomplete username lookup URL. Dependencies, local
credentials, and build output are ignored. Existing tracked data remains tracked.
