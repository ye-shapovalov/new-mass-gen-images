import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_STYLE, parseCSV, jobsFromCSV, buildPrompt, imageType, outputStem, selectedNumbers } from './core.mjs';
import { findChrome, oracleCLI, generateWithGeminiBrowser, openLogin, assertBackgroundChrome, closeBackgroundChrome, checkExistingChrome, accountBrowserProfile, checkGeminiSession } from './oracle.mjs';
import { listChromeProfiles } from './chrome-profiles.mjs';
import { DEFAULT_GEMINI_URL, accountProfileKey, validateGeminiAccount, geminiAccountIndex } from './gemini-accounts.mjs';
import { ensureSessionToken, migrateLegacyData, runtimeDataDirectory } from './runtime.mjs';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
const busy = () => Object.assign(new Error('Спочатку поставте чергу на паузу й дочекайтеся завершення зображення.'), { status: 409 });
const invalid = message => Object.assign(new Error(message), { status: 400 });
function outputDirectory(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 32767 || value.includes('\0') || !path.isAbsolute(value.trim())) throw invalid('Вкажіть повний шлях до папки зображень, наприклад C:\\Pictures\\New Mass Gen.');
  return path.resolve(value.trim());
}
async function atomicJSON(file, data) {
  await fs.writeFile(`${file}.tmp`, JSON.stringify(data, null, 2));
  await fs.rename(`${file}.tmp`, file);
}

async function clearDiagnosticFiles(directory) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  let removed = 0;
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) removed += await clearDiagnosticFiles(file);
    else if (entry.name === 'page.png' || entry.name === 'page-state.json') { await fs.unlink(file); removed++; }
  }
  return removed;
}

function progressReport(state) {
  return {
    version: state.version, source: state.source, style: state.style, range: state.range,
    batchSize: state.batchSize, status: state.status, exportedAt: new Date().toISOString(),
    jobs: state.jobs.map(job => {
      const { geminiAccount, geminiProfile, log, phase, ...safe } = job;
      return { ...safe, prompt: buildPrompt(job, state.style) };
    })
  };
}

export async function createStudio({ root = ROOT, dataDir, defaultOutputDir, generate = generateWithGeminiBrowser, login = openLogin, listProfiles = listChromeProfiles, checkBrowser = checkExistingChrome, checkSession = checkGeminiSession } = {}) {
  const data = dataDir || (path.resolve(root) === path.resolve(ROOT) ? runtimeDataDirectory() : path.join(root, '.data'));
  const defaultImages = defaultOutputDir || path.join(root, 'output/images');
  const profile = path.join(data, 'browser-profile'); const stateFile = path.join(data, 'state.json');
  await fs.mkdir(data, { recursive: true });
  const lockFile = path.join(data, 'server.lock');
  try { await fs.writeFile(lockFile, String(process.pid), { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await fs.readFile(lockFile, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Перевірте локальний server.lock: некоректний номер процесу.');
    try { process.kill(pid, 0); throw busy(); }
    catch (check) { if (check.code !== 'ESRCH') throw check; }
    await fs.unlink(lockFile);
    await fs.writeFile(lockFile, String(process.pid), { flag: 'wx' });
  }
  let state; let scenes = {}; let chain = Promise.resolve(); let worker = null; let controller; let delayController; let pause = false;
  let chromeProfiles = [];
  const locked = fn => { const next = chain.then(fn); chain = next.catch(() => {}); return next; };
  const save = () => atomicJSON(stateFile, state);
  const requireIdle = () => { if (worker) throw busy(); };
  const maxJobNumber = () => Math.max(...state.jobs.map(job => job.number));
  const selected = () => selectedNumbers(state.range, maxJobNumber());
  const accountKey = () => accountProfileKey(state.browserMode, state.chromeProfile);
  const accounts = () => state.geminiAccounts[accountKey()];
  const accountProfile = account => state.browserMode === 'dedicated' ? accountBrowserProfile(profile, account.id) : profile;
  const accountURL = account => state.browserMode === 'dedicated' ? DEFAULT_GEMINI_URL : account.url;
  const log = message => {
    state.events.push({ at: new Date().toISOString(), message });
    state.events = state.events.slice(-200);
  };
  const resetBatch = () => {
    delete state.batch;
    if (!state.reason || !state.jobs.some(job => job.errorKind === state.reason)) {
      delete state.reason;
      state.status = 'idle';
    }
  };
  async function archiveImage(job) {
    if (!job.filename || path.basename(job.filename) !== job.filename) return;
    const source = path.join(state.outputDir, job.filename);
    const archive = path.join(state.outputDir, '_previous');
    await fs.mkdir(archive, { recursive: true });
    await fs.rename(source, path.join(archive, `${Date.now()} - ${job.filename}`));
  }
  function resetJobForQueue(job, status) {
    job.status = status; job.attempts = 0;
    for (const key of ['error', 'errorKind', 'completedAt', 'startedAt', 'phase', 'log', 'geminiAccount', 'geminiProfile']) delete job[key];
    if (status === 'pending') delete job.filename;
  }
  async function applyQueueSelection(range, regenerateSelected) {
    const included = selectedNumbers(range, maxJobNumber());
    let queued = 0; let held = 0; let regenerated = 0; let kept = 0;
    for (const job of state.jobs) {
      if (['done', 'exists'].includes(job.status)) {
        if (!included.has(job.number)) continue;
        if (!regenerateSelected) { kept++; continue; }
        try { await archiveImage(job); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        resetJobForQueue(job, 'pending'); regenerated++; queued++;
      } else if (included.has(job.number)) {
        resetJobForQueue(job, 'pending'); queued++;
      } else {
        resetJobForQueue(job, 'held'); held++;
      }
    }
    resetBatch();
    log(`Застосовано вибір рядків: у черзі ${queued}, призупинено ${held}, готових залишено ${kept}, на перегенерацію ${regenerated}.`);
  }
  function releaseAccountPause() {
    if (!['limit', 'capability'].includes(state.reason) || !accounts()?.some(account => account.enabled)) return;
    for (const job of state.jobs) if (state.batch?.numbers.includes(job.number) && job.status === 'error' && job.errorKind === state.reason) {
      job.status = 'pending'; delete job.error; delete job.errorKind;
    }
    delete state.reason; log('Є увімкнений акаунт Gemini. Пакет можна продовжити кнопкою запуску.');
  }

  async function imageInFolder(folder, job, files) {
    const stem = outputStem(job).toLocaleLowerCase('uk');
    for (const file of files) {
      if (!/\.(png|jpe?g|webp)$/i.test(file) || file.replace(/\.(png|jpe?g|webp)$/i, '').toLocaleLowerCase('uk') !== stem) continue;
      try { imageType(await fs.readFile(path.join(folder, file))); return file; }
      catch { /* An invalid file is never counted as complete. */ }
    }
    return null;
  }

  async function scan() {
    const images = state.outputDir;
    const files = await fs.readdir(images);
    for (const job of state.jobs) {
      const found = await imageInFolder(images, job, files);
      if (found) { job.filename = found; job.status = job.status === 'done' ? 'done' : 'exists'; delete job.error; }
      else if (['done', 'exists'].includes(job.status)) { job.status = 'pending'; delete job.filename; }
    }
  }

  try {
    chromeProfiles = await listProfiles();
    scenes = JSON.parse(await fs.readFile(path.join(root, 'scenes.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; }));
    try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Не вдалося прочитати локальний state.json. Файл збережено без змін.', { cause: error });
      const text = await fs.readFile(path.join(root, 'input.csv'), 'utf8');
      state = { version: 1, source: 'input.csv', style: DEFAULT_STYLE, range: '', batchSize: 25, diagnostics: false, status: 'idle', jobs: jobsFromCSV(parseCSV(text), 0, 1, scenes), events: [] };
      log(`Завантажено ${state.jobs.length} рядків із CSV.`);
    }
    if (state.version !== 1 || !Array.isArray(state.jobs) || typeof state.style !== 'string' || !Array.isArray(state.events)) throw new Error('Невідомий формат стану; файл не змінено.');
    if (state.jobs.some(job => !job.scene && typeof scenes[job.name] === 'string' && scenes[job.name].trim())) {
      await atomicJSON(path.join(data, `backup-scenes-${Date.now()}.json`), state);
      for (const job of state.jobs) if (!job.scene && typeof scenes[job.name] === 'string') job.scene = scenes[job.name];
      log('Відновлено сцени для відомих рядків після імпорту CSV.');
    }
    state.batchSize ??= 25;
    state.outputDir = outputDirectory(state.outputDir ?? defaultImages);
    await fs.mkdir(state.outputDir, { recursive: true });
    state.requestDelaySeconds ??= 30;
    state.diagnostics ??= false;
    if (!state.diagnostics) await clearDiagnosticFiles(data);
    delete state.waitingUntil;
    state.background ??= true;
    state.browserMode ??= 'dedicated'; state.chromeProfile ??= '';
    state.geminiAccounts ??= {};
    for (const key of ['dedicated', ...chromeProfiles.map(profile => accountProfileKey('existing', profile.id))]) {
      state.geminiAccounts[key] ??= [{ id: 'main', name: 'Основний акаунт', url: DEFAULT_GEMINI_URL, enabled: true }];
    }
    if (['running', 'pausing'].includes(state.status)) {
      for (const job of state.jobs) if (job.status === 'running') { job.status = 'interrupted'; job.error = 'Запуск перервано. Перевірте Gemini перед повтором.'; }
      state.status = 'paused'; log('Відновлено після перезапуску. Автоматичний повтор вимкнено.');
    }
    await scan(); await save();
  } catch (error) { await fs.unlink(lockFile); throw error; }

  function snapshot() {
    const included = selected();
    const queued = state.jobs.filter(job => included.has(job.number) && job.status === 'pending').length;
    return { ...structuredClone(state), root, chromeProfiles,
      queued, nextBatch: Math.min(queued, state.batchSize || queued),
      batchDone: state.jobs.filter(job => state.batch?.numbers.includes(job.number) && ['done', 'exists'].includes(job.status)).length,
      batchFailed: state.jobs.filter(job => state.batch?.numbers.includes(job.number) && ['error', 'interrupted'].includes(job.status)).length,
      oracle: existsSync(oracleCLI(root)), chrome: Boolean(findChrome()),
      generation: { provider: 'Gemini', transport: 'browser-ui', browserSessions: 'Oracle 0.21.6', background: state.background },
      jobs: state.jobs.map(job => ({ ...job, selected: included.has(job.number) })) };
  }

  async function loop() {
    const retried = new Set();
    let accountIndex = 0;
    try {
      while (!pause) {
        const step = await locked(async () => {
          const job = state.jobs.find(item => state.batch.numbers.includes(item.number) && item.status === 'pending');
          if (!job) return null;
          const nextRequestAt = (Date.parse(state.lastRequestFinishedAt) || 0) + state.requestDelaySeconds * 1000;
          const waitMs = nextRequestAt - Date.now();
          if (waitMs > 0) {
            state.waitingUntil = new Date(nextRequestAt).toISOString(); await save();
            return { waitMs };
          }
          delete state.waitingUntil;
          const prompt = buildPrompt(job, state.style);
          const account = state.batch.accounts[accountIndex];
          job.geminiAccount = { id: account.id, name: account.name, url: accountURL(account) }; job.geminiProfile = accountKey();
          job.status = 'running'; job.attempts++; job.startedAt = new Date().toISOString(); delete job.error; delete job.errorKind;
          job.phase = 'Починаємо спробу…';
          job.log = `${job.number}-${job.attempts}-${Date.now()}`;
          log(`Генерація №${job.number}: ${job.name} · акаунт: ${account.name}`); await save();
          return { job, prompt, account };
        });
        if (!step) break;
        if (step.waitMs) {
          delayController = new AbortController();
          try { if (!pause) await sleep(step.waitMs, undefined, { signal: delayController.signal }); }
          catch (error) { if (error.name !== 'AbortError') throw error; }
          finally { delayController = null; }
          continue;
        }
        const runDir = path.join(data, 'runs', step.job.log);
        await fs.mkdir(runDir, { recursive: true });
        await fs.writeFile(path.join(runDir, 'prompt.txt'), step.prompt);
        try {
          const bytes = await generate({ root, profile: accountProfile(step.account), browserMode: state.browserMode, chromeProfile: state.chromeProfile, background: state.background, diagnostics: state.diagnostics, geminiUrl: accountURL(step.account), prompt: step.prompt, dest: path.join(runDir, 'image.png'), logPath: path.join(runDir, 'oracle.log'), signal: controller.signal,
            onProgress: phase => locked(async () => { if (step.job.status === 'running') { step.job.phase = phase; await save(); } }) });
          const extension = imageType(bytes); const filename = outputStem(step.job) + extension;
          // Exclusive creation keeps files safe even if a user adds one during a request.
          try { await fs.writeFile(path.join(state.outputDir, filename), bytes, { flag: 'wx' }); }
          catch (error) { if (error.code === 'EEXIST') throw new Error('Файл уже існує. Його збережено без змін; натисніть «Перевірити файли».'); throw error; }
          await locked(async () => {
            state.lastRequestFinishedAt = new Date().toISOString();
            Object.assign(step.job, { status: 'done', filename, completedAt: new Date().toISOString() });
            delete step.job.phase;
            log(`Збережено: ${filename}`); await save();
          });
          await fs.unlink(path.join(runDir, 'image.png')).catch(() => {});
        } catch (error) {
          const outcome = await locked(async () => {
            state.lastRequestFinishedAt = new Date().toISOString();
            delete step.job.phase;
            if (error.kind === 'limit') {
              const exhausted = accounts().find(account => account.id === step.account.id);
              if (exhausted) { exhausted.enabled = false; exhausted.limitedAt = new Date().toISOString(); }
              state.batch.exhaustedAccounts ??= []; state.batch.exhaustedAccounts.push(step.account.id);
              if (!pause && accountIndex + 1 < state.batch.accounts.length) {
                accountIndex++; step.job.status = 'pending'; delete step.job.error;
                log(`Ліміт на акаунті «${step.account.name}»: його вимкнено. Повторюємо №${step.job.number} на «${state.batch.accounts[accountIndex].name}».`);
                await save(); return 'next-account';
              }
            }
            const retryKey = `${step.job.number}:${step.account.id}`;
            if (['capability', 'tool-setup', 'timeout'].includes(error.kind) && !pause && !retried.has(retryKey)) {
              retried.add(retryKey); step.job.status = 'pending';
              step.job.error = error.message;
              log(`№${step.job.number}: ${error.message} Автоматичний повтор у новій сесії, спроба 2/2.`);
              await save(); return 'retry';
            }
            if (error.kind === 'capability' && !pause) {
              const unavailable = accounts().find(account => account.id === step.account.id);
              if (unavailable) { unavailable.enabled = false; unavailable.capabilityAt = new Date().toISOString(); }
              state.batch.unavailableAccounts ??= []; state.batch.unavailableAccounts.push(step.account.id);
              if (accountIndex + 1 < state.batch.accounts.length) {
                accountIndex++; step.job.status = 'pending'; delete step.job.error;
                log(`Акаунт «${step.account.name}» не підтримує генерацію зображень: його вимкнено. Повторюємо №${step.job.number} на «${state.batch.accounts[accountIndex].name}».`);
                await save(); return 'next-account';
              }
            }
            step.job.status = error.kind === 'interrupted' ? 'interrupted' : 'error';
            step.job.error = error.message; step.job.errorKind = error.kind || 'error';
            if (['tool-setup', 'timeout', 'refusal'].includes(error.kind) && !pause) {
              log(`№${step.job.number}: ${error.message} Рядок залишено для перевірки; продовжуємо пакет.`);
              await save(); return 'continue';
            }
            state.reason = error.kind || 'error'; state.status = 'paused';
            log(`Пауза №${step.job.number}: ${error.message}`); await save(); return 'stop';
          });
          if (outcome !== 'stop') continue;
          return;
        }
      }
      await locked(async () => {
        delete state.waitingUntil;
        state.status = pause ? 'paused' : 'complete';
        const result = snapshot();
        log(pause ? 'Пакет на паузі. Прогрес збережено.' : `Пакет завершено: збережено ${result.batchDone}/${state.batch.numbers.length}, помилок ${result.batchFailed}. Можна запускати наступний.`);
        await save();
      });
    } catch (error) {
      await locked(async () => {
        delete state.waitingUntil;
        for (const job of state.jobs) if (job.status === 'running') { job.status = 'interrupted'; job.error = error.message; }
        state.status = 'paused'; state.reason = 'error'; log(`Чергу зупинено: ${error.message}`); await save();
      });
    } finally { worker = null; }
  }

  return {
    snapshot: () => locked(snapshot),
    async action(action, body = {}) {
      return locked(async () => {
        if (action === 'pause' || action === 'stop') {
          pause = true;
          delayController?.abort();
          if (action === 'stop') controller?.abort(Object.assign(new Error('Зупинено користувачем. Перевірте результат у Gemini перед повтором.'), { kind: 'interrupted' }));
          if (worker) state.status = 'pausing';
          await save(); return snapshot();
        }
        requireIdle();
        let savedReady;
        if (action === 'clear-diagnostics') {
          const clearedDiagnostics = await clearDiagnosticFiles(data);
          log(`Очищено діагностичних файлів: ${clearedDiagnostics}.`); await save();
          return { ...snapshot(), clearedDiagnostics };
        }
        if (action.startsWith('account-')) {
          const list = accounts();
          if (!list) throw invalid('Спочатку оберіть профіль Chrome.');
          if (action === 'account-login' || action === 'account-check') {
            if (state.browserMode !== 'dedicated') throw invalid('Оберіть прихований Chrome генератора.');
            const account = list.find(item => item.id === body.id);
            if (!account) throw invalid('Акаунт не знайдено.');
            if (action === 'account-login') {
              await login(accountProfile(account), { root, browserMode: 'dedicated', geminiUrl: DEFAULT_GEMINI_URL });
              delete account.sessionCheckedAt;
            } else {
              try { await checkSession({ root, profile: accountProfile(account) }); }
              catch (error) { delete account.sessionCheckedAt; await save(); throw error; }
              account.sessionCheckedAt = new Date().toISOString();
              const stopped = state.jobs.filter(job => job.errorKind === 'login' && job.geminiProfile === accountKey() && job.geminiAccount?.id === account.id);
              if (state.reason === 'login' && stopped.length) {
                for (const job of stopped) { job.status = 'pending'; delete job.error; delete job.errorKind; }
                delete state.reason;
              }
            }
            await save(); return snapshot();
          }
          if (action === 'account-add' || action === 'account-update') {
            const current = action === 'account-update' ? list.find(account => account.id === body.id) : null;
            if (action === 'account-update' && !current) throw invalid('Акаунт не знайдено в цьому профілі.');
            if (!current && list.length >= 50) throw invalid('У профілі вже 50 акаунтів.');
            let next; try { next = validateGeminiAccount({ ...current, ...body, enabled: body.enabled ?? current?.enabled ?? true }); } catch (error) { throw invalid(error.message); }
            if (state.browserMode === 'existing' && list.some(account => account.id !== current?.id && geminiAccountIndex(account.url) === geminiAccountIndex(next.url))) throw invalid('Цей акаунт Gemini вже є у списку цього профілю.');
            if (current) {
              if (next.enabled || next.url !== current.url) { delete current.limitedAt; delete current.capabilityAt; }
              Object.assign(current, next);
            } else list.push({ id: randomUUID(), ...next });
          } else if (action === 'account-move') {
            const index = list.findIndex(account => account.id === body.id);
            if (index < 0 || ![-1, 1].includes(body.direction)) throw invalid('Некоректне переміщення акаунта.');
            const next = index + body.direction;
            if (next >= 0 && next < list.length) [list[index], list[next]] = [list[next], list[index]];
          } else throw invalid('Невідома дія з акаунтом.');
          releaseAccountPause(); await save(); return snapshot();
        }
        if (action === 'login') { const account = accounts()?.find(account => account.enabled) || accounts()?.[0]; await login(account ? accountProfile(account) : profile, { root, browserMode: state.browserMode, chromeProfile: state.chromeProfile, geminiUrl: account ? accountURL(account) : DEFAULT_GEMINI_URL }); return snapshot(); }
        if (action === 'check-browser') {
          if (state.browserMode !== 'existing') throw invalid('Спочатку оберіть «Мій звичайний Chrome» та профіль.');
          await checkBrowser({ root, chromeProfile: state.chromeProfile }); return snapshot();
        }
        if (action === 'settings' || action === 'save-ready') {
          if (typeof body.style !== 'string' || body.style.length > 12000 || !body.style.trim()) throw invalid('Стиль має містити від 1 до 12 000 символів.');
          if (typeof body.range !== 'string') throw invalid('Некоректний діапазон.');
          const batchSize = body.batchSize ?? state.batchSize;
          const requestDelaySeconds = body.requestDelaySeconds === undefined ? state.requestDelaySeconds : body.requestDelaySeconds;
          const background = body.background ?? state.background;
          const diagnostics = body.diagnostics ?? state.diagnostics;
          const applyRange = body.applyRange ?? false; const regenerateSelected = body.regenerateSelected ?? false;
          const browserMode = body.browserMode ?? state.browserMode; const chromeProfile = body.chromeProfile ?? state.chromeProfile;
          if (!['dedicated', 'existing'].includes(browserMode)) throw invalid('Некоректний режим Chrome.');
          if (typeof chromeProfile !== 'string' || (browserMode === 'existing' && !chromeProfiles.some(profile => profile.id === chromeProfile))) throw invalid('Оберіть наявний профіль Chrome зі списку.');
          if (browserMode === 'existing' && background) throw invalid('Наявний профіль працює у звичайному Chrome. Вимкніть прихований режим.');
          if (typeof background !== 'boolean') throw invalid('Некоректний фоновий режим.');
          if (typeof diagnostics !== 'boolean') throw invalid('Некоректний режим діагностики.');
          if (typeof applyRange !== 'boolean' || typeof regenerateSelected !== 'boolean') throw invalid('Некоректне застосування вибору рядків.');
          if (!Number.isInteger(batchSize) || batchSize < 0 || batchSize > 5000) throw invalid('Розмір пакета: від 1 до 5000 або 0 для всіх незавершених.');
          if (!Number.isInteger(requestDelaySeconds) || requestDelaySeconds < 0 || requestDelaySeconds > 3600) throw invalid('Затримка між запитами: ціле число від 0 до 3600 секунд.');
          selectedNumbers(body.range, maxJobNumber());
          for (const job of state.jobs) buildPrompt(job, body.style);
          const outputDir = outputDirectory(body.outputDir === undefined ? state.outputDir : body.outputDir);
          if (outputDir !== state.outputDir || action === 'save-ready') {
            const probe = path.join(outputDir, `.mass-gen-write-${randomUUID()}.tmp`);
            try {
              await fs.mkdir(outputDir, { recursive: true });
              await fs.readdir(outputDir);
              await fs.writeFile(probe, '', { flag: 'wx' });
              await fs.unlink(probe);
            } catch { throw invalid('Не вдалося відкрити папку для збереження. Перевірте шлях і дозвіл на запис.'); }
          }
          if (action === 'save-ready') {
            savedReady = { copied: 0, skipped: 0, failed: [] };
            const files = await fs.readdir(outputDir);
            for (const job of state.jobs.filter(job => ['done', 'exists'].includes(job.status))) {
              if (await imageInFolder(outputDir, job, files)) { savedReady.skipped++; continue; }
              try {
                if (!job.filename || path.basename(job.filename) !== job.filename) throw new Error('Не знайдено оригінальний файл.');
                const bytes = await fs.readFile(path.join(state.outputDir, job.filename)); imageType(bytes);
                await fs.writeFile(path.join(outputDir, job.filename), bytes, { flag: 'wx' });
                files.push(job.filename); savedReady.copied++;
              } catch (error) {
                savedReady.failed.push({ number: job.number, name: job.name, message: error.code === 'ENOENT' ? 'Оригінальний файл відсутній. Без нього дозавантаження неможливе.' : error.code === 'EEXIST' ? 'Файл із такою назвою вже існує, але не є коректним зображенням. Його не перезаписано.' : error.message });
              }
            }
          }
          if (outputDir !== state.outputDir) {
            state.outputDir = outputDir;
            state.jobs = state.jobs.map(({ number, name, description, scene }) => ({ number, name, description, scene, status: 'pending', attempts: 0 }));
            state.events = []; state.status = 'idle'; delete state.batch; delete state.reason;
            log(`Обрано папку зображень: ${outputDir}. Прогрес визначено за її файлами.`);
          }
          await scan();
          if (savedReady) log(`Збереження готових: записано ${savedReady.copied}, уже є ${savedReady.skipped}, не вдалося ${savedReady.failed.length}.`);
          state.style = body.style; state.range = body.range; state.batchSize = batchSize; state.background = background;
          state.diagnostics = diagnostics;
          if (!diagnostics) await clearDiagnosticFiles(data);
          state.requestDelaySeconds = requestDelaySeconds;
          state.browserMode = browserMode; state.chromeProfile = chromeProfile;
          if (applyRange) await applyQueueSelection(body.range, regenerateSelected);
          releaseAccountPause();
        } else if (action === 'scan') await scan();
        else if (action === 'job-update') {
          const job = state.jobs.find(item => item.number === body.number);
          if (!job || !['pending', 'held', 'error', 'interrupted'].includes(job.status)) throw invalid('Редагувати можна лише рядок, який ще не готовий. Для готового спочатку оберіть перегенерацію.');
          if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 500) throw invalid('Назва має містити від 1 до 500 символів.');
          if (typeof body.description !== 'string' || body.description.length > 10000) throw invalid('Опис має бути до 10 000 символів.');
          if (typeof body.scene !== 'string' || body.scene.length > 10000) throw invalid('Опис сцени має бути до 10 000 символів.');
          const held = job.status === 'held';
          Object.assign(job, { name: body.name.trim(), description: body.description.trim(), scene: body.scene.trim(), status: held ? 'held' : 'pending', attempts: 0 });
          for (const key of ['error', 'errorKind', 'filename', 'completedAt', 'startedAt', 'phase', 'log', 'geminiAccount', 'geminiProfile']) delete job[key];
          resetBatch(); await scan(); log(`№${job.number} відредаговано.`);
        } else if (action === 'job-hold') {
          const job = state.jobs.find(item => item.number === body.number);
          if (!job || !['pending', 'error', 'interrupted'].includes(job.status)) throw invalid('Призупинити можна лише незавершений рядок.');
          job.status = 'held'; delete job.error; delete job.errorKind; resetBatch(); log(`№${job.number} призупинено й виключено з черги.`);
        } else if (action === 'job-resume') {
          const job = state.jobs.find(item => item.number === body.number);
          if (!job || job.status !== 'held') throw invalid('Цей рядок не призупинений.');
          job.status = 'pending'; resetBatch(); log(`№${job.number} повернено в чергу.`);
        } else if (action === 'job-regenerate') {
          const job = state.jobs.find(item => item.number === body.number);
          if (!job || !['done', 'exists'].includes(job.status)) throw invalid('Перегенерувати можна лише готове зображення.');
          try { await archiveImage(job); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          job.status = 'pending'; job.attempts = 0;
          for (const key of ['error', 'errorKind', 'filename', 'completedAt', 'startedAt', 'phase', 'log', 'geminiAccount', 'geminiProfile']) delete job[key];
          resetBatch(); log(`№${job.number} поставлено на перегенерацію. Попереднє зображення збережено в папці _previous.`);
        } else if (action === 'job-delete') {
          if (state.jobs.length === 1) throw invalid('У серії має залишитися хоча б один рядок.');
          const index = state.jobs.findIndex(item => item.number === body.number);
          if (index < 0) throw invalid('Рядок не знайдено.');
          const [job] = state.jobs.splice(index, 1);
          state.range = ''; resetBatch();
          log(`№${job.number} «${job.name}» видалено з проєкту${job.filename ? '; файл зображення залишено в папці' : ''}.`);
        } else if (action === 'retry') {
          const job = state.jobs.find(item => item.number === body.number);
          if (!job || !['error', 'interrupted'].includes(job.status)) throw invalid('Оберіть рядок із помилкою або перерваним запитом.');
          if (['limit', 'login'].includes(state.reason) && job.errorKind === state.reason) delete state.reason;
          job.status = 'pending'; delete job.error; delete job.errorKind; log(`№${job.number} дозволено повторити.`);
        } else if (action === 'import') {
          if (typeof body.csv !== 'string' || body.csv.length > 5_000_000) throw invalid('CSV має бути до 5 МБ.');
          const jobs = jobsFromCSV(parseCSV(body.csv), body.nameColumn, body.descriptionColumn, scenes);
          await atomicJSON(path.join(data, `backup-${Date.now()}.json`), state);
          state.jobs = jobs; state.source = String(body.filename || 'CSV').slice(0, 200); state.range = ''; state.status = 'idle'; delete state.reason; delete state.batch;
          log(`Імпортовано ${jobs.length} рядків. Попередній стан збережено в локальному резервному файлі.`); await scan();
        } else if (action === 'start') {
          if (['limit', 'login'].includes(state.reason)) throw invalid('Gemini зупинив пакет через ліміт або вхід. Після відновлення доступу натисніть «Повторити цей рядок».');
          const enabledAccounts = accounts()?.filter(account => account.enabled);
          if (!enabledAccounts?.length) throw invalid('Увімкніть хоча б один акаунт Gemini в цьому профілі.');
          if (state.browserMode === 'dedicated' && state.background && generate === generateWithGeminiBrowser) {
            for (const account of enabledAccounts) {
              try { await assertBackgroundChrome(accountProfile(account)); }
              catch (error) { throw invalid(`Акаунт «${account.name}»: ${error.message}`); }
            }
          }
          await scan();
          const included = selected();
          const pending = state.jobs.filter(job => included.has(job.number) && job.status === 'pending');
          if (!pending.length) throw invalid('У вибраному діапазоні немає незавершених рядків.');
          state.batch = { numbers: pending.slice(0, state.batchSize || pending.length).map(job => job.number), accounts: structuredClone(enabledAccounts), startedAt: new Date().toISOString() };
          log(`Запущено пакет: ${state.batch.numbers.length} зображень.`);
          pause = false; controller = new AbortController(); state.status = 'running'; delete state.reason;
          await save(); worker = loop(); return snapshot();
        } else throw invalid('Невідома дія.');
        await save(); return { ...snapshot(), ...(savedReady ? { savedReady } : {}) };
      });
    },
    async image(number) {
      const job = state.jobs.find(item => item.number === number);
      if (!job?.filename || path.basename(job.filename) !== job.filename) return null;
      return { bytes: await fs.readFile(path.join(state.outputDir, job.filename)), filename: job.filename };
    },
    async jobLog(number) {
      const job = state.jobs.find(item => item.number === number);
      if (!job?.log || !/^\d+-\d+-\d+$/.test(job.log)) return 'Запит для цього рядка ще не виконувався.';
      return fs.readFile(path.join(data, 'runs', job.log, 'oracle.log'), 'utf8').catch(() => 'Запит ще виконується.');
    },
    settled: async () => { await worker; await chain; },
    async close() {
      pause = true; delayController?.abort(); controller?.abort(); await worker; await chain;
      if (generate === generateWithGeminiBrowser) {
        for (const account of state.geminiAccounts.dedicated) await closeBackgroundChrome(accountBrowserProfile(profile, account.id), root);
      }
      await fs.unlink(lockFile);
    }
  };
}

const staticFiles = { '/': ['public/index.html', 'text/html'], '/chrome-session': ['public/chrome-session.html', 'text/html'], '/app.js': ['public/app.js', 'text/javascript'], '/style.css': ['public/style.css', 'text/css'], '/core.mjs': ['core.mjs', 'text/javascript'], '/gemini-accounts.mjs': ['gemini-accounts.mjs', 'text/javascript'] };
function send(res, status, body, type = 'application/json', headers = {}) {
  res.writeHead(status, { 'Content-Type': `${type}${type.startsWith('image/') ? '' : '; charset=utf-8'}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", ...headers });
  res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
}
async function readBody(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 12 * 1024 * 1024) throw invalid('Запит завеликий.');
    chunks.push(chunk);
  }
  try { const body = JSON.parse(Buffer.concat(chunks).toString()); if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error(); return body; }
  catch { throw invalid('Некоректний JSON.'); }
}

export async function listen(studio, { port = 0, root = ROOT, token = randomBytes(32).toString('base64url') } = {}) {
  const cookieName = 'new_mass_gen_session';
  const authorized = req => {
    const value = String(req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) || '';
    const actual = Buffer.from(value); const expected = Buffer.from(token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const port = server.address().port;
      const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
      if (!origins.includes(`http://${req.headers.host}`) || (req.headers.origin && !origins.includes(req.headers.origin)) || ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return send(res, 403, { message: 'Доступ лише з цієї локальної студії.' });
      const url = new URL(req.url, origins[0]);
      const bootstrap = url.pathname.match(/^\/session\/([A-Za-z0-9_-]{43})$/);
      if (req.method === 'GET' && bootstrap) {
        const actual = Buffer.from(bootstrap[1]); const expected = Buffer.from(token);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return send(res, 401, { message: 'Недійсний локальний доступ.' });
        res.writeHead(302, { Location: '/', 'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        return res.end();
      }
      const protectedPath = url.pathname.startsWith('/api/') || url.pathname.startsWith('/images/') || url.pathname.startsWith('/logs/');
      if (protectedPath && !authorized(req)) return send(res, 401, { message: 'Запустіть студію через «Відкрити.cmd».' });
      if (req.method === 'GET') {
        if (staticFiles[url.pathname]) { const [file, type] = staticFiles[url.pathname]; return send(res, 200, await fs.readFile(path.join(root, file)), type); }
        if (url.pathname === '/api/health') return send(res, 200, { app: 'new-mass-gen', root });
        if (url.pathname === '/api/state') return send(res, 200, await studio.snapshot());
        if (url.pathname === '/api/report') {
          const state = await studio.snapshot();
          return send(res, 200, progressReport(state), 'application/json', { 'Content-Disposition': 'attachment; filename="generation-report.json"' });
        }
        const media = url.pathname.match(/^\/images\/(\d+)$/);
        if (media) { const image = await studio.image(Number(media[1])); if (!image) return send(res, 404, 'Не знайдено.', 'text/plain'); return send(res, 200, image.bytes, imageType(image.bytes) === '.jpg' ? 'image/jpeg' : imageType(image.bytes) === '.png' ? 'image/png' : 'image/webp'); }
        const log = url.pathname.match(/^\/logs\/(\d+)$/);
        if (log) return send(res, 200, await studio.jobLog(Number(log[1])), 'text/plain');
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, { message: 'Потрібен JSON.' });
        const body = await readBody(req); const action = url.pathname.slice(5);
        if (action === 'preview') {
          if (typeof body.csv !== 'string' || body.csv.length > 5_000_000) throw invalid('CSV має бути до 5 МБ.');
          const table = parseCSV(body.csv); return send(res, 200, { headers: table.headers, rows: table.rows.slice(0, 3), total: table.rows.length });
        }
        return send(res, 200, await studio.action(action, body));
      }
      return send(res, 404, { message: 'Не знайдено.' });
    } catch (error) {
      console.error(error.message);
      if (!res.headersSent) send(res, error.status || 400, { message: error.message });
    }
  });
  Object.defineProperty(server, 'sessionToken', { value: token });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}

async function main() {
  const dataDir = runtimeDataDirectory();
  await migrateLegacyData(ROOT, dataDir);
  const token = await ensureSessionToken(dataDir);
  const studio = await createStudio({ dataDir });
  let server;
  try { server = await listen(studio, { port: Number(process.env.PORT || 4188), token }); }
  catch (error) { await studio.close(); throw error; }
  console.log(`New Mass Gen: http://127.0.0.1:${server.address().port}/`);
  const close = async () => { server.close(); await studio.close(); process.exit(0); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
