const express = require('express');
const { resolvePlayer } = require('./minecraft');

const skyblock = require('./skyblock');

function createApp({ service = skyblock, resolveMinecraftPlayer = resolvePlayer,
  getApiKey = () => process.env.HYPIXEL_API_KEY } = {}) {
  const { fetchSkyBlockData, loadLatestSkyBlockData, loadSkyBlockHistory, loadSkyBlockSnapshot } = service;

  const app = express();

  app.use(express.json());

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/player/:username', async (req, res) => {
    const username = req.params.username.trim();
    if (!/^[A-Za-z0-9_]{1,16}$/.test(username)) {
      return res.status(400).json({ error: 'Use a Minecraft Java username with 1–16 letters, numbers, or underscores.' });
    }
    try {
      return res.json(await resolveMinecraftPlayer(username));
    } catch (error) {
      return res.status(error.status || 502).json({ error: error.message });
    }
  });

  app.get('/api/player/:username/skyblock', async (req, res) => {
    const username = req.params.username.trim();

    if (!/^[A-Za-z0-9_]{1,16}$/.test(username)) {
      return res.status(400).json({
        error: 'Invalid Minecraft username.',
      });
    }

    if (req.query.uuid !== undefined && (typeof req.query.uuid !== 'string' || !/^[a-f0-9]{32}$/i.test(req.query.uuid))) {
      return res.status(400).json({ error: 'Invalid Minecraft UUID.' });
    }
    try {
      return res.json(
        await loadLatestSkyBlockData(username, req.query.uuid),
      );
    } catch (error) {
      console.error(
        'Could not load MongoDB SkyBlock data:',
        error,
      );

      return res.status(500).json({
        error: 'Stored SkyBlock data could not be loaded. Check the MongoDB connection and server logs.',
      });
    }
  });

  app.get('/api/player/:username/skyblock/history', async (req, res) => {
    const username = req.params.username.trim();
    if (!/^[A-Za-z0-9_]{1,16}$/.test(username)) {
      return res.status(400).json({ error: 'Invalid Minecraft username.' });
    }
    try {
      return res.json(await loadSkyBlockHistory(username));
    } catch (error) {
      console.error('Could not load MongoDB snapshot history:', error);
      return res.status(500).json({ error: 'Snapshot history could not be loaded. Check the MongoDB connection and server logs.' });
    }
  });

  app.get('/api/player/:username/skyblock/history/:timestamp', async (req, res) => {
    const username = req.params.username.trim();
    if (!/^[A-Za-z0-9_]{1,16}$/.test(username)) {
      return res.status(400).json({ error: 'Invalid Minecraft username.' });
    }
    try {
      return res.json(await loadSkyBlockSnapshot(
        username,
        req.params.timestamp,
        req.query.profileId,
      ));
    } catch (error) {
      if (error.message === 'Invalid snapshot timestamp.' || error.message === 'Invalid profile ID.') {
        return res.status(400).json({ error: error.message });
      }
      console.error('Could not load historical SkyBlock snapshot:', error);
      return res.status(500).json({ error: 'Historical snapshot could not be loaded. Check the MongoDB connection and server logs.' });
    }
  });

  /*
   * Explicit user-initiated SkyBlock data fetch.
   *
   * There is deliberately NO timer, polling loop, startup fetch,
   * background refresh, or scheduled task associated with this route.
   */
  app.post('/api/player/:username/skyblock', async (req, res) => {
    const username = req.params.username.trim();
    const { uuid } = req.body || {};

    if (!/^[A-Za-z0-9_]{1,16}$/.test(username)) {
      return res.status(400).json({
        error: 'Invalid Minecraft username.',
      });
    }

    if (
      typeof uuid !== 'string' ||
      !/^[a-f0-9]{32}$/i.test(uuid)
    ) {
      return res.status(400).json({
        error: 'Invalid Minecraft UUID.',
      });
    }

    try {
      const result = await fetchSkyBlockData({
        username,
        uuid,
        apiKey: getApiKey(),
      });

      return res.json({
        success: true,
        ...result,
      });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      if (error.code === 'PLAYER_MISMATCH') return res.status(409).json({ error: error.message });
      if (error.code === 'FETCH_IN_PROGRESS') {
        return res.status(409).json({ error: error.message });
      }

      if (error.code === 'FETCH_TOO_SOON') {
        res.set('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
        return res.status(429).json({
          error: error.message,
          retryAfterMs: error.retryAfterMs,
          fetchesLast24Hours: error.fetchesLast24Hours,
        });
      }

      if (error.code === 'FETCH_DAILY_LIMIT') {
        res.set('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
        return res.status(429).json({
          error: error.message,
          retryAfterMs: error.retryAfterMs,
          fetchesLast24Hours: error.fetchesLast24Hours,
        });
      }

      if (error.code === 'HYPIXEL_TIMEOUT') {
        return res.status(504).json({
          error: error.message,
        });
      }

      if (
        error.code === 'HYPIXEL_NETWORK' ||
        error.code === 'HYPIXEL_INVALID_RESPONSE'
      ) {
        return res.status(502).json({
          error: error.message,
        });
      }

      if (error.code === 'NO_PROFILES') {
        return res.status(404).json({
          error: 'No SkyBlock profiles were found for this player.',
        });
      }

      if (error.code === 'HYPIXEL_AUTH') {
        console.error('Hypixel authentication failed:', error.message);
        return res.status(502).json({
          error: 'Hypixel rejected the API key. Confirm the current key is in the root .env as HYPIXEL_API_KEY, then restart the server. Check the server log for Hypixel’s rejection reason.',
        });
      }

      if (error.code === 'HYPIXEL_RATE_LIMIT') {
        console.error('Hypixel API rate limit reached:', error.message);
        return res.status(429).json({
          error: 'Hypixel rate-limited this API key. Wait for the API key limit to reset before trying again.',
        });
      }

      if (error.code === 'HYPIXEL_API_ERROR') {
        console.error(`Hypixel API error (HTTP ${error.httpStatus || 'unknown'}):`, error.message);
        return res.status(502).json({
          error: `Hypixel API request failed (HTTP ${error.httpStatus || 'unknown'}). Check the server console for the rejection reason.`,
        });
      }

      if (error.message === 'Hypixel API key is not configured.') {
        return res.status(500).json({
          error: 'Hypixel API key is not configured on the server.',
        });
      }

      console.error('SkyBlock fetch failed:', error);

      return res.status(500).json({
        error: 'SkyBlock data could not be retrieved.',
      });
    }
  });

  return app;
}

// Keep routes separate from listening so tests can use an available local port.
module.exports = createApp();
module.exports.createApp = createApp;