import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { pageState, clickImageTool, clickSendPrompt, isTextOnlyRefusal, isCapabilityRefusal, generateInPage } from '../gemini-page.mjs';

function element(text = '', attrs = {}, visible = true) {
  return { innerText: text, clicked: 0, click() { this.clicked++; }, getAttribute: name => attrs[name] || null,
    getBoundingClientRect: () => ({ width: visible ? 100 : 0, height: visible ? 30 : 0 }), querySelectorAll: () => [] };
}

function observedMode({ selected = [], hints = [], buttons = [] } = {}) {
  const composer = element();
  const document = { querySelectorAll(selector) {
    if (selector.startsWith('button,')) return buttons;
    if (selector.startsWith('[contenteditable=')) return [composer];
    if (selector.startsWith('[aria-pressed=')) return selected;
    if (selector.startsWith('[data-placeholder]')) return hints;
    return [];
  } };
  return vm.runInNewContext(`(${pageState.toString()})()`, { document, location: { href: 'https://gemini.google.com/app' } }).imageMode;
}

test('a visible Create image option alone does not prove the tool is selected', () => {
  assert.equal(observedMode({ buttons: [element('Create image')] }), false);
  assert.equal(observedMode({ selected: [element('Image')] }), true);
  assert.equal(observedMode({ selected: [element('Research')] }), false);
  assert.equal(observedMode({ hints: [element('', { 'data-placeholder': 'Describe your image' })] }), true);
  assert.equal(observedMode({ hints: [element('', { 'data-placeholder': 'Describe your image' }, false)] }), false);
});

test('image selection accepts menu descriptions, icon lines and badges without toggling off selection', () => {
  for (const button of [element('', { 'aria-label': 'Create image, new' }), element('image\nCreate image\nNew'), element('Створити зображення Нове'), element('Создание изображений')]) {
    const result = vm.runInNewContext(`(${clickImageTool.toString()})()`, { document: { querySelectorAll: () => [button] } });
    assert.ok(result); assert.equal(button.clicked, 1);
  }
  const selected = element('Create image', { 'aria-checked': 'true' });
  const result = vm.runInNewContext(`(${clickImageTool.toString()})()`, { document: { querySelectorAll: () => [selected] } });
  assert.equal(result.selected, true); assert.equal(selected.clicked, 0);
  const disabled = element('Create image', { 'aria-disabled': 'true' });
  assert.equal(vm.runInNewContext(`(${clickImageTool.toString()})()`, { document: { querySelectorAll: () => [disabled] } }), null);
});

test('the reported Ukrainian text-only refusal is recognized immediately', () => {
  const text = 'Я не маю необхідної інформації чи функцій, щоб допомогти з цим. Я лише мовна модель.';
  assert.equal(isTextOnlyRefusal({ text, busy: false }), true);
  assert.equal(isTextOnlyRefusal({ text, busy: true }), false);
  assert.equal(isTextOnlyRefusal({ text: 'I am only a language model.', busy: false }), true);
  assert.equal(isTextOnlyRefusal({ text: 'Creating your image…', busy: true }), false);
  assert.equal(isTextOnlyRefusal({ text: 'Я не маю потрібних функцій для таких завдань.', busy: false }), true);
  assert.equal(isCapabilityRefusal('Я не маю потрібних функцій для таких завдань.'), true);
  assert.equal(isTextOnlyRefusal({ text: 'Я не понимаю вас и не могу ответить. Я просто языковая модель, и таких возможностей у меня нет.', busy: false }), true);
  assert.equal(isCapabilityRefusal('Я просто языковая модель, и таких возможностей у меня нет.'), true);
  assert.equal(isCapabilityRefusal('I cannot generate that prohibited content.'), false);
});

test('localized send and stop labels accept Cyrillic word boundaries', () => {
  for (const label of ['Send message', 'Надіслати повідомлення', 'Отправить сообщение']) {
    const button = element('', { 'aria-label': label });
    assert.equal(vm.runInNewContext(`(${clickSendPrompt.toString()})()`, { document: { querySelectorAll: () => [button] } }), true);
    assert.equal(button.clicked, 1);
  }
  const disabled = element('', { 'aria-label': 'Отправить сообщение', 'aria-disabled': 'true' });
  assert.equal(vm.runInNewContext(`(${clickSendPrompt.toString()})()`, { document: { querySelectorAll: () => [disabled] } }), false);
  for (const label of ['Stop response', 'Зупинити відповідь', 'Остановить ответ']) {
    const button = element('', { 'aria-label': label });
    const document = { querySelectorAll: selector => selector.startsWith('button,') ? [button] : [] };
    assert.equal(vm.runInNewContext(`(${pageState.toString()})()`, { document, location: { href: 'https://gemini.google.com/app' } }).busy, true);
  }
});

function fakeClient(imageMode, response = '') {
  let reads = 0; const sent = []; const navigated = []; let currentURL = 'https://gemini.google.com/app';
  const client = {
    Page: { enable: async () => {}, navigate: async ({ url }) => { currentURL = url; navigated.push(url); }, bringToFront: async () => {} },
    Runtime: { enable: async () => {}, evaluate: async ({ expression }) => ({ result: { value:
      expression.includes('function pageState') ? {
        url: currentURL, composer: true, imageMode, buttons: ['Upload & tools'], busy: false, images: [], text: ++reads >= 4 ? response : ''
      } : true
    } }) },
    Network: { responseReceived() {}, enable: async () => {}, setCacheDisabled: async () => {} },
    Input: { insertText: async ({ text }) => sent.push(text) }
  };
  return { client, sent, navigated };
}

test('the driver stops on a text-only refusal without resending the prompt', async () => {
  const f = fakeClient(true, 'Я лише мовна модель.'); const logs = [];
  await assert.rejects(generateInPage(f.client, 'Намалюй яблуко', { log: text => logs.push(text) }), /текст замість зображення/);
  assert.deepEqual(f.sent, ['Намалюй яблуко']);
  assert.ok(logs.some(text => text.includes('Gemini text response: Я лише мовна модель.')));
});

test('the existing-profile mode does not bring Chrome to the foreground for each image', async () => {
  const f = fakeClient(true, 'Я лише мовна модель.');
  f.client.Page.bringToFront = async () => { throw new Error('Must not focus the personal browser'); };
  await assert.rejects(generateInPage(f.client, 'Камера', { foreground: false }), error => error.kind === 'capability');
  assert.deepEqual(f.sent, ['Камера']);
});

test('a signed-out Gemini page stops before selecting tools or sending a prompt', async () => {
  const f = fakeClient(true);
  f.client.Runtime.evaluate = async () => ({ result: { value: { url: 'https://gemini.google.com/app', composer: true, loginRequired: true, buttons: ['Sign in'], images: [] } } });
  await assert.rejects(generateInPage(f.client, 'Test', { foreground: false }), error => error.kind === 'login');
  assert.deepEqual(f.sent, []);
});

test('the real daily quota response stops immediately without waiting for the image deadline', async () => {
  const f = fakeClient(true, 'Сьогодні я не можу створити для вас більше зображень, проте все одно можу шукати їх в Інтернеті.');
  const logs = [];
  await assert.rejects(generateInPage(f.client, 'Екологічний моніторинг', { log: text => logs.push(text) }), error => error.kind === 'limit');
  assert.deepEqual(f.sent, ['Екологічний моніторинг']);
  assert.ok(logs.some(text => text.includes('Gemini limit response:')));
});

test('the driver never sends a prompt when image-mode selection cannot be verified', async () => {
  const f = fakeClient(false); const logs = [];
  await assert.rejects(generateInPage(f.client, 'Намалюй яблуко', { log: text => logs.push(text) }), /не підтвердив активний режим/);
  assert.deepEqual(f.sent, []);
  assert.equal(logs.some(text => text.includes('Підтверджено активний режим')), false);
});

test('a delayed Create image menu is awaited before submitting the prompt', async () => {
  const f = fakeClient(false); const logs = []; let checks = 0; let selected = false; let stateReadsAfterSelection = 0;
  f.client.Runtime.evaluate = async ({ expression }) => {
    let value = true;
    if (expression.includes('function clickImageTool')) {
      selected = ++checks >= 3;
      value = selected ? { label: 'Create image New', selected: false } : null;
    } else if (expression.includes('function pageState')) {
      if (selected) stateReadsAfterSelection++;
      value = { url: 'https://gemini.google.com/app', composer: true, imageMode: selected, buttons: ['Upload & tools'], images: [], busy: false,
        text: stateReadsAfterSelection >= 3 ? 'Я лише мовна модель.' : '' };
    }
    return { result: { value } };
  };
  await assert.rejects(generateInPage(f.client, 'ГІС', { log: text => logs.push(text) }), error => error.kind === 'capability');
  assert.equal(checks, 3); assert.deepEqual(f.sent, ['ГІС']);
  assert.ok(logs.some(text => text.includes('Знайдено інструмент: Create image New')));
});

test('generation navigates to the saved account URL with its query intact', async () => {
  const f = fakeClient(true, 'Я лише мовна модель.');
  const geminiUrl = 'https://gemini.google.com/u/2/app?pageId=none';
  await assert.rejects(generateInPage(f.client, 'Камера', { geminiUrl }), error => error.kind === 'capability');
  assert.deepEqual(f.navigated, [geminiUrl]); assert.deepEqual(f.sent, ['Камера']);
});

test('redirecting to another account stops before submitting the image prompt', async () => {
  const f = fakeClient(true); f.client.Page.navigate = async () => {};
  await assert.rejects(generateInPage(f.client, 'Камера', { geminiUrl: 'https://gemini.google.com/u/2/app?pageId=none' }), error => error.kind === 'account-setup');
  assert.deepEqual(f.sent, []);
});
