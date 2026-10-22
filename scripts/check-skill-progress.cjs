// Browser regression/preview using synthetic players and frozen official thresholds.
// Requires an installed Chromium browser; set CHROME_BIN on non-macOS systems.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { createApp } = require('../server/app');
const { createSkyBlockService } = require('../server/skyblock');
const { createMemoryDatabase } = require('../server/test-support/memory-db');
const { normalizeSkillResource } = require('../server/skill-resource');
const { officialSkillsFixture } = require('../server/fixtures/skill-resource');
const { PLAYER, PLAYER_ID, FETCHED_AT, profilesReply } = require('../server/fixtures/skyblock');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, ws, vite, api;

async function run() {
  const memory = createMemoryDatabase();
  let thresholdRequests = 0;
  let playerFetches = 0;
  let offline = false;
  const thresholds = { ...normalizeSkillResource(officialSkillsFixture()), fetchedAt: FETCHED_AT, stale: false };
  const resolveMinecraftPlayer = async () => PLAYER;
  const service = createSkyBlockService({ getDatabase: async () => memory.db,
    withDatabaseTransaction: memory.transaction, resolveMinecraftPlayer,
    request: async () => {
      playerFetches++;
      const reply = profilesReply();
      const member = reply.profiles[0].members[PLAYER_ID];
      member.jacobs_contest = { perks: { farming_level_cap: 0 } };
      member.player_data.experience = {
        SKILL_FARMING: 112.5, SKILL_MINING: 111672425, SKILL_COMBAT: 174.9999,
        SKILL_FORAGING: 12345.5, SKILL_FISHING: 0, SKILL_ENCHANTING: 175,
        SKILL_CARPENTRY: 20000, SKILL_RUNECRAFTING: 100, SKILL_SOCIAL: 225,
        SKILL_TAMING: 55172426,
      };
      reply.profiles[1].members[PLAYER_ID].player_data.experience.SKILL_FARMING = 225;
      reply.profiles.push({ profile_id: 'cccccccccccccccccccccccccccccccc', cute_name: 'Coconut',
        members: { [PLAYER_ID]: { api_settings: { skills: false } } } });
      return Response.json(reply);
    }, now: () => new Date(FETCHED_AT),
  });
  await service.fetchSkyBlockData({ username: PLAYER.name, uuid: PLAYER_ID, apiKey: 'fixture-key' });
  const app = createApp({ service, resolveMinecraftPlayer, getApiKey: () => 'fixture-key',
    loadSkillResource: async () => { thresholdRequests++; if (offline) throw new Error('Fixture offline'); return thresholds; } });
  api = await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve(server));
  });
  const { createServer } = await import(pathToFileURL(require.resolve('vite', { paths: [root + '/client'] })).href);
  vite = await createServer({ root: root + '/client', configFile: root + '/client/vite.config.js',
    server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': `http://127.0.0.1:${api.address().port}` } } });
  await vite.listen();
  const binary = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.ok(fs.existsSync(binary), 'Set CHROME_BIN to an installed Chromium/Chrome executable.');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skyadvisor-skills-browser-'));
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
  const card = id => `document.querySelector('[data-skill-id="${id}"]')`;
  const progressValue = id => evaluate(`${card(id)}.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')`);
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['https://mcasset.cloud/*'] });
  await send('Emulation.setLocaleOverride', { locale: 'en-US' });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${vite.httpServer.address().port}/` });
  await waitFor("document.querySelector('#username') !== null");
  await evaluate(`(() => { const input = document.querySelector('#username'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '${PLAYER.name}'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click('Find player');
  await waitFor("document.body.textContent.includes('Continue to SkyBlock data')");
  await click('Continue to SkyBlock data');
  await waitFor(`${card('farming')}?.querySelector('[role=progressbar]') !== null && ${card('farming')}?.querySelector('[role=progressbar]') !== undefined`);
  assert.equal(await progressValue('farming'), '50');
  assert.equal(await evaluate(`${card('farming')}.querySelector('.skill-level').textContent`), 'Level 1');
  assert.ok(await evaluate(`${card('farming')}.querySelector('.skill-remaining').textContent.includes('63 XP')`));
  assert.ok(await evaluate(`${card('farming')}.querySelector('[role=progressbar]').getAttribute('aria-valuetext').includes('level 2')`));
  assert.equal(await progressValue('combat'), '99.9');
  assert.ok(await evaluate(`${card('combat')}.querySelector('.skill-total-xp').textContent.includes('≈')`));
  assert.equal(await progressValue('fishing'), '0');
  assert.equal(await progressValue('mining'), '100');
  assert.ok(await evaluate(`${card('mining')}.textContent.includes('Max level')`));
  for (const id of ['alchemy', 'taming']) {
    assert.equal(await progressValue(id), undefined);
    assert.ok(await evaluate(`${card(id)}.textContent.includes('Unavailable') && !${card(id)}.textContent.includes('%')`));
  }
  console.log('PASS: rendered level, progress, XP remaining, accessible text, zero XP, max level, and unavailable states');
  const originalRequests = thresholdRequests;
  await click('Banana');
  await waitFor(`${card('farming')}?.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') === '25'`);
  assert.equal(await progressValue('mining'), '0');
  assert.equal(await evaluate(`${card('farming')}.querySelector('.skill-level').textContent`), 'Level 2');
  await click('Coconut');
  await waitFor("document.querySelector('.selected-profile')?.textContent === 'Coconut profile'");
  assert.equal(await evaluate("document.querySelectorAll('.skill-progress-track').length"), 0);
  assert.ok(await evaluate("document.querySelector('.data-section').textContent.includes('Unavailable')"));
  await click('Apple');
  await waitFor(`${card('farming')}?.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') === '50'`);
  assert.equal(thresholdRequests, originalRequests, 'Profile switching does not refetch public resource');
  assert.equal(playerFetches, 1, 'No extra player requests');
  console.log('PASS: profile switching recalculates bars and private profiles show no percentages or stale bars');
  await evaluate("document.querySelector('.data-section').scrollIntoView()");
  async function screenshotSkills() {
    await evaluate('window.scrollTo(0, 0)');
    const clip = await evaluate(`(() => { const box = document.querySelector('.data-section').getBoundingClientRect(); return { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height, scale: 1 }; })()`);
    return send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
  }
  const desktop = await screenshotSkills();
  const desktopPath = path.join(os.tmpdir(), 'skyadvisor-skill-progress-desktop.png');
  fs.writeFileSync(desktopPath, Buffer.from(desktop.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  const mobile = await screenshotSkills();
  const mobilePath = path.join(os.tmpdir(), 'skyadvisor-skill-progress-mobile.png');
  fs.writeFileSync(mobilePath, Buffer.from(mobile.data, 'base64'));
  console.log('PASS: mobile viewport fits without horizontal scrolling');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  offline = true;
  await click('Collections');
  await waitFor("document.querySelector('.collection-table') !== null");
  await click('Skills');
  await waitFor("document.querySelector('.skill-resource-error') !== null");
  assert.equal(await evaluate("document.querySelectorAll('[role=progressbar]').length"), 0);
  offline = false;
  await click('Retry thresholds');
  await waitFor(`${card('farming')}?.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') === '50'`);
  assert.equal(exceptions.length, 0);
  console.log('PASS: unavailable threshold service hides percentages and manual retry restores them; no uncaught browser errors');
  console.log(JSON.stringify({ desktopPreview: desktopPath, mobilePreview: mobilePath, syntheticData: true }, null, 2));
  await send('Browser.close').catch(() => {});
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  ws?.close(); chrome?.kill('SIGTERM');
  await vite?.close(); if (api) await new Promise(resolve => api.close(resolve));
});
