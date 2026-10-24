import { buildPrompt, selectedNumbers } from '/core.mjs';
import { accountProfileKey, DEFAULT_GEMINI_URL } from '/gemini-accounts.mjs';
const $ = id => document.getElementById(id);
const labels = { pending: 'У черзі', held: 'Призупинено', exists: 'Вже збережено', done: 'Готово', running: 'Генерація', error: 'Помилка', interrupted: 'Перервано' };
const runLabels = { idle: 'Готово до запуску пакета', paused: 'Пакет на паузі', pausing: 'Зупиняємо після поточного зображення', running: 'Генеруємо пакет автоматично', complete: 'Пакет завершено' };
let state, chosen, filter = 'all', grid = false, dirty = false, rangeDirty = false, csv, csvName, noticeTimer, renderingKey;
let accountsRenderingKey, templatesRenderingKey, savingReady = false, preparing = false, templateImageData;
function renderBrowserMode() {
  const existing = $('browser-mode').value === 'existing';
  $('existing-profile-settings').hidden = !existing;
  $('existing-connection-help').hidden = !existing;
  $('account-url').hidden = $('account-url-label').hidden = !existing;
  $('account-session-hint').hidden = existing;
  $('account-url-hint').hidden = !existing;
  $('login').hidden = !existing;
  $('accounts-heading').textContent = existing ? 'Акаунти Gemini в цьому профілі' : 'Акаунти для фонової генерації';
  $('background').disabled = active() || savingReady || existing;
  $('chrome-profile').disabled = active() || savingReady; $('browser-mode').disabled = active() || savingReady; $('check-browser').disabled = active() || savingReady;
  $('login').textContent = existing ? '1. Відкрити вибраний Chrome' : '↗ Відкрити вхід у Gemini';
  $('browser-hint').textContent = existing ? 'Цей режим відкриває вкладки у вашому робочому Chrome. Для роботи без видимих процесів оберіть прихований Chrome генератора.' : 'Залиште «Виконувати у фоні без вікон» увімкненим. Сесії акаунтів, введення запитів та перемикання працюватимуть приховано; робочим Chrome можна користуватися.';
  renderAccounts();
}
async function accountAction(name, body) { if (dirty) await saveSettings(); await action(name, body); }
function renderAccounts() {
  const key = accountProfileKey($('browser-mode').value, $('chrome-profile').value);
  const list = state?.geminiAccounts?.[key] || [];
  const dedicated = $('browser-mode').value === 'dedicated';
  const unavailable = active() || savingReady || ($('browser-mode').value === 'existing' && !$('chrome-profile').value);
  for (const id of ['account-name', 'account-url', 'add-account']) $(id).disabled = unavailable;
  const renderKey = JSON.stringify([key, list, unavailable]); if (renderKey === accountsRenderingKey) return; accountsRenderingKey = renderKey;
  const fragment = document.createDocumentFragment();
  for (const [index, account] of list.entries()) {
    const card = node('div', 'account-row');
    const name = node('input'); name.value = account.name; name.maxLength = 100; name.setAttribute('aria-label', `Назва акаунта ${index + 1}`);
    const url = node('input'); url.type = 'url'; url.value = account.url; url.maxLength = 2000; url.setAttribute('aria-label', `Посилання акаунта ${index + 1}`);
    name.disabled = url.disabled = unavailable;
    const controls = node('div', 'account-controls');
    const toggle = node('label', 'account-enabled'); const enabled = node('input'); enabled.type = 'checkbox'; enabled.checked = account.enabled; enabled.disabled = unavailable;
    enabled.setAttribute('aria-label', `Увімкнути акаунт ${index + 1}: ${account.name}`); toggle.append(enabled, document.createTextNode('Увімкнено'));
    const values = () => ({ id: account.id, name: name.value, url: dedicated ? DEFAULT_GEMINI_URL : url.value, enabled: enabled.checked });
    enabled.addEventListener('change', () => accountAction('account-update', values()).catch(error => { enabled.checked = account.enabled; notify(error.message); }));
    const save = node('button', 'secondary', 'Зберегти'); save.disabled = unavailable; save.setAttribute('aria-label', `Зберегти акаунт ${index + 1}`);
    save.addEventListener('click', () => accountAction('account-update', values()).then(() => notify('Акаунт збережено.')).catch(error => notify(error.message)));
    controls.append(toggle, save);
    for (const [direction, label, text] of [[-1, 'вгору', '↑'], [1, 'вниз', '↓']]) {
      const move = node('button', 'secondary', text); move.disabled = unavailable || index + direction < 0 || index + direction >= list.length;
      move.setAttribute('aria-label', `Перемістити акаунт ${index + 1} ${label}`);
      move.addEventListener('click', async () => {
        try {
          if (name.value !== account.name || url.value !== account.url) await accountAction('account-update', values());
          await accountAction('account-move', { id: account.id, direction });
        } catch (error) { notify(error.message); }
      }); controls.append(move);
    }
    card.append(node('small', 'account-position', `Акаунт ${index + 1}${account.limitedAt ? ' · Ліміт Gemini' : account.capabilityAt ? ' · Немає генерації зображень' : ''}`), name);
    if (!dedicated) card.append(url);
    card.append(controls);
    if (dedicated) {
      card.append(node('small', 'hint', account.sessionCheckedAt ? '✓ Вхід збережено · сесію перевірено' : 'Почніть із «Увійти», потім перевірте сесію'));
      const sessionControls = node('div', 'account-session-actions');
      for (const [command, title] of [['account-login', 'Увійти'], ['account-check', 'Перевірити сесію']]) {
        const button = node('button', 'secondary', title); button.disabled = unavailable; button.setAttribute('aria-label', `${title}: ${account.name}`);
        button.addEventListener('click', async () => {
          button.disabled = true;
          button.textContent = command === 'account-check' ? 'Перевіряємо…' : 'Відкриваємо…';
          try {
            await accountAction(command, { id: account.id });
            notify(command === 'account-login' ? 'Увійдіть у потрібний акаунт, закрийте окреме вікно та натисніть «Перевірити сесію» біля його назви.' : 'Вхід перевірено приховано. Запитів на зображення не надсилали.');
          } catch (error) { notify(error.message); } finally { button.disabled = active(); button.textContent = title; }
        }); sessionControls.append(button);
      }
      card.append(sessionControls);
    }
    fragment.append(card);
  }
  if (!list.length) fragment.append(node('small', 'hint', 'Спочатку оберіть профіль Chrome.'));
  $('gemini-accounts').replaceChildren(fragment);
}
function node(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; }
function paletteSwatches(tone) {
  const wrap = node('span', 'tone-swatches');
  for (const color of tone?.colors || []) { const swatch = node('i'); swatch.style.backgroundColor = color; swatch.title = color; wrap.append(swatch); }
  return wrap;
}
function fillTemplateSelectors(preferredId, preferredTone) {
  const templates = state.templates || []; const selectedId = preferredId || state.activeTemplateId || $('template-select').value || templates[0]?.id;
  $('template-select').replaceChildren(...templates.map(template => { const option = node('option', '', template.title); option.value = template.id; return option; }));
  $('template-select').value = templates.some(template => template.id === selectedId) ? selectedId : templates[0]?.id || '';
  const template = templates.find(item => item.id === $('template-select').value);
  const selectedTone = preferredTone || (template?.id === state.activeTemplateId ? state.activeToneId : '') || $('tone-select').value || template?.tones?.[0]?.id;
  $('tone-select').replaceChildren(...(template?.tones || []).map(tone => { const option = node('option', '', tone.title); option.value = tone.id; return option; }));
  $('tone-select').value = template?.tones?.some(tone => tone.id === selectedTone) ? selectedTone : template?.tones?.[0]?.id || '';
  const tone = template?.tones?.find(item => item.id === $('tone-select').value);
  $('tone-swatches').replaceChildren(...[...(tone?.colors || [])].map(color => { const swatch = node('i'); swatch.style.backgroundColor = color; swatch.title = color; return swatch; }));
  $('active-template-image').src = template?.imageUrl || '';
  $('active-template-image').hidden = !template;
  const activeStyle = state.activeStyle;
  $('active-template-label').textContent = activeStyle?.type === 'template' ? `✓ Активний: ${activeStyle.templateTitle} · ${activeStyle.toneTitle}. Зміна списку застосовується одразу.` : 'Активний власний запит. Вибір шаблону або палітри застосовується одразу.';
}
function renderTemplateLibrary(force = false) {
  const key = JSON.stringify(state.templates || []); if (!force && key === templatesRenderingKey) return; templatesRenderingKey = key;
  const fragment = document.createDocumentFragment();
  for (const template of state.templates || []) {
    const card = node('article', `template-card${template.id === state.activeTemplateId ? ' selected' : ''}`);
    const image = node('img'); image.src = template.imageUrl; image.alt = `Стиль ${template.title}`; image.loading = 'lazy';
    const heading = node('div', 'template-card-heading'); heading.append(node('h3', '', template.title), node('small', '', template.builtin ? 'Вбудований' : 'Власний'));
    const toneSelect = node('select'); toneSelect.setAttribute('aria-label', `Палітра для ${template.title}`);
    for (const tone of template.tones) { const option = node('option', '', tone.title); option.value = tone.id; toneSelect.append(option); }
    toneSelect.value = template.id === state.activeTemplateId ? state.activeToneId : template.tones[0].id;
    const swatches = paletteSwatches(template.tones.find(tone => tone.id === toneSelect.value));
    toneSelect.addEventListener('change', () => swatches.replaceChildren(...paletteSwatches(template.tones.find(tone => tone.id === toneSelect.value)).children));
    const controls = node('div', 'template-card-actions');
    const use = node('button', 'primary', 'Застосувати'); use.disabled = active(); use.addEventListener('click', () => action('template-use', { id: template.id, toneId: toneSelect.value }).then(() => { dirty = false; $('templates-dialog').close(); notify('Шаблон і палітру застосовано.'); }).catch(error => notify(error.message)));
    const edit = node('button', 'secondary', 'Редагувати'); edit.disabled = active(); edit.addEventListener('click', () => { $('templates-dialog').close(); openTemplateEditor(template); });
    const duplicate = node('button', 'secondary', 'Дублювати'); duplicate.disabled = active(); duplicate.addEventListener('click', () => action('template-duplicate', { id: template.id }).then(() => notify('Створено копію шаблону.')).catch(error => notify(error.message)));
    const remove = node('button', 'secondary danger', 'Видалити'); remove.disabled = active(); remove.addEventListener('click', () => { if (window.confirm(`Видалити шаблон «${template.title}»?`)) action('template-delete', { id: template.id }).then(() => notify('Шаблон видалено.')).catch(error => notify(error.message)); });
    controls.append(use, edit, duplicate, remove); card.append(image, heading, toneSelect, swatches, node('p', '', template.prompt), controls); fragment.append(card);
  }
  if (!state.templates?.length) fragment.append(node('div', 'empty', 'Бібліотека порожня. Створіть шаблон або відновіть вбудовані.'));
  $('template-grid').replaceChildren(fragment);
}
function defaultTones() {
  return [
    ['Natural neutral', 'Use warm ivory, stone, sand, taupe and restrained sage accents. Keep the background light but visibly warm, not pure white.', '#eee5d8,#c7b49a,#8e7b68,#7b8764'],
    ['Blue & violet', 'Use navy, indigo, dusty violet and soft blue-gray, with a pale blue-gray background.', '#26395d,#55588e,#8c7fa6,#ccd5df'],
    ['Warm earth', 'Use terracotta, muted ochre, clay, sand and olive, with a warm cream background.', '#a94f35,#c58a3d,#d8b58d,#6e744b'],
    ['Fresh muted', 'Use sage green, muted teal, dusty coral and pale sky blue, with a softly tinted background.', '#819d78,#4f8584,#c47d70,#b9ced8']
  ].map(([title, prompt, colors], index) => ({ id: `tone-${index + 1}`, title, prompt, colors: colors.split(',') }));
}
function renderToneFields(tones) {
  const fragment = document.createDocumentFragment();
  tones.forEach((tone, index) => {
    const field = node('fieldset', 'tone-field'); field.dataset.toneId = tone.id || `tone-${index + 1}`; field.append(node('legend', '', `Палітра ${index + 1}`));
    const title = node('input'); title.value = tone.title; title.maxLength = 80; title.required = true; title.dataset.part = 'title'; title.placeholder = 'Назва палітри';
    const prompt = node('textarea'); prompt.value = tone.prompt; prompt.maxLength = 1000; prompt.rows = 3; prompt.required = true; prompt.dataset.part = 'prompt'; prompt.placeholder = 'Інструкція щодо кольорів';
    const colors = node('input'); colors.value = tone.colors.join(','); colors.required = true; colors.dataset.part = 'colors'; colors.pattern = '#[0-9A-Fa-f]{6}(,\\s*#[0-9A-Fa-f]{6}){3}'; colors.placeholder = '#112233,#445566,#778899,#aabbcc';
    field.append(title, prompt, colors); fragment.append(field);
  }); $('template-tone-fields').replaceChildren(fragment);
}
function openTemplateEditor(template) {
  templateImageData = undefined; $('template-id').value = template?.id || ''; $('template-title').value = template?.title || ''; $('template-prompt').value = template?.prompt || '';
  $('template-editor-title').textContent = template ? 'Редагувати шаблон' : 'Новий шаблон'; $('template-image-preview').src = template?.imageUrl || ''; $('template-image-preview').hidden = !template; $('template-image').value = ''; $('template-image').required = !template;
  renderToneFields(template?.tones || defaultTones()); $('template-editor-dialog').showModal();
}
function notify(message) { $('notice').textContent = message; $('notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('notice').hidden = true, 7500); }
async function request(action, body = {}) {
  const response = await fetch(`/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.message || 'Не вдалося виконати дію.'); return data;
}
async function action(name, body = {}) { state = await request(name, body); render(); }
function listen(id, fn) { $(id).addEventListener('click', () => Promise.resolve().then(fn).catch(error => notify(error.message))); }
const active = () => ['running', 'pausing'].includes(state?.status);
function validateRange() {
  if (!state?.jobs?.length) return true;
  const input = $('range'); const hint = $('range-hint');
  try {
    const max = Math.max(...state.jobs.map(job => job.number));
    const numbers = selectedNumbers(input.value, max);
    const selected = state.jobs.filter(job => numbers.has(job.number));
    const completed = selected.filter(job => ['done', 'exists'].includes(job.status)).length;
    const queueable = selected.length - completed;
    const heldOutside = state.jobs.filter(job => !numbers.has(job.number) && !['done', 'exists'].includes(job.status)).length;
    input.setCustomValidity(''); hint.classList.remove('invalid');
    hint.textContent = input.value.trim()
      ? `Вибрано: ${selected.length}. Стануть у чергу: ${queueable}. Будуть призупинені: ${heldOutside}.${completed ? ` Уже готові: ${completed} — під час збереження з’явиться запит про перегенерацію.` : ''}`
      : `Усі ${queueable} незавершених рядків стануть у чергу.${completed ? ` Готові: ${completed} — під час збереження з’явиться запит про перегенерацію.` : ''}`;
    return true;
  } catch (error) {
    input.setCustomValidity(error.message); hint.classList.add('invalid'); hint.textContent = error.message; return false;
  }
}
function formatRange(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b); const parts = [];
  for (let i = 0; i < sorted.length;) {
    let end = i; while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end++;
    parts.push(end === i ? String(sorted[i]) : `${sorted[i]}-${sorted[end]}`); i = end + 1;
  }
  return parts.join(',');
}
function setRange(value) {
  $('range').value = value; dirty = true; rangeDirty = value !== state.range; validateRange();
}
function status(job) { return node('span', `status ${job.status}`, labels[job.status] || job.status); }
function renderJobs() {
  const search = $('search').value.toLocaleLowerCase('uk');
  const jobs = state.jobs.filter(job => (!search || `${job.name} ${job.description}`.toLocaleLowerCase('uk').includes(search)) &&
    (filter === 'all' || (filter === 'pending' && job.selected && ['pending', 'held'].includes(job.status)) || (filter === 'done' && ['done', 'exists'].includes(job.status)) || (filter === 'error' && ['error', 'interrupted'].includes(job.status))));
  $('visible-count').textContent = jobs.length;
  $('jobs').classList.toggle('grid', grid); const fragment = document.createDocumentFragment();
  for (const job of jobs) {
    const row = node('div', `job${job.number === chosen ? ' selected' : ''}${!job.selected ? ' outside' : ''}`);
    row.setAttribute('role', 'button'); row.tabIndex = 0; row.setAttribute('aria-pressed', String(job.number === chosen)); row.append(node('span', 'job-number', String(job.number).padStart(3, '0')));
    if (job.filename) { const img = node('img'); img.src = `/images/${job.number}`; img.alt = ''; img.loading = 'lazy'; row.append(img); }
    else row.append(node('span', 'job-placeholder', '◇'));
    const text = node('span', 'job-text'); text.append(node('strong', '', job.name), node('small', '', job.description));
    row.append(text, status(job));
    const quick = node('span', 'job-quick-actions');
    const quickButton = (label, title, command, message) => {
      const button = node('button', 'quick-action', label); button.type = 'button'; button.title = title; button.setAttribute('aria-label', `${title}: ${job.name}`); button.disabled = active();
      button.addEventListener('click', event => { event.stopPropagation(); action(command, { number: job.number }).then(() => notify(message)).catch(error => notify(error.message)); }); quick.append(button);
    };
    if (job.status === 'held') quickButton('▶', 'Повернути в чергу', 'job-resume', 'Рядок повернено в чергу.');
    else if (['pending', 'error', 'interrupted'].includes(job.status)) quickButton('Ⅱ', 'Призупинити цей рядок', 'job-hold', 'Рядок призупинено.');
    else if (['done', 'exists'].includes(job.status)) quickButton('↻', 'Перегенерувати це зображення', 'job-regenerate', 'Рядок поставлено на перегенерацію; попередній файл збережено в _previous.');
    if (quick.childElementCount) row.append(quick);
    const open = () => { chosen = job.number; renderJobs(); renderDetail(); };
    row.addEventListener('click', event => { if (!event.target.closest('button,a,input,textarea,select')) open(); });
    row.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target === row) { event.preventDefault(); open(); } }); fragment.append(row);
  }
  if (!jobs.length) fragment.append(node('div', 'empty', 'Немає рядків за цим фільтром.'));
  const scroll = $('jobs').scrollTop; $('jobs').replaceChildren(fragment); $('jobs').scrollTop = scroll;
}
function renderDetail() {
  const job = state.jobs.find(item => item.number === chosen) || state.jobs[0]; const detail = $('detail'); detail.replaceChildren();
  if (!job) return;
  detail.append(node('div', 'detail-eyebrow', `ПЕРЕГЛЯД РЯДКА / ${String(job.number).padStart(3, '0')}`));
  if (job.filename) { const link = node('a'); link.href = `/images/${job.number}`; link.target = '_blank'; const img = node('img', 'detail-image'); img.src = link.href; img.alt = job.name; link.append(img); detail.append(link); }
  else { const placeholder = node('div', 'detail-image empty-image'); placeholder.append(node('span', '', '◇'), node('small', '', job.status === 'running' ? 'Ілюстрація створюється…' : job.status === 'held' ? 'Цей рядок призупинено' : 'Тут з’явиться ілюстрація')); detail.append(placeholder); }
  detail.append(node('h3', '', job.name), status(job), node('p', 'detail-description', job.description));
  if (job.geminiAccount) detail.append(node('p', 'detail-description', `Акаунт Gemini: ${job.geminiAccount.name}`));
  if (job.styleSource) detail.append(node('p', 'style-source', job.styleSource.type === 'template' ? `Надіслано зі стилем: ${job.styleSource.templateTitle} · ${job.styleSource.toneTitle}` : 'Надіслано з власним запитом стилю'));
  if (job.filename) detail.append(node('p', 'hint image-folder', `Папка: ${state.outputDir}`));
  if (job.error) detail.append(node('p', 'error-detail', job.error));
  if (['capability', 'refusal', 'tool-setup'].includes(job.errorKind)) {
    const help = node('div', 'generation-help');
    help.append(node('strong', '', job.errorKind === 'capability' ? 'Gemini відповів текстом замість картинки' : job.errorKind === 'refusal' ? 'Gemini відмовився створити цю картинку' : 'Не вдалося ввімкнути Create image'));
    help.append(node('p', '', job.errorKind === 'capability'
      ? 'Режим Create image було вибрано, але цей акаунт відповів як звичайний чат. Причиною може бути недоступна для акаунта генерація, стан сесії або нерозпізнаний опис.'
      : job.errorKind === 'refusal'
        ? 'Уточніть безпечну, нейтральну сцену без двозначних формулювань і повторіть рядок.'
        : 'Відкрийте вхід цього акаунта й перевірте, чи є в Gemini інструмент Create image.'));
    help.append(node('p', '', 'Перевірка: вручну надішліть цьому акаунту “Create one square image of a red apple”. Якщо картинка не створюється — використайте інший акаунт. Якщо створюється — відредагуйте рядок і, за можливості, напишіть назву та опис англійською.'));
    detail.append(help);
  }
  if (['error', 'interrupted'].includes(job.status)) { const retry = node('button', 'primary full', '↻ Повторити цей рядок'); retry.disabled = active(); retry.addEventListener('click', () => action('retry', { number: job.number }).catch(error => notify(error.message))); detail.append(retry); }
  const controls = node('div', 'row-actions');
  if (job.status === 'held') {
    const resume = node('button', 'outline', '▶ Повернути в чергу'); resume.disabled = active();
    resume.addEventListener('click', () => action('job-resume', { number: job.number }).then(() => notify('Рядок повернено в чергу.')).catch(error => notify(error.message))); controls.append(resume);
  } else if (['pending', 'error', 'interrupted'].includes(job.status)) {
    const hold = node('button', 'outline', 'Ⅱ Призупинити рядок'); hold.disabled = active();
    hold.addEventListener('click', () => action('job-hold', { number: job.number }).then(() => notify('Рядок призупинено. Решта черги працюватиме без нього.')).catch(error => notify(error.message))); controls.append(hold);
  }
  if (['done', 'exists'].includes(job.status)) {
    const regenerate = node('button', 'outline', '↻ Перегенерувати'); regenerate.disabled = active();
    regenerate.addEventListener('click', () => action('job-regenerate', { number: job.number }).then(() => notify('Рядок поставлено в чергу. Попереднє зображення збережено в папці _previous.')).catch(error => notify(error.message))); controls.append(regenerate);
    const asTemplate = node('button', 'outline', 'Використати як обкладинку шаблону'); asTemplate.disabled = active() || !state.templates?.length;
    asTemplate.addEventListener('click', () => {
      $('template-image-job').value = job.number;
      $('template-image-target').replaceChildren(...state.templates.map(template => { const option = node('option', '', template.title); option.value = template.id; return option; }));
      $('template-image-dialog').showModal();
    }); controls.append(asTemplate);
  }
  const remove = node('button', 'outline danger', 'Видалити рядок'); remove.disabled = active() || state.jobs.length === 1;
  remove.addEventListener('click', () => {
    if (!window.confirm(`Видалити рядок №${job.number} «${job.name}»? Файл готового зображення, якщо він є, залишиться у папці.`)) return;
    action('job-delete', { number: job.number }).then(() => notify('Рядок видалено з проєкту.')).catch(error => notify(error.message));
  }); controls.append(remove); detail.append(controls);
  if (['pending', 'held', 'error', 'interrupted'].includes(job.status)) {
    const editor = node('details', 'job-editor'); editor.append(node('summary', '', 'Редагувати рядок'));
    const nameLabel = node('label', '', 'Назва'); const name = node('input'); name.value = job.name; name.maxLength = 500; nameLabel.append(name);
    const descriptionLabel = node('label', '', 'Опис або контекст'); const description = node('textarea'); description.value = job.description; description.maxLength = 10000; description.rows = 5; descriptionLabel.append(description);
    const sceneLabel = node('label', '', 'Сцена (необов’язково)'); const scene = node('textarea'); scene.value = job.scene || ''; scene.maxLength = 10000; scene.rows = 3; sceneLabel.append(scene);
    const saveRow = node('button', 'primary full', 'Зберегти рядок'); saveRow.disabled = active();
    saveRow.addEventListener('click', () => action('job-update', { number: job.number, name: name.value, description: description.value, scene: scene.value }).then(() => notify('Рядок оновлено.')).catch(error => notify(error.message)));
    editor.append(nameLabel, descriptionLabel, sceneLabel, saveRow); detail.append(editor);
  }
  if (job.log) { const log = node('a', 'outline', 'Відкрити журнал запиту ↗'); log.href = `/logs/${job.number}`; log.target = '_blank'; detail.append(log); }
  if (job.filename) { const download = node('a', 'outline', '↓ Завантажити зображення'); download.href = `/images/${job.number}`; download.download = job.filename; detail.append(download); }
  const disclosure = node('details'); disclosure.append(node('summary', '', 'Переглянути запит до Gemini'));
  let prompt; try { prompt = buildPrompt(job, dirty ? $('style').value : state.style); } catch (error) { prompt = error.message; }
  disclosure.append(node('pre', 'prompt', prompt)); const copy = node('button', 'outline full', 'Копіювати запит');
  copy.addEventListener('click', () => navigator.clipboard.writeText(prompt).then(() => notify('Запит скопійовано.')).catch(() => notify('Не вдалося скопіювати. Виділіть текст запиту вручну.')));
  disclosure.append(copy); detail.append(disclosure);
}
function render() {
  const done = state.jobs.filter(job => ['done', 'exists'].includes(job.status)).length; const percent = Math.round(done / state.jobs.length * 100);
  if (!chosen || !state.jobs.some(job => job.number === chosen)) chosen = state.jobs.find(job => state.reason && job.errorKind === state.reason)?.number || state.jobs.find(job => job.status === 'pending')?.number || state.jobs[0]?.number;
  $('source-label').textContent = `${state.source} · ${state.jobs.length} рядків`;
  $('total').textContent = state.jobs.length; $('done').textContent = done; $('pending').textContent = state.queued; $('percent').textContent = `${percent}%`; $('progress').value = percent;
  $('run-label').textContent = state.status === 'paused' && state.reason === 'limit' ? 'Ліміт Gemini — пакет на паузі' : state.status === 'paused' && state.reason === 'capability' ? 'Акаунти не підтримують генерацію зображень' : state.status === 'complete' && state.batchFailed ? 'Пакет завершено з помилками' : runLabels[state.status] || state.status;
  const current = state.jobs.find(job => job.status === 'running');
  const waitSeconds = Math.max(0, Math.ceil((Date.parse(state.waitingUntil) - Date.now()) / 1000));
  if (state.status === 'running' && state.waitingUntil) $('run-label').textContent = 'Очікуємо перед наступним запитом';
  const elapsed = current ? Math.max(0, Math.floor((Date.now() - Date.parse(current.startedAt)) / 1000)) : 0;
  $('run-detail').textContent = state.status === 'running' && state.waitingUntil ? `Затримка між запитами: ще ${waitSeconds} с · збережено в пакеті: ${state.batchDone || 0}/${state.batch?.numbers.length || 0}.` : current ? `Пакет: ${state.batchDone || 0}/${state.batch?.numbers.length || 1} · №${current.number} · ${current.name} · акаунт: ${current.geminiAccount?.name || 'Основний'} · спроба ${Math.min(current.attempts || 1, 2)}/2 · ${current.phase || 'Починаємо спробу…'} · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}` :
    `${state.status === 'paused' ? (state.jobs.find(job => job.errorKind === state.reason)?.error || state.jobs.find(job => job.error)?.error || '') + ' ' : ''}${state.batchFailed ? `Помилок у пакеті: ${state.batchFailed}. ` : ''}Наступний пакет: ${state.nextBatch ?? state.queued} · у черзі всього: ${state.queued}`;
  $('status-dot').classList.toggle('running', active());
  $('tools-status').textContent = `${state.oracle ? 'Сесії Chrome: Oracle 0.21.6' : '✕ Oracle відсутній'} · ${state.chrome ? '✓ Chrome' : '✕ Chrome відсутній'}`;
  $('active-style-status').textContent = state.activeStyle?.type === 'template' ? `Стиль: ${state.activeStyle.templateTitle} · ${state.activeStyle.toneTitle}` : 'Стиль: власний запит';
  $('output-dir').textContent = state.outputDir;
  if (!dirty) { $('style').value = state.style; $('range').value = state.range; $('batch-size').value = state.batchSize ?? 25; $('request-delay').value = state.requestDelaySeconds ?? 30; $('background').checked = state.background !== false; $('diagnostics').checked = state.diagnostics === true; $('output-folder').value = state.outputDir; }
  fillTemplateSelectors(); renderTemplateLibrary();
  validateRange();
  if (!dirty) {
    $('browser-mode').value = state.browserMode || 'dedicated';
    const options = [node('option', '', 'Оберіть профіль…')]; options[0].value = '';
    for (const profile of state.chromeProfiles || []) { const option = node('option', '', `${profile.name}${profile.account ? ' · ' + profile.account : ''}`); option.value = profile.id; options.push(option); }
    $('chrome-profile').replaceChildren(...options); $('chrome-profile').value = state.chromeProfile || '';
  }
  for (const id of ['style', 'range', 'range-all', 'range-unfinished', 'batch-size', 'request-delay', 'background', 'diagnostics', 'clear-diagnostics', 'output-folder', 'choose-output-folder', 'save-output-folder', 'save-settings', 'scan', 'login', 'import-button', 'template-select', 'tone-select', 'manage-templates']) $(id).disabled = active() || savingReady || preparing;
  $('save-ready').disabled = active() || savingReady || !state.jobs.some(job => ['done', 'exists'].includes(job.status));
  renderBrowserMode();
  $('start').textContent = preparing ? 'Перевіряємо готовність…' : `▶ Генерувати пакет · ${state.nextBatch ?? state.queued}`;
  $('start').disabled = active() || savingReady || preparing || ['limit', 'login', 'capability'].includes(state.reason) || !state.oracle || !state.chrome || state.queued === 0;
  $('pause').disabled = !active() || state.status === 'pausing';
  $('stop').disabled = !active();
  const key = JSON.stringify([state.jobs, chosen, grid, filter, $('search').value]);
  if (renderingKey !== key) { renderJobs(); renderDetail(); renderingKey = key; }
  const events = state.events.slice(-4).reverse().map(event => { const li = node('li'); const time = node('time', '', new Date(event.at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })); li.append(time, document.createTextNode(event.message)); return li; });
  $('events').replaceChildren(...events);
}
async function askRegeneration(count) {
  if (!count) return false;
  $('regenerate-count').textContent = count;
  const dialog = $('regenerate-dialog'); dialog.returnValue = 'keep'; dialog.showModal();
  await new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }));
  return dialog.returnValue === 'regenerate';
}
async function saveSettings(command = 'settings') {
  if (!validateRange()) { $('range').reportValidity(); throw new Error($('range').validationMessage); }
  const applyRange = rangeDirty;
  const numbers = selectedNumbers($('range').value, Math.max(...state.jobs.map(job => job.number)));
  const completed = applyRange ? state.jobs.filter(job => numbers.has(job.number) && ['done', 'exists'].includes(job.status)).length : 0;
  const regenerateSelected = await askRegeneration(completed);
  state = await request(command, { style: $('style').value, range: $('range').value, applyRange, regenerateSelected, batchSize: Number($('batch-size').value), requestDelaySeconds: $('request-delay').value === '' ? null : Number($('request-delay').value), background: $('background').checked, diagnostics: $('diagnostics').checked, browserMode: $('browser-mode').value, chromeProfile: $('chrome-profile').value, outputDir: $('output-folder').value });
  dirty = false; rangeDirty = false; render();
}
$('style').addEventListener('input', () => { dirty = true; $('active-template-label').textContent = 'Власні зміни ще не збережено. Натисніть «Зберегти налаштування».'; renderDetail(); }); $('range').addEventListener('input', () => { dirty = true; rangeDirty = $('range').value !== state.range; validateRange(); });
async function applySelectedTemplate(id, toneId) { await action('template-use', { id, toneId }); dirty = false; notify(`Активний стиль: ${state.activeStyle.templateTitle} · ${state.activeStyle.toneTitle}.`); }
$('template-select').addEventListener('change', event => { const id = event.target.value; fillTemplateSelectors(id); applySelectedTemplate(id, $('tone-select').value).catch(error => notify(error.message)); });
$('tone-select').addEventListener('change', event => { const id = $('template-select').value; const toneId = event.target.value; fillTemplateSelectors(id, toneId); applySelectedTemplate(id, toneId).catch(error => notify(error.message)); });
listen('manage-templates', () => { renderTemplateLibrary(true); $('templates-dialog').showModal(); });
listen('close-templates', () => $('templates-dialog').close());
listen('add-template', () => { $('templates-dialog').close(); openTemplateEditor(); });
listen('restore-templates', async () => { if (!window.confirm('Відновити початкові вбудовані шаблони? Власні шаблони залишаться.')) return; await action('template-restore'); renderTemplateLibrary(true); notify('Вбудовані шаблони відновлено.'); });
listen('close-template-editor', () => $('template-editor-dialog').close());
$('template-image').addEventListener('change', async event => {
  try {
    const file = event.target.files[0]; if (!file) return;
    if (file.size > 10 * 1024 * 1024) { event.target.value = ''; throw new Error('Обкладинка має бути до 10 МБ.'); }
    templateImageData = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Не вдалося прочитати обкладинку.')); reader.readAsDataURL(file); });
    $('template-image-preview').src = templateImageData; $('template-image-preview').hidden = false;
  } catch (error) { notify(error.message); }
});
$('template-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const tones = [...$('template-tone-fields').querySelectorAll('.tone-field')].map((field, index) => ({ id: field.dataset.toneId || `tone-${index + 1}`, title: field.querySelector('[data-part="title"]').value, prompt: field.querySelector('[data-part="prompt"]').value, colors: field.querySelector('[data-part="colors"]').value.split(',').map(color => color.trim()) }));
    const id = $('template-id').value; const body = { title: $('template-title').value, prompt: $('template-prompt').value, tones, ...(templateImageData ? { imageData: templateImageData } : {}) };
    await action(id ? 'template-update' : 'template-add', id ? { id, ...body } : body); templateImageData = undefined; $('template-editor-dialog').close(); renderTemplateLibrary(true); $('templates-dialog').showModal(); notify(id ? 'Шаблон оновлено.' : 'Шаблон створено.');
  } catch (error) { notify(error.message); }
});
listen('close-template-image', () => $('template-image-dialog').close());
$('template-image-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { await action('template-preview-job', { id: $('template-image-target').value, number: Number($('template-image-job').value) }); $('template-image-dialog').close(); notify('Обкладинку шаблону оновлено.'); }
  catch (error) { notify(error.message); }
});
listen('range-all', () => setRange(''));
listen('range-unfinished', () => {
  const numbers = state.jobs.filter(job => !['done', 'exists'].includes(job.status)).map(job => job.number);
  if (!numbers.length) throw new Error('Усі рядки вже мають готові зображення.');
  setRange(formatRange(numbers));
});
$('batch-size').addEventListener('change', () => dirty = true);
$('request-delay').addEventListener('input', () => dirty = true);
$('output-folder').addEventListener('input', () => dirty = true);
if (window.newMassGenDesktop?.chooseOutputFolder) {
  $('choose-output-folder').hidden = false;
  listen('choose-output-folder', async () => {
    const folder = await window.newMassGenDesktop.chooseOutputFolder();
    if (!folder) return;
    $('output-folder').value = folder;
    dirty = true;
    notify('Папку обрано. Натисніть «Зберегти папку», щоб застосувати її.');
  });
}
$('background').addEventListener('change', () => dirty = true);
$('diagnostics').addEventListener('change', () => dirty = true);
$('browser-mode').addEventListener('change', () => { dirty = true; $('background').checked = $('browser-mode').value === 'dedicated'; renderBrowserMode(); });
$('chrome-profile').addEventListener('change', () => { dirty = true; renderAccounts(); });
listen('add-account', async () => { await accountAction('account-add', { name: $('account-name').value, url: $('browser-mode').value === 'dedicated' ? DEFAULT_GEMINI_URL : $('account-url').value, enabled: true }); $('account-name').value = ''; $('account-url').value = ''; notify(state.browserMode === 'dedicated' ? 'Акаунт додано. Натисніть «Увійти» в його картці, щоб зберегти вхід.' : 'Акаунт додано.'); });
listen('save-settings', async () => { await saveSettings(); notify('Налаштування збережено.'); });
listen('save-output-folder', async () => { await saveSettings(); notify('Папку збережено. Прогрес визначено за файлами в ній.'); });
listen('save-ready', async () => {
  savingReady = true; $('save-ready-result').hidden = true; render();
  try {
    await saveSettings('save-ready');
    const result = state.savedReady;
    const summary = `Збережено: ${result.copied}. Уже є в папці: ${result.skipped}. Не вдалося: ${result.failed.length}.`;
    $('save-ready-result').textContent = [summary, ...result.failed.map(job => `№${job.number} ${job.name}: ${job.message}`)].join('\n');
    $('save-ready-result').hidden = false; notify(summary);
  } finally { savingReady = false; render(); }
});
listen('start', async () => {
  preparing = true; render();
  try { if (dirty) await saveSettings(); notify('Перевіряємо папку, Chrome та вхід першого акаунта…'); await action('start'); }
  finally { preparing = false; render(); }
});
listen('pause', () => action('pause')); listen('scan', async () => { await action('scan'); notify('Файли перевірено.'); });
listen('stop', () => action('stop'));
listen('login', async () => { if (dirty) await saveSettings(); await action('login'); notify(state.browserMode === 'existing' ? 'Відкрито ваш Chrome. Кнопкою 2 скопіюйте адресу доступу та відкрийте її в адресному рядку Chrome.' : state.background ? 'Увійдіть у Gemini, потім закрийте це вікно. Пакет працюватиме без видимих вікон.' : 'Увійдіть у Gemini та запустіть пакет.'); });
listen('copy-debug-url', () => navigator.clipboard.writeText('chrome://inspect/#remote-debugging').then(() => notify('Адресу скопійовано. У звичайному Chrome натисніть Ctrl+L, Ctrl+V, Enter.')));
listen('check-browser', async () => { if (dirty) await saveSettings(); notify('Якщо Chrome попросить дозвіл, натисніть Allow у його вікні.'); await action('check-browser'); notify('Підключення до вибраного профілю Chrome перевірено. Запити на зображення не надсилалися.'); });
listen('clear-diagnostics', async () => { await action('clear-diagnostics'); notify(`Очищено діагностичних файлів: ${state.clearedDiagnostics || 0}.`); });
listen('copy-path', () => navigator.clipboard.writeText(state.outputDir).then(() => notify('Шлях скопійовано.')));
$('search').addEventListener('input', renderJobs);
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => { filter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('active', item === button)); renderJobs(); });
for (const [id, value] of [['list-view', false], ['grid-view', true]]) listen(id, () => { grid = value; for (const view of ['list-view', 'grid-view']) { const enabled = (view === 'grid-view') === grid; $(view).classList.toggle('active', enabled); $(view).setAttribute('aria-pressed', String(enabled)); } renderJobs(); });
listen('import-button', () => $('csv-file').click()); listen('close-import', () => $('import-dialog').close());
$('csv-file').addEventListener('change', async event => {
  try {
    const file = event.target.files[0]; if (!file) return;
    if (file.size > 5_000_000) throw new Error('CSV має бути до 5 МБ.');
    csv = await file.text(); csvName = file.name; const preview = await request('preview', { csv });
    for (const id of ['name-column', 'description-column']) { $(id).replaceChildren(...preview.headers.map((header, index) => { const option = node('option', '', header); option.value = index; return option; })); }
    $('description-column').value = Math.min(1, preview.headers.length - 1); $('import-summary').textContent = `${csvName}: ${preview.total} рядків. Перевірте відповідність колонок.`;
    $('import-dialog').showModal();
  } catch (error) { notify(error.message); } finally { event.target.value = ''; }
});
$('import-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { await action('import', { csv, filename: csvName, nameColumn: Number($('name-column').value), descriptionColumn: Number($('description-column').value) }); chosen = undefined; dirty = false; rangeDirty = false; render(); $('import-dialog').close(); notify('Таблицю імпортовано.'); }
  catch (error) { notify(error.message); }
});
let refreshing = false;
async function refresh() {
  if (refreshing) return; refreshing = true;
  try { const response = await fetch('/api/state'); if (!response.ok) throw Object.assign(new Error(), { status: response.status }); state = await response.json(); render(); }
  catch (error) { $('run-label').textContent = error.status === 401 ? 'Потрібен захищений локальний запуск' : 'Сервер не відповідає'; $('run-detail').textContent = 'Відкрийте «Відкрити.cmd», щоб продовжити зі збереженого місця.'; $('start').disabled = true; }
  finally { refreshing = false; }
}
await refresh();
if (window.newMassGenDesktop?.checkForUpdates) {
  window.newMassGenDesktop.checkForUpdates().then(update => {
    if (!update?.available || !/^https:\/\/github\.com\/ye-shapovalov\/new-mass-gen-images\/releases\//.test(update.url || '')) return;
    const banner = $('update-banner'); banner.href = update.url; banner.textContent = `Доступна версія ${update.version} — завантажити ↗`; banner.hidden = false;
  }).catch(() => {});
}
setInterval(refresh, 2500);
