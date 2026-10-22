// Release gate: refuses to ship runtime artefacts, hardcoded keys or real addresses.
// Run before sharing the folder: npm run check:privacy

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argument = process.argv.slice(2).find(value => !value.startsWith('-'));
const ROOT = argument ? path.resolve(argument) : path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const strict = process.argv.includes('--strict');

const SKIP_DIRECTORIES = new Set(['node_modules', '.npm-cache', '.git', '.data', 'output']);
const TEXT_EXTENSIONS = new Set(['.mjs', '.js', '.json', '.html', '.css', '.md', '.csv', '.txt', '.cmd', '']);
// A file that deliberately contains key-like fixtures marks itself with this line.
const IGNORE_MARKER = 'privacy-check: ignore';

const SECRET_PATTERNS = [
  { name: 'ключ у стилі sk-', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'ключ Google API', pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { name: 'токен GitHub', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'токен Slack', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'ключ AWS', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'приватний ключ', pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  { name: 'присвоєний секрет', pattern: /\b(?:api[_-]?key|apikey|access[_-]?key|client[_-]?secret|password|passwd|secret|token|auth[_-]?token)\b\s*[:=]\s*['"][^'"\s]{16,}['"]/gi }
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const RESERVED_DOMAINS = ['example.org', 'example.com', 'example.net', 'example', 'localhost', 'invalid', 'test', 'domain.com'];

// Files that must never travel with the source folder.
const FORBIDDEN_FILES = ['api-token', 'installation-id', 'state.json', 'session.json', 'page.png', 'page-state.json', 'oracle.log'];

const problems = [];
const warnings = [];
const report = (...items) => problems.push(...items.flat());

async function walk(directory, visit) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRECTORIES.has(entry.name)) await walk(full, visit); continue; }
    await visit(full);
  }
}

await walk(ROOT, async file => {
  const relative = path.relative(ROOT, file);
  if (relative.split(path.sep).some(part => part.startsWith('.test-'))) return;
  const extension = path.extname(file).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) return;
  const name = path.basename(file);
  if (name === 'package-lock.json') return; // only integrity hashes of the npm registry
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch { return; }
  if (text.includes('�')) return; // binary content
  if (text.includes(IGNORE_MARKER)) return; // the file declares its own key-like fixtures

  if (FORBIDDEN_FILES.includes(name) || name.endsWith('.log')) {
    report(`службовий файл «${relative}» — не має потрапляти в архів`);
  }
  for (const { name: label, pattern } of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern)) report(`«${relative}»: ${label} (${match[0].slice(0, 12)}…)`);
  }
  for (const match of text.matchAll(EMAIL)) {
    const domain = match[0].split('@')[1].toLowerCase();
    if (!RESERVED_DOMAINS.includes(domain)) warnings.push(`«${relative}»: адреса ${match[0]}`);
  }
});

const legacy = path.join(ROOT, '.data');
try {
  const entries = await fs.readdir(legacy);
  if (entries.length) report(`стара папка «.data» містить ${entries.length} об'єктів — перенесіть її в %LOCALAPPDATA%\\NewMassGen або видаліть`);
} catch (error) { if (error.code !== 'ENOENT') throw error; }

const output = path.join(ROOT, 'output');
try {
  const entries = await fs.readdir(output);
  if (entries.length) report(`папка «output» містить ${entries.length} об'єктів — згенеровані зображення не мають потрапляти в архів програми`);
} catch (error) { if (error.code !== 'ENOENT') throw error; }

if (warnings.length) {
  console.log('Перевірка приватності — попередження:');
  for (const warning of warnings) console.log(`  • ${warning}`);
  if (strict) report(...warnings);
}

if (problems.length) {
  console.log('Перевірка приватності — знайдено проблеми:');
  for (const problem of problems) console.log(`  ✗ ${problem}`);
  console.log('\nПриберіть або приховайте ці файли перед публікацією папки.');
  process.exitCode = 1;
} else {
  console.log(`Перевірка приватності: проблем не знайдено${warnings.length ? `, попереджень: ${warnings.length}` : ''}.`);
}
