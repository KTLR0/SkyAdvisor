const express = require('express');

const app = express();

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/player/:username', async (req, res) => {
  const username = req.params.username.trim();

  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    return res.status(400).json({
      error: 'Use a Minecraft Java username with 3–16 letters, numbers, or underscores.',
    });
  }

  try {
    const response = await fetch(
      `https://api.minecraftservices.com/minecraft/profile/lookup/name/${encodeURIComponent(username)}`,
      { signal: AbortSignal.timeout(5000) },
    );

    if (response.status === 404 || response.status === 204) {
      return res.status(404).json({ error: 'No Minecraft player found with that username.' });
    }

    if (response.status === 429) {
      return res.status(503).json({ error: 'Minecraft is receiving too many requests. Try again shortly.' });
    }

    if (!response.ok) {
      return res.status(502).json({ error: 'Minecraft lookup is unavailable. Try again shortly.' });
    }

    const profile = await response.json();
    if (typeof profile?.id !== 'string' || !/^[a-f0-9]{32}$/i.test(profile.id)
        || typeof profile?.name !== 'string' || !profile.name) {
      return res.status(502).json({ error: 'Minecraft returned an unexpected response. Try again shortly.' });
    }

    res.json({ name: profile.name, uuid: profile.id });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return res.status(504).json({ error: 'Minecraft lookup timed out. Please try again.' });
    }

    res.status(502).json({ error: 'Could not reach Minecraft. Please try again.' });
  }
});

// Keep routes separate from listening so tests can use an available local port.
module.exports = app;
