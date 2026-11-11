// Focused dashboard/planner regression with synthetic profiles and in-memory sessions.
// No .env, Atlas, Hypixel, Wiki, or Gemini access. Requires Chrome/CHROME_BIN.
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
const { createProgressionService } = require('../server/progression-service');
const { createMemoryDatabase } = require('../server/test-support/memory-db');
const { timelineRows } = require('../server/fixtures/timeline');
const { PLAYER, PLAYER_ID, PROFILE_A, PROFILE_B } = require('../server/fixtures/skyblock');
const { normalizeSkillResource } = require('../server/skill-resource');
const { officialSkillsFixture } = require('../server/fixtures/skill-resource');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const OTHER = { name: 'OtherFixture', uuid: '2'.repeat(32) };
const PROFILE_C = 'c'.repeat(32);
let chrome, ws, vite, api;

async function run() {
  const memory = createMemoryDatabase();
  const rows = timelineRows();
  const latest = rows.find(row => row._id === 'fetch-b:profile-a');
  const empty = () => ({ status: 'empty', items: [] });
  latest.data = {
    Skills: { status: 'partial', entries: [
      { id: 'mining', label: 'Mining', xp: 12345.5, status: 'available' },
      { id: 'farming', label: 'Farming', xp: 112.5, levelCap: 50, status: 'available' },
      { id: 'alchemy', label: 'Alchemy', xp: null, status: 'unavailable' },
    ] },
    Collections: { status: 'available', entries: [
      { id: 'COBBLESTONE', label: 'Cobblestone', amount: 100, status: 'available' },
      { id: 'WHEAT', label: 'Wheat', amount: 0, status: 'available' },
      { id: 'LOG:2', label: 'Birch Log', amount: 0, status: 'available' },
      { id: 'LOG:1', label: 'Spruce Log', amount: 50, status: 'available' },
      { id: 'UNKNOWN', label: 'Unknown', amount: null, status: 'unavailable' },
    ] },
    Inventory: { status: 'available', items: [{ id: 'OWNED_PICKAXE', name: 'Saved Pickaxe',
      minecraftId: null, count: 1, slot: 0, container: 'Inventory', lore: [], raw: {} }] },
    Armor: empty(), Equipment: empty(), Enderchest: empty(), Talismans: empty(), Backpacks: empty(),
    Pets: { status: 'empty', entries: [] },
  };
  for (const row of rows) {
    row.profileName = row.profileId.replaceAll('-', '').toLowerCase() === PROFILE_A ? 'Apple' : 'Banana';
    row.selected = row.profileName === 'Apple';
  }
  rows.push({ ...structuredClone(latest), _id: 'no-skills', profileId: PROFILE_C, profileName: 'Coconut',
    selected: false, data: { Skills: { status: 'private', entries: [] }, Collections: { status: 'empty', entries: [] } } });
  rows.push({ ...structuredClone(latest), _id: 'private-collections', profileId: 'd'.repeat(32),
    profileName: 'Date', selected: false, fetchedAt: 'unavailable',
    data: { Skills: { status: 'missing', entries: [] }, Collections: { status: 'private', entries: [] } } });
  memory.rows('players').push({ uuid: PLAYER_ID, username: PLAYER.name }, { uuid: OTHER.uuid, username: OTHER.name });
  memory.rows('skyblockSnapshots').push(...rows);
  const snapshotBefore = JSON.stringify(memory.rows('skyblockSnapshots'));
  const forbidden = () => { throw new Error('Live services and player-data writes are forbidden.'); };
  const thresholds = normalizeSkillResource(officialSkillsFixture());
  const service = createSkyBlockService({ getDatabase: async () => memory.db,
    withDatabaseTransaction: forbidden, request: forbidden, resolveMinecraftPlayer: forbidden });
  const progression = createProgressionService({ getDatabase: async () => memory.db,
    modelClient: { isConfigured: () => true, generate: async ({ input, schema }) => {
      if (schema.required.includes('targetId')) return { targetId: input.candidates[0].id };
      return { heading: input.stage === 'continue' ? 'Explore the selected topic' : 'Start your saved-profile plan',
        summary: 'Synthetic guide for browser checks; not live gameplay advice.',
        steps: [{ title: 'Review the source', detail: 'Review the linked reference and the saved snapshot.' },
          { title: 'Plan your next session', detail: 'Check the requirements before choosing your next action.' }],
        options: [{ label: 'Explore the prerequisites' }, { label: 'Compare the available paths' },
          { label: 'Plan what comes afterward' }] };
    } },
    resources: {
      items: async () => [
        { id: 'NEW_PICKAXE', name: 'Mining Pickaxe', category: 'PICKAXE', tier: 'RARE', stats: {} },
        { id: 'NEW_HOE', name: 'Farming Hoe', category: 'HOE', tier: 'RARE', stats: {} },
      ],
      collections: async () => [
        { id: 'COBBLESTONE', name: 'Cobblestone', category: 'MINING', tiers: [{ tier: 1, amountRequired: 50 }, { tier: 2, amountRequired: 500 }] },
        { id: 'WHEAT', name: 'Wheat', category: 'FARMING', tiers: [{ tier: 1, amountRequired: 50 }] },
        { id: 'LOG:2', name: 'Birch Wood', category: 'FORAGING', tiers: [{ tier: 1, amountRequired: 50 }] },
        { id: 'LOG:1', name: 'Spruce Wood', category: 'FORAGING', tiers: [{ tier: 1, amountRequired: 50 }] },
      ],
      wiki: async name => ({ title: name, url: 'https://wiki.hypixel.net/Skills', text: 'Synthetic reference for layout checks.' }),
    },
  });
  let slow = false, wrongCollection = false;
  const starts = [], collectionStarts = [], continuations = [], requests = [];
  const app = createApp({ service, getApiKey: forbidden,
    resolveMinecraftPlayer: async name => name === OTHER.name ? OTHER : PLAYER,
    loadSkillResource: async () => thresholds,
    timelineService: createTimelineService({ getDatabase: async () => memory.db }),
    recommendationService: { recommend: forbidden },
    progressionService: {
      start: async (...args) => { starts.push(args); if (slow) await delay(500); return progression.start(...args); },
      startCollection: async (...args) => {
        collectionStarts.push(args); if (slow) await delay(500);
        const result = await progression.startCollection(...args);
        return wrongCollection ? { ...result, objective: { ...result.objective, id: 'WHEAT' } } : result;
      },
      continueSession: async (...args) => { continuations.push(args); return progression.continueSession(...args); },
    },
  });
  api = http.createServer((req, res) => { requests.push({ method: req.method, path: req.url }); app(req, res); });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const { createServer } = await import(pathToFileURL(require.resolve('vite', { paths: [root + '/client'] })).href);
  const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react', { paths: [root + '/client'] })).href);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skyadvisor-next-steps-'));
  vite = await createServer({ root: root + '/client', configFile: false, envDir: false,
    cacheDir: path.join(directory, 'vite-cache'), plugins: [react()],
    server: { host: '127.0.0.1', port: 0, proxy: { '/api': `http://127.0.0.1:${api.address().port}` } } });
  await vite.listen();
  const binary = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.ok(fs.existsSync(binary), 'Set CHROME_BIN to an installed Chrome/Chromium executable.');
  chrome = spawn(binary, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${directory}/chrome`, 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = fs.readFileSync(path.join(directory, 'chrome/DevToolsActivePort'), 'utf8').split('\n')[0]; break; }
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
    for (let i = 0; i < 150; i++) { if (await evaluate(`!!(${expression})`)) return; await delay(100); }
    throw new Error('Timed out: ' + expression);
  }
  async function chooseProfile(name) {
    await evaluate(`(() => { const s = document.querySelector('#dashboard-profile'); const option = [...s.options].find(o => o.textContent === ${JSON.stringify(name)}); if (!option) throw new Error('Profile not found'); s.value = option.value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`document.querySelector('#dashboard-profile').selectedOptions[0].textContent === ${JSON.stringify(name)}`);
  }
  async function click(text) {
    assert.equal(await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => !b.closest('[hidden]') && b.textContent.trim() === ${JSON.stringify(text)}); if (!b || b.disabled) return false; b.click(); return true; })()`), true, 'Clickable control: ' + text);
  }
  async function enterPlayer(name) {
    await waitFor("document.querySelector('#username')");
    await evaluate(`(() => { const input = document.querySelector('#username'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(name)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await click('Find player'); await waitFor("document.body.textContent.includes('Continue to SkyBlock data')");
    await click('Continue to SkyBlock data'); await waitFor("document.querySelector('.overview-grid')");
    await waitFor("document.querySelector('[role=progressbar]')");
  }
  const pageHeading = "document.querySelector('.planner-page-header h2')";
  async function openSkillCard(skill) {
    await click('Skills');
    await evaluate(`document.querySelector('[data-skill-id="${skill}"] .skill-plan-button').click()`);
    await waitFor(`${pageHeading}.textContent === ${JSON.stringify('Next steps for ' + skill[0].toUpperCase() + skill.slice(1))}`);
    assert.equal(await evaluate(`document.activeElement === ${pageHeading}`), true);
  }
  async function openCollection(id, label) {
    await click('Collections');
    if (!await evaluate(`document.querySelector('[data-collection-id="${id}"] button') !== null`)) await searchCollections('');
    await evaluate(`document.querySelector('[data-collection-id="${id}"] button').click()`);
    await waitFor(`${pageHeading}.textContent === ${JSON.stringify('Next steps for ' + label)}`);
    assert.equal(await evaluate(`document.activeElement === ${pageHeading}`), true);
  }
  async function searchCollections(value) {
    await evaluate(`(() => { const input = document.querySelector('.collections-controls input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(`document.querySelector('.collections-controls input').value === ${JSON.stringify(value)}`);
  }
  async function sortCollections(value) {
    await evaluate(`(() => { const select = document.querySelector('.collections-controls select'); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`document.querySelector('.collections-controls select').value === ${JSON.stringify(value)}`);
  }
  const previews = [];
  async function screenshot(name, viewport = false) {
    await evaluate("document.querySelectorAll('.player-uuid,.profile-id').forEach(el => { el.textContent = 'Identifier hidden for review'; })");
    await evaluate('window.scrollTo(0, 0)');
    const clip = viewport ? await evaluate('({ x: 0, y: 0, width: innerWidth, height: innerHeight, scale: 1 })')
      : await evaluate("(() => { const b = document.querySelector('.data-section').getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height, scale: 1 }; })()");
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
    const file = path.join(os.tmpdir(), `skyadvisor-dashboard-redesign-${name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64')); previews.push(file);
  }
  const plannerCount = () => evaluate("document.querySelectorAll('.progression-chat').length");
  const turns = () => evaluate("document.querySelectorAll('.progression-turn').length");
  const noLegacyPanel = async () => assert.equal(await evaluate("document.querySelectorAll('.recommendations-section,.recommendation-goal').length"), 0);
  const downloadDirectory = path.join(directory, 'exports');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory });
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['https://*'] });
  await send('Emulation.setLocaleOverride', { locale: 'en-US' });
  await send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
  for (const [label, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: label === 'mobile' });
    await send('Page.navigate', { url: `http://127.0.0.1:${vite.httpServer.address().port}/` });
    await enterPlayer(PLAYER.name); await noLegacyPanel();
    assert.equal(await evaluate("[...document.querySelectorAll('.data-tabs button')].some(b => b.textContent === 'Next Steps')"), false);
    assert.equal(await evaluate("document.querySelectorAll('.next-steps-skill').length"), 0);
    assert.equal(await plannerCount(), 0);
    assert.equal(await evaluate(`${pageHeading}.textContent`), 'Overview');
    assert.equal(await evaluate("document.querySelector('.data-details').open"), false);
    assert.equal(await evaluate("document.querySelectorAll('.overview-grid .skill-plan-button,.overview-grid .progression-chat').length"), 0);
    assert.equal(await evaluate("document.querySelector('[data-preview-skill=mining] [role=progressbar]').getAttribute('aria-valuenow')"),
      await evaluate("document.querySelector('[data-skill-id=mining] [role=progressbar]').getAttribute('aria-valuenow')"));
    assert.ok(await evaluate("document.querySelector('.overview-collections').textContent.includes('4 collection counts available')"));
    assert.ok(await evaluate("document.querySelector('.overview-collection-list').textContent.includes('Wheat0')"));
    assert.ok(await evaluate("document.querySelector('.overview-collections').textContent.includes('Some collection counts are unavailable')"));
    const browseStart = starts.length + collectionStarts.length;
    await screenshot(`${label}-overview`, true);
    assert.equal(await evaluate("document.querySelector('.overview-timeline').getBoundingClientRect().bottom <= innerHeight"), true,
      'Overview summaries and Timeline shortcut fit the initial viewport');
    await evaluate("document.querySelector('.data-details summary').click()");
    assert.equal(await evaluate("document.querySelector('.data-details').open"), true);
    await evaluate("document.querySelector('.data-details summary').click()");
    await chooseProfile('Banana');
    await waitFor("document.querySelector('.overview-collections').textContent.includes('999')");
    assert.ok(await evaluate("!document.querySelector('.overview-grid').textContent.includes('Cobblestone')"));
    await screenshot(`${label}-profile-switch`, true);
    await chooseProfile('Date');
    await waitFor("document.querySelector('.overview-collections').textContent.includes('API sharing is disabled')");
    assert.ok(await evaluate("document.querySelector('.overview-skills').textContent.includes('unavailable')"));
    assert.equal(await evaluate("document.querySelector('.overview-grid [role=progressbar]') === null"), true);
    assert.ok(await evaluate("document.querySelector('.snapshot-time').textContent.includes('Time unavailable')"));
    assert.equal(await evaluate("document.querySelectorAll('.overview-collection-list li').length"), 0);
    await screenshot(`${label}-unavailable`, true);
    await click('View Collections');
    await waitFor("document.querySelector('.collections-state h3')?.textContent === 'Collection sharing is disabled'");
    assert.equal(await evaluate("document.querySelectorAll('.collection-row').length"), 0);
    await screenshot(`${label}-collections-private`);
    await chooseProfile('Coconut');
    await waitFor("document.querySelector('.collections-state h3')?.textContent === 'No collections recorded'");
    assert.equal(await evaluate("document.querySelectorAll('.collection-row').length"), 0);
    await screenshot(`${label}-collections-empty`);
    await click('Overview');
    await chooseProfile('Apple'); await click('Open Timeline'); await waitFor("document.querySelector('.timeline-detail')");
    await click('Overview'); await click('View Collections');
    await waitFor("document.querySelector('.collections-controls')");
    await click('Overview'); await click('View Skills');
    await waitFor(`${pageHeading}.textContent === 'Skills'`);
    assert.equal(starts.length + collectionStarts.length, browseStart, 'Overview and profile/category shortcuts do not generate advice');
    await screenshot(`${label}-skills`);
    const before = starts.length;
    await openSkillCard('mining'); assert.equal(await plannerCount(), 1); assert.equal(starts.length, before);
    assert.equal(await evaluate("document.querySelectorAll('.data-section h2').length"), 1);
    await screenshot(`${label}-skill-entry`);
    // Double clicks must not start duplicate sessions.
    slow = true; await click('Find my next item');
    await evaluate("(() => { const b = [...document.querySelectorAll('.progression-chat button')].find(b => b.textContent === 'Build step-by-step guide'); b.click(); b.click(); })()");
    await waitFor("document.querySelector('.progression-turn')"); slow = false;
    assert.equal(starts.length, before + 1);
    assert.deepEqual(starts.at(-1).slice(2), ['mining', 'item']);
    assert.equal(await plannerCount(), 1);
    assert.equal(await evaluate("document.querySelectorAll('.progression-options button').length"), 3);
    assert.ok(await evaluate("getComputedStyle(document.querySelector('.recommendation-priority')).fontWeight >= 600"));
    await screenshot(`${label}-item-guide`);
    await click('Explore the prerequisites'); await waitFor("document.querySelectorAll('.progression-turn').length === 2");
    await click('Download steps (.txt)');
    for (let i = 0; i < 50 && !fs.existsSync(path.join(downloadDirectory, 'SkyAdvisor-mining-item-guide.txt')); i++) await delay(100);
    const exported = fs.readFileSync(path.join(downloadDirectory, 'SkyAdvisor-mining-item-guide.txt'), 'utf8');
    assert.ok(exported.includes('PART 2') && exported.includes('Explore the prerequisites'));
    const afterGuide = starts.length, afterContinue = continuations.length;
    await click('Back to Skills');
    for (const tab of ['Overview', 'Collections', 'Inventory', 'Armor', 'Equipment', 'Pets', 'Timeline']) {
      await click(tab); await noLegacyPanel();
      if (tab === 'Timeline') await waitFor("document.querySelector('.timeline-detail')");
    }
    await openSkillCard('mining'); assert.equal(await turns(), 2); assert.equal(await plannerCount(), 1);
    assert.equal(starts.length, afterGuide); assert.equal(continuations.length, afterContinue);
    await openSkillCard('farming'); assert.equal(await turns(), 0); assert.equal(starts.length, afterGuide);
    await click('Choose my next collection'); await click('Build step-by-step guide');
    await waitFor("document.querySelector('.progression-objective')?.textContent.includes('Wheat')");
    assert.deepEqual(starts.at(-1).slice(2), ['farming', 'collection']);
    assert.ok(await evaluate("document.querySelector('.progression-objective').textContent.includes('Recorded: 0')"));
    await click('Collections');
    assert.equal(await evaluate("document.querySelector('[data-collection-id=UNKNOWN] button') === null"), true);
    const collectionRequestsBefore = requests.length;
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.collection-group')].map(g => g.dataset.collectionCategory)"),
      ['FARMING', 'FORAGING', 'MINING', 'uncategorized']);
    assert.equal(await evaluate("document.querySelector('[data-collection-id=UNKNOWN] .collection-count strong').textContent"), 'Not provided');
    assert.equal(await evaluate("document.querySelector('[data-collection-id=WHEAT] .collection-count strong').textContent"), '0');
    assert.equal(await evaluate("document.querySelectorAll('.collections-view [role=progressbar]').length"), 0, 'Counts have no guessed tier percentages');
    await waitFor("[...document.querySelectorAll('.collection-icon img')].every(img => img.complete && img.naturalWidth > 0)");
    assert.ok(await evaluate("(() => { const src = document.querySelector('[data-collection-id=UNKNOWN] img').src; return src.startsWith('data:image/svg+xml') || new URL(src).origin === location.origin; })()"),
      'Unclassified collections use a bundled fallback, never a guessed remote image');
    await screenshot(`${label}-collections`);
    await evaluate("document.querySelector('[data-collection-id=WHEAT] img').src = '/missing-collection-image.svg'");
    await waitFor("document.querySelector('[data-collection-id=WHEAT] [data-collection-fallback]')");
    assert.equal(await evaluate("document.querySelector('[data-collection-id=WHEAT] .collection-count strong').textContent"), '0');
    await screenshot(`${label}-collections-fallback`);
    const foragingOrder = "[...document.querySelectorAll('[data-collection-category=FORAGING] [data-collection-id]')].map(row => row.dataset.collectionId)";
    await sortCollections('count-desc'); assert.deepEqual(await evaluate(foragingOrder), ['LOG:1', 'LOG:2']);
    await sortCollections('count-asc'); assert.deepEqual(await evaluate(foragingOrder), ['LOG:2', 'LOG:1']);
    await sortCollections('name-desc'); assert.deepEqual(await evaluate(foragingOrder), ['LOG:1', 'LOG:2']);
    await screenshot(`${label}-collections-sorted`);
    await sortCollections('name-asc');
    await searchCollections('no matching collection');
    await waitFor("document.querySelector('.collections-state h3')?.textContent === 'No matching collections'");
    assert.equal(await evaluate("document.querySelectorAll('.collection-row').length"), 0);
    await screenshot(`${label}-collections-no-results`);
    await click('Clear search'); await waitFor("document.querySelectorAll('.collection-row').length === 5");
    await searchCollections(' bIrCh '); await waitFor("document.querySelectorAll('.collection-row').length === 1");
    assert.equal(await evaluate("document.querySelector('.collection-row').dataset.collectionId"), 'LOG:2');
    await screenshot(`${label}-collections-search`);
    assert.equal(requests.length, collectionRequestsBefore, 'Collections search/sort/fallback never call an API');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    const beforeCollection = collectionStarts.length;
    await openCollection('LOG:2', 'Birch Log');
    assert.equal(collectionStarts.length, beforeCollection, 'Opening a collection does not generate advice');
    assert.equal(await plannerCount(), 1);
    assert.equal(await evaluate("document.querySelector('.progression-modes') === null"), true);
    await screenshot(`${label}-collection-entry`);
    await click('Build step-by-step guide'); await waitFor("document.querySelector('.progression-turn')");
    assert.equal(collectionStarts.length, beforeCollection + 1);
    assert.deepEqual(collectionStarts.at(-1), [PLAYER_ID, PROFILE_A, 'LOG:2']);
    assert.ok(await evaluate("document.querySelector('.progression-objective').textContent.includes('Recorded: 0')"));
    await screenshot(`${label}-collection-guide`);
    await click('Explore the prerequisites'); await waitFor("document.querySelectorAll('.progression-turn').length === 2");
    await click('Download steps (.txt)');
    for (let i = 0; i < 50 && !fs.existsSync(path.join(downloadDirectory, 'SkyAdvisor-foraging-collection-guide.txt')); i++) await delay(100);
    const collectionExport = fs.readFileSync(path.join(downloadDirectory, 'SkyAdvisor-foraging-collection-guide.txt'), 'utf8');
    assert.ok(collectionExport.includes('Birch Wood (LOG:2)') && collectionExport.includes('PART 2'));
    const afterCollection = collectionStarts.length;
    await click('Back to Collections');
    assert.equal(await evaluate("document.querySelector('.collections-controls input').value"), ' bIrCh ');
    await click('Overview'); await openCollection('LOG:2', 'Birch Log');
    assert.equal(await turns(), 2); assert.equal(collectionStarts.length, afterCollection);
    await screenshot(`${label}-collection-followup`);
    await openCollection('LOG:1', 'Spruce Log'); await click('Build step-by-step guide');
    await waitFor("document.querySelector('.progression-chat [role=alert]')?.textContent.includes('No next tier')");
    assert.equal(await turns(), 0, 'A maxed collection never receives a substitute generic guide');
    await openCollection('LOG:2', 'Birch Log'); wrongCollection = true;
    await click('Build step-by-step guide');
    await waitFor("document.querySelector('.progression-chat [role=alert]')?.textContent.includes('response was invalid')");
    assert.equal(await turns(), 0, 'A response for another collection is rejected'); wrongCollection = false;
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(JSON.stringify(memory.rows('skyblockSnapshots')), snapshotBefore);
    console.log(`PASS: ${label} Overview, compact header, profile switching, saved/missing/private values and shortcuts; Collections search, name/count sorting, verified groups, local icons and failed-image fallback; skill and exact-collection entry; single heading/planner; preserved guides on return, both skill paths, collection context, follow-ups, TXT exports, mobile fit and maxed/mismatched collection errors`);
  }
  // Deliberately ignore network cancellation to prove late results cannot repopulate another selection.
  await evaluate(`window.requestAborts = 0; const originalFetch = window.fetch; window.fetch = (url, options = {}) => {
    if (String(url).includes('/progression')) { options.signal?.addEventListener('abort', () => { window.requestAborts++; });
      const { signal, ...rest } = options; return originalFetch(url, rest); }
    return originalFetch(url, options); };`);
  async function pendingGuide(kind = 'collection', id = 'LOG:2', label = 'Birch Log') {
    if (kind === 'skill') await openSkillCard(id); else await openCollection(id, label);
    if (await turns()) await click('Start over');
    const before = starts.length + collectionStarts.length; slow = true;
    if (kind === 'skill') await click('Find my next item');
    await click('Build step-by-step guide'); await waitFor("document.querySelector('.progression-busy')");
    for (let i = 0; i < 50 && starts.length + collectionStarts.length === before; i++) await delay(20);
    assert.equal(starts.length + collectionStarts.length, before + 1);
  }
  await pendingGuide(); await openCollection('COBBLESTONE', 'Cobblestone');
  await delay(700); assert.equal(await turns(), 0); assert.equal(await plannerCount(), 1);
  await pendingGuide('collection', 'COBBLESTONE', 'Cobblestone'); await chooseProfile('Banana');
  await waitFor(`${pageHeading}.textContent === 'Overview'`);
  await delay(700); assert.equal(await plannerCount(), 0);
  await chooseProfile('Coconut'); await waitFor("document.querySelector('#dashboard-profile').selectedOptions[0].textContent === 'Coconut'");
  assert.equal(await plannerCount(), 0);
  assert.equal(await evaluate("document.querySelectorAll('.skill-plan-button').length"), 0);
  await chooseProfile('Apple'); await pendingGuide('skill', 'mining');
  latest.fetchedAt = new Date('2026-10-24T12:00:00Z');
  await click('Reload saved data'); await waitFor(`${pageHeading}.textContent === 'Overview'`);
  await delay(700); assert.equal(await plannerCount(), 0);
  await pendingGuide(); await click('Change player'); await enterPlayer(OTHER.name);
  await delay(700); assert.equal(await plannerCount(), 0);
  assert.equal(await evaluate('window.requestAborts'), 4);
  slow = false;
  assert.ok(requests.filter(r => r.method === 'POST').every(r => r.path.includes('/progression')));
  assert.equal(requests.filter(r => r.path.includes('/recommendations')).length, 0);
  assert.ok(memory.writes.every(write => write.name === 'progressionSessions'));
  assert.equal(exceptions.length, 0);
  console.log('PASS: target/profile/snapshot/player changes abort pending work and discard late results; unavailable skills have no planner; only explicit progression POSTs, no player fetches or recommendation requests');
  console.log(JSON.stringify({ previews, syntheticData: true }, null, 2));
  await send('Browser.close').catch(() => {});
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  ws?.close(); chrome?.kill('SIGTERM');
  await vite?.close(); if (api) await new Promise(resolve => api.close(resolve));
});
