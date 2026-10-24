import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
const privatePaths = /(^|\/)(\.data|account-profiles|runs|output)(\/|$)|(^|\/)(page\.png|page-state\.json|state\.json|api-token)$/i;
const privateContent = [
  /C:\\Users\\[^%<\\/\s]+/i,
  /AIza[0-9A-Za-z_-]{30,}/,
  /gh[oprsu]_[0-9A-Za-z]{30,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*['"][^'"\s]{12,}/i
];
const genericTemplateFiles = new Set(['input.csv', 'scenes.json', 'README.md', 'requirements.md', 'public/index.html', 'public/app.js', 'server.mjs']);
const legacyTopic = new RegExp(String.fromCodePoint(1076, 1088, 1086, 1085) + '|' + String.fromCodePoint(1073, 1087, 1083, 1072) + '|drone|uav', 'i');
const problems = [];

for (const relative of files) {
  const normalized = relative.replaceAll('\\', '/');
  if (privatePaths.test(normalized)) problems.push(`${relative}: приватний runtime-файл не можна публікувати`);
  const absolute = path.join(root, relative);
  let content;
  try { content = fs.readFileSync(absolute, 'utf8'); } catch { continue; }
  for (const pattern of privateContent) if (pattern.test(content)) problems.push(`${relative}: можливий секрет або особистий шлях`);
  if (genericTemplateFiles.has(normalized) && legacyTopic.test(content)) problems.push(`${relative}: шаблон містить стару тематичну згадку`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`Release privacy check passed for ${files.length} tracked files.`);
