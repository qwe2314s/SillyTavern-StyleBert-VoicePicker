import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptions, normalizeModels, syncVoice, voiceParams, splitText, extractDialogue,
  characterIdentity, fetchWithTimeout, mergeWavs } from '../core.js';
import { localApi, relay } from '../server-plugin/index.mjs';
import { EventEmitter } from 'node:events';

const catalog = normalizeModels({ 0: { config_path: 'E:\\model_assets\\fll_emotion\\config.json',
  spk2id: { fll_emotion: 0 }, style2id: { Neutral: 0, Normal: 1, Battle: 2 },
  checkpoints: ['voice_s15000.safetensors'], default_checkpoint: 'voice_s15000.safetensors' } });

test('uses stable model names and prefers the trained Normal voice', () => {
  const result = syncVoice({ modelName: 'removed', style: 'unknown', speakerName: 'bad' }, catalog);
  assert.equal(result.modelName, 'fll_emotion'); assert.equal(result.style, 'Normal');
  assert.equal(result.speakerName, 'fll_emotion'); assert.equal(result.checkpoint, 'voice_s15000.safetensors');
});

test('all synthesis controls map to the API; unsupported controls are omitted', () => {
  const input = { modelName: 'fll_emotion', speakerName: 'fll_emotion', style: 'Battle',
    styleWeight: 1.4, sdpRatio: .4, noise: .5, noiseW: .7, length: .9, autoSplit: false,
    splitInterval: .3, pitchScale: 1.1, intonationScale: 1.2, useAssistText: true,
    assistText: '小心！', assistWeight: .2, checkpoint: 'voice_s15000.safetensors' };
  const ordinary = voiceParams('你好 & 再见？', input);
  assert.equal(ordinary.get('text'), '你好 & 再见？'); assert.equal(ordinary.get('sdp_ratio'), '0.4');
  assert.equal(ordinary.get('noise'), '0.5'); assert.equal(ordinary.get('noisew'), '0.7');
  assert.equal(ordinary.get('auto_split'), 'false'); assert.equal(ordinary.get('assist_text_weight'), '0.2');
  assert.equal(ordinary.has('pitch_scale'), false); assert.equal(ordinary.has('checkpoint'), false);
  const bridge = voiceParams('你好', input, { parameters: ['pitch_scale', 'intonation_scale'], checkpoint_selection: true });
  assert.equal(bridge.get('pitch_scale'), '1.1'); assert.equal(bridge.get('intonation_scale'), '1.2');
  assert.equal(bridge.get('checkpoint'), input.checkpoint);
  assert.notEqual(voiceParams('你好', input).toString(), voiceParams('你好', { ...input, noise: .4 }).toString());
});

test('invalid numeric input falls back or clamps and assistance is opt-in', () => {
  const value = normalizeOptions({ length: -100, noise: Infinity, styleWeight: 'bad', pitchScale: 50 });
  assert.equal(value.length, .5); assert.equal(value.noise, .6); assert.equal(value.styleWeight, 1); assert.equal(value.pitchScale, 1.5);
  assert.equal(voiceParams('台词', { assistText: '提示', useAssistText: false }).has('assist_text'), false);
});

test('chunks Unicode by code point without losing newlines or splitting emoji', () => {
  const text = '一段台词。\n还有第二段😀😀😀，以及最后的内容。';
  const chunks = splitText(text, 8);
  assert(chunks.every(chunk => Array.from(chunk).length <= 8));
  assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
  assert.equal(extractDialogue('她说：“你好。”随后又说「再见。」'), '你好。\n再见。');
});

test('character bindings use avatar identity and do not confuse group speakers', () => {
  const ctx = { characterId: 0, characters: [{ name: 'A', avatar: 'A.png' }, { name: 'B', avatar: 'B.png' }] };
  assert.equal(characterIdentity(ctx)?.key, 'avatar:A.png');
  assert.equal(characterIdentity({ ...ctx, groupId: 'group' }, { name: 'B' })?.key, 'avatar:B.png');
  assert.equal(characterIdentity({ ...ctx, groupId: 'group' }, { name: 'unknown' }), null);
  assert.equal(characterIdentity(ctx, { is_user: true }), null);
});

function wav(sample = 42) {
  const buffer = new ArrayBuffer(48), view = new DataView(buffer), data = new Uint8Array(buffer);
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) [...text].forEach((c, i) => data[offset + i] = c.charCodeAt(0));
  view.setUint32(4, 40, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 100, true); view.setUint32(28, 200, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, 4, true);
  view.setInt16(44, sample, true); view.setInt16(46, sample, true);
  return new Blob([buffer], { type: 'audio/wav' });
}

test('merged WAV is replayable PCM with a valid header and inserted pause', async () => {
  const result = await mergeWavs([wav(42), wav(99)], .1), buffer = await result.arrayBuffer(), view = new DataView(buffer);
  assert.equal(buffer.byteLength, 72); assert.equal(view.getUint32(40, true), 28);
  assert.equal(view.getInt16(44, true), 42); assert.equal(view.getInt16(68, true), 99);
  await assert.rejects(mergeWavs([new Blob(['not wav'])]), /无效 WAV/);
});

test('timeout remains active while the audio body is being read', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (_, { signal }) => ({ ok: true, body: null, signal });
  try {
    await assert.rejects(fetchWithTimeout('/voice', {}, response => new Promise((_, reject) => {
      response.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }), 15), /超时/);
  } finally { globalThis.fetch = previous; }
});

test('caller cancellation and HTTP errors surface actionable messages', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 422, json: async () => ({ detail: [{ msg: 'unknown style' }] }) });
  try { await assert.rejects(fetchWithTimeout('/voice'), /unknown style/); }
  finally { globalThis.fetch = previous; }
});

test('caller abort cancels an in-flight fetch even without AbortSignal.any', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (_, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) reject(new Error('aborted'));
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  try {
    const controller = new AbortController();
    const pending = fetchWithTimeout('/voice', { signal: controller.signal });
    controller.abort(); await assert.rejects(pending, /操作已取消/);
  } finally { globalThis.fetch = previous; }
});

test('same-origin proxy is restricted to a fixed loopback target and known fields', async () => {
  assert.throws(() => localApi('http://example.com:5000'), /loopback/);
  assert.throws(() => localApi('http://localhost:5000/private'), /loopback/);
  assert.throws(() => localApi('http://user:password@localhost:5000'), /loopback/);
  const previous = globalThis.fetch; let requested;
  globalThis.fetch = async url => { requested = url; return new Response('audio', { headers: { 'content-type': 'audio/wav' } }); };
  const res = new EventEmitter(); res.status = () => res; res.type = () => res; res.send = () => { res.writableEnded = true; }; res.json = () => {};
  try {
    await relay('/voice', 'POST')({ query: { text: '你好', target: 'https://example.com', reference_audio_path: 'secret' } }, res);
    const url = new URL(requested); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.searchParams.get('text'), '你好');
    assert.equal(url.searchParams.has('target'), false); assert.equal(url.searchParams.has('reference_audio_path'), false);
  } finally { globalThis.fetch = previous; }
});
