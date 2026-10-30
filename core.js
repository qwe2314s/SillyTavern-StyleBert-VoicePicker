export const SYNTH_DEFAULTS = Object.freeze({
  modelName: '', speakerName: '', style: '', checkpoint: '', language: 'ZH',
  styleWeight: 1, length: 1, sdpRatio: 0.2, noise: 0.6, noiseW: 0.8,
  autoSplit: true, splitInterval: 0.5, pitchScale: 1, intonationScale: 1,
  autoEmotion: false, useAssistText: false, assistText: '', assistWeight: 0.3,
});

export const NUMBER_SETTINGS = {
  styleWeight: [0, 3, 0.1], length: [0.5, 2, 0.05], sdpRatio: [0, 1, 0.1],
  noise: [0.1, 2, 0.1], noiseW: [0.1, 2, 0.1], splitInterval: [0, 2, 0.1],
  pitchScale: [0.8, 1.5, 0.05], intonationScale: [0, 2, 0.1], assistWeight: [0, 1, 0.1],
};

export function normalizeOptions(input = {}) {
  const result = { ...SYNTH_DEFAULTS };
  for (const key of Object.keys(result)) {
    if (typeof result[key] === 'string') result[key] = String(input[key] ?? result[key]);
    if (typeof result[key] === 'boolean') result[key] = input[key] === undefined ? result[key] : Boolean(input[key]);
  }
  for (const [key, [min, max]] of Object.entries(NUMBER_SETTINGS)) {
    const value = input[key] === '' ? NaN : Number(input[key] ?? result[key]);
    result[key] = Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : SYNTH_DEFAULTS[key];
  }
  if (!['ZH', 'JP', 'EN'].includes(result.language)) result.language = 'ZH';
  result.assistText = result.assistText.trim().slice(0, 160);
  return result;
}

export function normalizeModels(payload) {
  return Object.fromEntries(Object.entries(payload || {}).filter(([, info]) => info && typeof info === 'object').map(([id, info]) => {
    const path = String(info.config_path || '').replaceAll('\\', '/').split('/');
    return [id, { ...info, model_id: id, model_name: info.model_name || path.at(-2) || `模型 ${id}` }];
  }));
}

export function syncVoice(options, models) {
  const value = normalizeOptions(options);
  const all = Object.values(models);
  const model = all.find(item => item.model_name === value.modelName)
    || all.find(item => item.model_name === 'fll_emotion') || all[0];
  if (!model) return value;
  value.modelName = model.model_name;
  const speakers = Object.keys(model.spk2id || {});
  const styles = Object.keys(model.style2id || {});
  if (!speakers.includes(value.speakerName)) value.speakerName = speakers[0] || '';
  if (!styles.includes(value.style)) value.style = styles.find(name => name === 'Normal') || styles.find(name => name === 'Neutral') || styles[0] || '';
  const checkpoints = model.checkpoints || [];
  if (!checkpoints.includes(value.checkpoint)) value.checkpoint = model.default_checkpoint || checkpoints[0] || '';
  return value;
}

export function cleanText(value) {
  return String(value || '').replace(/```[\s\S]*?```/g, '').replace(/[*_~`#>|]/g, '')
    .replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function extractDialogue(value) {
  const source = String(value || '');
  const quoted = [...source.matchAll(/“([^”]+)”|「([^」]+)」|『([^』]+)』/gs)]
    .map(match => cleanText(match.slice(1).find(Boolean))).filter(Boolean);
  return quoted.length ? quoted.join('\n') : cleanText(source);
}

export function splitText(value, maximum = 90) {
  const chars = Array.from(cleanText(value));
  const limit = Math.max(1, Math.floor(Number(maximum) || 90));
  const result = [];
  while (chars.length) {
    let count = Math.min(limit, chars.length);
    if (chars.length > limit) {
      for (let i = count - 1; i >= Math.floor(count * 0.45); i--) {
        if (/[。！？；，.!?;,\n]/u.test(chars[i])) { count = i + 1; break; }
      }
    }
    const text = chars.splice(0, count).join('').trim();
    if (text) result.push(text);
  }
  return result;
}

export function voiceParams(text, options, capabilities = {}) {
  const o = normalizeOptions(options);
  const params = new URLSearchParams({ text, model_name: o.modelName, speaker_name: o.speakerName,
    style: o.style, style_weight: String(o.styleWeight), language: o.language, length: String(o.length),
    sdp_ratio: String(o.sdpRatio), noise: String(o.noise), noisew: String(o.noiseW),
    auto_split: String(o.autoSplit), split_interval: String(o.splitInterval) });
  if (o.useAssistText && o.assistText) {
    params.set('assist_text', o.assistText); params.set('assist_text_weight', String(o.assistWeight));
  }
  if (capabilities.parameters?.includes('pitch_scale')) params.set('pitch_scale', String(o.pitchScale));
  if (capabilities.parameters?.includes('intonation_scale')) params.set('intonation_scale', String(o.intonationScale));
  if (capabilities.checkpoint_selection && o.checkpoint) params.set('checkpoint', o.checkpoint);
  return params;
}

export function characterIdentity(context, message) {
  if (message?.is_user || message?.is_system) return null;
  let character;
  if (message) {
    const avatar = message.original_avatar;
    character = context?.characters?.find(item => avatar && item.avatar === avatar);
    if (!character && message.name) {
      const matching = context?.characters?.filter(item => item.name === message.name) || [];
      if (matching.length === 1) character = matching[0];
    }
  }
  if (!character && !context?.groupId) character = context?.characters?.[context.characterId];
  return character?.avatar ? { key: `avatar:${character.avatar}`, name: character.name || message?.name || '当前角色' } : null;
}

export async function fetchWithTimeout(url, options = {}, parse = response => response.json(), timeoutMs = 120000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const body = await response.json();
        detail = Array.isArray(body.detail) ? body.detail.map(item => item.msg).join('; ') : body.detail || body.error || detail;
      } catch { /* A proxy can return non-JSON. */ }
      const error = new Error(String(detail)); error.status = response.status; throw error;
    }
    return await parse(response);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(options.signal?.aborted ? '操作已取消' : '语音接口超时，请检查服务是否正在加载模型');
    if (error instanceof TypeError) throw new Error('无法连接语音接口。请确认配套 API 已启动，并检查地址、CORS、HTTPS 和手机访问方式。');
    throw error;
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
  }
}

function wavData(buffer) {
  const view = new DataView(buffer);
  const word = offset => String.fromCharCode(...new Uint8Array(buffer, offset, 4));
  if (buffer.byteLength < 44 || word(0) !== 'RIFF' || word(8) !== 'WAVE') throw new Error('接口返回了无效 WAV');
  let format, data;
  for (let offset = 12; offset + 8 <= buffer.byteLength;) {
    const size = view.getUint32(offset + 4, true);
    if (offset + 8 + size > buffer.byteLength) throw new Error('WAV 文件不完整');
    if (word(offset) === 'fmt ') format = new Uint8Array(buffer.slice(offset + 8, offset + 8 + size));
    if (word(offset) === 'data') data = new Uint8Array(buffer.slice(offset + 8, offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  if (!format || format.length < 16 || !data) throw new Error('WAV 缺少格式或音频数据');
  const fmt = new DataView(format.buffer);
  if (fmt.getUint16(0, true) !== 1 || fmt.getUint16(14, true) !== 16) throw new Error('合并朗读需要 PCM 16 位 WAV');
  return { format, data, rate: fmt.getUint32(4, true), alignment: fmt.getUint16(12, true) };
}

export async function mergeWavs(blobs, interval = 0) {
  if (!blobs.length) throw new Error('没有生成音频');
  const waves = await Promise.all(blobs.map(async blob => wavData(await blob.arrayBuffer())));
  const first = waves[0];
  for (const item of waves) {
    if (String(item.format) !== String(first.format)) throw new Error('分段音频格式不一致，无法合并');
  }
  const gap = Math.round(first.rate * Math.max(0, Math.min(2, Number(interval) || 0))) * first.alignment;
  const bytes = waves.reduce((sum, item) => sum + item.data.length, 0) + gap * (waves.length - 1);
  const result = new ArrayBuffer(28 + first.format.length + bytes);
  const view = new DataView(result); const data = new Uint8Array(result);
  const put = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  put(0, 'RIFF'); view.setUint32(4, result.byteLength - 8, true); put(8, 'WAVE'); put(12, 'fmt ');
  view.setUint32(16, first.format.length, true); data.set(first.format, 20);
  const start = 20 + first.format.length; put(start, 'data'); view.setUint32(start + 4, bytes, true);
  let offset = start + 8;
  waves.forEach((item, i) => { data.set(item.data, offset); offset += item.data.length; if (i < waves.length - 1) offset += gap; });
  return new Blob([result], { type: 'audio/wav' });
}
