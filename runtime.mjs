import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function runtimeDataDirectory({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.NEW_MASS_GEN_DATA_DIR) return path.resolve(env.NEW_MASS_GEN_DATA_DIR);
  if (platform === 'win32' && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'NewMassGen');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'new-mass-gen');
}

async function moveEntry(source, destination) {
  try { await fs.rename(source, destination); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.cp(source, destination, { recursive: true, errorOnExist: true });
    await fs.rm(source, { recursive: true, force: true });
  }
}

export async function migrateLegacyData(root, destination) {
  const source = path.join(root, '.data');
  if (path.resolve(source) === path.resolve(destination)) return false;
  let entries;
  try { entries = await fs.readdir(source); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }

  const legacyLock = path.join(source, 'server.lock');
  try {
    const pid = Number(await fs.readFile(legacyLock, 'utf8'));
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); throw new Error('Закрийте попередню версію New Mass Gen і запустіть оновлену програму знову.'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await fs.unlink(legacyLock);
    entries = entries.filter(name => name !== 'server.lock');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  let moved = false;
  for (const name of entries) {
    const from = path.join(source, name); const to = path.join(destination, name);
    try { await fs.access(to); continue; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await moveEntry(from, to); moved = true;
  }
  if (!(await fs.readdir(source)).length) await fs.rmdir(source);
  return moved;
}

export async function ensureSessionToken(dataDirectory) {
  const file = path.join(dataDirectory, 'api-token');
  await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  try {
    const token = (await fs.readFile(file, 'utf8')).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Некоректний локальний ключ доступу. Видаліть api-token і запустіть програму знову.');
    return token;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const token = randomBytes(32).toString('base64url');
    try { await fs.writeFile(file, token, { flag: 'wx', mode: 0o600 }); return token; }
    catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; return ensureSessionToken(dataDirectory); }
  }
}

// A stable, non-identifying id of this installation. It replaces the folder path in
// local API responses, so the Windows user name never leaves the machine.
export async function ensureInstallationId(dataDirectory) {
  const file = path.join(dataDirectory, 'installation-id');
  await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  try {
    const id = (await fs.readFile(file, 'utf8')).trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Некоректний ідентифікатор встановлення. Видаліть installation-id і запустіть програму знову.');
    return id;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const id = randomUUID();
    try { await fs.writeFile(file, id, { flag: 'wx', mode: 0o600 }); return id; }
    catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; return ensureInstallationId(dataDirectory); }
  }
}
