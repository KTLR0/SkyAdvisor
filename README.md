# SkyAdvisor

Stage 2: a React page built with Vite and a small Express server. Enter a Minecraft
Java username to see its canonical player name and UUID. The page also checks
`GET /api/health`. No Hypixel or database features are connected.

## Install and run

Install **Node.js 24 or newer** (including npm) from https://nodejs.org/.
On macOS with Homebrew, you can instead use:

```sh
brew install node@24
export PATH="$(brew --prefix node@24)/bin:$PATH"
```

With that Homebrew installation, run the export in each new terminal, or add it
to your shell configuration. From this repository's root:

```sh
npm install
test -f .env || cp .env.example .env
npm run dev
```

Copy `.env.example` only if you do not already have a root `.env`. Configuration
is optional: the server defaults to port 3001. `PORT` in the root `.env` changes
both the server port and Vite's proxy target; restart `npm run dev` after changing it.

Open **http://127.0.0.1:5173**. You should see **Server is running**.
Vite forwards `/api` requests to Express at `http://127.0.0.1:3001`.
Click **Check again** to repeat the check. Stop both processes with **Ctrl+C**.
If port 5173 is occupied, stop the other app first. For port 3001, stop the other
app or choose another `PORT` in `.env`.

Check the API directly (use your configured port if different):

```sh
curl http://127.0.0.1:3001/api/health
```

Expected response: `{"status":"ok"}`.

## Username lookup

Enter a username such as `Phia98` and click **Find player**. Express calls
`https://api.minecraftservices.com/minecraft/profile/lookup/name/{username}`.
This public lookup needs internet access, but no API key.

```sh
curl http://127.0.0.1:3001/api/player/Phia98
```

Response: `{"name":"Phia98","uuid":"849c4c836b424fbfb845aca13c122204"}`.
Names must contain 3–16 letters, numbers, or underscores. Surrounding spaces are
trimmed. Errors return `{ "error": "..." }`: 400 for invalid input, 404 for a missing
player, 502 for an upstream failure, 503 for upstream rate limiting, or 504 for a
five-second upstream timeout. Lookups are not cached in this stage.

Run the server route tests (they mock Minecraft and do not need internet):

```sh
npm test
```

## Build

```sh
npm run build
```

This creates the browser files in `client/dist/`. Express runs JavaScript
directly, so it needs no compilation. This stage does not configure production
hosting or serve the build from Express; use `npm run dev` for the working app.

## Files

- `client/src/App.jsx`: username form, results, and server status display.
- `client/vite.config.js`: React setup and development API proxy.
- `server/index.js`: environment configuration and server startup.
- `server/app.js`: Express health and player lookup routes.
- `server/app.test.js`: route tests using Node's built-in test runner.
- Root `package.json`: npm workspaces and commands for both apps. One root
  `package-lock.json` records dependencies; no separate installs are needed.
- `test.js`: preserved standalone Hypixel export experiment, **not a test suite**.
  It is not run by the app or build. Its original dependencies remain installed.
  Its uncached username lookup URL appears incomplete; review it in a later stage
  before using it. A future move to `scripts/` must update its `__dirname` paths.
- `cache.json`: preserved username-to-UUID cache used by that experiment.
- `PlayerData/Phia98/`: preserved JSON snapshots for Kiwi, Orange, Papaya, and
  Peach dated 2026-09-23. They are not loaded by this app.

Existing tracked cache and snapshot files stay tracked and unchanged; newly
generated local data is ignored. Dependencies, build output, and local `.env`
files are ignored. No Hypixel key or AWS credentials are needed for Stage 2.
