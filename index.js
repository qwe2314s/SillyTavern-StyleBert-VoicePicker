const EXTENSION_KEY = 'styleBertVoicePicker';
const LOG_PREFIX = '[Style-Bert Voice Picker]';
const MESSAGE_BUTTON_CLASS = 'sbvp-message-button';
const CACHE_LIMIT = 30;

const defaults = {
  apiUrl: deriveApiUrl(),
  modelName: '',
  speakerName: '',
  style: '',
  language: 'ZH',
  autoEmotion: true,
  useAssistText: true,
  chunkLength: 90,
  volume: 1,
  length: 1,
  styleWeight: 1,
};

let settings;
let models = {};
let activeText = '';
let synthQueue = Promise.resolve();
let selectionButton;
let dialog;
let audioPlayer;
let finishPlayback;
let retainedAudioUrl;
let activeOperation;
let playbackCancelled = false;
let refreshSequence = 0;
const audioCache = new Map();

function deriveApiUrl() {
  const protocol = location.protocol === 'https:' ? 'https:' : 'http:';
  return `${protocol}//${location.hostname}:5000`;
}

function notify(type, message) {
  globalThis.toastr?.[type]?.(message);
}

function normalizeApiUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function escapeHtml(value) {
  const element = document.createElement('div');
  element.textContent = String(value ?? '');
  return element.innerHTML;
}

function getContext() {
  return globalThis.SillyTavern?.getContext?.();
}

function saveSettings() {
  getContext()?.saveSettingsDebounced?.();
}

function selectedModel() {
  return Object.entries(models).find(([, model]) => model.model_name === settings.modelName)?.[1]
    ?? Object.values(models).find((model) => model.model_name === settings.modelName)
    ?? null;
}

function modelNameFromInfo(info) {
  const configPath = String(info.config_path || '').replaceAll('\\', '/');
  const parts = configPath.split('/');
  return parts.length >= 2 ? parts.at(-2) : configPath || 'Model';
}

function normalizedModels(payload) {
  return Object.fromEntries(Object.entries(payload || {}).map(([id, info]) => [id, {
    ...info,
    model_id: id,
    model_name: modelNameFromInfo(info),
  }]));
}

async function apiFetch(path, options = {}) {
  const apiUrl = normalizeApiUrl(settings.apiUrl);
  if (!apiUrl) throw new Error('请先填写 Style-Bert-VITS2 API 地址');
  if (location.protocol === 'https:' && apiUrl.startsWith('http:')) {
    throw new Error('当前酒馆使用 HTTPS，浏览器会拦截 HTTP TTS 请求。请让两个服务使用相同协议');
  }

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), 60000);
  const signal = options.signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : options.signal || timeoutController.signal;
  let response;
  try {
    response = await fetch(`${apiUrl}${path}`, { ...options, signal });
  } catch (error) {
    if (signal.aborted) throw new Error(options.signal?.aborted ? '操作已取消' : 'Style-Bert-VITS2 请求超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      detail = body.detail?.map?.((item) => item.msg).join('; ') || body.detail || detail;
    } catch {
      // Keep the HTTP status when an upstream proxy returns non-JSON.
    }
    throw new Error(String(detail));
  }
  return response;
}

async function refreshModels({ rescan = false, announce = true } = {}) {
  const requestId = ++refreshSequence;
  const requestedUrl = normalizeApiUrl(settings.apiUrl);
  const response = await apiFetch(rescan ? '/models/refresh' : '/models/info', {
    method: rescan ? 'POST' : 'GET',
  });
  const result = normalizedModels(await response.json());
  if (requestId !== refreshSequence || requestedUrl !== normalizeApiUrl(settings.apiUrl)) return;
  models = result;
  if (!Object.keys(models).length) throw new Error('API 已连接，但没有发现可用模型');

  if (!Object.values(models).some((model) => model.model_name === settings.modelName)) {
    settings.modelName = Object.values(models)[0].model_name;
  }
  syncDependentDefaults();
  renderModelControls();
  if (rescan) audioCache.clear();
  saveSettings();
  if (announce) notify('success', `已发现 ${Object.keys(models).length} 个模型`);
}

function syncDependentDefaults() {
  const model = selectedModel();
  if (!model) return;
  const speakers = Object.keys(model.spk2id || {});
  const styles = Object.keys(model.style2id || {});
  if (!speakers.includes(settings.speakerName)) settings.speakerName = speakers[0] || '';
  if (!styles.includes(settings.style)) {
    settings.style = styles.find((style) => style.toLowerCase() === 'neutral') || styles[0] || '';
  }
}

function optionsHtml(values, selected) {
  return values.map((value) => `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('');
}

function renderModelControls() {
  const modelNames = Object.values(models).map((model) => model.model_name);
  document.querySelectorAll('[data-sbvp-model]').forEach((select) => {
    select.innerHTML = optionsHtml(modelNames, settings.modelName);
    select.disabled = !modelNames.length;
  });

  const model = selectedModel();
  const speakers = Object.keys(model?.spk2id || {});
  const styles = Object.keys(model?.style2id || {});
  document.querySelectorAll('[data-sbvp-speaker]').forEach((select) => {
    select.innerHTML = optionsHtml(speakers, settings.speakerName);
    select.disabled = !speakers.length;
  });
  document.querySelectorAll('[data-sbvp-style]').forEach((select) => {
    const current = select.closest('#sbvp-dialog') ? (select.value || settings.style) : settings.style;
    select.innerHTML = optionsHtml(styles, styles.includes(current) ? current : settings.style);
    select.disabled = !styles.length;
  });
}

function bindSetting(root, selector, key, parse = (value) => value) {
  const input = root.querySelector(selector);
  if (!input) return;
  if (input.type === 'checkbox') input.checked = Boolean(settings[key]);
  else input.value = settings[key];
  input.addEventListener('change', () => {
    settings[key] = input.type === 'checkbox' ? input.checked : parse(input.value);
    saveSettings();
  });
}

function createSettingsPanel() {
  if (document.getElementById('sbvp-settings')) return;
  const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
  if (!container) return;

  const root = document.createElement('div');
  root.id = 'sbvp-settings';
  root.className = 'extension_container';
  root.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>Style-Bert Voice Picker</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <label>API 地址 <input class="text_pole" data-sbvp-api type="url" placeholder="http://192.168.1.10:5000"></label>
        <div class="sbvp-button-row">
          <button class="menu_button" data-sbvp-test>测试连接</button>
          <button class="menu_button" data-sbvp-refresh>刷新模型</button>
        </div>
        <label>默认模型 <select class="text_pole" data-sbvp-model></select></label>
        <label>默认说话人 <select class="text_pole" data-sbvp-speaker></select></label>
        <label>默认风格 <select class="text_pole" data-sbvp-style></select></label>
        <label>默认语言
          <select class="text_pole" data-sbvp-language><option>ZH</option><option>JP</option><option>EN</option></select>
        </label>
        <label class="checkbox_label"><input data-sbvp-auto-emotion type="checkbox"> <span>让当前 LLM 自动选择情绪</span></label>
        <label class="checkbox_label"><input data-sbvp-assist type="checkbox"> <span>允许 LLM 生成辅助情绪文本</span></label>
        <label>单段字符数 <input class="text_pole" data-sbvp-chunk type="number" min="20" max="100"></label>
        <label>播放音量 <input data-sbvp-volume type="range" min="0" max="1" step="0.05"></label>
        <small>手机访问时，API 地址应使用运行 Style-Bert-VITS2 的电脑局域网 IP。</small>
      </div>
    </div>`;
  container.append(root);

  const apiInput = root.querySelector('[data-sbvp-api]');
  apiInput.value = settings.apiUrl;
  apiInput.addEventListener('change', () => {
    settings.apiUrl = normalizeApiUrl(apiInput.value);
    apiInput.value = settings.apiUrl;
    refreshSequence += 1;
    models = {};
    audioCache.clear();
    renderModelControls();
    saveSettings();
  });
  bindSetting(root, '[data-sbvp-language]', 'language');
  bindSetting(root, '[data-sbvp-auto-emotion]', 'autoEmotion');
  bindSetting(root, '[data-sbvp-assist]', 'useAssistText');
  bindSetting(root, '[data-sbvp-chunk]', 'chunkLength', (value) => Math.max(20, Math.min(100, Number(value) || 90)));
  bindSetting(root, '[data-sbvp-volume]', 'volume', Number);

  root.querySelector('[data-sbvp-model]').addEventListener('change', (event) => {
    settings.modelName = event.target.value;
    syncDependentDefaults();
    renderModelControls();
    saveSettings();
  });
  root.querySelector('[data-sbvp-speaker]').addEventListener('change', (event) => {
    settings.speakerName = event.target.value;
    saveSettings();
  });
  root.querySelector('[data-sbvp-style]').addEventListener('change', (event) => {
    settings.style = event.target.value;
    saveSettings();
  });
  root.querySelector('[data-sbvp-test]').addEventListener('click', () => runBusy(root, () => refreshModels()));
  root.querySelector('[data-sbvp-refresh]').addEventListener('click', () => runBusy(root, () => refreshModels({ rescan: true })));
  renderModelControls();
}

async function runBusy(root, operation) {
  root.classList.add('sbvp-busy');
  try {
    await operation();
  } catch (error) {
    console.error(LOG_PREFIX, error);
    notify('error', error.message || String(error));
  } finally {
    root.classList.remove('sbvp-busy');
  }
}

function createDialog() {
  if (dialog) return;
  dialog = document.createElement('dialog');
  dialog.id = 'sbvp-dialog';
  dialog.innerHTML = `
    <form method="dialog" class="sbvp-dialog-card">
      <div class="sbvp-dialog-header"><b>生成角色语音</b><button class="menu_button" value="cancel" title="关闭">×</button></div>
      <label>台词<textarea class="text_pole" data-sbvp-text rows="5"></textarea></label>
      <div class="sbvp-grid">
        <label>模型<select class="text_pole" data-sbvp-model></select></label>
        <label>说话人<select class="text_pole" data-sbvp-speaker></select></label>
        <label>情绪风格<select class="text_pole" data-sbvp-style></select></label>
        <label>语言<select class="text_pole" data-sbvp-language><option>ZH</option><option>JP</option><option>EN</option></select></label>
        <label>风格强度<input class="text_pole" data-sbvp-weight type="number" min="0" max="3" step="0.1"></label>
        <label>语速（越小越快）<input class="text_pole" data-sbvp-length type="number" min="0.5" max="2" step="0.05"></label>
      </div>
      <label class="checkbox_label"><input data-sbvp-auto-emotion type="checkbox"> <span>自动识别情绪</span></label>
      <label class="checkbox_label"><input data-sbvp-assist type="checkbox"> <span>使用辅助情绪文本</span></label>
      <label>辅助情绪文本（可修改）<textarea class="text_pole" data-sbvp-assist-text rows="2" placeholder="自动识别后生成，可留空"></textarea></label>
      <div class="sbvp-status" data-sbvp-status></div>
      <audio data-sbvp-audio controls preload="none"></audio>
      <div class="sbvp-button-row sbvp-dialog-actions">
        <button class="menu_button" type="button" data-sbvp-analyze>识别情绪</button>
        <button class="menu_button" type="button" data-sbvp-speak>生成并播放</button>
        <button class="menu_button" type="button" data-sbvp-stop>停止</button>
      </div>
    </form>`;
  document.body.append(dialog);
  audioPlayer = dialog.querySelector('[data-sbvp-audio]');

  dialog.querySelector('[data-sbvp-model]').addEventListener('change', (event) => {
    settings.modelName = event.target.value;
    syncDependentDefaults();
    renderModelControls();
  });
  dialog.querySelector('[data-sbvp-speaker]').addEventListener('change', (event) => {
    settings.speakerName = event.target.value;
  });
  dialog.querySelector('[data-sbvp-analyze]').addEventListener('click', () => runDialogTask(analyzeEmotion));
  dialog.querySelector('[data-sbvp-speak]').addEventListener('click', () => runDialogTask(speakFromDialog));
  dialog.querySelector('[data-sbvp-stop]').addEventListener('click', stopOperation);
  dialog.addEventListener('cancel', stopOperation);
  dialog.addEventListener('close', stopOperation);
}

function openDialog(text) {
  activeText = cleanText(text);
  if (!activeText) {
    notify('warning', '没有可朗读的文本');
    return;
  }
  createDialog();
  dialog.querySelector('[data-sbvp-text]').value = activeText;
  dialog.querySelector('[data-sbvp-language]').value = settings.language;
  dialog.querySelector('[data-sbvp-weight]').value = settings.styleWeight;
  dialog.querySelector('[data-sbvp-length]').value = settings.length;
  dialog.querySelector('[data-sbvp-auto-emotion]').checked = settings.autoEmotion;
  dialog.querySelector('[data-sbvp-assist]').checked = settings.useAssistText;
  dialog.querySelector('[data-sbvp-assist-text]').value = '';
  dialog.querySelector('[data-sbvp-status]').textContent = '';
  renderModelControls();
  dialog.showModal();
}

async function runDialogTask(task) {
  dialog.classList.add('sbvp-busy');
  try {
    await task();
  } catch (error) {
    console.error(LOG_PREFIX, error);
    setDialogStatus(error.message || String(error), true);
    notify('error', error.message || String(error));
  } finally {
    dialog.classList.remove('sbvp-busy');
  }
}

function setDialogStatus(message, isError = false) {
  const status = dialog.querySelector('[data-sbvp-status]');
  status.textContent = message;
  status.classList.toggle('sbvp-error', isError);
}

function cleanText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[*_~`#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDialogue(text) {
  const source = String(text || '');
  const matches = [...source.matchAll(/[“「『](.*?)[”」』]|“([^”]+)”|「([^」]+)」|『([^』]+)』/gs)]
    .map((match) => cleanText(match.slice(1).find(Boolean)))
    .filter(Boolean);
  return matches.length ? matches.join('\n') : cleanText(source);
}

function parseJsonResult(value) {
  const source = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? source.slice(start, end + 1) : source);
}

async function analyzeEmotion() {
  const text = cleanText(dialog.querySelector('[data-sbvp-text]').value);
  const styleSelect = dialog.querySelector('[data-sbvp-style]');
  const styles = Object.keys(selectedModel()?.style2id || {});
  if (!styles.length) throw new Error('请先连接 API 并选择模型');
  const context = getContext();
  if (!context?.generateRaw) throw new Error('当前 SillyTavern 不支持 generateRaw');

  setDialogStatus('正在使用当前 LLM 判断情绪…');
  const schema = {
    name: 'style_bert_emotion',
    description: 'Select one available Style-Bert-VITS2 style for the quoted dialogue.',
    strict: true,
    value: {
      type: 'object',
      properties: {
        style: { type: 'string', enum: styles },
        style_weight: { type: 'number', minimum: 0, maximum: 3 },
        assist_text: { type: 'string' },
      },
      required: ['style', 'style_weight', 'assist_text'],
      additionalProperties: false,
    },
  };
  const prompt = `分析以下角色台词的情绪。style 必须且只能从给定列表选择；style_weight 建议 0.5 到 2；assist_text 用简短中文描述语气，不要复述台词。\n\n可选 style：${styles.join(', ')}\n\n台词：${text}`;
  let result;
  try {
    result = parseJsonResult(await context.generateRaw({
      prompt,
      systemPrompt: '你是语音导演。只返回符合 JSON Schema 的对象。',
      responseLength: 180,
      jsonSchema: schema,
    }));
  } catch (structuredError) {
    console.warn(LOG_PREFIX, 'Structured generation failed, retrying plain JSON', structuredError);
    result = parseJsonResult(await context.generateRaw({
      prompt: `${prompt}\n只返回 JSON，例如 {"style":"${styles[0]}","style_weight":1,"assist_text":"平静而自然"}`,
      systemPrompt: '只返回一个 JSON 对象，不要使用 Markdown。',
      responseLength: 180,
    }));
  }

  if (!styles.includes(result.style)) throw new Error('LLM 返回了模型不存在的 style');
  styleSelect.value = result.style;
  const parsedWeight = Number(result.style_weight);
  dialog.querySelector('[data-sbvp-weight]').value = Math.max(0, Math.min(3, Number.isFinite(parsedWeight) ? parsedWeight : 1));
  dialog.querySelector('[data-sbvp-assist-text]').value = cleanText(result.assist_text).slice(0, 160);
  setDialogStatus(`已选择情绪：${result.style}`);
  return result;
}

function splitText(text, maxLength) {
  const normalized = cleanText(text);
  if (normalized.length <= maxLength) return [normalized];
  const chunks = [];
  let remaining = normalized;
  while (remaining.length) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    const window = remaining.slice(0, maxLength + 1);
    const punctuation = Math.max(...['。', '！', '？', '；', '，', '.', '!', '?', ';', ','].map((mark) => window.lastIndexOf(mark)));
    const cut = punctuation >= Math.floor(maxLength * 0.45) ? punctuation + 1 : maxLength;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  return chunks.filter(Boolean);
}

function hashKey(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function cacheAudio(key, blob) {
  if (audioCache.has(key)) audioCache.delete(key);
  audioCache.set(key, blob);
  while (audioCache.size > CACHE_LIMIT) audioCache.delete(audioCache.keys().next().value);
}

async function synthesizeChunk(text, options, signal) {
  const params = new URLSearchParams({
    text,
    model_name: options.modelName,
    speaker_name: options.speakerName,
    style: options.style,
    style_weight: String(options.styleWeight),
    length: String(options.length),
    language: options.language,
    auto_split: 'false',
  });
  if (options.assistText) params.set('assist_text', options.assistText);
  const cacheKey = hashKey(`${settings.apiUrl}|${params}`);
  if (audioCache.has(cacheKey)) return audioCache.get(cacheKey);
  const response = await apiFetch(`/voice?${params}`, { method: 'POST', signal });
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('audio/')) throw new Error('TTS API 未返回音频');
  const blob = await response.blob();
  cacheAudio(cacheKey, blob);
  return blob;
}

function enqueueSynthesis(operation) {
  const next = synthQueue.then(operation, operation);
  synthQueue = next.catch(() => {});
  return next;
}

async function speakFromDialog() {
  if (!Object.keys(models).length) await refreshModels({ announce: false });
  if (dialog.querySelector('[data-sbvp-auto-emotion]').checked) await analyzeEmotion();

  const text = cleanText(dialog.querySelector('[data-sbvp-text]').value);
  const rawWeight = Number(dialog.querySelector('[data-sbvp-weight]').value);
  const rawLength = Number(dialog.querySelector('[data-sbvp-length]').value);
  const options = {
    modelName: dialog.querySelector('[data-sbvp-model]').value,
    speakerName: dialog.querySelector('[data-sbvp-speaker]').value,
    style: dialog.querySelector('[data-sbvp-style]').value,
    styleWeight: Math.max(0, Math.min(3, Number.isFinite(rawWeight) ? rawWeight : 1)),
    length: Math.max(0.5, Math.min(2, Number.isFinite(rawLength) ? rawLength : 1)),
    language: dialog.querySelector('[data-sbvp-language]').value,
    assistText: dialog.querySelector('[data-sbvp-assist]').checked
      ? cleanText(dialog.querySelector('[data-sbvp-assist-text]').value).slice(0, 160)
      : '',
  };
  if (!text || !options.modelName || !options.speakerName || !options.style) throw new Error('台词、模型、说话人和情绪不能为空');

  Object.assign(settings, {
    modelName: options.modelName,
    speakerName: options.speakerName,
    style: options.style,
    styleWeight: options.styleWeight,
    length: options.length,
    language: options.language,
    autoEmotion: dialog.querySelector('[data-sbvp-auto-emotion]').checked,
    useAssistText: dialog.querySelector('[data-sbvp-assist]').checked,
  });
  saveSettings();

  const chunks = splitText(text, Math.max(20, Math.min(100, settings.chunkLength)));
  const operation = { controller: new AbortController(), cancelled: false };
  if (activeOperation) {
    activeOperation.cancelled = true;
    activeOperation.controller.abort();
  }
  activeOperation = operation;
  setDialogStatus(`已加入队列，共 ${chunks.length} 段`);
  await enqueueSynthesis(async () => {
    if (operation.cancelled) throw new Error('操作已取消');
    const blobs = [];
    for (let index = 0; index < chunks.length; index += 1) {
      if (operation.cancelled) throw new Error('操作已取消');
      setDialogStatus(`正在合成 ${index + 1}/${chunks.length}…`);
      blobs.push(await synthesizeChunk(chunks[index], options, operation.controller.signal));
    }
    if (operation.cancelled) throw new Error('操作已取消');
    setDialogStatus('合成完成，正在播放');
    await playBlobs(blobs, operation);
    if (!operation.cancelled) setDialogStatus('播放完成');
  }).finally(() => {
    if (activeOperation === operation) activeOperation = null;
  });
}

async function playBlobs(blobs, operation) {
  stopAudio();
  playbackCancelled = false;
  for (const blob of blobs) {
    if (operation.cancelled || playbackCancelled) return;
    const url = URL.createObjectURL(blob);
    if (retainedAudioUrl) URL.revokeObjectURL(retainedAudioUrl);
    retainedAudioUrl = url;
    audioPlayer.src = url;
    audioPlayer.volume = settings.volume;
    const ended = new Promise((resolve, reject) => {
      finishPlayback = resolve;
      audioPlayer.onended = () => {
        finishPlayback = null;
        resolve();
      };
      audioPlayer.onerror = () => {
        finishPlayback = null;
        reject(new Error('音频播放失败'));
      };
    });
    try {
      await audioPlayer.play();
    } catch (error) {
      if (error.name === 'NotAllowedError') {
        setDialogStatus('浏览器阻止了自动播放，请点击音频控件播放');
      } else {
        throw error;
      }
    }
    await ended;
    if (operation.cancelled || playbackCancelled) return;
    audioPlayer.removeAttribute('src');
    URL.revokeObjectURL(url);
    retainedAudioUrl = null;
  }
}

function stopAudio() {
  if (!audioPlayer) return;
  playbackCancelled = true;
  audioPlayer.pause();
  audioPlayer.currentTime = 0;
  finishPlayback?.();
  finishPlayback = null;
}

function stopOperation() {
  if (activeOperation) {
    activeOperation.cancelled = true;
    activeOperation.controller.abort();
  }
  stopAudio();
}

function addMessageControl(messageId) {
  const id = Number(messageId);
  const message = getContext()?.chat?.[id];
  if (!message || message.is_user || message.is_system) return;
  const element = document.querySelector(`#chat .mes[mesid="${CSS.escape(String(id))}"]`);
  const controls = element?.querySelector('.extraMesButtons') ?? element?.querySelector('.mes_buttons');
  if (!controls || controls.querySelector(`.${MESSAGE_BUTTON_CLASS}`)) return;
  const button = document.createElement('div');
  button.className = `mes_button fa-solid fa-volume-high ${MESSAGE_BUTTON_CLASS}`;
  button.title = '选择台词并生成语音';
  controls.append(button);
}

function reconcileMessageControls() {
  document.querySelectorAll('#chat .mes[mesid]').forEach((element) => addMessageControl(element.getAttribute('mesid')));
}

function createSelectionButton() {
  selectionButton = document.createElement('button');
  selectionButton.id = 'sbvp-selection-button';
  selectionButton.type = 'button';
  selectionButton.className = 'fa-solid fa-volume-high';
  selectionButton.title = '朗读选中文字';
  selectionButton.hidden = true;
  document.body.append(selectionButton);
  selectionButton.addEventListener('pointerdown', (event) => event.preventDefault());
  selectionButton.addEventListener('click', () => {
    const text = selectionButton.dataset.text;
    selectionButton.hidden = true;
    openDialog(text);
  });
}

function updateSelectionButton() {
  const selection = globalThis.getSelection?.();
  const text = cleanText(selection?.toString());
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const container = range?.commonAncestorContainer?.parentElement ?? range?.commonAncestorContainer;
  if (!text || !container?.closest?.('#chat .mes:not([is_user="true"])')) {
    selectionButton.hidden = true;
    return;
  }
  const rect = range.getBoundingClientRect();
  selectionButton.dataset.text = text;
  selectionButton.style.left = `${Math.min(innerWidth - 52, Math.max(8, rect.right + scrollX - 38))}px`;
  selectionButton.style.top = `${Math.max(8, rect.top + scrollY - 44)}px`;
  selectionButton.hidden = false;
}

function bindChatControls() {
  const chat = document.getElementById('chat');
  if (!chat) return;
  chat.addEventListener('click', (event) => {
    const button = event.target.closest(`.${MESSAGE_BUTTON_CLASS}`);
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const messageId = Number(button.closest('.mes[mesid]')?.getAttribute('mesid'));
    const message = getContext()?.chat?.[messageId];
    if (!message) return notify('warning', '消息已不存在');
    openDialog(extractDialogue(message.mes));
  });
  document.addEventListener('selectionchange', () => requestAnimationFrame(updateSelectionButton));
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      reconcileMessageControls();
    });
  }).observe(chat, { childList: true, subtree: true });
}

function bindEvents() {
  const { eventSource, eventTypes } = getContext() || {};
  if (!eventSource || !eventTypes) return;
  eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, addMessageControl);
  eventSource.on(eventTypes.MESSAGE_UPDATED, addMessageControl);
  eventSource.on(eventTypes.MESSAGE_SWIPED, addMessageControl);
  eventSource.on(eventTypes.MORE_MESSAGES_LOADED, reconcileMessageControls);
  eventSource.on(eventTypes.CHAT_CHANGED, () => queueMicrotask(reconcileMessageControls));
}

async function init() {
  const context = getContext();
  if (!context) {
    console.error(LOG_PREFIX, 'SillyTavern context is unavailable');
    return;
  }
  context.extensionSettings[EXTENSION_KEY] ??= {};
  settings = context.extensionSettings[EXTENSION_KEY];
  Object.assign(settings, { ...defaults, ...settings });
  settings.apiUrl = normalizeApiUrl(settings.apiUrl || defaults.apiUrl);
  createSettingsPanel();
  createDialog();
  createSelectionButton();
  bindChatControls();
  bindEvents();
  reconcileMessageControls();
  try {
    await refreshModels({ announce: false });
  } catch (error) {
    console.info(LOG_PREFIX, 'API not ready during startup:', error.message);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
