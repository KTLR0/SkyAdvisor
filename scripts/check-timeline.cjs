// Focused browser regression using synthetic saved records. No Atlas/API credentials.
// Requires installed Chrome/Chromium; set CHROME_BIN if necessary.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { createSkyBlockService } = require('../server/skyblock');
const { createTimelineService } = require('../server/timeline');
const { createMemoryDatabase } = require('../server/test-support/memory-db');
const { timelineRows, skill, collection } = require('../server/fixtures/timeline');
const { PLAYER, PLAYER_ID, PROFILE_A, PROFILE_B, FETCHED_AT } = require('../server/fixtures/skyblock');
const { officialSkillsFixture } = require('../server/fixtures/skill-resource');
const { normalizeSkillResource } = require('../server/skill-resource');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const PROFILE_C = 'cccccccccccccccccccccccccccccccc';
let chrome, ws, vite, api;

async function run() {
  const memory = createMemoryDatabase();
  const rows = timelineRows();
  for (let day = 1; day <= 6; day++) rows.push({
    _id: `older-${day}`, schemaVersion: 2, playerUuid: PLAYER_ID, profileId: PROFILE_A,
    fetchedAt: new Date(`2026-10-0${day}T12:00:00.000Z`),
    data: { Skills: skill((day - 1) * 10), Collections: collection((day - 1) * 2) },
  });
  rows[4].data.Collections = collection(5); // Reliable decrease from 10.
  for (const row of rows) {
    row.profileName = row.profileId.replaceAll('-', '').toLowerCase() === PROFILE_A ? 'Apple' : 'Banana';
    row.selected = row.profileName === 'Apple';
  }
  memory.rows('players').push({ uuid: PLAYER_ID, username: PLAYER.name });
  memory.rows('skyblockSnapshots').push(...rows);
  const before = JSON.stringify(memory.rows('skyblockSnapshots'));
  let forbiddenCalls = 0, resourceCalls = 0, failList = false, failDetail = false, slowDetail = false;
  const forbidden = () => { forbiddenCalls++; throw new Error('External calls and writes forbidden.'); };
  const readonly = { collection(name) {
    const col = memory.db.collection(name);
    return { find: col.find, findOne: col.findOne, aggregate: col.aggregate };
  } };
  const service = createSkyBlockService({ getDatabase: async () => readonly,
    withDatabaseTransaction: forbidden, request: forbidden, resolveMinecraftPlayer: forbidden });
  const originalLatest = service.loadLatestSkyBlockData;
  service.loadLatestSkyBlockData = async (...args) => {
    const saved = await originalLatest(...args);
    // Simulate history becoming empty after the dashboard's profile list was saved.
    saved.profiles.push({ profile: 'Coconut', profileId: PROFILE_C, playerUuid: PLAYER_ID,
      fetchedAt: FETCHED_AT, sourceSchemaVersion: 2, data: {} });
    return saved;
  };
  const app = createApp({ service,
    timelineService: createTimelineService({ getDatabase: async () => readonly }),
    resolveMinecraftPlayer: async () => PLAYER, getApiKey: forbidden,
    loadSkillResource: async () => { resourceCalls++; return normalizeSkillResource(officialSkillsFixture()); } });
  const requests = [];
  api = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    const url = new URL(req.url, 'http://localhost');
    const list = url.pathname.endsWith('/snapshots');
    const detail = url.pathname.includes('/snapshots/');
    if ((list && failList) || (detail && failDetail)) {
      res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Fixture temporarily offline.' }));
    } else if (detail && slowDetail) setTimeout(() => { if (!res.destroyed) app(req, res); }, 500);
    else app(req, res);
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const { createServer } = await import(pathToFileURL(require.resolve('vite', { paths: [root + '/client'] })).href);
  vite = await createServer({ root: root + '/client', configFile: root + '/client/vite.config.js',
    server: { host: '127.0.0.1', port: 0, proxy: { '/api': `http://127.0.0.1:${api.address().port}` } } });
  await vite.listen();
  const binary = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.ok(fs.existsSync(binary), 'Set CHROME_BIN to an installed Chromium/Chrome executable.');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skyadvisor-timeline-browser-'));
  chrome = spawn(binary, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = fs.readFileSync(path.join(directory, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; }
    catch { await delay(100); }
  }
  assert.ok(port, 'Chrome debugging port available');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await once(ws, 'open');
  let nextId = 0;
  const pending = new Map(), exceptions = [], network = [];
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params);
    if (message.method === 'Network.requestWillBeSent') network.push(message.params.request);
    const request = pending.get(message.id);
    if (request) { pending.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function waitFor(expression) {
    for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error('Timed out: ' + expression);
  }
  async function click(text) {
    assert.equal(await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b || b.disabled) return false; b.click(); return true; })()`), true, 'Clickable control: ' + text);
  }
  async function select(index) {
    await evaluate(`document.querySelectorAll('.timeline-date')[${index}].click()`);
    await waitFor("document.querySelector('.timeline-detail') !== null");
  }
  const savedRow = name => `document.querySelector('.timeline-category [data-history-entry="${name}"]')`;
  const selectedIndex = () => evaluate("[...document.querySelectorAll('.timeline-date')].findIndex(b => b.getAttribute('aria-pressed') === 'true')");
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Emulation.setLocaleOverride', { locale: 'en-US' });
  await send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${vite.httpServer.address().port}/` });
  await waitFor("document.querySelector('#username') !== null");
  await evaluate(`(() => { const input = document.querySelector('#username'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '${PLAYER.name}'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click('Find player'); await waitFor("document.body.textContent.includes('Continue to SkyBlock data')");
  await click('Continue to SkyBlock data'); await waitFor("document.querySelector('[role=progressbar]') !== null");
  await delay(200);
  const requestStart = requests.length, networkStart = network.length, initialResourceCalls = resourceCalls;
  failList = true;
  await click('Timeline'); await waitFor("document.querySelector('.timeline-error')?.textContent.includes('Could not load saved dates')");
  failList = false; await click('Retry dates');
  await waitFor("document.querySelector('.timeline-detail') !== null");
  assert.equal(await evaluate("document.querySelectorAll('.timeline-date').length"), 10);
  assert.equal(await selectedIndex(), 0);
  assert.ok(await evaluate(`${savedRow('mining')}.textContent.includes('+50 XP')`));
  assert.ok(await evaluate("document.querySelector('.timeline-decrease')?.textContent.includes('Unexpected decrease: −5 items')"));
  assert.ok(await evaluate("[...document.querySelectorAll('.timeline-date time')].every(t => t.textContent.includes(':'))"));
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Next snapshot (newer)\"]').disabled"), true);
  await click('Previous'); await waitFor("document.querySelector('.timeline-detail') !== null");
  assert.equal(await selectedIndex(), 1);
  await click('Next'); await waitFor("document.querySelector('.timeline-detail') !== null");
  assert.equal(await selectedIndex(), 0);
  console.log('PASS: initial list retry, selected state, saved totals, changes, decrease labels, same-date times, Previous/Next');
  await select(9); await click('Previous');
  await waitFor("document.querySelectorAll('.timeline-date').length === 11 && document.querySelector('.timeline-first') !== null");
  assert.equal(await selectedIndex(), 10);
  assert.equal(await evaluate("document.querySelector('.timeline-first').textContent"), 'First recorded snapshot');
  assert.equal(await evaluate(`${savedRow('mining')}.querySelector('td').textContent`), '0');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Previous snapshot (older)\"]').disabled"), true);
  await select(4);
  assert.ok(await evaluate(`${savedRow('mining')}.textContent.includes('Unavailable') && ${savedRow('mining')}.textContent.includes('Comparison unavailable')`));
  console.log('PASS: Previous loads another cursor page; first snapshot, reliable zero and legacy unavailable values render correctly');
  await click('Banana'); await waitFor("document.querySelector('.timeline-first') !== null && document.querySelectorAll('.timeline-date').length === 1");
  assert.ok(await evaluate(`${savedRow('mining')}.textContent.includes('999')`));
  await click('Coconut'); await waitFor("document.querySelector('.timeline-view .empty-state') !== null");
  assert.equal(await evaluate("document.querySelectorAll('.timeline-date, .timeline-detail').length"), 0);
  await click('Apple'); await waitFor("document.querySelectorAll('.timeline-date').length === 10 && document.querySelector('.timeline-detail') !== null");
  assert.equal(await selectedIndex(), 0);
  slowDetail = true;
  await evaluate("document.querySelectorAll('.timeline-date')[1].click()");
  await waitFor("document.querySelector('.timeline-view').textContent.includes('Loading saved snapshot')");
  await click('Banana'); slowDetail = false;
  await waitFor("document.querySelector('.timeline-first') !== null && document.querySelectorAll('.timeline-date').length === 1");
  await delay(600);
  assert.ok(await evaluate(`${savedRow('mining')}.textContent.includes('999')`));
  await click('Apple'); await waitFor("document.querySelector('.timeline-detail') !== null && document.querySelectorAll('.timeline-date').length === 10");
  console.log('PASS: profile switching resets history and selection; empty histories and aborted stale detail requests are safe');
  failDetail = true;
  await evaluate("document.querySelectorAll('.timeline-date')[1].click()");
  await waitFor("document.querySelector('.timeline-error')?.textContent.includes('Could not load this snapshot')");
  assert.equal(await evaluate("document.querySelector('.timeline-detail')"), null);
  failDetail = false; await click('Retry snapshot'); await waitFor("document.querySelector('.timeline-detail') !== null");
  failList = true; await click('Load older snapshots');
  await waitFor("document.querySelector('.timeline-error')?.textContent.includes('Could not load saved dates')");
  assert.equal(await evaluate("document.querySelectorAll('.timeline-date').length"), 10);
  assert.equal(await selectedIndex(), 1);
  failList = false; await click('Retry dates'); await waitFor("document.querySelectorAll('.timeline-date').length === 11");
  assert.equal(await selectedIndex(), 1);
  await select(0);
  console.log('PASS: detail and older-page retries preserve the correct selection and do not show stale details');
  async function screenshot(label) {
    await evaluate('window.scrollTo(0, 0)');
    const clip = await evaluate("(() => { const b = document.querySelector('.data-section').getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height, scale: 1 }; })()");
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
    const file = path.join(os.tmpdir(), `skyadvisor-timeline-${label}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64')); return file;
  }
  const desktop = await screenshot('desktop');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  assert.equal(await evaluate("document.querySelector('.timeline-strip').scrollWidth > document.querySelector('.timeline-strip').clientWidth"), true);
  const beforeScroll = requests.length;
  await evaluate("document.querySelector('.timeline-strip').scrollLeft = 1000"); await delay(200);
  assert.equal(requests.length, beforeScroll, 'Scrolling performs no requests');
  await evaluate("document.querySelector('.timeline-strip').scrollLeft = 0");
  const mobile = await screenshot('mobile');
  await click('Banana'); await waitFor("document.querySelector('.timeline-first') !== null && document.querySelectorAll('.timeline-date').length === 1");
  await click('Apple'); await waitFor("document.querySelectorAll('.timeline-date').length === 10 && document.querySelector('.timeline-detail') !== null");
  assert.equal(await selectedIndex(), 0);
  await delay(300);
  const snapshotGet = request => request.method === 'GET' && /^\/api\/players\/[a-f0-9]{32}\/profiles\/[a-f0-9]{32}\/snapshots(?:\/s1_[A-Za-z0-9_-]+)?$/.test(new URL(request.url || request.path, 'http://localhost').pathname);
  assert.ok(requests.slice(requestStart).length > 0);
  assert.ok(requests.slice(requestStart).every(snapshotGet), 'Backend received only saved snapshot GETs while browsing');
  assert.ok(network.slice(networkStart).every(snapshotGet), 'Browser made only saved snapshot GETs while browsing');
  assert.equal(resourceCalls, initialResourceCalls, 'No skill-resource refresh while browsing');
  assert.equal(forbiddenCalls, 0);
  assert.deepEqual(memory.writes, []);
  assert.equal(JSON.stringify(memory.rows('skyblockSnapshots')), before);
  assert.equal(exceptions.length, 0);
  console.log('PASS: desktop/mobile, horizontal scroll, mobile profile switching; only snapshot GETs, no resources, manual fetches, writes or browser errors');
  await click('Skills'); await waitFor("document.querySelector('[role=progressbar]') !== null");
  console.log('PASS: existing skill progress bars still work after leaving Timeline');
  console.log(JSON.stringify({ desktopPreview: desktop, mobilePreview: mobile, syntheticData: true }, null, 2));
  await send('Browser.close').catch(() => {});
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  ws?.close(); chrome?.kill('SIGTERM');
  await vite?.close(); if (api) await new Promise(resolve => api.close(resolve));
});
