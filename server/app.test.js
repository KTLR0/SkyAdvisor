const assert = require('node:assert/strict');
const http = require('node:http');
const { before, after, afterEach, test, mock } = require('node:test');
const app = require('./app');

let server;
let baseUrl;
const profile = { id: '849c4c836b424fbfb845aca13c122204', name: 'Phia98' };

before(async () => {
  server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', (error) => {
      if (error) reject(error);
      else resolve(listener);
    });
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && new Promise((resolve) => server.close(resolve)));
afterEach(() => mock.restoreAll());

// Use HTTP for local requests so mocked fetch affects only the Minecraft call.
function request(path) {
  return new Promise((resolve, reject) => {
    http.get(baseUrl + path, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      response.on('error', reject);
    }).on('error', reject);
  });
}

test('health check still works', async () => {
  assert.deepEqual(await request('/api/health'), { status: 200, body: { status: 'ok' } });
});

test('returns the canonical player name and UUID', async () => {
  const upstream = mock.method(globalThis, 'fetch', async () => Response.json(profile));
  assert.deepEqual(await request('/api/player/phia98'), {
    status: 200, body: { name: profile.name, uuid: profile.id },
  });
  assert.equal(upstream.mock.calls[0].arguments[0],
    'https://api.minecraftservices.com/minecraft/profile/lookup/name/phia98');
  assert.ok(upstream.mock.calls[0].arguments[1].signal instanceof AbortSignal);
});

test('rejects invalid usernames without contacting Minecraft', async () => {
  const upstream = mock.method(globalThis, 'fetch', async () => { throw new Error('Must not fetch'); });
  for (const username of ['ab', '12345678901234567', 'bad-name', 'bad%2Fname', '%20%20%20']) {
    assert.equal((await request(`/api/player/${username}`)).status, 400);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test('trims surrounding spaces before lookup', async () => {
  const upstream = mock.method(globalThis, 'fetch', async () => Response.json(profile));
  assert.equal((await request('/api/player/%20Phia98%20')).status, 200);
  assert.equal(upstream.mock.calls[0].arguments[0],
    'https://api.minecraftservices.com/minecraft/profile/lookup/name/Phia98');
});

test('returns 404 for missing players', async () => {
  for (const status of [404, 204]) {
    mock.method(globalThis, 'fetch', async () => new Response(null, { status }));
    const result = await request('/api/player/MissingPlayer');
    assert.equal(result.status, 404);
    assert.match(result.body.error, /No Minecraft player/);
    mock.restoreAll();
  }
});

test('returns a retry message when Minecraft rate limits requests', async () => {
  mock.method(globalThis, 'fetch', async () => new Response(null, { status: 429 }));
  const result = await request('/api/player/Phia98');
  assert.equal(result.status, 503);
  assert.match(result.body.error, /Try again/);
});

test('handles upstream failure and malformed responses', async () => {
  for (const response of [
    new Response(null, { status: 500 }),
    new Response('<html>Failure</html>'),
    Response.json({ id: 'invalid', name: 'Phia98' }),
    Response.json({ id: [profile.id], name: 'Phia98' }),
    Response.json(null),
  ]) {
    mock.method(globalThis, 'fetch', async () => response);
    assert.equal((await request('/api/player/Phia98')).status, 502);
    mock.restoreAll();
  }
});

test('handles network failures without exposing internal details', async () => {
  mock.method(globalThis, 'fetch', async () => { throw new Error('Private upstream detail'); });
  const result = await request('/api/player/Phia98');
  assert.equal(result.status, 502);
  assert.equal(result.body.error, 'Could not reach Minecraft. Please try again.');
});

test('reports timeouts', async () => {
  mock.method(globalThis, 'fetch', async () => {
    throw new DOMException('Timed out', 'TimeoutError');
  });
  const result = await request('/api/player/Phia98');
  assert.equal(result.status, 504);
  assert.match(result.body.error, /timed out/);
});
