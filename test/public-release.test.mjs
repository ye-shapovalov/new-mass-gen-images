import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('public release exposes an editable shared style and explains when it applies', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<textarea id="style"[^>]*maxlength="12000"/);
  assert.match(html, /Основний стиль запиту/);
  assert.match(html, /Зберегти налаштування/);
  assert.match(html, /додається до кожного нового запиту/);
  assert.match(html, /надійніше розпізнає запит на картинку англійською/);
});

test('public release is a generic template with per-row queue controls', async () => {
  const [html, app, csv, server, readme, requirements, scenes] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../input.csv', import.meta.url), 'utf8'),
    fs.readFile(new URL('../server.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../README.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../requirements.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../scenes.json', import.meta.url), 'utf8')
  ]);
  const legacyTerms = new RegExp('\\u0434\\u0440\\u043e\\u043d|\\u0431\\u043f\\u043b\\u0430|\\bdrone\\b|\\buav\\b', 'i');
  assert.doesNotMatch([html, app, csv, server, readme, requirements, scenes].join('\n'), legacyTerms);
  assert.match(csv, /Яблуко/); assert.match(csv, /Груша/); assert.match(csv, /Апельсин/);
  for (const command of ['job-update', 'job-hold', 'job-resume', 'job-regenerate', 'job-delete']) assert.match(app, new RegExp(command));
  assert.match(html, /1,3,5,7-10/); assert.match(app, /selectedNumbers/);
  assert.match(html, /regenerate-dialog/); assert.match(app, /applyRange/); assert.match(server, /applyQueueSelection/);
});
