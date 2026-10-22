export const DEFAULT_STYLE = `Minimalist product illustration with soft volume, clear shapes, and matte surfaces. Natural muted colors, soft diffused light, and a light neutral background. One simple recognizable scene. No neon, text, letters, numbers, captions, logos, collages, or multiple panels.`;

export function parseCSV(input) {
  const text = String(input).replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('CSV порожній.');
  const counts = { ',': 0, ';': 0, '\t': 0 }; let inHeaderQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && inHeaderQuote && text[i + 1] === '"') { i++; continue; }
    if (c === '"') inHeaderQuote = !inHeaderQuote;
    if (!inHeaderQuote && (c === '\r' || c === '\n')) break;
    if (!inHeaderQuote && c in counts) counts[c]++;
  }
  const delimiter = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const rows = []; let row = []; let field = ''; let quoted = false; let closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === '"' && !field && !closed) quoted = true;
    else if (c === delimiter || c === '\n' || c === '\r') {
      row.push(field); field = ''; closed = false;
      if (c !== delimiter) {
        if (row.some(value => value.trim())) rows.push(row);
        row = [];
        if (c === '\r' && text[i + 1] === '\n') i++;
      }
    } else {
      if (closed || c === '"') throw new Error('Некоректні лапки у CSV.');
      field += c;
    }
  }
  if (quoted) throw new Error('Незакриті лапки у CSV.');
  row.push(field);
  if (row.some(value => value.trim())) rows.push(row);
  if (rows.length < 2) throw new Error('CSV має містити заголовок і хоча б один рядок.');
  const headers = rows.shift().map(value => value.trim());
  if (headers.some(value => !value) || new Set(headers).size !== headers.length) throw new Error('Заголовки колонок мають бути унікальні й непорожні.');
  if (rows.length > 5000) throw new Error('Максимум 5000 рядків.');
  if (rows.some(values => values.length !== headers.length)) throw new Error('Кількість колонок у рядках CSV не збігається.');
  return { headers, rows };
}

export function jobsFromCSV(table, nameColumn = 0, descriptionColumn = 1, scenes = {}) {
  for (const column of [nameColumn, descriptionColumn]) {
    if (!Number.isInteger(column) || column < 0 || column >= table.headers.length) throw new Error('Оберіть колонки назви та опису.');
  }
  return table.rows.map((row, index) => {
    const name = row[nameColumn].trim(); const description = row[descriptionColumn].trim();
    if (!name || name.length > 500 || description.length > 10000) throw new Error(`Перевірте назву й опис у рядку ${index + 2}.`);
    return { number: index + 1, name, description, scene: typeof scenes[name] === 'string' ? scenes[name] : '', status: 'pending', attempts: 0 };
  });
}

export function buildPrompt(job, style) {
  const prompt = `Use the active Create image tool now. Create exactly ONE standalone square 1:1 image for a consistent illustration series.\n\nSubject: «${job.name}».\nDescription or context: ${job.description}\n${job.scene ? `Scene: ${job.scene}\n` : ''}\nShared visual style: ${style.trim()}\n\nRender the subject itself as an image. Return the generated image only, not an explanation, description, or rewritten prompt.`;
  if (!style.trim() || prompt.length > 30000) throw new Error('Вкажіть стиль; загальний запит має бути до 30 000 символів.');
  return prompt;
}

export function imageType(bytes) {
  if (bytes.length > 25 * 1024 * 1024) throw new Error('Зображення перевищує 25 МБ.');
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return '.png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return '.jpg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  throw new Error('Не отримано файл PNG, JPEG або WebP.');
}

export function outputStem(job) {
  const name = job.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' — ').replace(/\s+/g, ' ').trim().slice(0, 130).replace(/[. ]+$/, '');
  if (!name || !Number.isSafeInteger(job.number) || job.number < 1) throw new Error('Некоректна назва файлу.');
  return `${job.number}. ${name}`;
}

export function selectedNumbers(expression, max) {
  if (!expression.trim()) return new Set(Array.from({ length: max }, (_, i) => i + 1));
  const result = new Set();
  for (const part of expression.split(/[;,]/)) {
    const match = part.trim().match(/^(\d+)(?:\s*[-–—]\s*(\d+))?$/);
    const start = Number(match?.[1]); const end = Number(match?.[2] || match?.[1]);
    if (!match || start < 1 || end < start || end > max) throw new Error(`Вкажіть номери від 1 до ${max}, наприклад 1-3 або 1,3,5,7-10.`);
    for (let n = start; n <= end; n++) result.add(n);
  }
  return result;
}

export function failureKind(text) {
  if (/сьогодні[^.!?\n]{0,100}не можу[^.!?\n]{0,100}більше зображень|не можу[^.!?\n]{0,100}більше зображень[^.!?\n]{0,60}сьогодні|(?:can't|cannot|can not)[^.!?\n]{0,160}(?:more|additional) images?[^.!?\n]{0,80}(?:today|right now)/i.test(text.replace(/[’‘]/g, "'"))) return 'limit';
  if (/quota|rate.?limit|too many requests|resource.exhausted|429|ліміт|limit reached|usage limit/i.test(text)) return 'limit';
  if (/sign.?in|log.?in|cookies|unauthenticated|authentication|401|403/i.test(text)) return 'login';
  return 'error';
}
