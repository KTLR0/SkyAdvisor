const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./app');
const { PLAYER_ID, PROFILE_A } = require('./fixtures/skyblock');

async function serve(t, progressionService) {
  const app = createApp({ progressionService });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api/players/${PLAYER_ID}/profiles/${PROFILE_A}/progression`;
}

async function post(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) });
  return { status: response.status, noStore: response.headers.get('cache-control'), body: await response.json() };
}

test('progression routes accept only server-authorized skill and option payloads', async t => {
  const calls = [];
  const url = await serve(t, { start: async (...args) => {
    calls.push(['start', ...args]);
    return { contractVersion: 1, sessionId: 'sample', turns: [] };
  }, continueSession: async (...args) => {
    calls.push(['continue', ...args]);
    return { contractVersion: 1, sessionId: args[2], turns: [] };
  } });
  const start = await post(url, { skill: 'mining', mode: 'collection' });
  assert.equal(start.status, 200);
  assert.equal(start.noStore, 'no-store');
  assert.deepEqual(calls[0], ['start', PLAYER_ID, PROFILE_A, 'mining', 'collection']);
  const next = await post(`${url}/some-session/continue`, { optionId: '3' });
  assert.equal(next.status, 200);
  assert.deepEqual(calls[1], ['continue', PLAYER_ID, PROFILE_A, 'some-session', '3']);
  assert.equal((await post(url, { skill: 'mining', mode: 'item', playerFacts: {} })).status, 400);
  assert.equal((await post(`${url}/some-session/continue`, { optionId: '1', history: [] })).status, 400);
  assert.equal(calls.length, 2, 'Invalid bodies never reach a service');
});

test('progression routes return safe errors without exposing provider internals', async t => {
  const url = await serve(t, { start: async () => {
    throw Object.assign(new Error('Hypixel public metadata is unavailable.'), { status: 503, safe: true });
  } });
  const result = await post(url, { skill: 'farming', mode: 'item' });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'Hypixel public metadata is unavailable.');
});

test('collection-specific starts accept only the exact collection ID payload', async t => {
  const calls = [];
  const url = await serve(t, { startCollection: async (...args) => {
    calls.push(args);
    return { contractVersion: 1, objective: { id: args[2] }, turns: [] };
  } });
  const result = await post(url, { collectionId: 'LOG:2' });
  assert.equal(result.status, 200);
  assert.equal(result.noStore, 'no-store');
  assert.deepEqual(calls, [[PLAYER_ID, PROFILE_A, 'LOG:2']]);
  for (const extra of [{ skill: 'foraging' }, { mode: 'collection' }, { amount: 100 }, { playerFacts: {} }]) {
    assert.equal((await post(url, { collectionId: 'LOG:2', ...extra })).status, 400);
  }
  assert.equal(calls.length, 1);
});
