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
  assert.match(html, /Керувати шаблонами/); assert.match(html, /Колірна палітра/);
});

test('public release includes ten visual templates with four tones and full management controls', async () => {
  const [templates, html, app] = await Promise.all([
    import('../templates.mjs'),
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  ]);
  assert.equal(templates.BUILTIN_TEMPLATES.length, 10);
  assert.ok(templates.BUILTIN_TEMPLATES.every(template => template.tones.length === 4 && template.image.kind === 'builtin'));
  assert.match(templates.BUILTIN_TEMPLATES.find(template => template.id === 'studio-photo').prompt, /captured with a camera/);
  assert.match(templates.BUILTIN_TEMPLATES.find(template => template.id === 'studio-photo').prompt, /no illustration, vector art, line art, paper-cut layers/i);
  for (const command of ['template-use', 'template-add', 'template-update', 'template-duplicate', 'template-delete', 'template-restore', 'template-preview-job']) assert.match(app, new RegExp(command));
  assert.match(app, /applySelectedTemplate/); assert.match(html, /active-style-status/); assert.doesNotMatch(html, /id="use-template"/);
  assert.match(html, /Використати як обкладинку шаблону/); assert.match(html, /template-image/);
});

test('public release is a generic template with per-row queue controls', async () => {
  const [html, app, csv, server, readme, requirements, scenes, templates] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../input.csv', import.meta.url), 'utf8'),
    fs.readFile(new URL('../server.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../README.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../requirements.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../scenes.json', import.meta.url), 'utf8'),
    fs.readFile(new URL('../templates.mjs', import.meta.url), 'utf8')
  ]);
  const legacyTerms = new RegExp('\\u0434\\u0440\\u043e\\u043d|\\u0431\\u043f\\u043b\\u0430|\\x64\\x72\\x6f\\x6e\\x65|\\x75\\x61\\x76', 'i');
  assert.doesNotMatch([html, app, csv, server, readme, requirements, scenes, templates].join('\n'), legacyTerms);
  assert.match(csv, /Яблуко/); assert.match(csv, /Груша/); assert.match(csv, /Апельсин/);
  for (const command of ['job-update', 'job-hold', 'job-resume', 'job-regenerate', 'job-delete']) assert.match(app, new RegExp(command));
  assert.match(app, /job-quick-actions/); assert.match(app, /styleSource/);
  assert.match(html, /1,3,5,7-10/); assert.match(app, /selectedNumbers/);
  assert.match(html, /range-unfinished/); assert.match(app, /formatRange/);
  assert.match(html, /update-banner/); assert.match(app, /checkForUpdates/);
  assert.match(server, /action === 'preflight'/); assert.match(server, /checkReadiness/);
  assert.match(html, /regenerate-dialog/); assert.match(app, /applyRange/); assert.match(server, /applyQueueSelection/);
});
