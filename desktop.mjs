import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStudio, listen } from './server.mjs';
import { ensureSessionToken, migrateLegacyData, runtimeDataDirectory } from './runtime.mjs';
import { isNewerVersion } from './update.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const smokeTest = process.argv.includes('--smoke-test');
const smokeLog = message => { if (smokeTest) console.log(`ELECTRON_SMOKE: ${message}`); };
if (smokeTest) app.disableHardwareAcceleration();
let mainWindow;
let tray;
let studio;
let server;
let appOrigin;
let temporaryData;
let quitting = false;
let stopped = false;
const hasSingleInstanceLock = smokeTest || app.requestSingleInstanceLock();
smokeLog('module loaded');

function localURL(value) {
  try { return new URL(value).origin === appOrigin; }
  catch { return false; }
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function createWindow(token) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 700,
    show: false,
    title: 'New Mass Gen',
    icon: path.join(root, 'build', 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#eef1f7',
    webPreferences: {
      preload: path.join(root, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (localURL(url)) return {
      action: 'allow',
      overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: !app.isPackaged } }
    };
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => { if (!localURL(url)) event.preventDefault(); });
  mainWindow.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('ready-to-show', () => { if (!smokeTest) mainWindow.show(); });

  await mainWindow.webContents.session.cookies.set({
    url: appOrigin,
    name: 'new_mass_gen_session',
    value: token,
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60
  });
  await mainWindow.loadURL(appOrigin);
}

async function createTray() {
  tray = new Tray(path.join(root, 'build', 'icon.png'));
  tray.setToolTip('New Mass Gen');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Відкрити New Mass Gen', click: showWindow },
    { type: 'separator' },
    { label: 'Вийти', click: () => app.quit() }
  ]));
  tray.on('double-click', showWindow);
}

async function stop() {
  if (stopped) return;
  stopped = true;
  if (server) await new Promise(resolve => server.close(resolve));
  await studio?.close();
  if (temporaryData) await fs.rm(temporaryData, { recursive: true, force: true });
}

async function start() {
  smokeLog('starting');
  app.setName('New Mass Gen');
  app.setAppUserModelId('ua.newmassgen.desktop');
  Menu.setApplicationMenu(null);

  temporaryData = smokeTest ? await fs.mkdtemp(path.join(os.tmpdir(), 'new-mass-gen-electron-')) : null;
  const dataDir = temporaryData || runtimeDataDirectory();
  await migrateLegacyData(root, dataDir);
  const token = await ensureSessionToken(dataDir);
  smokeLog('runtime ready');
  studio = await createStudio({
    root,
    dataDir,
    defaultOutputDir: smokeTest ? path.join(temporaryData, 'images') : path.join(app.getPath('pictures'), 'New Mass Gen')
  });
  smokeLog('studio ready');
  if (smokeTest) {
    await import(pathToFileURL(path.join(root, 'node_modules/@steipete/oracle/dist/src/gemini-web/browserSessionManager.js')).href);
    smokeLog('oracle module ready');
  }
  server = await listen(studio, { port: 0, root, token });
  appOrigin = `http://127.0.0.1:${server.address().port}`;
  smokeLog('server ready');

  ipcMain.handle('choose-output-folder', async event => {
    if (event.sender !== mainWindow?.webContents || !localURL(event.sender.getURL())) throw new Error('Недійсне вікно програми.');
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Оберіть папку для зображень', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('check-for-updates', async event => {
    if (event.sender !== mainWindow?.webContents || !localURL(event.sender.getURL())) throw new Error('Недійсне вікно програми.');
    try {
      const response = await fetch('https://api.github.com/repos/ye-shapovalov/new-mass-gen-images/releases/latest', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `New-Mass-Gen/${app.getVersion()}` },
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) return { available: false };
      const release = await response.json();
      return { available: isNewerVersion(release.tag_name, app.getVersion()), version: release.tag_name, url: release.html_url };
    } catch { return { available: false }; }
  });

  await createWindow(token);
  smokeLog('window loaded');
  if (!smokeTest) await createTray();
  if (smokeTest) {
    const healthy = await mainWindow.webContents.executeJavaScript("fetch('/api/state').then(response => response.ok)");
    if (!healthy) throw new Error('Desktop UI не підключився до локального сервера.');
    const templatesReady = await mainWindow.webContents.executeJavaScript("new Promise(resolve => { let tries = 0; const check = async () => { const images = [...document.querySelectorAll('.template-card > img')]; if (document.querySelectorAll('#template-select option').length === 10 && images.length === 10) { const responses = await Promise.all(images.map(image => fetch(image.src))); return resolve(responses.every(response => response.ok && response.headers.get('content-type')?.startsWith('image/'))); } if (++tries > 200) resolve(false); else setTimeout(check, 25); }; check(); })");
    if (!templatesReady) throw new Error('Бібліотека шаблонів не завантажилася в інтерфейсі.');
    console.log('ELECTRON_SMOKE_OK');
    app.quit();
  }
}

app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  if (stopped) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  stop().catch(error => console.error(error.message)).finally(() => app.quit());
});

async function startupFailure(error) {
  console.error(error);
  if (!smokeTest) dialog.showErrorBox('New Mass Gen не запустився', error.message);
  quitting = true;
  await stop().catch(() => {});
  app.exit(1);
}

if (!hasSingleInstanceLock) app.quit();
else app.whenReady().then(async () => {
  smokeLog('electron ready');
  await start();
}).catch(startupFailure);
