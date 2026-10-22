// privacy-check: ignore — this file deliberately contains key-like fixtures and fake addresses.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../server.mjs';
import { maskEmail, redactEmails, redactState } from '../privacy.mjs';

test('a Chrome account address is shown masked and never in full', () => {
  assert.equal(maskEmail('user@example.org'), 'u***@example.org');
  assert.equal(maskEmail('work.account@gmail.com'), 'w***@gmail.com');
  assert.equal(maskEmail(''), '');
  assert.equal(maskEmail(undefined), '');
  assert.equal(maskEmail('not-an-address'), '');
});

test('addresses are removed from journals and page snapshots', () => {
  assert.equal(redactEmails('write to viktor@gmail.com please'), 'write to [email] please');
  assert.equal(redactEmails('no addresses here'), 'no addresses here');
  const state = redactState({ url: 'https://gemini.google.com/app', text: 'user@mail.com said hi', buttons: ['user@mail.com'] });
  assert.equal(state.text, '[email] said hi');
  assert.deepEqual(state.buttons, ['[email]']);
  assert.equal(state.url, 'https://gemini.google.com/app');
});

test('the release check reports planted keys and runtime files and passes on a clean folder', async () => {
  const script = path.join(ROOT, 'scripts/check-privacy.mjs');
  const clean = await fs.mkdtemp(path.join(ROOT, '.test-privacy-'));
  const dirty = await fs.mkdtemp(path.join(ROOT, '.test-privacy-'));
  try {
    const cleanRun = spawnSync(process.execPath, [script, clean], { encoding: 'utf8' });
    assert.equal(cleanRun.status, 0, cleanRun.stdout + cleanRun.stderr);

    await fs.writeFile(path.join(dirty, 'app.mjs'), 'const apiKey = "abcdef0123456789abcdef";\n');
    await fs.mkdir(path.join(dirty, '.data'), { recursive: true });
    await fs.writeFile(path.join(dirty, '.data/state.json'), '{}');
    await fs.writeFile(path.join(dirty, 'api-token'), 'local-token');
    const dirtyRun = spawnSync(process.execPath, [script, dirty], { encoding: 'utf8' });
    assert.equal(dirtyRun.status, 1, dirtyRun.stdout + dirtyRun.stderr);
    assert.match(dirtyRun.stdout, /присвоєний секрет/);
    assert.match(dirtyRun.stdout, /«\.data»/);
    assert.match(dirtyRun.stdout, /«api-token»/);
  } finally {
    assert.equal(path.dirname(clean), ROOT); assert.equal(path.dirname(dirty), ROOT);
    await fs.rm(clean, { recursive: true, force: true }); await fs.rm(dirty, { recursive: true, force: true });
  }
});
