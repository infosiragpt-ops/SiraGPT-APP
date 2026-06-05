const FAL_VIDEO_MODELS = Object.freeze([
  {
    id: 'fal-ai/sora-2/text-to-video/pro',
    name: 'fal-ai/sora-2/text-to-video/pro',
    displayName: 'Sora 2 Pro',
    provider: 'Fal.ai',
    type: 'VIDEO',
    icon: 'SoraLogo',
    description: 'Fal.ai Sora 2 Pro text-to-video for the highest quality cinematic generations.',
    qualityRank: 100,
    qualityLabel: 'Ultra',
    speedTier: 'quality',
    fal: {
      family: 'sora',
      textEndpoint: 'fal-ai/sora-2/text-to-video/pro',
      imageEndpoint: 'fal-ai/sora-2/image-to-video',
      supportsImage: true,
      supportsAudio: false,
      supportsDuration: true,
      supportsResolution: true,
      supportsNegativePrompt: false,
      defaultDuration: 8,
    },
    tags: ['fal', 'video', 'sora', 'pro', 'ultra-quality', 'text-to-video', 'image-to-video'],
  },
  {
    id: 'fal-ai/veo3.1',
    name: 'fal-ai/veo3.1',
    displayName: 'Veo 3.1 Quality',
    provider: 'Fal.ai',
    type: 'VIDEO',
    icon: 'GeminiLogo',
    description: 'Google Veo 3.1 through Fal.ai for premium text/image-to-video with audio-capable cinematic motion.',
    qualityRank: 98,
    qualityLabel: 'Ultra',
    speedTier: 'quality',
    fal: {
      family: 'veo',
      textEndpoint: 'fal-ai/veo3.1',
      imageEndpoint: 'fal-ai/veo3.1/image-to-video',
      supportsImage: true,
      supportsAudio: true,
      supportsDuration: true,
      supportsResolution: true,
      supportsNegativePrompt: false,
      defaultDuration: 8,
    },
    tags: ['fal', 'google', 'veo', 'video', 'ultra-quality', 'text-to-video', 'image-to-video', 'audio'],
  },
  {
    id: 'fal-ai/veo3.1/fast',
    name: 'fal-ai/veo3.1/fast',
    displayName: 'Veo 3.1 Fast',
    provider: 'Fal.ai',
    type: 'VIDEO',
    icon: 'GeminiLogo',
    description: 'Faster Fal.ai Veo 3.1 endpoint, balanced for professional previews and fast iteration.',
    qualityRank: 94,
    qualityLabel: 'High',
    speedTier: 'fast',
    fal: {
      family: 'veo',
      textEndpoint: 'fal-ai/veo3.1/fast',
      imageEndpoint: 'fal-ai/veo3.1/fast/image-to-video',
      supportsImage: true,
      supportsAudio: true,
      supportsDuration: true,
      supportsResolution: true,
      supportsNegativePrompt: false,
      defaultDuration: 8,
    },
    aliases: ['veo-fast', 'fal-ai/veo3/fast'],
    tags: ['fal', 'google', 'veo', 'video', 'fast', 'text-to-video', 'image-to-video', 'audio'],
  },
  {
    id: 'fal-ai/veo3.1/lite',
    name: 'fal-ai/veo3.1/lite',
    displayName: 'Veo 3.1 Lite',
    provider: 'Fal.ai',
    type: 'VIDEO',
    icon: 'GeminiLogo',
    description: 'Lightweight Veo 3.1 path on Fal.ai for lower-cost previews before final quality renders.',
    qualityRank: 90,
    qualityLabel: 'High',
    speedTier: 'efficient',
    fal: {
      family: 'veo',
      textEndpoint: 'fal-ai/veo3.1/lite',
      imageEndpoint: 'fal-ai/veo3.1/lite/image-to-video',
      supportsImage: true,
      supportsAudio: true,
      supportsDuration: true,
      supportsResolution: true,
      supportsNegativePrompt: false,
      defaultDuration: 8,
    },
    tags: ['fal', 'google', 'veo', 'video', 'lite', 'efficient', 'text-to-video', 'image-to-video'],
  },
  {
    id: 'fal-ai/kling-video/v3/pro/text-to-video',
    name: 'fal-ai/kling-video/v3/pro/text-to-video',
    displayName: 'Kling 3 Pro',
    provider: 'Fal.ai',
    type: 'VIDEO',
    icon: 'KlingLogo',
    description: 'Kling Video v3 Pro via Fal.ai for premium controllable motion and cinematic realism.',
    qualityRank: 88,
    qualityLabel: 'High',
    speedTier: 'quality',
    fal: {
      family: 'kling',
      textEndpoint: 'fal-ai/kling-video/v3/pro/text-to-video',
      imageEndpoint: 'fal-ai/kling-video/v3/pro/image-to-video',
      supportsImage: true,
      supportsAudio: false,
      supportsDuration: true,
      supportsResolution: true,
      supportsNegativePrompt: true,
      defaultDuration: 5,
    },
    tags: ['fal', 'kling', 'video', 'pro', 'text-to-video', 'image-to-video'],
  },
  {
    id: 'fal-ai/kling-video/o3/pro/text-to-video',
    name: 'fal-ai/kling-video/o3/pro/text-to-video',
    displayName: 'Kling O3 Pro',
    provider: 'Fal.ai',
    type: 'VIDEO',
    icon: 'KlingLogo',
    description: 'Kling O3 Pro through Fal.ai for high-quality prompt adherence and strong motion detail.',
    qualityRank: 86,
    qualityLabel: 'High',
    speedTier: 'quality',
    fal: {
      family: 'kling',
      textEndpoint: 'fal-ai/kling-video/o3/pro/text-to-video',
      imageEndpoint: 'fal-ai/kling-video/o3/pro/image-to-video',
      supportsImage: true,
      supportsAudio: false,
      supportsDuration: true,
      supportsResolution: true,
      supportsNegativePrompt: true,
      defaultDuration: 5,
    },
    tags: ['fal', 'kling', 'video', 'pro', 'text-to-video', 'image-to-video'],
  },
  {
    id: 'fal-ai/kling-video/v2.6/pro/text-to-video',
    name: 'fal-ai/kling-video/v2.6/pro/text-to-video',
    displayName: 'Kling 2.6 Pro',
    provider: 'Fal.ai',
    type: 'VIDEO',
    icon: 'KlingLogo',
    description: 'Kling 2.6 Pro via Fal.ai, a high quality model for polished text/image-to-video.',
    qualityRank: 84,
    qualityLabel: 'High',
    speedTier: 'quality',
    fal: {
      family: 'kling',
      textEndpoint: 'fal-ai/kling-video/v2.6/pro/text-to-video',
      imageEndpoint: 'fal-ai/kling-video/v2.6/pro/image-to-video',
      supportsImage: true,
      supportsAudio: false,
      supportsDuration: true,
      supportsResolution: true,
      supportsNegativePrompt: true,
      defaultDuration: 5,
    },
    tags: ['fal', 'kling', 'video', 'pro', 'text-to-video', 'image-to-video'],
  },
  {
    id: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video',
    name: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video',
    displayName: 'Kling 2.5 Turbo Pro',
    provider: 'Fal.ai',
    type: 'VIDEO',
    icon: 'KlingLogo',
    description: 'Kling 2.5 Turbo Pro on Fal.ai for strong quality with faster turnaround.',
    qualityRank: 82,
    qualityLabel: 'High',
    speedTier: 'fast',
    fal: {
      family: 'kling',
      textEndpoint: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video',
      imageEndpoint: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
      supportsImage: true,
      supportsAudio: false,
      supportsDuration: true,
      supportsResolution: true,
      supportsNegativePrompt: true,
      defaultDuration: 5,
    },
    tags: ['fal', 'kling', 'video', 'fast', 'pro', 'text-to-video', 'image-to-video'],
  },
  {
    id: 'fal-ai/kling-video/v2.1/master/text-to-video',
    name: 'fal-ai/kling-video/v2.1/master/text-to-video',
    displayName: 'Kling 2.1 Master',
    provider: 'Fal.ai',
    type: 'VIDEO',
    icon: 'KlingLogo',
    description: 'Kling 2.1 Master via Fal.ai, preserved as the upgraded professional Kling option.',
    qualityRank: 80,
    qualityLabel: 'High',
    speedTier: 'quality',
    fal: {
      family: 'kling',
      textEndpoint: 'fal-ai/kling-video/v2.1/master/text-to-video',
      imageEndpoint: 'fal-ai/kling-video/v2.1/master/image-to-video',
      supportsImage: true,
      supportsAudio: false,
      supportsDuration: true,
      supportsResolution: true,
      supportsNegativePrompt: true,
      defaultDuration: 5,
    },
    aliases: ['kling-2-master'],
    tags: ['fal', 'kling', 'video', 'master', 'text-to-video', 'image-to-video'],
  },
  {
    id: 'fal-ai/bytedance/seedance/v1.5/pro/text-to-video',
    name: 'fal-ai/bytedance/seedance/v1.5/pro/text-to-video',
    displayName: 'Seedance 1.5 Pro',
    provider: 'Fal.ai',
    type: 'VIDEO',
    icon: 'ByteDanceLogo',
    description: 'ByteDance Seedance 1.5 Pro on Fal.ai for cinematic, prompt-faithful video generations.',
    qualityRank: 78,
    qualityLabel: 'High',
    speedTier: 'quality',
    fal: {
      family: 'seedance',
      textEndpoint: 'fal-ai/bytedance/seedance/v1.5/pro/text-to-video',
      imageEndpoint: 'fal-ai/bytedance/seedance/v1.5/pro/image-to-video',
      supportsImage: true,
      supportsAudio: false,
      supportsDuration: true,
      supportsResolution: true,
      supportsNegativePrompt: false,
      defaultDuration: 5,
    },
    tags: ['fal', 'bytedance', 'seedance', 'video', 'pro', 'text-to-video', 'image-to-video'],
  },
  {
    id: 'fal-ai/sora-2/text-to-video',
    name: 'fal-ai/sora-2/text-to-video',
    displayName: 'Sora 2',
    provider: 'Fal.ai',
    type: 'VIDEO',
    icon: 'SoraLogo',
    description: 'Fal.ai Sora 2 standard text-to-video for balanced quality and cost.',
    qualityRank: 76,
    qualityLabel: 'High',
    speedTier: 'balanced',
    fal: {
      family: 'sora',
      textEndpoint: 'fal-ai/sora-2/text-to-video',
      imageEndpoint: 'fal-ai/sora-2/image-to-video',
      supportsImage: true,
      supportsAudio: false,
      supportsDuration: true,
      supportsResolution: true,
      supportsNegativePrompt: false,
      defaultDuration: 8,
    },
    tags: ['fal', 'sora', 'video', 'text-to-video', 'image-to-video'],
  },
  {
    id: 'fal-ai/minimax/hailuo-02/standard/text-to-video',
    name: 'fal-ai/minimax/hailuo-02/standard/text-to-video',
    displayName: 'Hailuo 02 Standard',
    provider: 'Fal.ai',
    type: 'VIDEO',
    icon: 'MiniMaxLogo',
    description: 'MiniMax Hailuo 02 through Fal.ai for reliable standard quality video generation.',
    qualityRank: 72,
    qualityLabel: 'Balanced',
    speedTier: 'balanced',
    fal: {
      family: 'minimax',
      textEndpoint: 'fal-ai/minimax/hailuo-02/standard/text-to-video',
      imageEndpoint: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
      supportsImage: true,
      supportsAudio: false,
      supportsDuration: true,
      supportsResolution: true,
      supportsNegativePrompt: true,
      defaultDuration: 6,
    },
    tags: ['fal', 'minimax', 'hailuo', 'video', 'standard', 'text-to-video', 'image-to-video'],
  },
  {
    id: 'fal-ai/pixverse/v6/text-to-video',
    name: 'fal-ai/pixverse/v6/text-to-video',
    displayName: 'PixVerse V6',
    provider: 'Fal.ai',
    type: 'VIDEO',
    icon: 'PixVerseLogo',
    description: 'PixVerse v6 via Fal.ai for quick creative clips and flexible prompt-to-video drafts.',
    qualityRank: 70,
    qualityLabel: 'Balanced',
    speedTier: 'balanced',
    fal: {
      family: 'pixverse',
      textEndpoint: 'fal-ai/pixverse/v6/text-to-video',
      imageEndpoint: 'fal-ai/pixverse/v6/image-to-video',
      supportsImage: true,
      supportsAudio: false,
      supportsDuration: true,
      supportsResolution: true,
      supportsNegativePrompt: true,
      defaultDuration: 5,
    },
    tags: ['fal', 'pixverse', 'video', 'text-to-video', 'image-to-video'],
  },
  {
    id: 'fal-ai/wan/v2.7/text-to-video',
    name: 'fal-ai/wan/v2.7/text-to-video',
    displayName: 'Wan 2.7',
    provider: 'Fal.ai',
    type: 'VIDEO',
    icon: 'WanLogo',
    description: 'Wan 2.7 through Fal.ai for efficient text/image-to-video drafts with modern motion quality.',
    qualityRank: 68,
    qualityLabel: 'Balanced',
    speedTier: 'efficient',
    fal: {
      family: 'wan',
      textEndpoint: 'fal-ai/wan/v2.7/text-to-video',
      imageEndpoint: 'fal-ai/wan/v2.7/image-to-video',
      supportsImage: true,
      supportsAudio: false,
      supportsDuration: true,
      supportsResolution: true,
      supportsNegativePrompt: true,
      defaultDuration: 5,
    },
    tags: ['fal', 'wan', 'video', 'efficient', 'text-to-video', 'image-to-video'],
  },
  {
    id: 'fal-ai/wan/v2.2-a14b/text-to-video',
    name: 'fal-ai/wan/v2.2-a14b/text-to-video',
    displayName: 'Wan 2.2 A14B',
    provider: 'Fal.ai',
    type: 'VIDEO',
    icon: 'WanLogo',
    description: 'Wan 2.2 A14B via Fal.ai, a capable lower-cost model for previews and drafts.',
    qualityRank: 64,
    qualityLabel: 'Draft+',
    speedTier: 'efficient',
    fal: {
      family: 'wan',
      textEndpoint: 'fal-ai/wan/v2.2-a14b/text-to-video',
      imageEndpoint: 'fal-ai/wan/v2.2-a14b/image-to-video',
      supportsImage: true,
      supportsAudio: false,
      supportsDuration: true,
      supportsResolution: true,
      supportsNegativePrompt: true,
      defaultDuration: 5,
    },
    tags: ['fal', 'wan', 'video', 'draft', 'text-to-video', 'image-to-video'],
  },
  {
    id: 'fal-ai/ltx-2.3/text-to-video/fast',
    name: 'fal-ai/ltx-2.3/text-to-video/fast',
    displayName: 'LTX 2.3 Fast',
    provider: 'Fal.ai',
    type: 'VIDEO',
    icon: 'LtxLogo',
    description: 'LTX 2.3 Fast through Fal.ai for rapid preview videos before spending on higher tiers.',
    qualityRank: 58,
    qualityLabel: 'Draft',
    speedTier: 'fast',
    fal: {
      family: 'ltx',
      textEndpoint: 'fal-ai/ltx-2.3/text-to-video/fast',
      imageEndpoint: 'fal-ai/ltx-2-19b/image-to-video',
      supportsImage: true,
      supportsAudio: false,
      supportsDuration: true,
      supportsResolution: false,
      supportsNegativePrompt: true,
      defaultDuration: 5,
    },
    tags: ['fal', 'ltx', 'video', 'fast', 'draft', 'text-to-video', 'image-to-video'],
  },
  {
    id: 'fal-ai/kling-video/v1.6/pro/text-to-video',
    name: 'fal-ai/kling-video/v1.6/pro/text-to-video',
    displayName: 'Kling 1.6 Pro',
    provider: 'Fal.ai',
    type: 'VIDEO',
    icon: 'KlingLogo',
    description: 'Legacy Kling 1.6 Pro option via Fal.ai, kept available for compatibility.',
    qualityRank: 54,
    qualityLabel: 'Legacy',
    speedTier: 'balanced',
    fal: {
      family: 'kling',
      textEndpoint: 'fal-ai/kling-video/v1.6/pro/text-to-video',
      imageEndpoint: 'fal-ai/kling-video/v1.6/standard/image-to-video',
      supportsImage: true,
      supportsAudio: false,
      supportsDuration: true,
      supportsResolution: true,
      supportsNegativePrompt: true,
      defaultDuration: 5,
    },
    aliases: ['kling-1.6-pro'],
    tags: ['fal', 'kling', 'video', 'legacy', 'text-to-video', 'image-to-video'],
  },
]);

const ADDITIONAL_FAL_VIDEO_ENDPOINTS = Object.freeze([
  'fal-ai/veo3',
  'fal-ai/bytedance/seedance/v1/pro/text-to-video',
  'fal-ai/kling-video/o3/standard/text-to-video',
  'fal-ai/kling-video/v3/standard/text-to-video',
  'fal-ai/kling-video/v2/master/text-to-video',
  'fal-ai/kling-video/v1.6/standard/text-to-video',
  'fal-ai/wan-25-preview/text-to-video',
]);

const ADDITIONAL_IMAGE_ENDPOINTS = Object.freeze({
  'fal-ai/bytedance/seedance/v1/pro/text-to-video': 'fal-ai/bytedance/seedance/v1/pro/image-to-video',
  'fal-ai/kling-video/o3/standard/text-to-video': 'fal-ai/kling-video/o3/standard/image-to-video',
  'fal-ai/kling-video/v3/standard/text-to-video': 'fal-ai/kling-video/v3/standard/image-to-video',
});

const ADDITIONAL_DISPLAY_NAMES = Object.freeze({
  'fal-ai/veo3': 'Veo 3',
  'fal-ai/bytedance/seedance/v1/pro/text-to-video': 'Seedance 1 Pro',
  'fal-ai/kling-video/o3/standard/text-to-video': 'Kling O3 Standard',
  'fal-ai/kling-video/v3/standard/text-to-video': 'Kling 3 Standard',
  'fal-ai/kling-video/v2/master/text-to-video': 'Kling 2 Master',
  'fal-ai/kling-video/v1.6/standard/text-to-video': 'Kling 1.6 Standard',
  'fal-ai/wan-25-preview/text-to-video': 'Wan 2.5 Preview',
});

const ADDITIONAL_QUALITY_RANKS = Object.freeze({
  'fal-ai/veo3': 92,
  'fal-ai/bytedance/seedance/v1/pro/text-to-video': 74,
  'fal-ai/kling-video/o3/standard/text-to-video': 75,
  'fal-ai/kling-video/v3/standard/text-to-video': 73,
  'fal-ai/kling-video/v2/master/text-to-video': 66,
  'fal-ai/kling-video/v1.6/standard/text-to-video': 50,
  'fal-ai/wan-25-preview/text-to-video': 62,
});

function inferFamily(endpoint) {
  if (endpoint.includes('sora')) return 'sora';
  if (endpoint.includes('veo')) return 'veo';
  if (endpoint.includes('kling')) return 'kling';
  if (endpoint.includes('seedance') || endpoint.includes('bytedance')) return 'seedance';
  if (endpoint.includes('minimax') || endpoint.includes('hailuo')) return 'minimax';
  if (endpoint.includes('pixverse')) return 'pixverse';
  if (endpoint.includes('/wan') || endpoint.includes('wan-')) return 'wan';
  if (endpoint.includes('ltx')) return 'ltx';
  return 'fal';
}

function iconForFamily(family) {
  return {
    sora: 'SoraLogo',
    veo: 'GeminiLogo',
    kling: 'KlingLogo',
    seedance: 'ByteDanceLogo',
    minimax: 'MiniMaxLogo',
    pixverse: 'PixVerseLogo',
    wan: 'WanLogo',
    ltx: 'LtxLogo',
  }[family] || 'FalLogo';
}

function qualityLabelForRank(rank) {
  if (rank >= 94) return 'Ultra';
  if (rank >= 72) return 'High';
  if (rank >= 60) return 'Balanced';
  return 'Draft';
}

function createAdditionalFalVideoModel(endpoint) {
  const family = inferFamily(endpoint);
  const rank = ADDITIONAL_QUALITY_RANKS[endpoint] || 60;
  const imageEndpoint = ADDITIONAL_IMAGE_ENDPOINTS[endpoint] || null;
  return {
    id: endpoint,
    name: endpoint,
    displayName: ADDITIONAL_DISPLAY_NAMES[endpoint] || endpoint.replace(/^fal-ai\//, ''),
    provider: 'Fal.ai',
    type: 'VIDEO',
    icon: iconForFamily(family),
    description: `${ADDITIONAL_DISPLAY_NAMES[endpoint] || endpoint} via Fal.ai video generation endpoint.`,
    qualityRank: rank,
    qualityLabel: qualityLabelForRank(rank),
    speedTier: endpoint.includes('fast') || endpoint.includes('standard') || endpoint.includes('preview') ? 'balanced' : 'quality',
    fal: {
      family,
      textEndpoint: endpoint,
      imageEndpoint,
      supportsImage: Boolean(imageEndpoint),
      supportsAudio: family === 'veo',
      supportsDuration: true,
      supportsResolution: family !== 'ltx',
      supportsNegativePrompt: family !== 'sora',
      defaultDuration: family === 'veo' || family === 'sora' ? 8 : 5,
    },
    tags: ['fal', family, 'video', 'text-to-video', ...(imageEndpoint ? ['image-to-video'] : [])],
  };
}

const CURATED_FAL_VIDEO_NAMES = new Set(FAL_VIDEO_MODELS.map((model) => model.name));
const ADDITIONAL_FAL_VIDEO_MODELS = ADDITIONAL_FAL_VIDEO_ENDPOINTS
  .filter((endpoint) => !CURATED_FAL_VIDEO_NAMES.has(endpoint))
  .map(createAdditionalFalVideoModel);
const ALL_FAL_VIDEO_MODELS = Object.freeze([...FAL_VIDEO_MODELS, ...ADDITIONAL_FAL_VIDEO_MODELS]);

const ALIASES = new Map();
for (const model of ALL_FAL_VIDEO_MODELS) {
  ALIASES.set(model.name, model.name);
  ALIASES.set(model.id, model.name);
  for (const alias of model.aliases || []) {
    ALIASES.set(alias, model.name);
  }
  const fal = model.fal || {};
  for (const endpoint of [fal.textEndpoint, fal.imageEndpoint]) {
    if (endpoint) ALIASES.set(endpoint, model.name);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function listFalVideoModels() {
  return ALL_FAL_VIDEO_MODELS
    .slice()
    .sort((a, b) => (b.qualityRank || 0) - (a.qualityRank || 0))
    .map((model) => ({
      ...clone(model),
      apiData: {
        ...(model.apiData || {}),
        fal: clone(model.fal || {}),
        qualityRank: model.qualityRank,
        qualityLabel: model.qualityLabel,
        speedTier: model.speedTier,
      },
      syncSource: 'fal_static_catalog',
      isActive: model.isActive !== false,
    }));
}

function resolveFalVideoModel(modelName, { imageToVideo = false } = {}) {
  const raw = String(modelName || '').trim();
  const canonicalName = ALIASES.get(raw) || ALIASES.get(raw.toLowerCase()) || raw;
  const model = ALL_FAL_VIDEO_MODELS.find((entry) => entry.name === canonicalName || entry.id === canonicalName)
    || ALL_FAL_VIDEO_MODELS.find((entry) => entry.name === 'fal-ai/veo3.1/fast');
  const fal = model.fal || {};
  const endpoint = imageToVideo && fal.imageEndpoint ? fal.imageEndpoint : fal.textEndpoint || model.name;
  return { model: clone(model), endpoint, fal: clone(fal) };
}

function sanitizeDuration(value, fallback = 5) {
  const numeric = Number.parseInt(String(value || fallback).replace(/s$/i, ''), 10);
  return Math.min(Math.max(Number.isFinite(numeric) ? numeric : fallback, 4), 15);
}

function buildFalVideoPayload({ modelName, prompt, aspectRatio = '16:9', duration = '5s', negativePrompt, imageUrl = null, resolution = '720p', audio = true }) {
  const imageToVideo = Boolean(imageUrl);
  const resolved = resolveFalVideoModel(modelName, { imageToVideo });
  const { fal, endpoint } = resolved;
  const seconds = sanitizeDuration(duration, fal.defaultDuration || 5);
  const payload = { prompt };

  if (imageToVideo) {
    payload.image_url = imageUrl;
  }

  if (fal.supportsAspectRatio !== false) {
    payload.aspect_ratio = aspectRatio === 'auto' ? '16:9' : aspectRatio;
  }

  if (fal.supportsDuration !== false) {
    payload.duration = `${seconds}s`;
  }

  if (fal.supportsAudio) {
    payload.generate_audio = Boolean(audio);
  }

  if (fal.supportsResolution) {
    payload.resolution = resolution;
  }

  if (fal.supportsNegativePrompt && negativePrompt) {
    payload.negative_prompt = negativePrompt;
  }

  return {
    ...resolved,
    endpoint,
    payload,
    normalizedDuration: `${seconds}s`,
  };
}

module.exports = {
  FAL_VIDEO_MODELS,
  ALL_FAL_VIDEO_MODELS,
  buildFalVideoPayload,
  listFalVideoModels,
  resolveFalVideoModel,
};
