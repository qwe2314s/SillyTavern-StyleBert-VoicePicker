// Optional SillyTavern server plugin. The browser never supplies an upstream URL.
export const info = { id: 'sbvp', name: 'Style-Bert local proxy', description: 'Authenticated same-origin access to a loopback TTS API.' };

export function localApi(value = process.env.SBVP_API_URL || 'http://127.0.0.1:5000') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('SBVP_API_URL must be an HTTP loopback origin without credentials or paths');
  }
  return url.origin;
}

const allowed = new Set(['text', 'model_name', 'model_id', 'speaker_name', 'speaker_id', 'checkpoint', 'language',
  'style', 'style_weight', 'sdp_ratio', 'noise', 'noisew', 'length', 'auto_split', 'split_interval',
  'assist_text', 'assist_text_weight', 'pitch_scale', 'intonation_scale']);

export function relay(path, method, upstream = localApi()) {
  // Validate even when a custom origin is supplied by a local test or installer.
  const origin = localApi(upstream);
  return async (req, res) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', close);
    try {
      const params = new URLSearchParams();
      if (path === '/voice') {
        for (const [key, value] of Object.entries({ ...req.query, ...req.body })) {
          if (allowed.has(key) && ['string', 'number', 'boolean'].includes(typeof value)) params.set(key, String(value));
        }
      }
      const response = await fetch(`${origin}${path}${params.size ? `?${params}` : ''}`, { method, signal: controller.signal });
      const data = Buffer.from(await response.arrayBuffer());
      res.status(response.status).type(response.headers.get('content-type') || 'application/octet-stream').send(data);
    } catch (error) {
      if (!res.destroyed) res.status(controller.signal.aborted ? 504 : 502).json({ detail: '本机语音 API 未启动或请求超时，请检查电脑上的 TTS 窗口。' });
    } finally { clearTimeout(timer); res.off('close', close); }
  };
}

export async function init(router) {
  const upstream = localApi();
  router.get('/models/info', relay('/models/info', 'GET', upstream));
  router.get('/capabilities', relay('/capabilities', 'GET', upstream));
  router.post('/models/refresh', relay('/models/refresh', 'POST', upstream));
  router.post('/voice', relay('/voice', 'POST', upstream));
}
