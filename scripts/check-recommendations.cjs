// Synthetic endpoint responses only: no .env, Gemini, Hypixel, or Atlas access.
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
const { timelineRows } = require('../server/fixtures/timeline');
const { PLAYER, PLAYER_ID, PROFILE_A, PROFILE_B } = require('../server/fixtures/skyblock');
const { normalizeSkillResource } = require('../server/skill-resource');
const { officialSkillsFixture } = require('../server/fixtures/skill-resource');
const { GOALS } = require('../server/ai-recommendations');
const { calculateSkillProgress } = require('../client/src/skill-progress.js');

const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const OTHER = { name: 'OtherFixture', uuid: '2'.repeat(32) };
const FETCHED_AT = '2026-10-22T00:00:00.000Z';
const thresholds = normalizeSkillResource(officialSkillsFixture());
let chrome, ws, vite, api;

function response(playerUuid, profileId, goal) {
  const skill = goal === 'general' ? 'mining' : goal;
  const xp = profileId === PROFILE_B ? 999 : playerUuid === OTHER.uuid ? 888 : 112.5;
  const progress = calculateSkillProgress({ id: skill, xp, status: 'available' }, thresholds.skills[skill]);
  const collected = profileId === PROFILE_B ? 999 : playerUuid === OTHER.uuid ? 888 : 0;
  const facts = [
    { factId: `skill:${skill}`, skill, xp, level: progress.level, nextLevel: progress.nextLevel, xpRemaining: progress.xpRemaining, atCap: false },
    { factId: 'collection:WHEAT', collectionId: 'WHEAT', amount: collected },
    { factId: 'inventory:Inventory:0:DIAMOND_PICKAXE', itemId: 'DIAMOND_PICKAXE', count: 1, container: 'Inventory', slot: 0 },
  ];
  return { contractVersion: 2, playerUuid, profileId, goal, source: 'ai',
    snapshot: { factId: 'snapshot:time', fetchedAt: profileId === PROFILE_B || playerUuid === OTHER.uuid
      ? '2026-10-23T00:00:00.000Z' : FETCHED_AT },
    actions: [
      { title: `Train ${skill[0].toUpperCase() + skill.slice(1)}`, whatToDo: `Work toward ${skill} level ${progress.nextLevel}.`, whyItFitsGoal: `The saved snapshot records ${xp} ${skill} XP.`, kind: 'train_skill' },
      { title: 'Grow the WHEAT collection', whatToDo: 'Focus on increasing the recorded WHEAT collection count.', whyItFitsGoal: `The saved snapshot records ${collected} collected items for WHEAT.`, kind: 'grow_collection' },
      { title: 'Review DIAMOND_PICKAXE', whatToDo: 'Review the recorded item before planning your next session.', whyItFitsGoal: 'The saved snapshot contains this item record with count 1.', kind: 'review_inventory' },
    ].map((action, index) => ({ ...action, priority: index + 1, reason: index === 2 ? 'known_item' : 'recorded_progress',
      focusFactId: facts[index].factId, supportingFactIds: [facts[index].factId], evidence: [facts[index]] })) };
}

async function run() {
  const memory = createMemoryDatabase();
  const rows = timelineRows();
  for (const row of rows) {
    row.profileName = row.profileId.replaceAll('-', '').toLowerCase() === PROFILE_A ? 'Apple' : 'Banana';
    row.selected = row.profileName === 'Apple';
  }
  rows.find(row => row._id === 'fetch-b:profile-a').data.Inventory = { status: 'available', items: [{
    id: 'DIAMOND_PICKAXE', name: 'Fixture Pickaxe', count: 1, slot: 0, container: 'Inventory', lore: [], raw: {},
  }] };
  rows.find(row => row._id === 'fetch-b:profile-a').data.Skills.entries[0].xp = 112.5;
  rows.find(row => row._id === 'fetch-b:profile-a').data.Collections.entries[0].amount = 0;
  memory.rows('players').push({ uuid: PLAYER_ID, username: PLAYER.name }, { uuid: OTHER.uuid, username: OTHER.name });
  memory.rows('skyblockSnapshots').push(...rows);
  const before = JSON.stringify(memory.rows('skyblockSnapshots'));
  const forbidden = () => { throw new Error('Live services and writes are forbidden in this browser check.'); };
  const readonly = { collection(name) {
    const col = memory.db.collection(name);
    return { find: col.find, findOne: col.findOne, aggregate: col.aggregate };
  } };
  const service = createSkyBlockService({ getDatabase: async () => readonly,
    withDatabaseTransaction: forbidden, request: forbidden, resolveMinecraftPlayer: forbidden });
  let mode = 'ai', slow = false;
  const calls = [];
  const app = createApp({ service, getApiKey: forbidden,
    resolveMinecraftPlayer: async name => name === OTHER.name ? OTHER : PLAYER,
    timelineService: createTimelineService({ getDatabase: async () => readonly }),
    loadSkillResource: async () => thresholds,
    recommendationService: { recommend: async (player, profile, goal) => {
      calls.push({ player, profile, goal });
      const currentMode = mode;
      if (slow) await delay(600);
      if (currentMode === 'failure') throw new Error('Synthetic temporary outage');
      const data = response(player, profile, goal);
      if (currentMode === 'fallback' || currentMode === 'busy' || currentMode === 'empty') {
        data.source = 'fallback'; data.fallbackReason = currentMode === 'empty' ? 'insufficient_evidence'
          : currentMode === 'busy' ? 'model_unavailable' : 'not_configured';
        data.actions = currentMode === 'empty' ? [] : data.actions.slice(0, 1);
      }
      if (currentMode === 'wrong-profile') data.profileId = 'f'.repeat(32);
      if (currentMode === 'malformed') data.actions = null;
      return data;
    } },
  });
  const network = [], requests = [];
  api = http.createServer((req, res) => { requests.push({ method: req.method, path: req.url }); app(req, res); });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const { createServer } = await import(pathToFileURL(require.resolve('vite', { paths: [root + '/client'] })).href);
  vite = await createServer({ root: root + '/client', configFile: root + '/client/vite.config.js',
    server: { host: '127.0.0.1', port: 0, proxy: { '/api': `http://127.0.0.1:${api.address().port}` } } });
  await vite.listen();
  const binary = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.ok(fs.existsSync(binary), 'Set CHROME_BIN to an installed Chromium/Chrome executable.');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skyadvisor-recommendations-browser-'));
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
  const pending = new Map(), exceptions = [];
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
  async function chooseGoal(goal) {
    await evaluate(`(() => { const s = document.querySelector('.recommendation-goal select'); s.value = ${JSON.stringify(goal)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  }
  async function enterPlayer(name) {
    await waitFor("document.querySelector('#username') !== null");
    await evaluate(`(() => { const input = document.querySelector('#username'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(name)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await click('Find player'); await waitFor("document.body.textContent.includes('Continue to SkyBlock data')");
    await click('Continue to SkyBlock data'); await waitFor("document.querySelector('.recommendations-section') !== null");
  }
  const cards = "document.querySelectorAll('.recommendation-card')";
  const text = "document.querySelector('.recommendations-section').textContent";
  const loading = "document.querySelector('.recommendation-results').getAttribute('aria-busy')";
  const error = "document.querySelector('.recommendations-section [role=alert]')";
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['https://mcasset.cloud/*'] });
  await send('Emulation.setLocaleOverride', { locale: 'en-US' });
  await send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${vite.httpServer.address().port}/` });
  await enterPlayer(PLAYER.name);
  assert.deepEqual(await evaluate("[...document.querySelector('.recommendation-goal select').options].map(o => o.value)"), GOALS);
  await click('Timeline'); await waitFor("document.querySelector('.timeline-detail') !== null");
  await click('Banana'); await waitFor("document.querySelector('.timeline-first') !== null");
  await click('Apple'); await waitFor("document.querySelector('.timeline-detail') !== null");
  await chooseGoal('mining'); await delay(200);
  assert.equal(calls.length, 0, 'Opening, timeline browsing, profile and goal changes never generate recommendations');
  console.log('PASS: initial dashboard, supported goals, profile switching and timeline browsing make no recommendation calls');

  slow = true;
  await evaluate("(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent === 'Get recommendations'); b.click(); b.click(); })()");
  await waitFor(`${loading} === 'true'`);
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Getting recommendations')).disabled"), true);
  await waitFor(`${cards}.length === 3`); slow = false;
  assert.equal(calls.length, 1, 'Double click makes only one request');
  assert.deepEqual(calls[0], { player: PLAYER_ID, profile: PROFILE_A, goal: 'mining' });
  assert.equal(await evaluate("document.querySelector('.recommendation-source').textContent"), 'AI');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.recommendation-priority')].map(p => p.textContent)"), ['Priority 1', 'Priority 2', 'Priority 3']);
  assert.ok(await evaluate(`${text}.includes('What to do') && ${text}.includes('Why it fits your goal') && ${text}.includes('Saved player facts')`));
  assert.ok(await evaluate("document.querySelectorAll('.recommendation-evidence')[0].textContent.includes('112.5 XP')"));
  assert.ok(await evaluate("document.querySelectorAll('.recommendation-evidence')[1].textContent.includes('0 items collected')"));
  assert.ok(await evaluate("document.querySelectorAll('.recommendation-evidence')[2].textContent.includes('Count: 1')"));
  assert.equal(await evaluate("document.querySelector('.recommendation-result-heading time').dateTime"), FETCHED_AT);

  async function screenshot(label) {
    await evaluate('window.scrollTo(0, 0)');
    const clip = await evaluate("(() => { const b = document.querySelector('.recommendations-section').getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height, scale: 1 }; })()");
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
    const file = path.join(os.tmpdir(), `skyadvisor-recommendations-${label}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64')); return file;
  }
  const desktop = await screenshot('desktop');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  console.log('PASS: click-only POST, loading and double-click protection, three prioritized AI cards, evidence, confirmed zero and snapshot time');

  await click('Inventory'); await waitFor("document.querySelector('.mc-item') !== null");
  await evaluate("document.querySelector('.mc-item').click()");
  await waitFor("document.querySelector('.item-details') !== null");
  await click('Close');
  assert.equal(await evaluate(`${cards}.length`), 3);
  assert.equal(calls.length, 1, 'Inspecting Inventory never generates advice');

  await chooseGoal('farming');
  assert.equal(await evaluate(`${cards}.length`), 0);
  assert.equal(calls.length, 1);
  mode = 'fallback'; await click('Get recommendations'); await waitFor(`${cards}.length === 1`);
  assert.equal(await evaluate("document.querySelector('.recommendation-source').textContent"), 'Basic fallback');
  assert.equal(calls.at(-1).goal, 'farming');
  mode = 'busy'; await click('Get recommendations');
  await waitFor(`${text}.includes('temporarily busy or unavailable')`);
  assert.equal(await evaluate(`${cards}.length`), 1);
  await click('Banana'); await waitFor(`${cards}.length === 0`);
  assert.equal(await evaluate("document.querySelector('.recommendation-goal select').value"), 'general');
  const afterProfile = calls.length;
  await delay(150); assert.equal(calls.length, afterProfile);
  await click('Get recommendations'); await waitFor(`${cards}.length === 1`);
  assert.ok(await evaluate(`${text}.includes('999') && !${text}.includes('112.5')`));
  await click('Apple'); await waitFor(`${cards}.length === 0`);

  mode = 'empty'; await click('Get recommendations');
  await waitFor(`${text}.includes('No usable saved data')`);
  assert.equal(await evaluate(`${cards}.length`), 0);
  mode = 'failure'; await click('Get recommendations'); await waitFor(`${error} !== null`);
  assert.equal(await evaluate(`${cards}.length`), 0);
  mode = 'ai'; await click('Try again'); await waitFor(`${cards}.length === 3`);
  for (const badMode of ['wrong-profile', 'malformed']) {
    mode = badMode; await click('Get recommendations'); await waitFor(`${error} !== null`);
    assert.equal(await evaluate(`${cards}.length`), 0);
    mode = 'ai'; await click('Try again'); await waitFor(`${cards}.length === 3`);
  }
  console.log('PASS: goal/profile reset, basic fallback, no usable data, failure/retry and rejection of mismatched or malformed responses');

  // Deliberately ignore fetch abort signals to prove late responses cannot repopulate a new selection.
  await evaluate("window.originalFetch = window.fetch; window.fetch = (url, options = {}) => { if (String(url).endsWith('/recommendations')) { const { signal, ...rest } = options; return window.originalFetch(url, rest); } return window.originalFetch(url, options); };");
  slow = true; await click('Get recommendations'); await waitFor(`${loading} === 'true'`);
  await chooseGoal('combat');
  assert.equal(await evaluate(`${cards}.length`), 0);
  await delay(750);
  assert.equal(await evaluate(`${cards}.length`), 0, 'Late response after goal change is discarded');
  await click('Get recommendations'); await waitFor(`${loading} === 'true'`);
  await click('Banana'); await delay(750);
  assert.equal(await evaluate(`${cards}.length`), 0, 'Late response after profile change is discarded');
  await click('Get recommendations'); await waitFor(`${loading} === 'true'`);
  await click('Back'); await enterPlayer(OTHER.name); await delay(750);
  assert.equal(await evaluate(`${cards}.length`), 0, 'Late response after player change is discarded');
  slow = false; await evaluate('window.fetch = window.originalFetch');
  await click('Get recommendations'); await waitFor(`${cards}.length === 3`);
  assert.ok(await evaluate(`${text}.includes('888') && !${text}.includes('999')`));
  assert.equal(calls.at(-1).player, OTHER.uuid);
  console.log('PASS: late responses after goal, profile and player changes never show under a new selection, even if network abort is ignored');

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await delay(100);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  assert.equal(await evaluate("(() => { const cards = [...document.querySelectorAll('.recommendation-card')].map(c => c.getBoundingClientRect()); return cards[1].top > cards[0].top && cards[2].top > cards[1].top; })()"), true);
  assert.equal(await evaluate("(() => { const s = document.querySelector('.recommendation-goal select'); return s.labels.length === 1 && !!s.getAttribute('aria-describedby'); })()"), true);
  const mobile = await screenshot('mobile');
  await chooseGoal('farming');
  assert.equal(await evaluate(`${cards}.length`), 0);
  await click('Get recommendations'); await waitFor(`${cards}.length === 3`);
  const countBeforeBrowsing = calls.length;
  for (const [tab, selector] of [['Skills', '[role=progressbar]'], ['Collections', '.collection-table'], ['Inventory', '.data-section .availability'], ['Timeline', '.timeline-detail']]) {
    await click(tab); await waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`);
  }
  await delay(150); assert.equal(calls.length, countBeforeBrowsing);
  const posts = requests.filter(request => request.method === 'POST');
  assert.equal(posts.length, calls.length);
  assert.ok(posts.every(request => request.path.endsWith('/recommendations')));
  const browserPosts = network.filter(request => request.method === 'POST');
  assert.equal(browserPosts.length, calls.length);
  assert.ok(browserPosts.every(request => request.url.endsWith('/recommendations')));
  assert.ok(browserPosts.every(request => Object.keys(JSON.parse(request.postData)).join() === 'goal'));
  assert.deepEqual(memory.writes, []);
  assert.equal(JSON.stringify(memory.rows('skyblockSnapshots')), before);
  assert.equal(exceptions.length, 0);
  console.log('PASS: mobile controls and stacked cards fit; existing Skills/Collections/Inventory/Timeline remain usable; only explicit goal-only recommendation POSTs, no writes or browser errors');
  console.log(JSON.stringify({ desktopPreview: desktop, mobilePreview: mobile, syntheticData: true }, null, 2));
  await send('Browser.close').catch(() => {});
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  ws?.close(); chrome?.kill('SIGTERM');
  await vite?.close(); if (api) await new Promise(resolve => api.close(resolve));
});
