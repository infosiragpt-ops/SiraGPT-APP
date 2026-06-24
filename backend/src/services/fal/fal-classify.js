'use strict';

// Classifies a raw fal.ai model record (from https://fal.ai/api/models) into
// the brand / quality-tier / capability metadata the chat model gallery needs.
// Pure functions, no I/O — used by both the build script (scripts/build-fal-catalog.js)
// and the runtime catalog loader (services/fal-model-catalog.js).

// Brand inference. Ordered most-specific → most-generic; first match wins.
// `iconKey` is a stable slug the frontend maps to a logo / branded badge.
const BRAND_RULES = [
  [/(^|\/)flux(\/|-|$)/, 'Black Forest Labs', 'flux'],
  [/nano-banana/, 'Google', 'nano-banana'],
  [/(gpt-image|dall-?e)/, 'OpenAI', 'openai'],
  [/(^|\/)sora(\/|-|$)/, 'OpenAI', 'sora'],
  [/(^xai\/|\/grok|grok-imagine)/, 'xAI', 'grok'],
  [/(veo[\d.]|\/veo)/, 'Google', 'veo'],
  [/(gemini|imagen|lyria|dreamina)/, 'Google', 'google'],
  [/(seedance|seedream|bytedance)/, 'ByteDance', 'bytedance'],
  [/kling/, 'Kling AI', 'kling'],
  [/(minimax|hailuo)/, 'MiniMax', 'minimax'],
  [/(^|\/)wan(\/|-|\d|$)/, 'Alibaba Wan', 'wan'],
  [/qwen/, 'Alibaba Qwen', 'qwen'],
  [/hunyuan/, 'Tencent Hunyuan', 'hunyuan'],
  [/stable-audio/, 'Stability AI', 'stability'],
  [/(stable-diffusion|sdxl|sd3|sd-?1\.5|stable)/, 'Stability AI', 'stability'],
  [/ltx/, 'Lightricks', 'ltx'],
  [/ideogram/, 'Ideogram', 'ideogram'],
  [/recraft/, 'Recraft', 'recraft'],
  [/(^|\/)bria(\/|-|$)/, 'Bria', 'bria'],
  [/vidu/, 'Vidu', 'vidu'],
  [/luma/, 'Luma', 'luma'],
  [/pika/, 'Pika', 'pika'],
  [/hidream/, 'HiDream', 'hidream'],
  [/elevenlabs/, 'ElevenLabs', 'elevenlabs'],
  [/kokoro/, 'Kokoro', 'kokoro'],
  [/cassette/, 'CassetteAI', 'cassette'],
  [/trellis/, 'Microsoft', 'trellis'],
  [/(rodin|hyper3d)/, 'Deemos Rodin', 'rodin'],
  [/meshy/, 'Meshy', 'meshy'],
  [/tripo/, 'Tripo', 'tripo'],
  [/framepack/, 'FramePack', 'framepack'],
  [/mochi/, 'Genmo', 'mochi'],
  [/cogvideo/, 'CogVideo', 'cogvideo'],
  [/(playht|play-ht)/, 'PlayHT', 'playht'],
  [/(^|\/)dia(\/|-|$)/, 'Dia', 'dia'],
  [/chatterbox/, 'Chatterbox', 'chatterbox'],
  [/krea/, 'Krea', 'krea'],
  [/moonvalley/, 'Moonvalley', 'moonvalley'],
  [/(imagineart|imagine-art)/, 'ImagineArt', 'imagineart'],
  [/veed/, 'VEED', 'veed'],
  [/riffusion/, 'Riffusion', 'riffusion'],
  [/(sonauto|sonilo)/, 'Sonauto', 'sonauto'],
];

const DEFAULT_BRAND = { brand: 'fal.ai', iconKey: 'fal' };

// Brand prestige — secondary ordering within a quality tier so recognizable
// flagship families surface before the long tail (lower = earlier). Unlisted
// brands fall back to 50; the generic fal.ai bucket sorts last.
const BRAND_PRIORITY = {
  flux: 1, openai: 2, sora: 2, 'nano-banana': 3, veo: 3, google: 4, bytedance: 5,
  kling: 6, minimax: 7, luma: 8, ideogram: 9, recraft: 10, stability: 11,
  hidream: 12, wan: 13, qwen: 14, hunyuan: 15, ltx: 16, vidu: 17, pika: 18,
  bria: 19, elevenlabs: 20, krea: 21, moonvalley: 22, framepack: 23, mochi: 24,
  cogvideo: 25, trellis: 26, rodin: 27, meshy: 28, tripo: 29, kokoro: 30,
  cassette: 31, playht: 32, dia: 33, chatterbox: 34, riffusion: 35, sonauto: 36,
  imagineart: 37, veed: 38, fal: 90,
};

// Pure utilities (not creative-generative). Excluded when the catalog is built
// in "creative" mode — upscalers, codecs, separators, detectors, training, etc.
const UTILITY_RE = /(upscal|esrgan|gfpgan|topaz|clarity-upscaler|ccsr|aura-sr|ffmpeg|demucs|deepfilter|audio-isolation|\baudio-isolation\b|\/isolate|\/separate|sam-audio|\bsam-?[23]?\b|background-removal|remove-background|\brembg\b|bg-removal|face-detect|\bdetect\b|nsfw|moderation|\bcaption\b|\bdescribe\b|\bocr\b|embeddings?|\brerank\b|\btrain\b|\btuning\b|lora-training|\bmerge\b|\bconcat\b|\btrim\b|metadata|ffprobe|\bworkflow\b|\butil\b|read-pdf|file-?upload)/;

const TIER_LABEL = { 5: 'Ultra', 4: 'Pro', 3: 'Standard', 2: 'Fast', 1: 'Basic' };

function inferBrand(id) {
  const s = String(id || '').toLowerCase();
  for (const [re, brand, iconKey] of BRAND_RULES) {
    if (re.test(s)) return { brand, iconKey };
  }
  return { ...DEFAULT_BRAND };
}

function isUtility(id, title) {
  return UTILITY_RE.test(`${id} ${title || ''}`.toLowerCase());
}

function categoryGroup(category) {
  const c = String(category || '').toLowerCase();
  if (/3d/.test(c)) return '3d';
  if (/(audio|speech|music|voice|tts)/.test(c)) return 'audio';
  if (/video/.test(c)) return 'video';
  return 'image';
}

// Heuristic quality tier (5=Ultra … 1=Basic). Flagship families are pinned high;
// fast/turbo/lite variants are pulled down. Imperfect but gives a sensible
// high→low ordering for the gallery.
function inferTierRank(id, title) {
  const s = `${id} ${title || ''}`.toLowerCase();
  let rank = 3;
  if (/(ultra|\/max(\/|$)|\bmax\b|pro\/ultra)/.test(s)) rank = 5;
  else if (/(\bpro\b|-pro|\/pro|\bplus\b|v1\.1|kontext|\bhd\b|advanced)/.test(s)) rank = 4;
  if (/(seedance-2|veo[-.]?3|sora-2|kling-video\/v3\/pro|flux-2-pro|flux-pro\/v1\.1|nano-banana-pro|gpt-image-2|imagen-4|seedream\/v4|hunyuan-3d\/v3|wan\/v2\.[5-9]|kling-video\/v3)/.test(s)) {
    rank = Math.max(rank, 5);
  }
  if (/(fast|turbo|schnell|lite|flash|mini|distill|lightning|tiny|small|draft|low|nano(?!-banana)|2b|1\.7b)/.test(s)) rank = Math.min(rank, 2);
  if (/(v1(\b|\/)|sd-?1\.5|legacy|\bold\b|deprecated)/.test(s)) rank = Math.min(rank, 2);
  return rank;
}

const TAG_BADGES = {
  lipsync: 'Lip-sync', audio: 'Audio', stylized: 'Stylized', transform: 'Transform',
  reference: 'Reference', '4k': '4K', hd: 'HD', upscale: 'Upscale', inpaint: 'Inpaint',
  outpaint: 'Outpaint', controlnet: 'ControlNet', lora: 'LoRA',
};

function inferCapabilities(id, category, tags) {
  const out = new Set();
  const s = String(id || '').toLowerCase();
  if (/audio|sound|music|tts|speech|voice/.test(`${category} ${s}`)) out.add('Audio');
  if (/(\/edit|kontext|inpaint|image-to-image)/.test(`${category} ${s}`)) out.add('Edit');
  if (/(reference|ref-to|\/ref)/.test(s)) out.add('Reference');
  if (/(4k|2160)/.test(s)) out.add('4K');
  else if (/(hd|1080)/.test(s)) out.add('HD');
  if (/lipsync|lip-sync/.test(`${(tags || []).join(' ')} ${s}`)) out.add('Lip-sync');
  for (const t of tags || []) {
    const b = TAG_BADGES[String(t).toLowerCase()];
    if (b) out.add(b);
  }
  return [...out].slice(0, 4);
}

// category → human label for the gallery's section headers / mode badge.
const MODE_LABEL = {
  'text-to-image': 'Text → Image',
  'image-to-image': 'Image → Image',
  'text-to-video': 'Text → Video',
  'image-to-video': 'Image → Video',
  'text-to-audio': 'Text → Audio',
  'audio-to-audio': 'Audio → Audio',
  'text-to-speech': 'Text → Speech',
  'image-to-3d': 'Image → 3D',
};

/**
 * Classify a raw fal model record `{ id, title, category, tags, desc }`.
 * Returns the enriched catalog record, or null when it's a pure utility and
 * `opts.creativeOnly` is set (the default for the chat gallery).
 */
function classifyFalModel(raw, opts = {}) {
  const creativeOnly = opts.creativeOnly !== false;
  if (!raw || !raw.id) return null;
  const id = String(raw.id);
  const title = raw.title || id.split('/').slice(-1)[0];
  if (creativeOnly && isUtility(id, title)) return null;
  const category = raw.category || 'text-to-image';
  const { brand, iconKey } = inferBrand(id);
  const tierRank = inferTierRank(id, title);
  return {
    id,
    endpoint: id, // the real fal endpoint — shown small on the card to disambiguate same-title variants
    displayName: title,
    brand,
    iconKey,
    prio: BRAND_PRIORITY[iconKey] != null ? BRAND_PRIORITY[iconKey] : 50,
    category,
    group: categoryGroup(category),
    mode: MODE_LABEL[category] || category,
    qualityTier: TIER_LABEL[tierRank],
    tierRank,
    capabilities: inferCapabilities(id, category, raw.tags),
    description: String(raw.desc || raw.shortDescription || '').slice(0, 200),
    provider: 'fal.ai',
  };
}

// Stable sort: quality desc, then brand prestige, then brand A→Z, then name A→Z.
function sortFalModels(models) {
  return [...models].sort((a, b) =>
    b.tierRank - a.tierRank ||
    (a.prio || 50) - (b.prio || 50) ||
    a.brand.localeCompare(b.brand) ||
    a.displayName.localeCompare(b.displayName) ||
    a.id.localeCompare(b.id));
}

module.exports = {
  BRAND_RULES,
  TIER_LABEL,
  MODE_LABEL,
  inferBrand,
  isUtility,
  categoryGroup,
  inferTierRank,
  inferCapabilities,
  classifyFalModel,
  sortFalModels,
};
