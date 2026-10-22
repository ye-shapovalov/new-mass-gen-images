import { setTimeout as delay } from 'node:timers/promises';
import { imageType, failureKind } from './core.mjs';
import { bounded } from './timing.mjs';
import { DEFAULT_GEMINI_URL, normalizeGeminiURL, geminiAccountIndex } from './gemini-accounts.mjs';

// These selectors run only inside the app's dedicated Gemini generation tab.
export function pageState() {
  const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 5 && rect.height > 5; };
  const buttons = [...document.querySelectorAll('button, [role="button"], [role="menuitemcheckbox"], [role="menuitem"]')].filter(visible);
  const label = element => `${element.getAttribute('aria-label') || ''} ${element.innerText || ''}`.trim();
  const composer = [...document.querySelectorAll('[contenteditable="true"], textarea')].find(visible);
  const responses = [...document.querySelectorAll('model-response, [data-message-author-role="assistant"]')];
  const last = responses.at(-1); const scope = last || document;
  const selectedImage = [...document.querySelectorAll('[aria-pressed="true"], [aria-selected="true"], [aria-checked="true"]')]
    .filter(visible).some(element => /\bimages?\b|зображенн|изображени/i.test(label(element)));
  const imageHint = [...document.querySelectorAll('[data-placeholder], [placeholder]')].filter(visible)
    .some(element => /describe your image|опишіть.*зображення|опишите.*изображение/i.test(`${element.getAttribute('data-placeholder') || ''} ${element.getAttribute('placeholder') || ''}`));
  return { url: location.href, composer: Boolean(composer),
    loginRequired: [...buttons, ...document.querySelectorAll('a')].filter(visible).some(element => /^(sign in|увійти|ввійти|войти)$/i.test(label(element))),
    imageMode: selectedImage || imageHint || buttons.some(button => /deselect.*image|remove.*image.*tool/i.test(label(button))),
    buttons: buttons.map(label),
    busy: buttons.some(button => /^(stop|зупинити|остановить)(?:\s|$)/i.test(label(button))),
    text: last?.innerText?.slice(-5000) || '',
    images: [...scope.querySelectorAll('img')].filter(img => img.complete && img.naturalWidth >= 512 && img.naturalHeight >= 512)
      .map(img => ({ src: img.currentSrc || img.src, width: img.naturalWidth, height: img.naturalHeight })) };
}

export function imageToolsReady(state) {
  return Boolean(state?.composer && (state.imageMode || state.buttons.some(label => /upload.*tools|tools|інструменти|инструменты|create images?|створити зображення|створення зображень|создать изображение|создание изображений/i.test(label))));
}

export function isTextOnlyRefusal(state) {
  return !state.busy && (isCapabilityRefusal(state.text) || /(?:cannot|can't|unable to) (?:create|generate)|не (?:можу|маю технічної можливості).*згенерувати|image generation.*(?:unavailable|not available)/is.test(state.text || ''));
}

export function isCapabilityRefusal(text) {
  return /i(?:'m| am) (?:just|only) (?:a )?(?:text|language) model|я (?:лише|тільки) мовна модель|я не маю[^.!?\n]{0,100}функці[йї]|я (?:просто|лишь|только) языковая модель|таких возможност(?:ей|и) у меня нет|таких можливост(?:ей|і) у мене немає/i.test(text || '');
}

export function clickImageTool() {
  const entries = [...document.querySelectorAll('button, [role="button"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="menuitem"]')];
  for (const element of entries) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 5 || rect.height <= 5 || element.disabled || element.getAttribute('aria-disabled') === 'true') continue;
    const labels = [element.getAttribute('aria-label'), ...(element.innerText || '').split('\n')].filter(Boolean).map(text => text.replace(/\s+/g, ' ').trim());
    const label = labels.find(text => /^(?:create|generate) images?\b|^(?:створити зображення|створення зображень|создать изображение|создание изображений)(?:\s|$)/i.test(text));
    if (!label) continue;
    const selected = element.getAttribute('aria-checked') === 'true' || element.getAttribute('aria-pressed') === 'true';
    if (!selected) element.click();
    return { label, selected };
  }
  return null;
}

export function clickSendPrompt() {
  const button = [...document.querySelectorAll('button')].find(element => !element.disabled && element.getAttribute('aria-disabled') !== 'true' && /^(send|send message|send prompt|надіслати|отправить)(?:\s|$)/i.test((element.getAttribute('aria-label') || '').trim()));
  if (!button) return false;
  button.click(); return true;
}

export async function generateInPage(client, prompt, { signal, log = () => {}, onProgress = () => {}, foreground = true, geminiUrl = DEFAULT_GEMINI_URL } = {}) {
  geminiUrl = normalizeGeminiURL(geminiUrl);
  const { Page, Runtime, Network, Input } = client;
  const command = promise => bounded(promise, 30000, 'Chrome не відповів протягом 30 секунд.', signal);
  const report = async message => { log(message); await onProgress(message); };
  const evaluate = async fn => {
    const result = await command(Runtime.evaluate({ expression: typeof fn === 'function' ? `(${fn.toString()})()` : fn, returnByValue: true, awaitPromise: true }));
    if (result.exceptionDetails) throw new Error('Не вдалося взаємодіяти зі сторінкою Gemini.');
    return result.result.value;
  };
  const check = () => { if (signal?.aborted) throw signal.reason?.kind ? signal.reason : Object.assign(new Error('Запит перервано. Перевірте Gemini перед повтором.'), { kind: 'interrupted' }); };
  const sleep = async () => { check(); try { await delay(1200, undefined, { signal }); } catch { check(); } };
  const responseImages = new Map();
  Network.responseReceived(event => {
    if (event.response.mimeType?.startsWith('image/')) responseImages.set(event.response.url, event.requestId);
  });
  await command(Page.enable()); await command(Runtime.enable()); await command(Network.enable({ maxTotalBufferSize: 60 * 1024 * 1024, maxResourceBufferSize: 25 * 1024 * 1024 }));
  await command(Network.setCacheDisabled({ cacheDisabled: true }));
  if (foreground) await command(Page.bringToFront());
  check(); await command(Page.navigate({ url: geminiUrl })); await report('Завантажуємо Gemini…');
  let ready;
  for (let attempt = 0; attempt < 50; attempt++) {
    ready = await evaluate(pageState); if (ready?.loginRequired || ready?.url?.startsWith('https://accounts.google.com/') || imageToolsReady(ready)) break; await sleep();
  }
  if (!ready?.composer || ready.loginRequired) throw Object.assign(new Error('Потрібен вхід у цей акаунт. Відкрийте «Увійти» біля його назви, увійдіть, закрийте окреме вікно та повторіть пакет.'), { kind: 'login' });
  if (geminiAccountIndex(ready.url) !== geminiAccountIndex(geminiUrl)) throw Object.assign(new Error('Gemini відкрив інший акаунт. Перевірте посилання та входи у вибраному профілі. Запит не надіслано.'), { kind: 'account-setup' });
  if (!imageToolsReady(ready)) throw Object.assign(new Error('Gemini не завантажив інструменти зображень.'), { kind: 'tool-setup' });

  await report('Вмикаємо Create image…');
  let imageTool = ready.imageMode || await evaluate(clickImageTool);
  if (!imageTool) {
    const toolsOpened = await evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(element => element.getBoundingClientRect().width > 5 && /upload.*tools|tools|інструменти|инструменты/i.test(element.getAttribute('aria-label') || element.innerText || ''));
      if (!button) return false; button.click(); return true;
    });
    if (!toolsOpened) throw Object.assign(new Error('Не вдалося відкрити меню інструментів Gemini. Запит не надіслано.'), { kind: 'tool-setup' });
    log('Відкрито меню інструментів; очікування пункту Create image…');
    let expandedMore = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      await sleep();
      const current = await evaluate(pageState);
      imageTool = current.imageMode || await evaluate(clickImageTool);
      if (imageTool) break;
      if (attempt >= 1 && !expandedMore) {
        expandedMore = await evaluate(() => {
          const more = [...document.querySelectorAll('button, [role="menuitem"]')].find(element => element.getBoundingClientRect().width > 5 && /^(more tools|більше інструментів|інші інструменти|другие инструменты)$/i.test((element.getAttribute('aria-label') || element.innerText || '').trim()));
          if (!more) return false; more.click(); return true;
        });
        if (expandedMore) log('Відкрито додаткові інструменти Gemini.');
      }
    }
    if (!imageTool) throw Object.assign(new Error('Не вдалося знайти та ввімкнути Create image у меню Gemini. Запит не надіслано; доступ акаунта не визначено.'), { kind: 'tool-setup' });
  }
  if (imageTool?.label) log(`Знайдено інструмент: ${imageTool.label}`);
  let imageModeConfirmed = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep();
    if ((await evaluate(pageState)).imageMode) { imageModeConfirmed = true; break; }
  }
  if (!imageModeConfirmed) throw Object.assign(new Error('Gemini не підтвердив активний режим Create image. Запит не надіслано. Перевірте інструмент у вікні генерації.'), { kind: 'tool-setup' });
  log('Підтверджено активний режим Create image.');
  const baseline = new Set((await evaluate(pageState)).images.map(img => img.src));
  await evaluate(() => {
    const input = [...document.querySelectorAll('[contenteditable="true"], textarea')].find(element => element.getBoundingClientRect().height > 10);
    if (!input) throw new Error('No composer'); input.focus();
  });
  check(); await command(Input.insertText({ text: prompt }));
  let sent = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    sent = await evaluate(clickSendPrompt);
    if (sent) break; await sleep();
  }
  if (!sent) throw new Error('Не вдалося надіслати запит у Gemini.');
  await report('Gemini створює зображення — очікуємо до 2 хвилин…');
  const started = Date.now(); const deadline = started + 120000; let nextUpdate = started + 15000;
  while (Date.now() < deadline) {
    await sleep(); const state = await evaluate(pageState);
    if (Date.now() >= nextUpdate) {
      log(`Очікування ${Math.round((Date.now() - started) / 1000)} с; Gemini busy=${state.busy}; зображень=${state.images.length}; текст=${JSON.stringify(state.text.slice(-300))}`);
      nextUpdate = Date.now() + 15000;
    }
    const image = state.images.find(img => !baseline.has(img.src));
    if (image) {
      const requestId = responseImages.get(image.src); let bytes;
      if (requestId) {
        try { const body = await command(Network.getResponseBody({ requestId })); bytes = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'binary'); }
        catch (error) { if (['timeout', 'interrupted'].includes(error.kind)) throw error; continue; }
      } else if (/^(blob:|data:image\/)/.test(image.src)) {
        const base64 = await evaluate(`(async () => { const r = await fetch(${JSON.stringify(image.src)}); const bytes = new Uint8Array(await r.arrayBuffer()); if(bytes.length > 26214400) throw new Error('Image too large'); let text = ''; for(let n=0;n<bytes.length;n+=32768) text += String.fromCharCode(...bytes.subarray(n,n+32768)); return btoa(text); })()`);
        bytes = Buffer.from(base64, 'base64');
      } else continue;
      imageType(bytes); log(`Отримано зображення ${image.width}×${image.height}, ${bytes.length} байтів.`); await report('Зберігаємо зображення…'); return bytes;
    }
    if (state.text && failureKind(state.text) === 'limit') {
      log(`Gemini limit response: ${state.text}`);
      throw Object.assign(new Error('Gemini повідомив про ліміт зображень. Після відновлення доступу натисніть «Повторити цей рядок».'), { kind: 'limit' });
    }
    if (isTextOnlyRefusal(state)) {
      log(`Gemini text response: ${state.text}`);
      throw Object.assign(new Error(`Gemini повернув текст замість зображення: ${state.text.slice(-400)}`), { kind: isCapabilityRefusal(state.text) ? 'capability' : 'refusal' });
    }
  }
  throw Object.assign(new Error('Gemini не повернув зображення за 2 хвилини.'), { kind: 'timeout' });
}
