// 涂鸦 → 艺术画作：服务端生图接口（Vercel Serverless Function）
// 环境变量：
//   GEMINI_API_KEY      Google Gemini（首选）
//   GEMINI_MODEL        默认 gemini-2.5-flash-image
//   DASHSCOPE_API_KEY   阿里云百炼（备选）
//   DASHSCOPE_MODEL     默认 qwen-image-edit
//   PROVIDER            gemini | dashscope，不填则按有哪个 key 自动选（Gemini 优先）
//   ACCESS_CODE         可选，设了就要求前端带口令
//   RATE_PER_10MIN      每个 IP 每 10 分钟最多几张，默认 8
//   RATE_PER_DAY        每个 IP 每天最多几张，默认 40
//   GLOBAL_PER_DAY      单实例每天总上限，默认 300

const STYLES = {
  oil: {
    name: '古典油画',
    en: 'a museum-grade classical oil painting on canvas, thick impasto brushstrokes, rich layered glazes, dramatic chiaroscuro lighting, visible canvas texture, in the manner of the old masters',
  },
  watercolor: {
    name: '水彩',
    en: 'a luminous watercolor painting on cold-press paper, soft wet-on-wet bleeding edges, transparent layered washes, delicate pigment granulation, airy white highlights',
  },
  ink: {
    name: '国画水墨',
    en: 'a traditional Chinese ink wash painting (shui-mo) on rice paper, expressive calligraphic brush strokes, gradations of black ink, generous negative space, subtle mineral color accents, a small red seal stamp',
  },
  vangogh: {
    name: '梵高星夜',
    en: 'a post-impressionist painting in the style of Vincent van Gogh, swirling energetic brushstrokes, thick impasto, vivid cobalt blues and chrome yellows, Starry Night atmosphere',
  },
  ukiyoe: {
    name: '浮世绘',
    en: 'a Japanese ukiyo-e woodblock print in the style of Hokusai and Hiroshige, bold outlines, flat areas of color, Prussian blue, washi paper texture, elegant composition',
  },
  cyberpunk: {
    name: '赛博朋克',
    en: 'a cinematic cyberpunk digital painting, neon magenta and cyan lighting, rain-slick reflections, holographic signs, volumetric fog, ultra detailed concept art',
  },
  cartoon3d: {
    name: '3D 卡通',
    en: 'a charming 3D animated movie still in a Pixar-like style, soft global illumination, subsurface scattering, adorable rounded shapes, vibrant colors, shallow depth of field, octane render',
  },
  ghibli: {
    name: '吉卜力动画',
    en: 'a hand-painted Studio Ghibli style anime background scene, lush painterly details, soft sunlight, fluffy clouds, nostalgic warm atmosphere',
  },
  monet: {
    name: '莫奈印象派',
    en: 'an impressionist painting in the style of Claude Monet, broken color, dappled light, shimmering reflections, soft pastel palette, plein-air brushwork',
  },
  dunhuang: {
    name: '敦煌壁画',
    en: 'an ancient Dunhuang Mogao cave mural painting, mineral pigments of malachite green, azurite blue and cinnabar red, gold leaf details, flowing ribbons, weathered plaster texture',
  },
  popart: {
    name: '波普艺术',
    en: 'a bold pop art piece in the style of Roy Lichtenstein and Andy Warhol, Ben-Day dots, thick black outlines, saturated primary colors, comic-book graphic look',
  },
  stainedglass: {
    name: '彩色玻璃',
    en: 'a radiant stained glass window artwork, jewel-toned translucent glass pieces, dark lead came outlines, sunlight glowing through, gothic cathedral feel',
  },
};

const FIDELITY = {
  strict: 'Follow the sketch very closely: keep the exact composition, outlines, shapes, positions and proportions of every element; only render it in the target style.',
  balanced: 'Keep the composition, the main subjects and their positions from the sketch, but freely enrich them with detail, lighting, texture and atmosphere.',
  free: 'Use the sketch as loose inspiration for subject and layout, and reimagine it boldly as a stunning, imaginative masterpiece.',
};

const buckets = new Map(); // ip -> [timestamps]
let globalDay = { day: '', count: 0 };

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'] || '';
  return (xf.split(',')[0] || req.headers['x-real-ip'] || 'unknown').trim();
}

function rateLimit(ip) {
  const now = Date.now();
  const per10 = Number(process.env.RATE_PER_10MIN || 8);
  const perDay = Number(process.env.RATE_PER_DAY || 40);
  const globalCap = Number(process.env.GLOBAL_PER_DAY || 300);
  const today = new Date().toISOString().slice(0, 10);
  if (globalDay.day !== today) globalDay = { day: today, count: 0 };
  if (globalDay.count >= globalCap) return '今天的总生成次数已用完，明天再来吧';
  const arr = (buckets.get(ip) || []).filter((t) => now - t < 86400000);
  if (arr.filter((t) => now - t < 600000).length >= per10) return '画得太快啦，休息几分钟再来（每 10 分钟最多 ' + per10 + ' 张）';
  if (arr.length >= perDay) return '今天已经画了 ' + perDay + ' 张，明天再来吧';
  arr.push(now);
  buckets.set(ip, arr);
  globalDay.count += 1;
  if (buckets.size > 5000) buckets.clear();
  return null;
}

function buildPrompt(styleKey, fidelity, desc) {
  const style = STYLES[styleKey] || STYLES.oil;
  const fid = FIDELITY[fidelity] || FIDELITY.balanced;
  let p =
    'Transform this rough hand-drawn doodle into a breathtaking, gallery-worthy finished artwork. ' +
    'Render it as ' + style.en + '. ' + fid + ' ';
  if (desc) p += 'The artist describes the drawing as: "' + desc + '". Make sure this is reflected. ';
  p +=
    'Masterful composition, harmonious colors, exquisite detail, high resolution. ' +
    'The result must be a complete polished painting that fills the whole frame: no sketch lines, no paper edges, no text, no letters, no watermark, no signature.';
  return p;
}

async function viaGemini(prompt, mime, b64) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-image';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j.error && j.error.message) || 'HTTP ' + r.status;
    const e = new Error('Gemini: ' + msg);
    e.status = r.status;
    throw e;
  }
  const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  const img = parts.find((p) => p.inlineData || p.inline_data);
  if (!img) {
    const txt = parts.map((p) => p.text).filter(Boolean).join(' ');
    throw new Error('Gemini 没有返回图片' + (txt ? '：' + txt.slice(0, 200) : ''));
  }
  const d = img.inlineData || img.inline_data;
  return { mime: d.mimeType || d.mime_type || 'image/png', b64: d.data, provider: 'gemini:' + model };
}

async function viaDashscope(prompt, mime, b64) {
  const model = process.env.DASHSCOPE_MODEL || 'qwen-image-edit';
  const base = process.env.DASHSCOPE_BASE || 'https://dashscope.aliyuncs.com';
  const r = await fetch(base + '/api/v1/services/aigc/multimodal-generation/generation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.DASHSCOPE_API_KEY },
    body: JSON.stringify({
      model,
      input: {
        messages: [{ role: 'user', content: [{ image: 'data:' + mime + ';base64,' + b64 }, { text: prompt.slice(0, 790) }] }],
      },
      parameters: { negative_prompt: 'sketch lines, text, watermark, signature, blurry, low quality', watermark: false },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.code) {
    const e = new Error('百炼: ' + (j.message || j.code || 'HTTP ' + r.status));
    e.status = r.status;
    throw e;
  }
  const content = (((((j.output || {}).choices || [])[0] || {}).message || {}).content) || [];
  const item = content.find((c) => c.image);
  if (!item) throw new Error('百炼没有返回图片');
  const ir = await fetch(item.image);
  if (!ir.ok) return { url: item.image, provider: 'dashscope:' + model };
  const buf = Buffer.from(await ir.arrayBuffer());
  return { mime: ir.headers.get('content-type') || 'image/png', b64: buf.toString('base64'), provider: 'dashscope:' + model };
}

function pickProvider() {
  const p = (process.env.PROVIDER || '').toLowerCase();
  if (p === 'gemini' && process.env.GEMINI_API_KEY) return 'gemini';
  if (p === 'dashscope' && process.env.DASHSCOPE_API_KEY) return 'dashscope';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.DASHSCOPE_API_KEY) return 'dashscope';
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, provider: pickProvider(), needCode: !!process.env.ACCESS_CODE, styles: Object.keys(STYLES) });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const host = req.headers.host || '';
  const origin = req.headers.origin || '';
  if (origin && host && !origin.endsWith('//' + host)) return res.status(403).json({ error: '不允许跨站调用' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  if (process.env.ACCESS_CODE && body.code !== process.env.ACCESS_CODE) {
    return res.status(401).json({ error: '口令不对', needCode: true });
  }

  const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(body.image || '');
  if (!m) return res.status(400).json({ error: '没收到画稿' });
  if (m[3].length > 3_500_000) return res.status(413).json({ error: '画稿太大了' });

  const desc = String(body.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const prompt = buildPrompt(String(body.style || 'oil'), String(body.fidelity || 'balanced'), desc);

  const provider = pickProvider();
  if (!provider) return res.status(500).json({ error: '服务端还没配置生图 API Key' });

  const limited = rateLimit(clientIp(req));
  if (limited) return res.status(429).json({ error: limited });

  const order = provider === 'gemini' && process.env.DASHSCOPE_API_KEY ? ['gemini', 'dashscope'] : [provider];
  let lastErr;
  for (const p of order) {
    try {
      const out = p === 'gemini' ? await viaGemini(prompt, m[1], m[3]) : await viaDashscope(prompt, m[1], m[3]);
      const image = out.b64 ? 'data:' + out.mime + ';base64,' + out.b64 : out.url;
      return res.status(200).json({ image, provider: out.provider, style: (STYLES[body.style] || STYLES.oil).name });
    } catch (e) {
      lastErr = e;
      console.error('[generate]', p, e.message);
    }
  }
  return res.status(502).json({ error: '生成失败：' + (lastErr ? lastErr.message : '未知错误') });
};

module.exports.config = { api: { bodyParser: { sizeLimit: '4mb' } }, maxDuration: 60 };
