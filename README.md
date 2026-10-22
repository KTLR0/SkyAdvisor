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
2. Choose **Continue to SkyBlock data**. Previously saved profiles load from MongoDB.
3. Use **Fetch fresh data** to request and save this one player's profiles.
4. Select a profile and a category. Skills show XP, Collections show item counts,
   and Inventory shows item cards with count, location, lore, and optional NBT details.

The header shows the selected player/profile and the snapshot's fetch time.
A real zero is shown as zero. Missing, private, empty, and undecodable data have
separate states. Existing schema-1 snapshots remain readable but ambiguous older
zeros are marked unavailable until a fresh fetch.

Fetches are manual only: once per hour and at most four per rolling 24 hours per
player. A database lock prevents overlapping requests. Reloading saved data and
switching profiles do not contact Hypixel or consume the fetch allowance.

## Checks

```sh
npm test
npm run build
```

Tests use synthetic fixtures and local HTTP; they need no live API or database.
They cover lookup/errors, normalization, NBT items, save/readback, duplicates,
transaction rollback, and rate limits. These fixture checks do not prove live
Atlas/Hypixel connectivity. Build output goes into `client/dist/`; production
hosting is not configured by this project.

## Important files

- `client/src/App.jsx`: username lookup and dashboard navigation.
- `client/src/SkyblockPage.jsx`: profile selection and category displays.
- `server/app.js`: health, identity, snapshots/history, and manual fetch routes.
- `server/minecraft.js`: canonical Minecraft username/UUID resolution.
- `server/normalize.js`: predictable, availability-aware category objects.
- `server/skyblock.js`: identity checks, fetching, atomic persistence, and readback.
- `server/database.js`: MongoDB setup and transaction lifecycle.
- `docs/data-contract.md`: stored/API shapes and legacy compatibility.

`test.js`, `cache.json`, and tracked `PlayerData/` files are preserved legacy export
experiments. The app does not use them as a database fallback. `test.js` is not a
test suite and still has an incomplete username lookup URL. Dependencies, local
credentials, and build output are ignored. Existing tracked data remains tracked.
