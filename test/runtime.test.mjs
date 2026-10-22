import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ROOT } from '../server.mjs';
import { ensureSessionToken, migrateLegacyData, runtimeDataDirectory, ensureInstallationId } from '../runtime.mjs';

test('runtime data is placed in the current Windows profile without exposing a setup step', () => {
  assert.equal(runtimeDataDirectory({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Profiles\\Sample\\AppData\\Local' } }), 'C:\\Profiles\\Sample\\AppData\\Local\\NewMassGen');
  assert.equal(runtimeDataDirectory({ platform: 'linux', env: { XDG_DATA_HOME: '/tmp/data' }, home: '/var/lib/sample' }), path.join('/tmp/data', 'new-mass-gen'));
});

test('the installation id is random, stable and carries no path of the user', async () => {
  const directory = await fs.mkdtemp(path.join(ROOT, '.test-runtime-id-'));
  try {
    const first = await ensureInstallationId(directory); const second = await ensureInstallationId(directory);
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(second, first);
    assert.equal((await fs.readFile(path.join(directory, 'installation-id'), 'utf8')).trim(), first);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('the local API token is strong, private and stable between launches', async () => {
  const directory = await fs.mkdtemp(path.join(ROOT, '.test-runtime-token-'));
  try {
    const first = await ensureSessionToken(directory); const second = await ensureSessionToken(directory);
    assert.match(first, /^[A-Za-z0-9_-]{43}$/); assert.equal(second, first);
    assert.equal((await fs.readFile(path.join(directory, 'api-token'), 'utf8')).trim(), first);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('legacy progress and account sessions move out of the application folder once', async () => {
  const root = await fs.mkdtemp(path.join(ROOT, '.test-runtime-migration-'));
  const destination = path.join(root, 'private-data'); const legacy = path.join(root, '.data');
  try {
    await fs.mkdir(path.join(legacy, 'account-profiles', 'account'), { recursive: true });
    await fs.writeFile(path.join(legacy, 'state.json'), '{"version":1}');
    await fs.writeFile(path.join(legacy, 'account-profiles', 'account', 'Cookies'), 'private');
    const token = await ensureSessionToken(destination);
    assert.equal(await migrateLegacyData(root, destination), true);
    assert.equal(await fs.readFile(path.join(destination, 'state.json'), 'utf8'), '{"version":1}');
    assert.equal(await fs.readFile(path.join(destination, 'account-profiles', 'account', 'Cookies'), 'utf8'), 'private');
    assert.equal(await ensureSessionToken(destination), token);
    await assert.rejects(fs.access(legacy));
    assert.equal(await migrateLegacyData(root, destination), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
