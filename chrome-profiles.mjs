import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { bounded } from './timing.mjs';
import { maskEmail } from './privacy.mjs';
const ownedTabs = new Map();

export function ownedProfileTab(targets, saved, endpoint) {
  if (!saved || saved.endpoint !== endpoint) return undefined;
  return targets.find(target => target.targetId === saved.targetId && (target.url === saved.marker || /^https:\/\/gemini\.google\.com\//.test(target.url)));
}

export function chromeUserDataDir() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'Google/Chrome/User Data');
}

function validProfile(id) { return id === 'Default' || /^Profile [1-9]\d*$/.test(id); }

export async function listChromeProfiles(userDataDir = chromeUserDataDir()) {
  let state;
  try { state = JSON.parse(await fs.readFile(path.join(userDataDir, 'Local State'), 'utf8')); }
  catch (error) { if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return []; throw error; }
  return Object.entries(state.profile?.info_cache || {}).filter(([id, profile]) => validProfile(id) && profile && typeof profile === 'object')
    // Only the label and a masked address leave the Chrome profile; no credential is read.
    .map(([id, profile]) => ({ id, name: String(profile.name || id), account: maskEmail(profile.user_name) }));
}

export function existingChromeArguments(id, url) {
  if (!validProfile(id)) throw new Error('Оберіть наявний профіль Chrome зі списку.');
  // Use Chrome's normal profile routing; never copy encrypted sessions or launch another user-data-dir.
  return [`--profile-directory=${id}`, url];
}

export async function openExistingChrome(chrome, id, url = 'https://gemini.google.com/app') {
  if (!chrome) throw new Error('Встановіть Google Chrome.');
  if (!(await listChromeProfiles()).some(profile => profile.id === id)) throw new Error('Вибраний профіль Chrome більше не існує. Оновіть студію.');
  const child = spawn(chrome, existingChromeArguments(id, url), { detached: true, stdio: 'ignore', windowsHide: false });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
}

export async function openExistingChromeSession({ root, chrome, chromeProfile, signal, log = () => {}, userDataDir = chromeUserDataDir() }) {
  const moduleDir = path.join(root, 'node_modules/@steipete/oracle/dist/src/browser');
  const { readDevToolsActivePortInfo } = await import(pathToFileURL(path.join(moduleDir, 'detect.js')).href);
  const endpoint = await readDevToolsActivePortInfo(userDataDir);
  if (!endpoint) throw Object.assign(new Error('Доступ до Chrome ще не ввімкнено. Скопіюйте адресу доступу кнопкою 2, вставте її в адресний рядок звичайного Chrome та поставте галочку «Allow remote debugging for this browser instance». Потім поверніться до перевірки підключення.'), { kind: 'browser-setup' });
  const { listRemoteChromeTargets, connectToRemoteChromeTarget } = await import(pathToFileURL(path.join(moduleDir, 'chromeLifecycle.js')).href);
  const connection = { host: '127.0.0.1', port: endpoint.port, browserWSEndpoint: endpoint.browserWSEndpoint, approvalWaitMs: 60000, logger: log, signal };
  const key = `${root}|${chromeProfile}`; const marker = `http://127.0.0.1:${Number(process.env.PORT || 4188)}/chrome-session#mass-gen-${randomUUID()}`;
  let target;
  try {
    if (ownedTabs.has(key)) {
      const targets = await bounded(listRemoteChromeTargets(connection), 65000, 'Chrome не підтвердив підключення.', signal);
      target = ownedProfileTab(targets, ownedTabs.get(key), endpoint.browserWSEndpoint);
    }
    if (!target) await openExistingChrome(chrome, chromeProfile, marker);
    // A marker opened by Chrome itself selects the requested profile, including when several are open.
    for (let attempt = 0; !target && attempt < 10; attempt++) {
      const targets = await bounded(listRemoteChromeTargets(connection), 65000, 'Chrome не підтвердив підключення. Натисніть Allow у вікні Chrome.', signal);
      target = targets.find(item => item.url === marker);
      if (target) break;
      await bounded(new Promise(resolve => setTimeout(resolve, 300)), 1000, 'Не відкрилася службова вкладка.', signal);
    }
    if (!target) throw new Error('Chrome не показав службову вкладку вибраного профілю. Перевірте дозвіл у Chrome.');
    const opening = connectToRemoteChromeTarget(connection.host, connection.port, log, { ...connection, targetId: target.targetId, closeTargetOnDispose: false });
    const session = await bounded(opening, 65000, 'Chrome не підтвердив доступ до вибраного профілю.', signal);
    ownedTabs.set(key, { targetId: target.targetId, endpoint: endpoint.browserWSEndpoint, marker });
    log(`Attached to selected existing Chrome profile: ${chromeProfile}.`);
    return session;
  } catch (error) {
    error.kind = signal?.aborted ? (signal.reason?.kind || 'interrupted') : 'browser-setup';
    throw error;
  }
}
