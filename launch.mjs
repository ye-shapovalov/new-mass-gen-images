import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureSessionToken, runtimeDataDirectory, ensureInstallationId } from './runtime.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4188); const url = `http://127.0.0.1:${port}/`;
const token = await ensureSessionToken(runtimeDataDirectory());
const instanceId = await ensureInstallationId(runtimeDataDirectory());
const cookie = `new_mass_gen_session=${token}`;
const ready = async () => {
  try {
    const response = await fetch(`${url}api/health`, { headers: { cookie }, signal: AbortSignal.timeout(1000) });
    const health = await response.json();
    if (health.app !== 'new-mass-gen' || health.instanceId !== instanceId) throw new Error(`Порт ${port} використовує інша програма. Задайте PORT.`);
    return true;
  } catch (error) { if (error.message.includes('використовує')) throw error; return false; }
};
if (!await ready()) {
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  let available = false;
  for (let i = 0; i < 80; i++) { if (await ready()) { available = true; break; } if (child.exitCode !== null) break; await delay(250); }
  if (!available) { child.kill(); throw new Error('Студія не запустилася. Перегляньте повідомлення у вікні.'); }
}
console.log(url);
const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', `${url}session/${token}`], { detached: true, stdio: 'ignore', windowsHide: true });
browser.on('error', () => console.log('Запустіть Відкрити.cmd ще раз, щоб відкрити захищену локальну студію.')); browser.unref();
