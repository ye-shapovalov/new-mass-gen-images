import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { generateInPage, pageState } from './gemini-page.mjs';
import { bounded } from './timing.mjs';
import { openExistingChrome, openExistingChromeSession } from './chrome-profiles.mjs';
import { DEFAULT_GEMINI_URL, normalizeGeminiURL } from './gemini-accounts.mjs';
import { redactEmails, redactState } from './privacy.mjs';

export function findChrome() {
  return [process.env.CHROME_PATH,
    path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')
  ].find(file => file && existsSync(file)) || '';
}

export function oracleCLI(root) {
  return path.join(root, 'node_modules/@steipete/oracle/dist/bin/oracle-cli.js');
}

export function oracleBrowserConfig(profile, background = true) {
  return { manualLogin: true, manualLoginProfileDir: profile, chromePath: findChrome(), cookieSync: false, keepBrowser: true, headless: background, timeoutMs: 360000 };
}

export function accountBrowserProfile(profile, accountId) {
  if (accountId === 'main') return profile;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId || '')) throw new Error('Некоректна сесія акаунта.');
  return path.join(path.dirname(profile), 'account-profiles', accountId);
}

export function isHeadlessChrome(version) {
  return /HeadlessChrome\//i.test(`${version?.Browser || ''} ${version?.['User-Agent'] || ''} ${version?.product || ''} ${version?.userAgent || ''}`);
}

export async function verifyHiddenSession(client) {
  const version = await bounded(client.Browser.getVersion(), 5000, 'Не вдалося перевірити прихований режим Chrome.');
  if (!isHeadlessChrome(version)) throw Object.assign(new Error('Chrome працює з видимим вікном. Приховану генерацію зупинено; закрийте вікно входу цього акаунта.'), { kind: 'browser-setup' });
}

export async function runningChrome(profile) {
  let port;
  try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Некоректний порт профілю Chrome.');
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error('Не вдалося перевірити режим Chrome.');
    const version = await response.json();
    return { port, version };
  } catch (error) { if (error.cause?.code === 'ECONNREFUSED') return null; throw error; }
}

export async function assertBackgroundChrome(profile) {
  if (await manualLoginActive(profile)) throw new Error('Для фонового режиму закрийте окреме вікно Gemini після входу та запустіть пакет знову. Звичайний Chrome можна залишити відкритим.');
  const running = await runningChrome(profile);
  if (running && !isHeadlessChrome(running.version)) throw new Error('Для фонового режиму закрийте окреме вікно Gemini після входу та запустіть пакет знову. Звичайний Chrome можна залишити відкритим.');
}

export async function closeBackgroundChrome(profile, root) {
  const running = await runningChrome(profile);
  if (!running || !isHeadlessChrome(running.version)) return;
  const { connectToChrome } = await import(pathToFileURL(path.join(root, 'node_modules/@steipete/oracle/dist/src/browser/chromeLifecycle.js')).href);
  const client = await bounded(connectToChrome(running.port, () => {}), 5000, 'Chrome не відповів на завершення.');
  try { await bounded(client.Browser.close(), 5000, 'Chrome не завершився.'); }
  finally { await bounded(client.close(), 3000, 'З’єднання завершене за часом.').catch(() => {}); }
  for (let i = 0; i < 30; i++) { if (!await runningChrome(profile)) return; await delay(100); }
  throw new Error('Фоновий Chrome ще завершується. Спробуйте відкрити вхід ще раз.');
}

export async function manualLoginActive(profile) {
  const file = path.join(profile, '.manual-login-pid');
  let pid;
  try { pid = Number(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Не вдалося перевірити вікно входу цього акаунта.');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code !== 'ESRCH') throw error; await fs.unlink(file).catch(() => {}); return false; }
}

export function loginChromeArguments(profile, geminiUrl) {
  return [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--new-window', normalizeGeminiURL(geminiUrl)];
}

export async function openLogin(profile, { root, browserMode = 'dedicated', chromeProfile, geminiUrl = DEFAULT_GEMINI_URL } = {}) {
  geminiUrl = normalizeGeminiURL(geminiUrl);
  const chrome = findChrome();
  if (!chrome) throw new Error('Встановіть Google Chrome або задайте CHROME_PATH.');
  if (browserMode === 'existing') return openExistingChrome(chrome, chromeProfile, geminiUrl);
  root ||= path.basename(path.dirname(profile)) === 'account-profiles' ? path.resolve(profile, '../../..') : path.resolve(profile, '../..');
  // Manual sign-in runs in normal Chrome, with no debugging connection or automation.
  await closeBackgroundChrome(profile, root);
  const oldWindow = await runningChrome(profile);
  if (oldWindow) throw new Error('Закрийте попереднє окреме вікно входу з помилкою Google та знову натисніть «Увійти». Новий вхід відкриється у звичайному Chrome без підключення генератора.');
  await fs.mkdir(profile, { recursive: true });
  const alreadyOpen = await manualLoginActive(profile);
  const child = spawn(chrome, loginChromeArguments(profile, geminiUrl),
    { detached: true, stdio: 'ignore', windowsHide: false });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  if (!alreadyOpen) await fs.writeFile(path.join(profile, '.manual-login-pid'), String(child.pid));
  child.unref();
}

export async function checkExistingChrome({ root, chromeProfile }) {
  const session = await openExistingChromeSession({ root, chrome: findChrome(), chromeProfile });
  try { await bounded(session.client.Target.closeTarget({ targetId: session.targetId }), 3000, 'Службова вкладка не закрилася.'); }
  finally { await bounded(session.close(), 3000, 'З’єднання не завершилося.').catch(() => {}); }
}

export async function checkGeminiSession({ root, profile }) {
  await assertBackgroundChrome(profile);
  const { openGeminiBrowserSession } = await import(pathToFileURL(path.join(root, 'node_modules/@steipete/oracle/dist/src/gemini-web/browserSessionManager.js')).href);
  const opening = openGeminiBrowserSession({ browserConfig: oracleBrowserConfig(profile, true), keepBrowserDefault: true, purpose: 'Check hidden Gemini login', log: () => {} });
  let session;
  try {
    session = await bounded(opening, 45000, 'Не вдалося запустити прихований Chrome.');
    await verifyHiddenSession(session.client);
    await bounded(session.client.Page.enable(), 5000, 'Chrome не відповідає.');
    await bounded(session.client.Page.navigate({ url: DEFAULT_GEMINI_URL }), 10000, 'Gemini не відкрився.');
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await bounded(session.client.Runtime.evaluate({ expression: `(${pageState.toString()})()`, returnByValue: true }), 5000, 'Gemini не відповідає.');
      const state = result.result?.value;
      if (state?.loginRequired || state?.url?.startsWith('https://accounts.google.com/')) break;
      if (state?.composer) return;
      await delay(500);
    }
    throw Object.assign(new Error('Потрібен одноразовий вхід у цей акаунт. Натисніть «Увійти», увійдіть у Gemini, закрийте окреме вікно та перевірте сесію знову.'), { kind: 'login' });
  } finally {
    if (session?.targetId) await bounded(session.client.Target.closeTarget({ targetId: session.targetId }), 3000, 'Вкладка перевірки не закрилася.').catch(() => {});
    if (session) await bounded(session.close(), 3000, 'Перевірку завершено за часом.').catch(() => {});
    else opening.then(async late => { await late.client.Target.closeTarget({ targetId: late.targetId }).catch(() => {}); await late.close(); }, () => {});
  }
}

export async function generateWithGeminiBrowser({ root, profile, browserMode = 'dedicated', chromeProfile = '', background = true, diagnostics = false, geminiUrl = DEFAULT_GEMINI_URL, prompt, logPath, signal, onProgress = () => {} }) {
  geminiUrl = normalizeGeminiURL(geminiUrl);
  if (!existsSync(oracleCLI(root))) throw new Error('Oracle не встановлено. Запустіть «Відкрити.cmd».');
  if (!findChrome()) throw new Error('Встановіть Google Chrome.');
  const existing = browserMode === 'existing';
  if (existing && background) throw Object.assign(new Error('Наявний профіль працює у звичайному Chrome. Вимкніть прихований режим.'), { kind: 'browser-setup' });
  if (background && !existing) await assertBackgroundChrome(profile);
  const handle = await fs.open(logPath, 'w'); let writes = Promise.resolve();
  const log = message => { writes = writes.then(() => handle.write(`${new Date().toISOString()} ${redactEmails(message)}\n`)); };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(Object.assign(new Error('Спроба перевищила 4 хвилини й зупинена.'), { kind: 'timeout' })), 240000);
  const attemptSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let session; let closeTarget = background || existing;
  try {
    // shortcut: Oracle's browser-session API is internal; keep 0.21.6 pinned and retest before upgrading.
    const modulePath = path.join(root, 'node_modules/@steipete/oracle/dist/src/gemini-web/browserSessionManager.js');
    const { openGeminiBrowserSession } = await import(pathToFileURL(modulePath).href);
    log(`Browser sessions: Oracle 0.21.6. Mode: ${existing ? 'existing Chrome profile' : modulePath}. Image requests: Gemini website, Create image; Oracle CLI is not invoked.`);
    log(`Browser display: ${background ? 'headless (no visible windows)' : 'visible'}.`);
    log(`Gemini account URL: ${geminiUrl}`);
    await onProgress(existing ? 'Підключаємо ваш Chrome; підтвердьте Allow у браузері…' : 'Підключаємо Chrome…');
    const opening = existing ? openExistingChromeSession({ root, chrome: findChrome(), chromeProfile, signal: attemptSignal, log }) :
      openGeminiBrowserSession({ browserConfig: oracleBrowserConfig(profile, background), keepBrowserDefault: true, purpose: 'Mass Gen image batch', log });
    opening.then(async late => {
      if (attemptSignal.aborted) {
        if (late.targetId) await bounded(late.client.Target.closeTarget({ targetId: late.targetId }), 3000, 'Вкладка не закрилася.').catch(() => {});
        await bounded(late.close(), 3000, 'Сесію завершено за часом.').catch(() => {});
      }
    }, () => {});
    session = await bounded(opening, existing ? 75000 : 45000, 'Не вдалося підключити Chrome. Перевірте дозвіл у його вікні.', attemptSignal);
    if (background) await verifyHiddenSession(session.client);
    const bytes = await generateInPage(session.client, prompt, { signal: attemptSignal, log, onProgress, foreground: !background && !existing, geminiUrl });
    closeTarget = !existing; return bytes;
  } catch (error) {
    if (error.kind === 'timeout') deadline.abort(error);
    if (['capability', 'tool-setup', 'timeout'].includes(error.kind)) closeTarget = true;
    if (diagnostics && session && error.kind !== 'interrupted') {
      try {
        const snapshot = await bounded(session.client.Runtime.evaluate({ expression: `(${pageState.toString()})()`, returnByValue: true }), 3000, 'Стан сторінки недоступний.');
        const state = snapshot.result?.value;
        if (state?.url?.startsWith('https://gemini.google.com/')) {
          // The snapshot can repeat the signed-in address, so it is sanitised before it is written.
          await fs.writeFile(path.join(path.dirname(logPath), 'page-state.json'), JSON.stringify(redactState(state), null, 2));
          const shot = await bounded(session.client.Page.captureScreenshot({ format: 'png', captureBeyondViewport: false }), 3000, 'Знімок сторінки недоступний.');
          await fs.writeFile(path.join(path.dirname(logPath), 'page.png'), Buffer.from(shot.data, 'base64'));
          log('Діагностика сторінки збережена: page-state.json, page.png.');
        }
      } catch (diagnostic) { log(`Діагностика сторінки недоступна: ${diagnostic.message}`); }
    }
    log(`Помилка: ${error.message}`); throw error;
  } finally {
    clearTimeout(timer);
    if (closeTarget && session?.targetId) await bounded(session.client.Target.closeTarget({ targetId: session.targetId }), 3000, 'Вкладка не закрилася.').catch(() => {});
    if (session) await bounded(session.close(), 3000, 'Сесію завершено за часом.').catch(() => {});
    try { await writes; } finally { await handle.close(); }
  }
}
