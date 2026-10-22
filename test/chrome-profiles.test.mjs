import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../server.mjs';
import { listChromeProfiles, existingChromeArguments, openExistingChromeSession, ownedProfileTab } from '../chrome-profiles.mjs';

test('existing profile choices read only Chrome profile labels and reject directory traversal', async () => {
  const root = await fs.mkdtemp(path.join(ROOT, '.test-profiles-'));
  try {
    assert.deepEqual(await listChromeProfiles(root), []);
    await fs.writeFile(path.join(root, 'Local State'), JSON.stringify({ profile: { info_cache: {
      Default: { name: 'Особистий', user_name: 'user@example.org', secret: 'never returned' },
      'Profile 1': { name: 'Робочий', user_name: 'work@example.org' },
      '../Other': { name: 'invalid' }, 'Profile 2': null
    } }, os_crypt: { encrypted_key: 'never returned' } }));
    assert.deepEqual(await listChromeProfiles(root), [
      { id: 'Default', name: 'Особистий', account: 'u***@example.org' },
      { id: 'Profile 1', name: 'Робочий', account: 'w***@example.org' }
    ]);
  } finally { assert.equal(path.dirname(root), ROOT); await fs.rm(root, { recursive: true, force: true }); }
});

test('normal Chrome opens the selected existing profile without a replacement data directory or debugging flags', () => {
  const args = existingChromeArguments('Profile 1', 'https://gemini.google.com/app');
  assert.deepEqual(args, ['--profile-directory=Profile 1', 'https://gemini.google.com/app']);
  for (const id of ['', '../Default', 'Default --remote-debugging-port=9222', 'C:\\Profile 1']) assert.throws(() => existingChromeArguments(id, 'about:blank'));
});

test('missing browser approval setup stops before opening any tab or sending a prompt', async () => {
  const root = await fs.mkdtemp(path.join(ROOT, '.test-profiles-'));
  try {
    await assert.rejects(openExistingChromeSession({ root: ROOT, chrome: '', chromeProfile: 'Default', userDataDir: root }), error => error.kind === 'browser-setup' && error.message.includes('Allow remote debugging'));
    assert.deepEqual(await fs.readdir(root), []);
  } finally { assert.equal(path.dirname(root), ROOT); await fs.rm(root, { recursive: true, force: true }); }
});

test('reuse stays in the selected profile’s owned tab and rejects navigated or restarted targets', () => {
  const saved = { targetId: 'owned', marker: 'http://127.0.0.1:4188/chrome-session#mass-gen-unique', endpoint: 'ws://127.0.0.1:9222/devtools/browser/one' };
  const unrelated = { targetId: 'personal', url: 'https://gemini.google.com/app/private' };
  const owned = { targetId: 'owned', url: 'https://gemini.google.com/app/generated' };
  assert.equal(ownedProfileTab([unrelated, owned], saved, saved.endpoint), owned);
  assert.equal(ownedProfileTab([unrelated], saved, saved.endpoint), undefined);
  assert.equal(ownedProfileTab([{ ...owned, url: 'https://mail.google.com/' }], saved, saved.endpoint), undefined);
  assert.equal(ownedProfileTab([owned], saved, 'ws://127.0.0.1:9222/devtools/browser/restarted'), undefined);
});
