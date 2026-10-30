import { SYNTH_DEFAULTS, NUMBER_SETTINGS, normalizeOptions, normalizeModels, syncVoice, cleanText,
  extractDialogue, splitText, voiceParams, characterIdentity, fetchWithTimeout, mergeWavs } from './core.js';

const KEY = 'styleBertVoicePicker';
const defaults = { ...SYNTH_DEFAULTS, apiUrl: 'http://127.0.0.1:5000', transport: 'direct', chunkLength: 90, volume: 1, bindings: {} };
const labels = { styleWeight: '风格强度', length: '时长 Length（小于 1 更快）', sdpRatio: '节奏随机性 SDP Ratio',
  noise: '声音随机性 Noise', noiseW: '字长随机幅度 Noise_W', splitInterval: '分段停顿（秒）',
  pitchScale: '音高（1 为原声）', intonationScale: '抑扬（1 为原声起伏）', assistWeight: '辅助文字强度' };
let settings, dialog, selectionButton, audioPlayer, activeCharacter, audioUrl, activeOperation;
let models = {}, capabilities = {}, dialogOptions = normalizeOptions(), refreshSequence = 0, queue = Promise.resolve();
const cache = new Map();
const context = () => globalThis.SillyTavern?.getContext?.();
const save = () => context()?.saveSettingsDebounced?.();
const notify = (type, message) => globalThis.toastr?.[type]?.(message);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const endpoint = () => settings.transport === 'proxy' ? '/api/plugins/sbvp' : String(settings.apiUrl).trim().replace(/\/+$/, '');
const optionsHtml = (values, selected) => values.map(value => `<option value="${escape(value)}"${value === selected ? ' selected' : ''}>${escape(value)}</option>`).join('');
const modelFor = options => Object.values(models).find(model => model.model_name === options.modelName);

function request(path, options = {}, parse) {
  const base = endpoint();
  if (!base) throw new Error('请填写 API 地址或选择酒馆同源代理');
  if (settings.transport !== 'proxy') {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API 地址只支持 HTTP 或 HTTPS');
    if (location.protocol === 'https:' && url.protocol === 'http:') throw new Error('HTTPS 酒馆无法直连 HTTP API，请使用同源代理');
  }
  const headers = settings.transport === 'proxy' ? context()?.getRequestHeaders?.() || {} : {};
  return fetchWithTimeout(`${base}${path}`, { ...options, headers: { ...headers, ...options.headers } }, parse);
}

async function refreshModels({ rescan = false, announce = true } = {}) {
  const sequence = ++refreshSequence, url = endpoint();
  const [payload, caps] = await Promise.all([
    request(rescan ? '/models/refresh' : '/models/info', { method: rescan ? 'POST' : 'GET' }),
    request('/capabilities').catch(error => { if ([404, 405].includes(error.status)) return {}; throw error; }),
  ]);
  if (sequence !== refreshSequence || url !== endpoint()) return;
  const updated = normalizeModels(payload);
  if (!Object.keys(updated).length) throw new Error('API 已连接，但没有可用模型');
  models = updated; capabilities = caps;
  Object.assign(settings, syncVoice(settings, models));
  dialogOptions = syncVoice(dialogOptions.modelName ? dialogOptions : settings, models);
  cache.clear(); renderVoices(); save();
  if (announce) notify('success', `连接成功，发现 ${Object.keys(models).length} 个音色模型`);
}

function numberInput(key) {
  const [min, max, step] = NUMBER_SETTINGS[key];
  const optional = ['pitchScale', 'intonationScale'].includes(key) ? ' data-sbvp-pitch' : '';
  return `<label>${labels[key]}<input class="text_pole" type="number" data-option="${key}" min="${min}" max="${max}" step="${step}"${optional}></label>`;
}

function voiceFields() {
  return `<div class="sbvp-grid">
    <label>音色模型<select class="text_pole" data-option="modelName"></select></label>
    <label>说话人<select class="text_pole" data-option="speakerName"></select></label>
    <label>训练版本<select class="text_pole" data-option="checkpoint"></select></label>
    <label>情绪风格<select class="text_pole" data-option="style"></select></label>
    <label>语言<select class="text_pole" data-option="language"><option>ZH</option><option>JP</option><option>EN</option></select></label>
    ${numberInput('styleWeight')}${numberInput('length')}
  </div><details><summary>更多合成设置</summary><div class="sbvp-grid">
    ${['sdpRatio', 'noise', 'noiseW', 'pitchScale', 'intonationScale', 'splitInterval'].map(numberInput).join('')}
  </div><p class="sbvp-hint" data-capability-note></p>
  <label class="checkbox_label"><input type="checkbox" data-option="autoSplit">按换行分句；超长台词仍按单段字数分段</label>
  <label class="checkbox_label"><input type="checkbox" data-option="useAssistText">使用辅助情绪文字</label>
  <label>辅助文字<textarea class="text_pole" data-option="assistText" rows="2" placeholder="可填写带相应情绪的短句，先从低强度尝试"></textarea></label>
  ${numberInput('assistWeight')}
  <label class="checkbox_label"><input type="checkbox" data-option="autoEmotion">使用当前 LLM 自动选情绪（会调用当前模型，可能计费）</label>
  <small>音高和抑扬保持 1 可保留原声；Length 越小越快。先固定一句台词，每次只改一项。</small></details>`;
}

function writeFields(root, options) {
  root.querySelectorAll('[data-option]').forEach(input => {
    const value = options[input.dataset.option];
    if (input.type === 'checkbox') input.checked = Boolean(value); else input.value = value ?? '';
  });
}

function readFields(root, base = {}) {
  const value = { ...base };
  root.querySelectorAll('[data-option]').forEach(input => { value[input.dataset.option] = input.type === 'checkbox' ? input.checked : input.value; });
  return normalizeOptions(value);
}

function renderRoot(root, options) {
  root.querySelector('[data-option="modelName"]').innerHTML = optionsHtml(Object.values(models).map(model => model.model_name), options.modelName);
  const model = modelFor(options);
  root.querySelector('[data-option="speakerName"]').innerHTML = optionsHtml(Object.keys(model?.spk2id || {}), options.speakerName);
  root.querySelector('[data-option="style"]').innerHTML = optionsHtml(Object.keys(model?.style2id || {}), options.style);
  const checkpoints = root.querySelector('[data-option="checkpoint"]');
  checkpoints.innerHTML = capabilities.checkpoint_selection ? optionsHtml(model?.checkpoints || [], options.checkpoint) : '<option value="">原版 API 自动选择模型文件</option>';
  checkpoints.disabled = !capabilities.checkpoint_selection;
  root.querySelectorAll('[data-sbvp-pitch]').forEach(input => { input.disabled = !capabilities.parameters?.includes('pitch_scale'); });
  root.querySelector('[data-capability-note]').textContent = capabilities.parameters?.includes('pitch_scale')
    ? '配套 API 已连接：音高、抑扬和训练版本选择可用。'
    : '原版 API 支持基本参数；音高、抑扬和训练版本选择需要启动配套 API。';
  writeFields(root, options);
  if (!capabilities.checkpoint_selection) checkpoints.value = '';
}

function renderVoices() {
  const panel = document.getElementById('sbvp-settings');
  if (panel) renderRoot(panel, settings); if (dialog) renderRoot(dialog, dialogOptions);
}

function bindFields(root, isDialog) {
  root.addEventListener('change', event => {
    if (!event.target.matches('[data-option]')) return;
    let options = readFields(root, isDialog ? dialogOptions : settings);
    if (event.target.dataset.option === 'modelName') {
      options.speakerName = ''; options.style = ''; options.checkpoint = ''; options = syncVoice(options, models);
    }
    if (isDialog) dialogOptions = options; else { Object.assign(settings, options); save(); }
    renderRoot(root, options);
  });
}

function setStatus(message, error = false) {
  const element = dialog.querySelector('[data-sbvp-status]'); element.textContent = message; element.classList.toggle('sbvp-error', error);
}

async function busy(root, fn) {
  if (root.classList.contains('sbvp-busy')) return;
  root.classList.add('sbvp-busy');
  const controls = [...root.querySelectorAll('input, select, textarea, button')].filter(input => !input.matches('[data-sbvp-stop], [data-close]'));
  const disabled = controls.map(input => input.disabled);
  controls.forEach(input => { input.disabled = true; });
  try { await fn(); } catch (error) {
    console.error('[Style-Bert Voice Picker]', error);
    if (root === dialog && dialog.open) setStatus(error.message, true); notify('error', error.message);
  } finally {
    controls.forEach((input, i) => { input.disabled = disabled[i]; }); root.classList.remove('sbvp-busy');
    renderVoices();
  }
}

function createSettingsPanel() {
  if (document.getElementById('sbvp-settings')) return;
  const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings'); if (!container) return;
  const root = document.createElement('div'); root.id = 'sbvp-settings'; root.className = 'extension_container';
  root.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>Style-Bert Voice Picker</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
    <div class="inline-drawer-content"><label>连接方式<select class="text_pole" data-transport><option value="direct">浏览器直连本机 API</option><option value="proxy">酒馆同源代理（手机推荐）</option></select></label>
    <label>API 地址<input class="text_pole" data-api type="url" placeholder="http://127.0.0.1:5000"></label>
    <p class="sbvp-hint">电脑可用 127.0.0.1；手机的 127.0.0.1 指手机自身。同源代理需要安装仓库附带的服务端插件。</p>
    <div class="sbvp-button-row"><button class="menu_button" data-connect>测试连接</button><button class="menu_button" data-refresh>重新扫描模型</button><button class="menu_button" data-open>打开语音面板</button></div>
    <b>全局默认音色与设置</b>${voiceFields()}
    <label>单段字数<input class="text_pole" data-chunk type="number" min="20" max="500"></label>
    <label>播放音量<input data-volume type="range" min="0" max="1" step="0.05"></label></div></div>`;
  container.append(root); writeFields(root, settings); bindFields(root, false);
  root.querySelector('[data-api]').value = settings.apiUrl;
  root.querySelector('[data-transport]').value = settings.transport;
  root.querySelector('[data-api]').disabled = settings.transport === 'proxy';
  root.querySelector('[data-chunk]').value = settings.chunkLength; root.querySelector('[data-volume]').value = settings.volume;
  for (const selector of ['[data-api]', '[data-transport]']) root.querySelector(selector).addEventListener('change', () => {
    stop(); settings.apiUrl = root.querySelector('[data-api]').value.trim().replace(/\/+$/, ''); settings.transport = root.querySelector('[data-transport]').value;
    root.querySelector('[data-api]').disabled = settings.transport === 'proxy';
    refreshSequence++; models = {}; capabilities = {}; cache.clear(); renderVoices(); save();
  });
  root.querySelector('[data-chunk]').addEventListener('change', event => {
    settings.chunkLength = Math.max(20, Math.min(500, Number(event.target.value) || 90)); event.target.value = settings.chunkLength; save();
  });
  root.querySelector('[data-volume]').addEventListener('input', event => {
    settings.volume = Math.max(0, Math.min(1, Number(event.target.value))); if (audioPlayer) audioPlayer.volume = settings.volume; save();
  });
  root.querySelector('[data-connect]').addEventListener('click', () => busy(root, () => refreshModels()));
  root.querySelector('[data-refresh]').addEventListener('click', () => busy(root, () => refreshModels({ rescan: true })));
  root.querySelector('[data-open]').addEventListener('click', () => openDialog(''));
}

function updateCharacterLabel() {
  dialog.querySelector('[data-character]').textContent = activeCharacter
    ? `${activeCharacter.name} · ${settings.bindings[activeCharacter.key] ? '已使用角色音色绑定' : '当前使用全局默认'}` : '未识别到唯一角色，当前使用全局默认';
  dialog.querySelector('[data-bind]').disabled = !activeCharacter;
  dialog.querySelector('[data-unbind]').disabled = !activeCharacter || !settings.bindings[activeCharacter.key];
}

function createDialog() {
  if (dialog) return;
  dialog = document.createElement('dialog'); dialog.id = 'sbvp-dialog';
  dialog.innerHTML = `<div class="sbvp-dialog-card"><div class="sbvp-dialog-header"><b>生成角色语音</b><button class="menu_button" type="button" data-close title="关闭">×</button></div>
    <p class="sbvp-hint" data-character></p><label>台词<textarea class="text_pole" data-text rows="5" placeholder="输入要合成的台词"></textarea></label>${voiceFields()}
    <div class="sbvp-button-row"><button class="menu_button" data-bind>保存为此角色音色</button><button class="menu_button" data-unbind>清除角色绑定</button><button class="menu_button" data-reset>使用全局默认</button></div>
    <div class="sbvp-status" data-sbvp-status role="status" aria-live="polite"></div><audio controls preload="none"></audio>
    <div class="sbvp-button-row sbvp-dialog-actions"><button class="menu_button" data-analyze>识别情绪</button><button class="menu_button" data-speak>生成并播放</button><button class="menu_button" data-sbvp-stop>停止</button><a class="menu_button" data-download hidden>下载 WAV</a></div></div>`;
  document.body.append(dialog); audioPlayer = dialog.querySelector('audio'); bindFields(dialog, true);
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-sbvp-stop]').addEventListener('click', stop); dialog.addEventListener('cancel', stop); dialog.addEventListener('close', stop);
  dialog.querySelector('[data-analyze]').addEventListener('click', () => busy(dialog, async () => {
    const operation = startOperation(); try { await analyze(operation); } finally { if (activeOperation === operation) activeOperation = null; }
  }));
  dialog.querySelector('[data-speak]').addEventListener('click', () => busy(dialog, speak));
  dialog.querySelector('[data-bind]').addEventListener('click', () => {
    if (!activeCharacter) return;
    settings.bindings[activeCharacter.key] = readFields(dialog, dialogOptions); save(); updateCharacterLabel(); notify('success', `已记住 ${activeCharacter.name} 的音色和合成设置`);
  });
  dialog.querySelector('[data-unbind]').addEventListener('click', () => {
    if (!activeCharacter) return; delete settings.bindings[activeCharacter.key]; save(); updateCharacterLabel();
  });
  dialog.querySelector('[data-reset]').addEventListener('click', () => { dialogOptions = syncVoice(settings, models); renderRoot(dialog, dialogOptions); });
}

function openDialog(text, message) {
  createDialog(); stop(); activeCharacter = characterIdentity(context(), message);
  dialogOptions = syncVoice(activeCharacter && settings.bindings[activeCharacter.key] || settings, models);
  dialog.querySelector('[data-text]').value = cleanText(text); setStatus(''); updateCharacterLabel(); renderRoot(dialog, dialogOptions);
  if (!dialog.open) dialog.showModal();
}

function stop() {
  if (activeOperation) { activeOperation.cancelled = true; activeOperation.controller.abort(); }
  if (audioPlayer) audioPlayer.pause();
}

function startOperation() {
  stop(); const operation = { controller: new AbortController(), cancelled: false }; activeOperation = operation; return operation;
}

function assertActive(operation) {
  if (operation.cancelled || activeOperation !== operation || !dialog.open) throw new Error('操作已取消');
}

function parseJson(value) {
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{'), end = text.lastIndexOf('}'); return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
}

async function analyze(operation) {
  const ctx = context(), styles = Object.keys(modelFor(dialogOptions)?.style2id || {}), text = cleanText(dialog.querySelector('[data-text]').value);
  if (!styles.length) throw new Error('请先测试连接并选择音色'); if (!text) throw new Error('请先填写台词');
  if (!ctx?.generateRaw) throw new Error('当前酒馆没有可用的 generateRaw 接口');
  setStatus('正在调用当前 LLM 识别情绪…');
  const prompt = `为角色台词选择情绪。只返回 JSON，字段 style、style_weight、assist_text。style 必须来自列表；style_weight 在 0.5 到 2 之间。assist_text 写一句带相应情绪的中文示例台词，不写“用某语气说”的操作指令。\n风格列表：${styles.join(', ')}\n台词：${text}`;
  const result = parseJson(await ctx.generateRaw({ prompt, systemPrompt: '你是语音导演，只返回一个 JSON 对象。', responseLength: 180 }));
  assertActive(operation); if (!styles.includes(result.style)) throw new Error('LLM 返回了不存在的风格，请手动选择');
  dialogOptions = normalizeOptions({ ...readFields(dialog, dialogOptions), style: result.style, styleWeight: result.style_weight, assistText: cleanText(result.assist_text).slice(0, 160) });
  renderRoot(dialog, dialogOptions); setStatus(`已选择 ${result.style}，仍可手动调整`);
}

async function speak() {
  const operation = startOperation();
  try {
    if (!Object.keys(models).length) await refreshModels({ announce: false });
    assertActive(operation); dialogOptions = syncVoice(readFields(dialog, dialogOptions), models);
    if (dialogOptions.autoEmotion) await analyze(operation);
    assertActive(operation); const text = cleanText(dialog.querySelector('[data-text]').value);
    if (!text || !dialogOptions.modelName || !dialogOptions.speakerName || !dialogOptions.style) throw new Error('请填写台词并选择音色、说话人和风格');
    const options = normalizeOptions(dialogOptions), chunks = splitText(text, Math.min(settings.chunkLength, capabilities.text_limit || 100));
    const base = endpoint(), caps = { ...capabilities };
    const task = async () => {
      assertActive(operation); const blobs = [];
      for (let i = 0; i < chunks.length; i++) {
        assertActive(operation); if (base !== endpoint()) throw new Error('接口已切换，请重新生成'); setStatus(`正在合成 ${i + 1}/${chunks.length}…`);
        const params = voiceParams(chunks[i], options, caps), key = `${base}|${params}`; let blob = cache.get(key);
        if (!blob) {
          blob = await request(`/voice?${params}`, { method: 'POST', signal: operation.controller.signal }, async response => {
            if (!response.headers.get('content-type')?.includes('audio/')) throw new Error('接口未返回音频'); return response.blob();
          });
          cache.set(key, blob); while (cache.size > 30) cache.delete(cache.keys().next().value);
        }
        blobs.push(blob);
      }
      assertActive(operation); const blob = await mergeWavs(blobs, options.splitInterval); assertActive(operation);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = URL.createObjectURL(blob); audioPlayer.src = audioUrl; audioPlayer.volume = settings.volume;
      const download = dialog.querySelector('[data-download]'); download.href = audioUrl; download.download = `${options.modelName}-${Date.now()}.wav`; download.hidden = false;
      setStatus('合成完成，可重复播放或下载 WAV');
      try { await audioPlayer.play(); } catch (error) {
        if (error.name === 'NotAllowedError') setStatus('合成完成，请点击播放器播放'); else throw error;
      }
    };
    const next = queue.then(task, task); queue = next.catch(() => {}); await next;
  } finally { if (activeOperation === operation) activeOperation = null; }
}

function addMessageButton(id) {
  const message = context()?.chat?.[Number(id)]; if (!message || message.is_user || message.is_system) return;
  const element = document.querySelector(`#chat .mes[mesid="${CSS.escape(String(id))}"]`);
  const controls = element?.querySelector('.extraMesButtons') || element?.querySelector('.mes_buttons');
  if (!controls || controls.querySelector('.sbvp-message-button')) return;
  const button = document.createElement('div'); button.className = 'mes_button fa-solid fa-volume-high sbvp-message-button';
  button.title = '选择音色并朗读台词'; button.setAttribute('role', 'button'); button.tabIndex = 0; controls.append(button);
}

function reconcile() { document.querySelectorAll('#chat .mes[mesid]').forEach(element => addMessageButton(element.getAttribute('mesid'))); }

function bindChat() {
  const chat = document.getElementById('chat'); if (!chat) return;
  const openMessage = event => {
    const button = event.target.closest('.sbvp-message-button'); if (!button) return;
    if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
    event.preventDefault(); const message = context()?.chat?.[Number(button.closest('.mes').getAttribute('mesid'))];
    if (message) openDialog(extractDialogue(message.mes), message);
  };
  chat.addEventListener('click', openMessage); chat.addEventListener('keydown', openMessage);
  selectionButton = document.createElement('button'); selectionButton.id = 'sbvp-selection-button';
  selectionButton.className = 'fa-solid fa-volume-high'; selectionButton.title = '朗读选中台词'; selectionButton.hidden = true; document.body.append(selectionButton);
  selectionButton.addEventListener('pointerdown', event => event.preventDefault());
  selectionButton.addEventListener('click', () => { openDialog(selectionButton.dataset.text, context()?.chat?.[Number(selectionButton.dataset.message)]); selectionButton.hidden = true; });
  document.addEventListener('selectionchange', () => requestAnimationFrame(() => {
    const selection = getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0) : null, parent = range?.commonAncestorContainer;
    const element = (parent?.nodeType === 1 ? parent : parent?.parentElement)?.closest?.('#chat .mes[mesid]');
    const message = context()?.chat?.[Number(element?.getAttribute('mesid'))], text = cleanText(selection?.toString());
    if (!element || !message || message.is_user || message.is_system || !text) { selectionButton.hidden = true; return; }
    const rect = range.getBoundingClientRect(); selectionButton.dataset.text = text; selectionButton.dataset.message = element.getAttribute('mesid');
    selectionButton.style.left = `${Math.max(8, Math.min(innerWidth - 52, rect.right - 38)) + scrollX}px`;
    selectionButton.style.top = `${Math.max(8, rect.top + scrollY - 44)}px`; selectionButton.hidden = false;
  }));
  let scheduled = false;
  new MutationObserver(() => { if (scheduled) return; scheduled = true; requestAnimationFrame(() => { scheduled = false; reconcile(); }); }).observe(chat, { childList: true, subtree: true });
}

async function init() {
  const ctx = context(); if (!ctx?.extensionSettings) return;
  ctx.extensionSettings[KEY] ||= {}; settings = ctx.extensionSettings[KEY];
  Object.assign(settings, { ...defaults, ...settings, ...normalizeOptions(settings) });
  if (!settings.bindings || typeof settings.bindings !== 'object') settings.bindings = {};
  settings.chunkLength = Math.max(20, Math.min(500, Number(settings.chunkLength) || 90));
  settings.volume = Math.max(0, Math.min(1, Number(settings.volume) || 0));
  createSettingsPanel(); createDialog(); bindChat(); reconcile();
  const { eventSource, eventTypes } = ctx;
  if (eventSource && eventTypes) {
    for (const event of ['CHARACTER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED']) if (eventTypes[event]) eventSource.on(eventTypes[event], addMessageButton);
    if (eventTypes.CHAT_CHANGED) eventSource.on(eventTypes.CHAT_CHANGED, () => { stop(); if (dialog.open) dialog.close(); reconcile(); });
  }
  try { await refreshModels({ announce: false }); } catch (error) { console.info('[Style-Bert Voice Picker]', error.message); }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
