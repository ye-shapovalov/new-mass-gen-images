import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_STYLE, parseCSV, jobsFromCSV, buildPrompt, imageType, outputStem, selectedNumbers, failureKind } from '../core.mjs';
import { oracleBrowserConfig } from '../oracle.mjs';
import { imageToolsReady } from '../gemini-page.mjs';
import { createStudio, listen, ROOT } from '../server.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const CSV = 'Поняття,Опис\nДрон,Літає\nБатарея,Живить\nКамера,Знімає\n';
async function fixture(generate = async () => PNG, options = {}) {
  const { requestDelaySeconds = 0, ...dependencies } = options;
  const root = await fs.mkdtemp(path.join(ROOT, '.test-'));
  await fs.writeFile(path.join(root, 'input.csv'), CSV);
  await fs.writeFile(path.join(root, 'scenes.json'), JSON.stringify({ Дрон: 'Квадрокоптер над платформою' }));
  const studio = await createStudio({ root, generate, login: async () => {}, checkSession: async () => {}, listProfiles: async () => [{ id: 'Default', name: 'Personal', account: '' }, { id: 'Profile 1', name: 'Work', account: 'user@example.org' }], ...dependencies });
  assert.equal((await studio.snapshot()).requestDelaySeconds, 30);
  await studio.action('settings', { style: DEFAULT_STYLE, range: '', requestDelaySeconds });
  return { root, studio, async clean() { await studio.close(); assert.ok(root.startsWith(path.join(ROOT, '.test-'))); await fs.rm(root, { recursive: true, force: true }); } };
}

test('CSV supports BOM, escaped quotes, embedded commas/newlines and semicolon tables', () => {
  const table = parseCSV('\uFEFFНазва,Опис\r\n"Дрон, БпА","Перша\nДруга ""цитата"""\r\n');
  assert.deepEqual(table.rows, [['Дрон, БпА', 'Перша\nДруга "цитата"']]);
  assert.deepEqual(parseCSV('a;b\r\n1;2').rows, [['1', '2']]);
  assert.deepEqual(parseCSV('"Name, term";"Description, context"\nДрон;Літає').rows, [['Дрон', 'Літає']]);
  for (const bad of ['', 'a,b', 'a,a\n1,2', 'a,b\n"1,2', 'a,b\n1,2,3', 'a,b\n"1"oops,2']) assert.throws(() => parseCSV(bad));
});

test('the supplied dataset maps all 141 definitions to matching scene ideas', async () => {
  const table = parseCSV(await fs.readFile(path.join(ROOT, 'input.csv'), 'utf8'));
  const scenes = JSON.parse(await fs.readFile(path.join(ROOT, 'scenes.json'), 'utf8'));
  const jobs = jobsFromCSV(table, 0, 1, scenes);
  assert.equal(jobs.length, 141); assert.equal(table.headers.length, 15);
  assert.equal(jobs[26].number, 27); assert.match(jobs[26].name, /Дрон-камікадзе/);
  assert.ok(jobs.every(job => job.scene && buildPrompt(job, DEFAULT_STYLE).includes(job.description)));
  assert.match(buildPrompt(jobs[0], DEFAULT_STYLE), /Без неону, тексту/);
});

test('range and filename validation keeps the original numbering', () => {
  assert.deepEqual([...selectedNumbers('1; 4; 7-9', 10)], [1, 4, 7, 8, 9]);
  assert.equal(selectedNumbers('', 141).size, 141);
  for (const expression of ['0', '9-2', '1-142', '1;;3', '../']) assert.throws(() => selectedNumbers(expression, 141));
  assert.equal(outputStem({ number: 3, name: 'Камера / відео: тест?' }), '3. Камера — відео — тест —');
  assert.throws(() => imageType(Buffer.from('<html>error</html>')));
  assert.equal(imageType(PNG), '.png');
});

test('Oracle uses an isolated persistent manual-login profile without cookie sync', () => {
  const profile = path.join(ROOT, '.data/browser-profile'); const config = oracleBrowserConfig(profile);
  assert.equal(config.manualLoginProfileDir, profile); assert.equal(config.manualLogin, true);
  assert.equal(config.cookieSync, false); assert.equal(config.keepBrowser, true);
  assert.equal(config.headless, true);
  assert.equal(oracleBrowserConfig(profile, false).headless, false);
});

test('batch navigation waits for image tools as well as the composer', () => {
  assert.equal(imageToolsReady({ composer: true, buttons: [] }), false);
  assert.equal(imageToolsReady({ composer: false, buttons: ['Upload & tools'] }), false);
  assert.equal(imageToolsReady({ composer: true, buttons: ['Upload & tools'] }), true);
  assert.equal(imageToolsReady({ composer: true, imageMode: true, buttons: [] }), true);
});

test('queue skips existing images and persists every generated result', async () => {
  let count = 0; const f = await fixture(async ({ prompt }) => { assert.match(prompt, /Батарея|Камера/); count++; return PNG; });
  try {
    await fs.writeFile(path.join(f.root, 'output/images/1. Дрон.png'), PNG);
    await f.studio.action('start'); await f.studio.settled();
    const state = await f.studio.snapshot();
    assert.equal(count, 2); assert.equal(state.status, 'complete'); assert.equal(state.jobs[0].status, 'exists');
    assert.deepEqual(state.jobs.slice(1).map(job => job.status), ['done', 'done']);
    assert.deepEqual(await fs.readFile(path.join(f.root, 'output/images/2. Батарея.png')), PNG);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.root, '.data/state.json'))).jobs[2].status, 'done');
    await assert.rejects(f.studio.action('start'), /немає незавершених/);
  } finally { await f.clean(); }
});

test('pause saves the in-flight image and leaves the next row untouched', async () => {
  let release, started; const gate = new Promise(resolve => release = resolve); const entered = new Promise(resolve => started = resolve);
  const f = await fixture(async () => { started(); await gate; return PNG; });
  try {
    await f.studio.action('start'); await entered;
    await assert.rejects(f.studio.action('settings', { style: 'other', range: '' }), /Спочатку/);
    await assert.rejects(f.studio.action('save-ready', { style: DEFAULT_STYLE, range: '', outputDir: path.join(f.root, 'another-folder') }), /Спочатку/);
    await assert.rejects(f.studio.action('account-update', { id: 'main', enabled: false }), /Спочатку/);
    await f.studio.action('pause'); release(); await f.studio.settled();
    const state = await f.studio.snapshot(); assert.equal(state.status, 'paused');
    assert.deepEqual(state.jobs.map(job => job.status), ['done', 'pending', 'pending']);
  } finally { release(); await f.clean(); }
});

test('the selected folder alone determines progress, image serving and generation after changes and restart', async () => {
  let requests = 0;
  const f = await fixture(async () => { requests++; return PNG; }); let studio = f.studio;
  try {
    const original = (await studio.snapshot()).outputDir;
    await studio.action('settings', { style: DEFAULT_STYLE, range: '1' });
    await studio.action('start'); await studio.settled();
    const next = path.join(f.root, 'Нова папка з пробілами');
    await fs.mkdir(next); await fs.writeFile(path.join(next, '2. Батарея.png'), PNG);
    await studio.action('settings', { style: DEFAULT_STYLE, range: '', outputDir: next });
    let state = await studio.snapshot();
    assert.equal(state.outputDir, next);
    assert.deepEqual(state.jobs.map(job => job.status), ['pending', 'exists', 'pending']);
    assert.equal(state.jobs[0].log, undefined); assert.equal(state.jobs[0].attempts, 0);
    assert.equal(state.batch, undefined); assert.equal(state.status, 'idle');
    assert.equal(state.events.length, 1);
    assert.equal(await studio.image(1), null);
    assert.deepEqual(await fs.readdir(original), ['1. Дрон.png']);
    await studio.action('start'); await studio.settled();
    assert.equal(requests, 3);
    assert.deepEqual(await fs.readFile(path.join(next, '1. Дрон.png')), PNG);
    assert.deepEqual(await fs.readFile(path.join(next, '3. Камера.png')), PNG);
    await studio.close(); studio = null;
    studio = await createStudio({ root: f.root, generate: async () => PNG });
    state = await studio.snapshot(); assert.equal(state.outputDir, next);
    assert.deepEqual(state.jobs.map(job => job.status), ['done', 'exists', 'done']);
    assert.deepEqual((await studio.image(1)).bytes, PNG);
    assert.deepEqual((await studio.image(3)).bytes, PNG);
    await studio.action('settings', { style: DEFAULT_STYLE, range: '', outputDir: original });
    assert.deepEqual((await studio.snapshot()).jobs.map(job => job.status), ['exists', 'pending', 'pending']);
    assert.equal(await studio.image(2), null);
    await fs.unlink(path.join(original, '1. Дрон.png'));
    await studio.action('settings', { style: DEFAULT_STYLE, range: '', outputDir: original });
    assert.deepEqual((await studio.snapshot()).jobs.map(job => job.status), ['pending', 'pending', 'pending']);
    assert.equal(await studio.image(1), null);
  } finally {
    if (studio) await studio.close(); assert.equal(path.dirname(f.root), ROOT);
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('image folder validation and write failures preserve settings and create no image files', async () => {
  const f = await fixture();
  try {
    const before = await f.studio.snapshot();
    for (const outputDir of ['', 'relative/path', null, 42, 'bad\0path']) {
      await assert.rejects(f.studio.action('settings', { style: 'Changed', range: '', outputDir }), /повний шлях/);
    }
    const blocked = path.join(f.root, 'not-a-folder'); await fs.writeFile(blocked, 'keep');
    await assert.rejects(f.studio.action('settings', { style: 'Changed', range: '', outputDir: blocked }), /дозвіл на запис/);
    assert.equal((await f.studio.snapshot()).outputDir, before.outputDir);
    assert.equal((await f.studio.snapshot()).style, before.style);
    assert.equal(await fs.readFile(blocked, 'utf8'), 'keep');
    const next = path.join(f.root, 'created', 'images');
    await f.studio.action('settings', { style: DEFAULT_STYLE, range: '', outputDir: next });
    assert.deepEqual(await fs.readdir(next), []);
  } finally { await f.clean(); }
});

test('older progress uses the default image folder and scans its existing images', async () => {
  const f = await fixture(); await f.studio.close();
  const stateFile = path.join(f.root, '.data/state.json'); const state = JSON.parse(await fs.readFile(stateFile));
  delete state.outputDir;
  await fs.writeFile(stateFile, JSON.stringify(state));
  await fs.writeFile(path.join(f.root, 'output/images/1. Дрон.png'), PNG);
  const again = await createStudio({ root: f.root, generate: async () => PNG });
  try {
    const restored = await again.snapshot();
    assert.equal(restored.outputDir, path.join(f.root, 'output/images'));
    assert.equal(restored.jobs[0].status, 'exists');
    assert.deepEqual((await again.image(1)).bytes, PNG);
  } finally {
    await again.close(); assert.equal(path.dirname(f.root), ROOT);
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('save-ready writes every ready image directly to the target folder, skips existing variants and never generates', async () => {
  let calls = 0; const f = await fixture(async () => { calls++; return PNG; });
  try {
    await f.studio.action('start'); await f.studio.settled();
    const original = (await f.studio.snapshot()).outputDir;
    const target = path.join(f.root, 'Усі готові картинки'); await fs.mkdir(target);
    const existing = Buffer.concat([PNG, Buffer.from('existing')]);
    await fs.writeFile(path.join(target, '2. Батарея.jpg'), existing);
    const result = await f.studio.action('save-ready', { style: DEFAULT_STYLE, range: '1', outputDir: target });
    assert.deepEqual(result.savedReady, { copied: 2, skipped: 1, failed: [] });
    assert.equal(result.outputDir, target); assert.equal(calls, 3);
    assert.deepEqual(result.jobs.map(job => job.status), ['exists', 'exists', 'exists']);
    assert.deepEqual((await fs.readdir(target)).sort(), ['1. Дрон.png', '2. Батарея.jpg', '3. Камера.png'].sort());
    assert.deepEqual(await fs.readFile(path.join(target, '1. Дрон.png')), PNG);
    assert.deepEqual(await fs.readFile(path.join(target, '2. Батарея.jpg')), existing);
    assert.equal((await fs.readdir(original)).length, 3);
    const again = await f.studio.action('save-ready', { style: DEFAULT_STYLE, range: '', outputDir: target });
    assert.deepEqual(again.savedReady, { copied: 0, skipped: 3, failed: [] }); assert.equal(calls, 3);
  } finally { await f.clean(); }
});

test('save-ready reports deleted originals and invalid destination conflicts while saving the remaining files', async () => {
  let calls = 0; const f = await fixture(async () => { calls++; return PNG; });
  try {
    await f.studio.action('start'); await f.studio.settled();
    const original = (await f.studio.snapshot()).outputDir;
    await fs.unlink(path.join(original, '1. Дрон.png'));
    const target = path.join(f.root, 'destination'); await fs.mkdir(target);
    await fs.writeFile(path.join(target, '3. Камера.png'), 'keep this file');
    const result = await f.studio.action('save-ready', { style: DEFAULT_STYLE, range: '', outputDir: target });
    assert.equal(result.savedReady.copied, 1); assert.equal(result.savedReady.skipped, 0);
    assert.deepEqual(result.savedReady.failed.map(job => job.number), [1, 3]);
    assert.match(result.savedReady.failed[0].message, /Оригінальний файл відсутній/);
    assert.match(result.savedReady.failed[1].message, /не перезаписано/);
    assert.equal(await fs.readFile(path.join(target, '3. Камера.png'), 'utf8'), 'keep this file');
    assert.deepEqual(await fs.readFile(path.join(target, '2. Батарея.png')), PNG);
    assert.deepEqual(result.jobs.map(job => job.status), ['pending', 'exists', 'pending']);
    assert.equal(calls, 3);
  } finally { await f.clean(); }
});

test('save-ready validates destination and settings before copying files or changing the working folder', async () => {
  const f = await fixture();
  try {
    await f.studio.action('start'); await f.studio.settled();
    const original = (await f.studio.snapshot()).outputDir;
    await assert.rejects(f.studio.action('save-ready', { style: DEFAULT_STYLE, range: '', outputDir: 'relative' }), /повний шлях/);
    const target = path.join(f.root, 'must-not-exist');
    await assert.rejects(f.studio.action('save-ready', { style: DEFAULT_STYLE, range: '999', outputDir: target }));
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    assert.equal((await f.studio.snapshot()).outputDir, original);
    assert.equal((await f.studio.snapshot()).jobs.filter(job => job.status === 'done').length, 3);
  } finally { await f.clean(); }
});

test('one click runs a complete batch, and the next batch continues without repeating files', async () => {
  const prompts = []; const f = await fixture(async ({ prompt }) => { prompts.push(prompt); return PNG; });
  try {
    await f.studio.action('settings', { style: DEFAULT_STYLE, range: '', batchSize: 2 });
    assert.equal((await f.studio.snapshot()).nextBatch, 2);
    await f.studio.action('start'); await f.studio.settled();
    let state = await f.studio.snapshot();
    assert.deepEqual(state.jobs.map(job => job.status), ['done', 'done', 'pending']);
    assert.equal(state.batchDone, 2); assert.equal(state.nextBatch, 1); assert.equal(prompts.length, 2);
    await f.studio.action('start'); await f.studio.settled(); state = await f.studio.snapshot();
    assert.equal(state.jobs[2].status, 'done'); assert.equal(prompts.length, 3); assert.equal(state.queued, 0);
    await assert.rejects(f.studio.action('settings', { style: DEFAULT_STYLE, range: '', batchSize: -1 }));
    assert.equal((await f.studio.snapshot()).batchSize, 2);
  } finally { await f.clean(); }
});

test('older saved queues default to a 30 second delay; only valid whole seconds are saved', async () => {
  const f = await fixture(); await f.studio.close();
  const statePath = path.join(f.root, '.data/state.json');
  const saved = JSON.parse(await fs.readFile(statePath)); delete saved.requestDelaySeconds;
  await fs.writeFile(statePath, JSON.stringify(saved));
  const again = await createStudio({ root: f.root, generate: async () => PNG, listProfiles: async () => [] });
  try {
    assert.equal((await again.snapshot()).requestDelaySeconds, 30);
    for (const value of [-1, 3601, 0.5, '30', null]) {
      await assert.rejects(again.action('settings', { style: 'Changed', range: '', requestDelaySeconds: value }), /Затримка/);
      assert.equal((await again.snapshot()).style, saved.style);
    }
    await again.action('settings', { style: DEFAULT_STYLE, range: '', requestDelaySeconds: 45 });
    assert.equal(JSON.parse(await fs.readFile(statePath)).requestDelaySeconds, 45);
    await again.action('settings', { style: DEFAULT_STYLE, range: '' });
    assert.equal((await again.snapshot()).requestDelaySeconds, 45);
  } finally {
    await again.close(); assert.equal(path.dirname(f.root), ROOT);
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('the delay separates successful requests, retries and account changes after each attempt finishes', { timeout: 15000 }, async () => {
  const calls = []; const f = await fixture(async ({ geminiUrl }) => {
    const call = { url: geminiUrl, started: Date.now() }; calls.push(call);
    await sleep(40); call.finished = Date.now();
    if (calls.length === 1) throw Object.assign(new Error('Tool failure'), { kind: 'tool-setup' });
    if (calls.length === 2) throw Object.assign(new Error('Quota'), { kind: 'limit' });
    return PNG;
  }, { requestDelaySeconds: 1 });
  try {
    await f.studio.action('settings', { style: DEFAULT_STYLE, range: '1-2', browserMode: 'existing', chromeProfile: 'Default', background: false });
    await f.studio.action('account-add', { name: 'Другий', url: 'https://gemini.google.com/u/2/app' });
    await f.studio.action('start'); await f.studio.settled();
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.map(call => call.url), ['https://gemini.google.com/app', 'https://gemini.google.com/app', 'https://gemini.google.com/u/2/app', 'https://gemini.google.com/u/2/app']);
    for (let i = 1; i < calls.length; i++) assert.ok(calls[i].started - calls[i - 1].finished >= 1000);
    const state = await f.studio.snapshot();
    assert.equal(state.status, 'complete'); assert.equal(state.waitingUntil, undefined);
    assert.deepEqual(state.jobs.map(job => job.status), ['done', 'done', 'pending']);
  } finally { await f.clean(); }
});

test('pausing during a 30 second delay stops immediately and leaves the next request unsent', { timeout: 5000 }, async () => {
  let calls = 0; const f = await fixture(async () => { calls++; return PNG; }, { requestDelaySeconds: 30 });
  try {
    await f.studio.action('start');
    const deadline = Date.now() + 2000;
    while (!(await f.studio.snapshot()).waitingUntil && Date.now() < deadline) await sleep(10);
    assert.ok((await f.studio.snapshot()).waitingUntil);
    const pausedAt = Date.now(); await f.studio.action('pause'); await f.studio.settled();
    assert.ok(Date.now() - pausedAt < 1000); assert.equal(calls, 1);
    const state = await f.studio.snapshot();
    assert.equal(state.status, 'paused'); assert.equal(state.waitingUntil, undefined);
    assert.deepEqual(state.jobs.map(job => job.status), ['done', 'pending', 'pending']);
  } finally { await f.clean(); }
});

test('remaining delay and custom seconds survive a server restart between batches', { timeout: 5000 }, async () => {
  const calls = []; const generate = async () => { calls.push(Date.now()); return PNG; };
  const f = await fixture(generate, { requestDelaySeconds: 1 });
  await f.studio.action('settings', { style: DEFAULT_STYLE, range: '', batchSize: 1 });
  await f.studio.action('start'); await f.studio.settled(); await f.studio.close();
  const saved = JSON.parse(await fs.readFile(path.join(f.root, '.data/state.json')));
  const again = await createStudio({ root: f.root, generate, listProfiles: async () => [] });
  try {
    assert.equal((await again.snapshot()).requestDelaySeconds, 1);
    await again.action('start'); await again.settled();
    assert.equal(calls.length, 2); assert.ok(calls[1] - Date.parse(saved.lastRequestFinishedAt) >= 1000);
    assert.deepEqual((await again.snapshot()).jobs.map(job => job.status), ['done', 'done', 'pending']);
  } finally {
    await again.close(); assert.equal(path.dirname(f.root), ROOT);
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('quota errors pause without sending the next term and require explicit retry', async () => {
  let count = 0; const f = await fixture(async () => { count++; throw Object.assign(new Error('Ліміт Gemini'), { kind: 'limit' }); });
  try {
    await f.studio.action('start'); await f.studio.settled();
    let state = await f.studio.snapshot(); assert.equal(count, 1); assert.equal(state.reason, 'limit');
    assert.deepEqual(state.jobs.map(job => job.status), ['error', 'pending', 'pending']);
    assert.equal(state.jobs[0].errorKind, 'limit');
    await assert.rejects(f.studio.action('start'), /Після відновлення/); assert.equal(count, 1);
    await f.studio.action('retry', { number: 1 }); state = await f.studio.snapshot(); assert.equal(state.jobs[0].status, 'pending'); assert.equal(state.reason, undefined);
  } finally { await f.clean(); }
});

test('the actual Ukrainian daily image limit is not mistaken for a slow response', () => {
  assert.equal(failureKind('Сьогодні я не можу створити для вас більше зображень, проте все одно можу шукати їх в Інтернеті.'), 'limit');
  assert.equal(failureKind('Я не можу створити більше зображень сьогодні.'), 'limit');
  assert.equal(failureKind('I can’t create any more images for you today, but I can find images online.'), 'limit');
  assert.equal(failureKind('Я не можу створити це зображення через його зміст.'), 'error');
});

test('a capability refusal retries the same term once, then continues the batch', async () => {
  const calls = []; const f = await fixture(async ({ prompt }) => {
    calls.push(prompt);
    if (calls.length === 1) throw Object.assign(new Error('Я не маю потрібних функцій для таких завдань.'), { kind: 'capability' });
    return PNG;
  });
  try {
    await f.studio.action('start'); await f.studio.settled();
    const state = await f.studio.snapshot();
    assert.equal(calls.length, 4); assert.equal(calls[0], calls[1]);
    assert.equal(state.jobs[0].attempts, 2); assert.equal(state.status, 'complete');
    assert.ok(state.jobs.every(job => job.status === 'done'));
  } finally { await f.clean(); }
});

test('two capability failures leave that row for review and continue the batch', async () => {
  let calls = 0; const f = await fixture(async () => { if (++calls <= 2) throw Object.assign(new Error('No image function'), { kind: 'capability' }); return PNG; });
  try {
    await f.studio.action('start'); await f.studio.settled(); const state = await f.studio.snapshot();
    assert.equal(calls, 4); assert.equal(state.status, 'complete'); assert.equal(state.jobs[0].attempts, 2);
    assert.deepEqual(state.jobs.map(job => job.status), ['error', 'done', 'done']);
    assert.equal(state.batchDone, 2); assert.equal(state.batchFailed, 1);
  } finally { await f.clean(); }
});

test('a tool-menu setup failure gets one fresh-session retry', async () => {
  let calls = 0; const f = await fixture(async () => {
    if (++calls === 1) throw Object.assign(new Error('Menu still loading'), { kind: 'tool-setup' });
    return PNG;
  });
  try {
    await f.studio.action('settings', { style: DEFAULT_STYLE, range: '1' });
    await f.studio.action('start'); await f.studio.settled();
    const state = await f.studio.snapshot();
    assert.equal(calls, 2); assert.equal(state.jobs[0].status, 'done');
    assert.equal(state.jobs[0].attempts, 2);
  } finally { await f.clean(); }
});

test('content refusals are not automatically retried', async () => {
  let calls = 0; const f = await fixture(async () => { calls++; throw Object.assign(new Error('Content refusal'), { kind: 'refusal' }); });
  try { await f.studio.action('start'); await f.studio.settled(); assert.equal(calls, 3); assert.equal((await f.studio.snapshot()).batchFailed, 3); }
  finally { await f.clean(); }
});

test('background mode is saved and passed to every generation attempt', async () => {
  const modes = []; const f = await fixture(async ({ background }) => { modes.push(background); return PNG; });
  try {
    assert.equal((await f.studio.snapshot()).background, true);
    await f.studio.action('settings', { style: DEFAULT_STYLE, range: '1', background: false });
    await f.studio.action('start'); await f.studio.settled();
    assert.deepEqual(modes, [false]);
    await assert.rejects(f.studio.action('settings', { style: DEFAULT_STYLE, range: '', background: 'true' }));
    assert.equal((await f.studio.snapshot()).background, false);
  } finally { await f.clean(); }
});

test('an existing Chrome profile is validated, saved, checked and passed to the whole batch', async () => {
  const calls = []; const checks = []; const logins = [];
  const f = await fixture(async ({ browserMode, chromeProfile, background }) => { calls.push({ browserMode, chromeProfile, background }); return PNG; }, {
    login: async (profile, options) => logins.push(options), checkBrowser: async options => checks.push(options)
  });
  try {
    await assert.rejects(f.studio.action('settings', { style: DEFAULT_STYLE, range: '', browserMode: 'existing', chromeProfile: '../Default', background: false }), /Оберіть наявний/);
    await assert.rejects(f.studio.action('settings', { style: DEFAULT_STYLE, range: '', browserMode: 'existing', chromeProfile: 'Profile 1', background: true }), /прихований режим/);
    assert.equal((await f.studio.snapshot()).browserMode, 'dedicated');
    await f.studio.action('settings', { style: DEFAULT_STYLE, range: '', browserMode: 'existing', chromeProfile: 'Profile 1', background: false });
    await f.studio.action('login'); await f.studio.action('check-browser');
    assert.deepEqual(logins, [{ root: f.root, browserMode: 'existing', chromeProfile: 'Profile 1', geminiUrl: 'https://gemini.google.com/app' }]);
    assert.equal(checks[0].chromeProfile, 'Profile 1');
    assert.equal(calls.length, 0);
    await f.studio.action('start'); await f.studio.settled();
    assert.equal(calls.length, 3); assert.ok(calls.every(call => call.browserMode === 'existing' && call.chromeProfile === 'Profile 1' && call.background === false));
    const saved = JSON.parse(await fs.readFile(path.join(f.root, '.data/state.json')));
    assert.equal(saved.chromeProfile, 'Profile 1'); assert.equal(saved.browserMode, 'existing');
  } finally { await f.clean(); }
});

test('Gemini account names, links, switches and order are saved independently for each Chrome profile', async () => {
  const f = await fixture();
  try {
    await f.studio.action('settings', { style: DEFAULT_STYLE, range: '', browserMode: 'existing', chromeProfile: 'Default', background: false });
    await f.studio.action('account-add', { name: 'Робочий', url: 'https://gemini.google.com/u/2/app?pageId=none' });
    let state = await f.studio.snapshot(); const second = state.geminiAccounts['chrome:Default'][1];
    await f.studio.action('account-update', { id: second.id, name: 'Другий робочий', enabled: false });
    await f.studio.action('account-move', { id: second.id, direction: -1 });
    state = await f.studio.snapshot();
    assert.equal(state.geminiAccounts['chrome:Default'][0].id, second.id);
    assert.equal(state.geminiAccounts['chrome:Default'][0].enabled, false);
    await f.studio.action('account-move', { id: second.id, direction: -1 });
    assert.equal((await f.studio.snapshot()).geminiAccounts['chrome:Default'][0].id, second.id);
    await assert.rejects(f.studio.action('account-add', { name: 'Дублікат', url: 'https://gemini.google.com/u/2/app' }), /вже є/);
    await assert.rejects(f.studio.action('account-add', { name: 'Інший', url: 'https://example.org/app' }), /посилання Gemini/);
    await f.studio.action('settings', { style: DEFAULT_STYLE, range: '', browserMode: 'existing', chromeProfile: 'Profile 1', background: false });
    assert.equal((await f.studio.snapshot()).geminiAccounts['chrome:Profile 1'].length, 1);
    await assert.rejects(f.studio.action('account-update', { id: second.id, enabled: true }), /не знайдено/);
    const saved = JSON.parse(await fs.readFile(path.join(f.root, '.data/state.json')));
    assert.equal(saved.geminiAccounts['chrome:Default'][0].name, 'Другий робочий');
    assert.equal(saved.geminiAccounts['chrome:Default'][0].url, 'https://gemini.google.com/u/2/app?pageId=none');
    assert.equal(saved.geminiAccounts['chrome:Profile 1'][0].enabled, true);
  } finally { await f.clean(); }
});

test('generation stays on the first enabled account and moves the same term to the next account on quota', async () => {
  const urls = []; const f = await fixture(async ({ geminiUrl }) => {
    urls.push(geminiUrl);
    if (urls.length === 1) throw Object.assign(new Error('No image tool'), { kind: 'capability' });
    if (urls.length === 3) throw Object.assign(new Error('Daily quota'), { kind: 'limit' });
    return PNG;
  });
  try {
    await f.studio.action('settings', { style: DEFAULT_STYLE, range: '', browserMode: 'existing', chromeProfile: 'Default', background: false });
    await f.studio.action('account-update', { id: 'main', enabled: false });
    await f.studio.action('account-add', { name: 'Перший', url: 'https://gemini.google.com/u/1/app' });
    await f.studio.action('account-add', { name: 'Другий', url: 'https://gemini.google.com/u/2/app?pageId=none' });
    const second = (await f.studio.snapshot()).geminiAccounts['chrome:Default'][2];
    await f.studio.action('account-move', { id: second.id, direction: -1 });
    await f.studio.action('start'); await f.studio.settled();
    const state = await f.studio.snapshot();
    assert.deepEqual(urls, [second.url, second.url, second.url, 'https://gemini.google.com/u/1/app', 'https://gemini.google.com/u/1/app']);
    assert.deepEqual(state.jobs.map(job => job.geminiAccount.name), ['Другий', 'Перший', 'Перший']);
    assert.deepEqual(state.batch.accounts.map(account => account.name), ['Другий', 'Перший']);
    assert.equal(state.geminiAccounts['chrome:Default'].find(account => account.id === second.id).enabled, false);
    assert.ok(state.geminiAccounts['chrome:Default'].find(account => account.id === second.id).limitedAt);
    assert.deepEqual(state.batch.exhaustedAccounts, [second.id]);
    assert.equal(state.batchDone, 3); assert.equal(state.batchFailed, 0);
  } finally { await f.clean(); }
});

test('exhausting every account pauses once and re-enabling an account restores the pending term without starting', async () => {
  const urls = []; const f = await fixture(async ({ geminiUrl }) => { urls.push(geminiUrl); throw Object.assign(new Error('Daily quota'), { kind: 'limit' }); });
  try {
    await f.studio.action('account-add', { name: 'Резервний', url: 'https://gemini.google.com/u/2/app?pageId=none' });
    await f.studio.action('start'); await f.studio.settled();
    let state = await f.studio.snapshot();
    assert.deepEqual(urls, ['https://gemini.google.com/app', 'https://gemini.google.com/app']);
    assert.equal(state.status, 'paused'); assert.equal(state.reason, 'limit');
    assert.ok(state.geminiAccounts.dedicated.every(account => !account.enabled && account.limitedAt));
    assert.deepEqual(state.jobs.map(job => job.status), ['error', 'pending', 'pending']);
    await f.studio.action('account-update', { id: 'main', enabled: true }); state = await f.studio.snapshot();
    assert.equal(state.reason, undefined); assert.equal(state.status, 'paused');
    assert.equal(state.jobs[0].status, 'pending'); assert.equal(urls.length, 2);
    assert.equal(state.geminiAccounts.dedicated[0].limitedAt, undefined);
  } finally { await f.clean(); }
});

test('turning off every Gemini account prevents a batch from sending requests', async () => {
  let calls = 0; const f = await fixture(async () => { calls++; return PNG; });
  try {
    await f.studio.action('account-update', { id: 'main', enabled: false });
    await assert.rejects(f.studio.action('start'), /Увімкніть хоча б один/);
    assert.equal(calls, 0); assert.equal((await f.studio.snapshot()).jobs[0].status, 'pending');
  } finally { await f.clean(); }
});

test('hidden generation switches isolated account sessions without relying on Google account URL positions', async () => {
  const calls = []; const f = await fixture(async options => {
    calls.push(options);
    if (calls.length === 1) throw Object.assign(new Error('Quota'), { kind: 'limit' });
    return PNG;
  });
  try {
    await f.studio.action('account-add', { name: 'GWS', url: 'https://gemini.google.com/app' });
    const second = (await f.studio.snapshot()).geminiAccounts.dedicated[1];
    await f.studio.action('start'); await f.studio.settled();
    assert.equal(calls.length, 4);
    assert.equal(calls[0].profile, path.join(f.root, '.data/browser-profile'));
    assert.ok(calls.slice(1).every(call => call.profile === path.join(f.root, '.data/account-profiles', second.id)));
    assert.ok(calls.every(call => call.background && call.browserMode === 'dedicated' && call.geminiUrl === 'https://gemini.google.com/app'));
    assert.ok((await f.studio.snapshot()).jobs.every(job => job.status === 'done' && job.geminiAccount.name === 'GWS'));
  } finally { await f.clean(); }
});

test('account login and hidden session checks use only that account profile and never generate an image', async () => {
  const logins = [], checks = []; let generations = 0, rejectCheck = false;
  const f = await fixture(async () => { generations++; return PNG; }, {
    login: async (profile, options) => logins.push({ profile, options }),
    checkSession: async options => { checks.push(options); if (rejectCheck) throw new Error('Sign in'); }
  });
  try {
    await f.studio.action('account-add', { name: 'GWS', url: 'https://gemini.google.com/app' });
    const account = (await f.studio.snapshot()).geminiAccounts.dedicated[1];
    await f.studio.action('account-login', { id: account.id });
    assert.equal(logins[0].profile, path.join(f.root, '.data/account-profiles', account.id));
    assert.deepEqual(logins[0].options, { root: f.root, browserMode: 'dedicated', geminiUrl: 'https://gemini.google.com/app' });
    await f.studio.action('account-check', { id: account.id });
    assert.equal(checks[0].profile, logins[0].profile);
    assert.ok((await f.studio.snapshot()).geminiAccounts.dedicated[1].sessionCheckedAt);
    rejectCheck = true; await assert.rejects(f.studio.action('account-check', { id: account.id }), /Sign in/);
    assert.equal((await f.studio.snapshot()).geminiAccounts.dedicated[1].sessionCheckedAt, undefined);
    assert.equal(generations, 0);
    await assert.rejects(f.studio.action('account-login', { id: '../other' }), /не знайдено/);
  } finally { await f.clean(); }
});

test('stop now aborts the current request and never submits the next term', async () => {
  let started; const entered = new Promise(resolve => started = resolve); let calls = 0;
  const f = await fixture(({ signal }) => new Promise((resolve, reject) => {
    calls++; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); started();
  }));
  try {
    await f.studio.action('start'); await entered; await f.studio.action('stop'); await f.studio.settled();
    const state = await f.studio.snapshot();
    assert.equal(calls, 1); assert.equal(state.status, 'paused');
    assert.deepEqual(state.jobs.map(job => job.status), ['interrupted', 'pending', 'pending']);
  } finally { await f.clean(); }
});

test('checking the correct renewed login restores its stopped term without starting generation', async () => {
  let calls = 0; const f = await fixture(async () => {
    if (++calls === 1) throw Object.assign(new Error('Sign in'), { kind: 'login' });
    return PNG;
  });
  try {
    await f.studio.action('account-add', { name: 'Другий', url: 'https://gemini.google.com/app' });
    const second = (await f.studio.snapshot()).geminiAccounts.dedicated[1];
    await f.studio.action('start'); await f.studio.settled();
    await f.studio.action('account-check', { id: second.id });
    assert.equal((await f.studio.snapshot()).reason, 'login');
    await f.studio.action('account-check', { id: 'main' });
    const state = await f.studio.snapshot();
    assert.equal(state.status, 'paused'); assert.equal(state.reason, undefined);
    assert.equal(state.jobs[0].status, 'pending'); assert.equal(calls, 1);
    await f.studio.action('start'); await f.studio.settled();
    assert.ok((await f.studio.snapshot()).jobs.every(job => job.status === 'done'));
  } finally { await f.clean(); }
});

test('a restarted uncertain request is held for review', async () => {
  const f = await fixture(); await f.studio.close();
  const statePath = path.join(f.root, '.data/state.json');
  const saved = JSON.parse(await fs.readFile(statePath)); saved.status = 'running'; saved.jobs[0].status = 'running';
  await fs.writeFile(statePath, JSON.stringify(saved));
  const again = await createStudio({ root: f.root, generate: async () => PNG });
  try {
    assert.equal((await again.snapshot()).jobs[0].status, 'interrupted');
    await again.action('start'); await again.settled();
    assert.deepEqual((await again.snapshot()).jobs.map(job => job.status), ['interrupted', 'done', 'done']);
  }
  finally { await again.close(); assert.ok(f.root.startsWith(path.join(ROOT, '.test-'))); await fs.rm(f.root, { recursive: true, force: true }); }
});

test('a 25-row batch continues after a stalled row, records phases and never overwrites completed files', async () => {
  let calls = 0; let f;
  f = await fixture(async ({ prompt, onProgress }) => {
    calls++;
    if (prompt.includes('«Поняття 1»')) throw Object.assign(new Error('Gemini не повернув зображення за 2 хвилини.'), { kind: 'timeout' });
    await onProgress('Зберігаємо зображення…');
    assert.equal((await f.studio.snapshot()).jobs.find(job => job.status === 'running').phase, 'Зберігаємо зображення…');
    return PNG;
  });
  try {
    const csv = 'Поняття,Опис\n' + Array.from({ length: 26 }, (_, n) => `Поняття ${n + 1},Опис ${n + 1}`).join('\n');
    await f.studio.action('import', { csv, nameColumn: 0, descriptionColumn: 1 });
    await f.studio.action('start'); await f.studio.settled();
    let state = await f.studio.snapshot();
    assert.equal(calls, 26); assert.equal(state.jobs[0].attempts, 2);
    assert.equal(state.batchDone, 24); assert.equal(state.batchFailed, 1); assert.equal(state.status, 'complete');
    assert.equal(state.jobs[25].status, 'pending');
    assert.equal(state.jobs[1].phase, undefined);
    const saved = await fs.readFile(path.join(f.root, 'output/images/2. Поняття 2.png'));
    await f.studio.action('start'); await f.studio.settled(); state = await f.studio.snapshot();
    assert.equal(calls, 27); assert.equal(state.jobs[0].attempts, 2); assert.equal(state.jobs[25].status, 'done');
    assert.deepEqual(await fs.readFile(path.join(f.root, 'output/images/2. Поняття 2.png')), saved);
  } finally { await f.clean(); }
});

test('login failure stops a batch without retrying or submitting other terms', async () => {
  let calls = 0; const f = await fixture(async () => { calls++; throw Object.assign(new Error('Увійдіть у Gemini'), { kind: 'login' }); });
  try {
    await f.studio.action('start'); await f.studio.settled(); const state = await f.studio.snapshot();
    assert.equal(calls, 1); assert.equal(state.status, 'paused'); assert.equal(state.reason, 'login');
    assert.deepEqual(state.jobs.map(job => job.status), ['error', 'pending', 'pending']);
  } finally { await f.clean(); }
});

test('invalid settings and imports do not change saved progress; valid imports keep a backup', async () => {
  const f = await fixture();
  try {
    const before = await f.studio.snapshot();
    await assert.rejects(f.studio.action('settings', { style: 'new style', range: '142' }));
    assert.equal((await f.studio.snapshot()).style, before.style);
    await assert.rejects(f.studio.action('import', { csv: 'a,b\n"unfinished', nameColumn: 0, descriptionColumn: 1 }));
    assert.equal((await f.studio.snapshot()).jobs.length, 3);
    await f.studio.action('import', { csv: 'Термін,Опис\nГвинт,Обертається', nameColumn: 0, descriptionColumn: 1, filename: 'new.csv' });
    assert.equal((await f.studio.snapshot()).jobs.length, 1);
    const backups = (await fs.readdir(path.join(f.root, '.data'))).filter(name => name.startsWith('backup-'));
    assert.equal(backups.length, 1); assert.equal(JSON.parse(await fs.readFile(path.join(f.root, '.data', backups[0]))).jobs.length, 3);
  } finally { await f.clean(); }
});

test('CSV reimport retains scene descriptions for known terms', async () => {
  const f = await fixture();
  try {
    await f.studio.action('import', { csv: CSV, nameColumn: 0, descriptionColumn: 1 });
    const job = (await f.studio.snapshot()).jobs[0];
    assert.equal(job.scene, 'Квадрокоптер над платформою');
    assert.match(buildPrompt(job, DEFAULT_STYLE), /Сцена: Квадрокоптер над платформою/);
  } finally { await f.clean(); }
});

test('startup restores scenes dropped by older imports without resetting job status', async () => {
  const f = await fixture(); await f.studio.close();
  const statePath = path.join(f.root, '.data/state.json');
  const state = JSON.parse(await fs.readFile(statePath));
  state.jobs[0].scene = ''; state.jobs[0].status = 'error'; state.jobs[0].error = 'Previous response';
  await fs.writeFile(statePath, JSON.stringify(state));
  const again = await createStudio({ root: f.root, generate: async () => PNG });
  try {
    const restored = (await again.snapshot()).jobs[0];
    assert.equal(restored.scene, 'Квадрокоптер над платформою'); assert.equal(restored.status, 'error');
    assert.equal(restored.error, 'Previous response');
    const backups = (await fs.readdir(path.join(f.root, '.data'))).filter(name => name.startsWith('backup-scenes-'));
    assert.equal(backups.length, 1);
  } finally {
    await again.close(); assert.equal(path.dirname(f.root), ROOT);
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('a file created during generation is never overwritten', async () => {
  let f; f = await fixture(async () => { await fs.writeFile(path.join(f.root, 'output/images/1. Дрон.png'), PNG); return PNG; });
  try {
    await f.studio.action('start'); await f.studio.settled();
    assert.equal((await f.studio.snapshot()).jobs[0].status, 'error');
    assert.deepEqual(await fs.readFile(path.join(f.root, 'output/images/1. Дрон.png')), PNG);
    await f.studio.action('scan'); assert.equal((await f.studio.snapshot()).jobs[0].status, 'exists');
  } finally { await f.clean(); }
});

test('a second app cannot share the same progress directory', async () => {
  const f = await fixture(); try { await assert.rejects(createStudio({ root: f.root }), /Спочатку/); } finally { await f.clean(); }
});

test('diagnostic screenshots are opt-in and can be removed without deleting logs', async () => {
  const f = await fixture();
  try {
    const run = path.join(f.root, '.data', 'runs', 'test'); await fs.mkdir(run, { recursive: true });
    await fs.writeFile(path.join(run, 'page.png'), PNG); await fs.writeFile(path.join(run, 'page-state.json'), '{}'); await fs.writeFile(path.join(run, 'oracle.log'), 'keep');
    const cleared = await f.studio.action('clear-diagnostics');
    assert.equal(cleared.clearedDiagnostics, 2); await assert.rejects(fs.access(path.join(run, 'page.png'))); await assert.rejects(fs.access(path.join(run, 'page-state.json')));
    assert.equal(await fs.readFile(path.join(run, 'oracle.log'), 'utf8'), 'keep');
    await f.studio.action('settings', { style: DEFAULT_STYLE, range: '', diagnostics: true });
    assert.equal((await f.studio.snapshot()).diagnostics, true);
  } finally { await f.clean(); }
});

test('local HTTP imports, generates, downloads and rejects foreign-site mutations', async () => {
  const f = await fixture(); const server = await listen(f.studio); const url = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const get = (resource, options = {}) => fetch(`${url}${resource}`, { ...options, headers: { cookie, ...options.headers } });
  const post = (action, body, extra = {}) => get(`/api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(url)).status, 200);
    const chromeSession = await fetch(`${url}/chrome-session`);
    assert.equal(chromeSession.status, 200); assert.match(await chromeSession.text(), /Підключаємо студію/);
    assert.equal((await fetch(`${url}/api/state`)).status, 401);
    assert.equal((await fetch(`${url}/images/2`)).status, 401);
    assert.equal((await fetch(`${url}/session/${'x'.repeat(43)}`, { redirect: 'manual' })).status, 401);
    const bootstrap = await fetch(`${url}/session/${server.sessionToken}`, { redirect: 'manual' });
    assert.equal(bootstrap.status, 302); assert.equal(bootstrap.headers.get('location'), '/');
    assert.match(bootstrap.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    cookie = bootstrap.headers.get('set-cookie').split(';')[0];
    assert.equal((await post('start', {}, { origin: 'https://example.org', 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await post('start', {}, { 'sec-fetch-site': 'same-site' })).status, 403);
    assert.equal((await post('preview', { csv: CSV })).status, 200);
    assert.equal((await post('import', { csv: CSV, nameColumn: -1, descriptionColumn: 1 })).status, 400);
    assert.equal((await post('settings', { style: DEFAULT_STYLE, range: '2' })).status, 200);
    assert.equal((await post('start', {})).status, 200); await f.studio.settled();
    const image = await get('/images/2'); assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
    const report = await (await get('/api/report')).json(); assert.equal(report.jobs[1].status, 'done'); assert.ok(report.jobs[1].prompt.includes('Батарея'));
    assert.equal(report.root, undefined); assert.equal(report.outputDir, undefined); assert.equal(report.geminiAccounts, undefined); assert.equal(report.jobs[1].geminiAccount, undefined);
    const health = await (await get('/api/health')).json();
    assert.equal(health.root, undefined); assert.equal(health.instanceId, f.studio.instanceId);
    const state = await (await get('/api/state')).json();
    assert.equal(state.root, undefined); assert.equal(state.instanceId, f.studio.instanceId);
    const saved = await (await post('save-ready', { style: DEFAULT_STYLE, range: '', outputDir: path.join(f.root, 'saved-ready') })).json();
    assert.deepEqual(saved.savedReady, { copied: 1, skipped: 0, failed: [] });
    assert.deepEqual(Buffer.from(await (await get('/images/2')).arrayBuffer()), PNG);
    assert.equal((await fetch(`${url}/.data/state.json`)).status, 404);
    assert.equal((await fetch(`${url}/images/../../input.csv`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); await f.clean(); }
});
