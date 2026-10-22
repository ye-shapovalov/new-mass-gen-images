import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { ROOT } from '../server.mjs';

const launcherPath = path.join(ROOT, 'Відкрити.cmd');

test('Windows launcher uses ASCII commands and CRLF line breaks', async () => {
  const bytes = await fs.readFile(launcherPath);
  assert.ok(bytes.every(byte => byte < 128), 'Commands must be independent of the console code page');
  assert.ok(bytes.includes(13), 'Use Windows line breaks');
  assert.equal(bytes.toString('ascii').replaceAll('\r\n', '').includes('\n'), false);
});

async function runLauncher(t, { installed, npmFails = false, noNode = false } = {}) {
  if (process.platform !== 'win32') { t.skip('Exercises Windows Command Prompt'); return; }
  const root = await fs.mkdtemp(path.join(ROOT, '.test-launcher-'));
  const app = path.join(root, 'Тестова папка з пробілами');
  const bin = path.join(root, 'bin');
  await fs.mkdir(app); await fs.mkdir(bin);
  await fs.copyFile(launcherPath, path.join(app, 'Відкрити.cmd'));
  await fs.writeFile(path.join(app, 'launch.mjs'), "import fs from 'node:fs'; fs.writeFileSync('started.txt', process.cwd()); console.log('launch-ok');");
  await fs.writeFile(path.join(bin, 'npm.cmd'), `@echo off\r\necho %*>install.txt\r\nexit /b ${npmFails ? 17 : 0}\r\n`, 'ascii');
  if (installed) {
    const oracle = path.join(app, 'node_modules/@steipete/oracle/dist/bin');
    await fs.mkdir(oracle, { recursive: true }); await fs.writeFile(path.join(oracle, 'oracle-cli.js'), '');
  }
  const env = { ...process.env };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = noNode ? path.join(process.env.SystemRoot, 'System32') : `${bin};${env[pathKey]}`;
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${path.join(app, 'Відкрити.cmd')}""`], {
    cwd: root, env, windowsVerbatimArguments: true, windowsHide: true, input: '\r\n', encoding: 'utf8', timeout: 15000
  });
  try {
    assert.ifError(result.error);
    assert.equal(result.status, noNode || npmFails ? 1 : 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /not recognized|cannot find the path/i);
    if (noNode || npmFails) {
      await assert.rejects(fs.access(path.join(app, 'started.txt')));
      assert.match(result.stdout, noNode ? /Install Node.js 24/ : /Oracle installation failed/);
    } else {
      assert.equal(await fs.readFile(path.join(app, 'started.txt'), 'utf8'), app);
      assert.match(result.stdout, /launch-ok/);
      if (!installed) assert.equal((await fs.readFile(path.join(app, 'install.txt'), 'utf8')).trim(), 'ci --omit=dev --ignore-scripts --no-audit --no-fund --cache .npm-cache');
    }
  } finally {
    assert.equal(path.dirname(root), ROOT); assert.ok(path.basename(root).startsWith('.test-launcher-'));
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('launcher starts from a Unicode path with spaces and changes to its own folder', t => runLauncher(t, { installed: true }));
test('launcher installs missing dependencies before starting', t => runLauncher(t, { installed: false }));
test('launcher stops cleanly if installation fails', t => runLauncher(t, { npmFails: true }));
test('launcher explains how to install missing Node.js', t => runLauncher(t, { noNode: true }));
