function lookupError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function resolvePlayer(username, request = globalThis.fetch) {
  try {
    const response = await request(
      `https://api.minecraftservices.com/minecraft/profile/lookup/name/${encodeURIComponent(username)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (response.status === 404 || response.status === 204) {
      throw lookupError(404, 'No Minecraft player found with that username.');
    }
    if (response.status === 429) throw lookupError(503, 'Minecraft is receiving too many requests. Try again shortly.');
    if (!response.ok) throw lookupError(502, 'Minecraft lookup is unavailable. Try again shortly.');
    const player = await response.json();
    if (typeof player?.id !== 'string' || !/^[a-f0-9]{32}$/i.test(player.id)
        || typeof player?.name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(player.name)
        || player.name.toLowerCase() !== username.toLowerCase()) {
      throw lookupError(502, 'Minecraft returned an unexpected response. Try again shortly.');
    }
    return { name: player.name, uuid: player.id.toLowerCase() };
  } catch (error) {
    if (error.status) throw error;
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw lookupError(504, 'Minecraft lookup timed out. Please try again.');
    }
    throw lookupError(502, 'Could not reach Minecraft. Please try again.');
  }
}

module.exports = { resolvePlayer };
