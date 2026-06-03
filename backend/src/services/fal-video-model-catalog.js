'use strict';

const FAL_VIDEO_PROVIDER = 'fal.ai';
const LEGACY_FAL_VIDEO_ALIASES = Object.freeze({
  'veo-fast': 'fal-ai/veo3/fast',
  'veo-3-fast': 'fal-ai/veo3/fast',
  'veo3-fast': 'fal-ai/veo3/fast',
  'veo3': 'fal-ai/veo3',
});

const FAL_VIDEO_MODELS = Object.freeze([
  // Ordered manually from highest-quality / flagship models down to faster or older variants.
  {
    id: 'bytedance/seedance-2.0/text-to-video',
    displayName: 'Seedance 2.0 Text to Video',
    brand: 'ByteDance',
    icon: 'ByteDanceLogo',
    mode: 'text-to-video',
    family: 'Seedance 2.0',
    qualityTier: 'Ultra',
    description: 'ByteDance Seedance 2.0 flagship text-to-video with cinematic motion, native audio and director-level camera control.',
    supportsAudio: true,
    supportsResolution: true,
    pairedImageEndpoint: 'bytedance/seedance-2.0/image-to-video',
    pairedReferenceEndpoint: 'bytedance/seedance-2.0/reference-to-video',
  },
  {
    id: 'fal-ai/kling-video/v3/pro/text-to-video',
    displayName: 'Kling Video v3 Pro',
    brand: 'Kling AI',
    icon: 'KlingLogo',
    mode: 'text-to-video',
    family: 'Kling v3',
    qualityTier: 'Ultra',
    description: 'Kling v3 Pro text-to-video via fal.ai with premium motion consistency and native audio support.',
    supportsAudio: true,
    supportsNegativePrompt: true,
    pairedImageEndpoint: 'fal-ai/kling-video/v3/pro/image-to-video',
  },
  {
    id: 'fal-ai/veo3.1',
    displayName: 'Veo 3.1',
    brand: 'Google',
    icon: 'GeminiLogo',
    mode: 'text-to-video',
    family: 'Veo 3.1',
    qualityTier: 'Ultra',
    description: 'Google Veo 3.1 through fal.ai for premium text-to-video generation with sound.',
    supportsAudio: true,
    supportsNegativePrompt: true,
    supportsResolution: true,
    pairedImageEndpoint: 'fal-ai/veo3.1/image-to-video',
  },
  {
    id: 'fal-ai/sora-2/text-to-video/pro',
    displayName: 'Sora 2 Pro',
    brand: 'OpenAI',
    icon: 'SoraLogo',
    mode: 'text-to-video',
    family: 'Sora 2',
    qualityTier: 'Ultra',
    description: 'OpenAI Sora 2 Pro text-to-video served by fal.ai for highest-quality narrative video generation.',
    supportsResolution: true,
  },
  {
    id: 'fal-ai/veo3.1/fast',
    displayName: 'Veo 3.1 Fast',
    brand: 'Google',
    icon: 'GeminiLogo',
    mode: 'text-to-video',
    family: 'Veo 3.1',
    qualityTier: 'High',
    description: 'Fast Google Veo 3.1 route via fal.ai balancing quality, audio and latency.',
    supportsAudio: true,
    supportsNegativePrompt: true,
    supportsResolution: true,
    pairedImageEndpoint: 'fal-ai/veo3.1/fast/image-to-video',
  },
  {
    id: 'fal-ai/kling-video/v3/standard/text-to-video',
    displayName: 'Kling Video v3 Standard',
    brand: 'Kling AI',
    icon: 'KlingLogo',
    mode: 'text-to-video',
    family: 'Kling v3',
    qualityTier: 'High',
    description: 'Kling v3 Standard text-to-video via fal.ai with strong motion quality at lower cost than Pro.',
    supportsAudio: true,
    supportsNegativePrompt: true,
    pairedImageEndpoint: 'fal-ai/kling-video/v3/standard/image-to-video',
  },
  {
    id: 'fal-ai/veo3/fast',
    displayName: 'Veo 3 Fast',
    brand: 'Google',
    icon: 'GeminiLogo',
    mode: 'text-to-video',
    family: 'Veo 3',
    qualityTier: 'High',
    description: 'Google Veo 3 Fast through fal.ai. Reliable high-quality generation for /chat video workflows.',
    supportsAudio: true,
    supportsNegativePrompt: true,
    supportsResolution: true,
    pairedImageEndpoint: 'fal-ai/veo3/fast/image-to-video',
  },
  {
    id: 'fal-ai/veo3',
    displayName: 'Veo 3',
    brand: 'Google',
    icon: 'GeminiLogo',
    mode: 'text-to-video',
    family: 'Veo 3',
    qualityTier: 'High',
    description: 'Google Veo 3 through fal.ai for high-quality text-to-video generation with audio.',
    supportsAudio: true,
    supportsNegativePrompt: true,
    supportsResolution: true,
  },
  {
    id: 'fal-ai/sora-2/text-to-video',
    displayName: 'Sora 2',
    brand: 'OpenAI',
    icon: 'SoraLogo',
    mode: 'text-to-video',
    family: 'Sora 2',
    qualityTier: 'High',
    description: 'OpenAI Sora 2 text-to-video served by fal.ai.',
    supportsResolution: true,
  },
  {
    id: 'bytedance/seedance-2.0/fast/text-to-video',
    displayName: 'Seedance 2.0 Fast Text to Video',
    brand: 'ByteDance',
    icon: 'ByteDanceLogo',
    mode: 'text-to-video',
    family: 'Seedance 2.0 Fast',
    qualityTier: 'High',
    description: 'Faster Seedance 2.0 text-to-video route via fal.ai.',
    supportsAudio: true,
    supportsResolution: true,
    pairedImageEndpoint: 'bytedance/seedance-2.0/fast/image-to-video',
    pairedReferenceEndpoint: 'bytedance/seedance-2.0/fast/reference-to-video',
  },
  {
    id: 'fal-ai/kling-video/v2.6/pro/text-to-video',
    displayName: 'Kling Video v2.6 Pro',
    brand: 'Kling AI',
    icon: 'KlingLogo',
    mode: 'text-to-video',
    family: 'Kling v2.6',
    qualityTier: 'High',
    description: 'Kling v2.6 Pro text-to-video via fal.ai.',
    supportsNegativePrompt: true,
    pairedImageEndpoint: 'fal-ai/kling-video/v2.6/pro/image-to-video',
  },
  {
    id: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video',
    displayName: 'Kling Video v2.5 Turbo Pro',
    brand: 'Kling AI',
    icon: 'KlingLogo',
    mode: 'text-to-video',
    family: 'Kling v2.5 Turbo',
    qualityTier: 'High',
    description: 'Kling v2.5 Turbo Pro text-to-video via fal.ai for strong quality with faster turnaround.',
    supportsNegativePrompt: true,
    pairedImageEndpoint: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
  },
  {
    id: 'fal-ai/bytedance/seedance/v1.5/pro/text-to-video',
    displayName: 'Seedance v1.5 Pro Text to Video',
    brand: 'ByteDance',
    icon: 'ByteDanceLogo',
    mode: 'text-to-video',
    family: 'Seedance v1.5',
    qualityTier: 'High',
    description: 'ByteDance Seedance v1.5 Pro text-to-video via fal.ai.',
    supportsAudio: true,
    supportsResolution: true,
    pairedImageEndpoint: 'fal-ai/bytedance/seedance/v1.5/pro/image-to-video',
  },
  {
    id: 'fal-ai/veo3.1/lite',
    displayName: 'Veo 3.1 Lite',
    brand: 'Google',
    icon: 'GeminiLogo',
    mode: 'text-to-video',
    family: 'Veo 3.1',
    qualityTier: 'Balanced',
    description: 'Lightweight Google Veo 3.1 route via fal.ai for faster or cheaper generations.',
    supportsAudio: true,
    supportsNegativePrompt: true,
    supportsResolution: true,
    pairedImageEndpoint: 'fal-ai/veo3.1/lite/image-to-video',
  },
  {
    id: 'fal-ai/kling-video/o3/pro/text-to-video',
    displayName: 'Kling O3 Pro',
    brand: 'Kling AI',
    icon: 'KlingLogo',
    mode: 'text-to-video',
    family: 'Kling O3',
    qualityTier: 'Balanced',
    description: 'Kling O3 Pro text-to-video via fal.ai.',
    supportsNegativePrompt: true,
    pairedImageEndpoint: 'fal-ai/kling-video/o3/pro/image-to-video',
  },
  {
    id: 'fal-ai/wan/v2.7/text-to-video',
    displayName: 'Wan v2.7 Text to Video',
    brand: 'Wan',
    icon: 'WanLogo',
    mode: 'text-to-video',
    family: 'Wan v2.7',
    qualityTier: 'Balanced',
    description: 'Wan v2.7 text-to-video model on fal.ai.',
    supportsNegativePrompt: true,
  },
  {
    id: 'fal-ai/pixverse/v6/text-to-video',
    displayName: 'PixVerse v6 Text to Video',
    brand: 'PixVerse',
    icon: 'PixverseLogo',
    mode: 'text-to-video',
    family: 'PixVerse v6',
    qualityTier: 'Balanced',
    description: 'PixVerse v6 text-to-video via fal.ai, with optional audio switch support.',
    supportsAudio: true,
    supportsNegativePrompt: true,
    supportsResolution: true,
    audioField: 'generate_audio_switch',
    pairedImageEndpoint: 'fal-ai/pixverse/v6/image-to-video',
  },
  {
    id: 'fal-ai/minimax/hailuo-02/standard/text-to-video',
    displayName: 'Hailuo 02 Standard Text to Video',
    brand: 'MiniMax',
    icon: 'MinimaxLogo',
    mode: 'text-to-video',
    family: 'Hailuo 02',
    qualityTier: 'Balanced',
    description: 'MiniMax Hailuo 02 Standard text-to-video served by fal.ai.',
    pairedImageEndpoint: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
  },
  {
    id: 'fal-ai/wan-25-preview/text-to-video',
    displayName: 'Wan 2.5 Preview Text to Video',
    brand: 'Wan',
    icon: 'WanLogo',
    mode: 'text-to-video',
    family: 'Wan 2.5',
    qualityTier: 'Balanced',
    description: 'Wan 2.5 preview text-to-video model via fal.ai.',
    supportsNegativePrompt: true,
  },
  {
    id: 'fal-ai/kling-video/v1.6/pro/text-to-video',
    displayName: 'Kling Video v1.6 Pro',
    brand: 'Kling AI',
    icon: 'KlingLogo',
    mode: 'text-to-video',
    family: 'Kling v1.6',
    qualityTier: 'Balanced',
    description: 'Kling v1.6 Pro text-to-video via fal.ai.',
    supportsNegativePrompt: true,
  },
  {
    id: 'fal-ai/kling-video/v2.1/master/text-to-video',
    displayName: 'Kling Video v2.1 Master',
    brand: 'Kling AI',
    icon: 'KlingLogo',
    mode: 'text-to-video',
    family: 'Kling v2.1',
    qualityTier: 'Balanced',
    description: 'Kling v2.1 Master text-to-video via fal.ai.',
    supportsNegativePrompt: true,
  },
  {
    id: 'fal-ai/kling-video/v1.6/standard/text-to-video',
    displayName: 'Kling Video v1.6 Standard',
    brand: 'Kling AI',
    icon: 'KlingLogo',
    mode: 'text-to-video',
    family: 'Kling v1.6',
    qualityTier: 'Balanced',
    description: 'Kling v1.6 Standard text-to-video via fal.ai.',
    supportsNegativePrompt: true,
    pairedImageEndpoint: 'fal-ai/kling-video/v1.6/standard/image-to-video',
  },
  {
    id: 'fal-ai/bytedance/seedance/v1/pro/text-to-video',
    displayName: 'Seedance v1 Pro Text to Video',
    brand: 'ByteDance',
    icon: 'ByteDanceLogo',
    mode: 'text-to-video',
    family: 'Seedance v1',
    qualityTier: 'Balanced',
    description: 'ByteDance Seedance v1 Pro text-to-video via fal.ai.',
    supportsAudio: true,
    supportsResolution: true,
    pairedImageEndpoint: 'fal-ai/bytedance/seedance/v1/pro/image-to-video',
  },
  {
    id: 'fal-ai/kling-video/o3/standard/text-to-video',
    displayName: 'Kling O3 Standard',
    brand: 'Kling AI',
    icon: 'KlingLogo',
    mode: 'text-to-video',
    family: 'Kling O3',
    qualityTier: 'Fast',
    description: 'Kling O3 Standard text-to-video via fal.ai.',
    supportsNegativePrompt: true,
  },
  {
    id: 'wan/v2.6/text-to-video',
    displayName: 'Wan v2.6 Text to Video',
    brand: 'Wan',
    icon: 'WanLogo',
    mode: 'text-to-video',
    family: 'Wan v2.6',
    qualityTier: 'Fast',
    description: 'Wan v2.6 text-to-video model served through fal.ai.',
    supportsNegativePrompt: true,
  },
  {
    id: 'alibaba/happy-horse/text-to-video',
    displayName: 'Alibaba Happy Horse Text to Video',
    brand: 'Alibaba',
    icon: 'QwenLogo',
    mode: 'text-to-video',
    family: 'Happy Horse',
    qualityTier: 'Fast',
    description: 'Alibaba Happy Horse text-to-video model on fal.ai.',
    pairedImageEndpoint: 'alibaba/happy-horse/image-to-video',
  },
  {
    id: 'fal-ai/ltx-2.3-quality/text-to-video',
    displayName: 'LTX 2.3 Quality Text to Video',
    brand: 'LTX',
    icon: 'LtxLogo',
    mode: 'text-to-video',
    family: 'LTX 2.3',
    qualityTier: 'Fast',
    description: 'LTX 2.3 Quality text-to-video via fal.ai.',
    supportsAudio: true,
    supportsNegativePrompt: true,
    supportsResolution: true,
    pairedImageEndpoint: 'fal-ai/ltx-2.3-quality/image-to-video',
  },
  {
    id: 'fal-ai/ltx-2.3/text-to-video/fast',
    displayName: 'LTX 2.3 Fast Text to Video',
    brand: 'LTX',
    icon: 'LtxLogo',
    mode: 'text-to-video',
    family: 'LTX 2.3',
    qualityTier: 'Fast',
    description: 'LTX 2.3 Fast text-to-video route via fal.ai.',
    supportsAudio: true,
    supportsNegativePrompt: true,
    supportsResolution: true,
  },
  {
    id: 'fal-ai/ltx-video',
    displayName: 'LTX Video',
    brand: 'LTX',
    icon: 'LtxLogo',
    mode: 'text-to-video',
    family: 'LTX',
    qualityTier: 'Fast',
    description: 'Classic LTX Video text-to-video model via fal.ai.',
  },
  {
    id: 'bytedance/seedance-2.0/image-to-video',
    displayName: 'Seedance 2.0 Image to Video',
    brand: 'ByteDance',
    icon: 'ByteDanceLogo',
    mode: 'image-to-video',
    family: 'Seedance 2.0',
    qualityTier: 'Ultra',
    description: 'Seedance 2.0 image-to-video with synchronized audio and start/end frame control.',
    supportsAudio: true,
    supportsImageInput: true,
    imageField: 'image_url',
    endImageField: 'end_image_url',
    supportsResolution: true,
    pairedTextEndpoint: 'bytedance/seedance-2.0/text-to-video',
    pairedReferenceEndpoint: 'bytedance/seedance-2.0/reference-to-video',
  },
  {
    id: 'bytedance/seedance-2.0/reference-to-video',
    displayName: 'Seedance 2.0 Reference to Video',
    brand: 'ByteDance',
    icon: 'ByteDanceLogo',
    mode: 'reference-to-video',
    family: 'Seedance 2.0',
    qualityTier: 'Ultra',
    description: 'Seedance 2.0 reference-to-video with up to nine image references, native audio and cinematic camera control.',
    supportsAudio: true,
    supportsImageInput: true,
    supportsImageList: true,
    imageField: 'image_urls',
    supportsResolution: true,
    pairedTextEndpoint: 'bytedance/seedance-2.0/text-to-video',
  },
  {
    id: 'bytedance/seedance-2.0/fast/reference-to-video',
    displayName: 'Seedance 2.0 Fast Reference to Video',
    brand: 'ByteDance',
    icon: 'ByteDanceLogo',
    mode: 'reference-to-video',
    family: 'Seedance 2.0 Fast',
    qualityTier: 'High',
    description: 'Fast Seedance 2.0 reference-to-video with multiple image references and the same reference schema as the standard endpoint.',
    supportsAudio: true,
    supportsImageInput: true,
    supportsImageList: true,
    imageField: 'image_urls',
    supportsResolution: true,
    pairedTextEndpoint: 'bytedance/seedance-2.0/fast/text-to-video',
  },
  {
    id: 'fal-ai/kling-video/v3/pro/image-to-video',
    displayName: 'Kling Video v3 Pro Image to Video',
    brand: 'Kling AI',
    icon: 'KlingLogo',
    mode: 'image-to-video',
    family: 'Kling v3',
    qualityTier: 'Ultra',
    description: 'Kling v3 Pro image-to-video via fal.ai using a start image.',
    supportsAudio: true,
    supportsImageInput: true,
    imageField: 'start_image_url',
    supportsNegativePrompt: true,
    pairedTextEndpoint: 'fal-ai/kling-video/v3/pro/text-to-video',
  },
  {
    id: 'fal-ai/veo3.1/image-to-video',
    displayName: 'Veo 3.1 Image to Video',
    brand: 'Google',
    icon: 'GeminiLogo',
    mode: 'image-to-video',
    family: 'Veo 3.1',
    qualityTier: 'Ultra',
    description: 'Google Veo 3.1 image-to-video through fal.ai.',
    supportsAudio: true,
    supportsImageInput: true,
    imageField: 'image_url',
    supportsNegativePrompt: true,
    supportsResolution: true,
    pairedTextEndpoint: 'fal-ai/veo3.1',
  },
  {
    id: 'fal-ai/veo3.1/fast/image-to-video',
    displayName: 'Veo 3.1 Fast Image to Video',
    brand: 'Google',
    icon: 'GeminiLogo',
    mode: 'image-to-video',
    family: 'Veo 3.1',
    qualityTier: 'High',
    description: 'Fast Google Veo 3.1 image-to-video through fal.ai.',
    supportsAudio: true,
    supportsImageInput: true,
    imageField: 'image_url',
    supportsNegativePrompt: true,
    supportsResolution: true,
    pairedTextEndpoint: 'fal-ai/veo3.1/fast',
  },
  {
    id: 'fal-ai/kling-video/v3/standard/image-to-video',
    displayName: 'Kling Video v3 Standard Image to Video',
    brand: 'Kling AI',
    icon: 'KlingLogo',
    mode: 'image-to-video',
    family: 'Kling v3',
    qualityTier: 'High',
    description: 'Kling v3 Standard image-to-video via fal.ai.',
    supportsAudio: true,
    supportsImageInput: true,
    imageField: 'start_image_url',
    supportsNegativePrompt: true,
    pairedTextEndpoint: 'fal-ai/kling-video/v3/standard/text-to-video',
  },
  {
    id: 'fal-ai/kling-video/v2.6/pro/image-to-video',
    displayName: 'Kling Video v2.6 Pro Image to Video',
    brand: 'Kling AI',
    icon: 'KlingLogo',
    mode: 'image-to-video',
    family: 'Kling v2.6',
    qualityTier: 'High',
    description: 'Kling v2.6 Pro image-to-video via fal.ai.',
    supportsImageInput: true,
    imageField: 'image_url',
    supportsNegativePrompt: true,
    pairedTextEndpoint: 'fal-ai/kling-video/v2.6/pro/text-to-video',
  },
  {
    id: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
    displayName: 'Kling Video v2.5 Turbo Pro Image to Video',
    brand: 'Kling AI',
    icon: 'KlingLogo',
    mode: 'image-to-video',
    family: 'Kling v2.5 Turbo',
    qualityTier: 'High',
    description: 'Kling v2.5 Turbo Pro image-to-video via fal.ai.',
    supportsImageInput: true,
    imageField: 'image_url',
    supportsNegativePrompt: true,
    pairedTextEndpoint: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video',
  },
  {
    id: 'fal-ai/bytedance/seedance/v1.5/pro/image-to-video',
    displayName: 'Seedance v1.5 Pro Image to Video',
    brand: 'ByteDance',
    icon: 'ByteDanceLogo',
    mode: 'image-to-video',
    family: 'Seedance v1.5',
    qualityTier: 'High',
    description: 'ByteDance Seedance v1.5 Pro image-to-video via fal.ai.',
    supportsAudio: true,
    supportsImageInput: true,
    imageField: 'image_url',
    endImageField: 'end_image_url',
    supportsResolution: true,
    pairedTextEndpoint: 'fal-ai/bytedance/seedance/v1.5/pro/text-to-video',
  },
  {
    id: 'fal-ai/kling-video/v2.1/standard/image-to-video',
    displayName: 'Kling Video v2.1 Standard Image to Video',
    brand: 'Kling AI',
    icon: 'KlingLogo',
    mode: 'image-to-video',
    family: 'Kling v2.1',
    qualityTier: 'Balanced',
    description: 'Kling v2.1 Standard image-to-video via fal.ai.',
    supportsImageInput: true,
    imageField: 'image_url',
    supportsNegativePrompt: true,
  },
  {
    id: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
    displayName: 'Hailuo 02 Standard Image to Video',
    brand: 'MiniMax',
    icon: 'MinimaxLogo',
    mode: 'image-to-video',
    family: 'Hailuo 02',
    qualityTier: 'Balanced',
    description: 'MiniMax Hailuo 02 Standard image-to-video via fal.ai.',
    supportsImageInput: true,
    imageField: 'image_url',
    pairedTextEndpoint: 'fal-ai/minimax/hailuo-02/standard/text-to-video',
  },
  {
    id: 'fal-ai/veo3.1/lite/image-to-video',
    displayName: 'Veo 3.1 Lite Image to Video',
    brand: 'Google',
    icon: 'GeminiLogo',
    mode: 'image-to-video',
    family: 'Veo 3.1',
    qualityTier: 'Balanced',
    description: 'Google Veo 3.1 Lite image-to-video through fal.ai.',
    supportsAudio: true,
    supportsImageInput: true,
    imageField: 'image_url',
    supportsNegativePrompt: true,
    supportsResolution: true,
    pairedTextEndpoint: 'fal-ai/veo3.1/lite',
  },
  {
    id: 'fal-ai/kling-video/v1.6/standard/image-to-video',
    displayName: 'Kling Video v1.6 Standard Image to Video',
    brand: 'Kling AI',
    icon: 'KlingLogo',
    mode: 'image-to-video',
    family: 'Kling v1.6',
    qualityTier: 'Balanced',
    description: 'Kling v1.6 Standard image-to-video via fal.ai.',
    supportsImageInput: true,
    imageField: 'image_url',
    supportsNegativePrompt: true,
    pairedTextEndpoint: 'fal-ai/kling-video/v1.6/standard/text-to-video',
  },
  {
    id: 'fal-ai/kling-video/o3/pro/image-to-video',
    displayName: 'Kling O3 Pro Image to Video',
    brand: 'Kling AI',
    icon: 'KlingLogo',
    mode: 'image-to-video',
    family: 'Kling O3',
    qualityTier: 'Balanced',
    description: 'Kling O3 Pro image-to-video via fal.ai.',
    supportsImageInput: true,
    imageField: 'image_url',
    supportsNegativePrompt: true,
    pairedTextEndpoint: 'fal-ai/kling-video/o3/pro/text-to-video',
  },
  {
    id: 'fal-ai/bytedance/seedance/v1/pro/image-to-video',
    displayName: 'Seedance v1 Pro Image to Video',
    brand: 'ByteDance',
    icon: 'ByteDanceLogo',
    mode: 'image-to-video',
    family: 'Seedance v1',
    qualityTier: 'Balanced',
    description: 'ByteDance Seedance v1 Pro image-to-video via fal.ai.',
    supportsAudio: true,
    supportsImageInput: true,
    imageField: 'image_url',
    endImageField: 'end_image_url',
    supportsResolution: true,
    pairedTextEndpoint: 'fal-ai/bytedance/seedance/v1/pro/text-to-video',
  },
  {
    id: 'fal-ai/pixverse/v6/image-to-video',
    displayName: 'PixVerse v6 Image to Video',
    brand: 'PixVerse',
    icon: 'PixverseLogo',
    mode: 'image-to-video',
    family: 'PixVerse v6',
    qualityTier: 'Balanced',
    description: 'PixVerse v6 image-to-video via fal.ai.',
    supportsAudio: true,
    supportsImageInput: true,
    imageField: 'first_image_url',
    endImageField: 'end_image_url',
    supportsNegativePrompt: true,
    supportsResolution: true,
    audioField: 'generate_audio_switch',
    pairedTextEndpoint: 'fal-ai/pixverse/v6/text-to-video',
  },
  {
    id: 'alibaba/happy-horse/image-to-video',
    displayName: 'Alibaba Happy Horse Image to Video',
    brand: 'Alibaba',
    icon: 'QwenLogo',
    mode: 'image-to-video',
    family: 'Happy Horse',
    qualityTier: 'Fast',
    description: 'Alibaba Happy Horse image-to-video model on fal.ai.',
    supportsImageInput: true,
    imageField: 'image_url',
    pairedTextEndpoint: 'alibaba/happy-horse/text-to-video',
  },
  {
    id: 'fal-ai/ltx-2.3-quality/image-to-video',
    displayName: 'LTX 2.3 Quality Image to Video',
    brand: 'LTX',
    icon: 'LtxLogo',
    mode: 'image-to-video',
    family: 'LTX 2.3',
    qualityTier: 'Fast',
    description: 'LTX 2.3 Quality image-to-video via fal.ai.',
    supportsAudio: true,
    supportsImageInput: true,
    imageField: 'image_url',
    supportsNegativePrompt: true,
    supportsResolution: true,
    pairedTextEndpoint: 'fal-ai/ltx-2.3-quality/text-to-video',
  },
  {
    id: 'fal-ai/ltx-video-13b-distilled/image-to-video',
    displayName: 'LTX Video 13B Distilled Image to Video',
    brand: 'LTX',
    icon: 'LtxLogo',
    mode: 'image-to-video',
    family: 'LTX 13B',
    qualityTier: 'Fast',
    description: 'LTX Video 13B Distilled image-to-video through fal.ai.',
    supportsImageInput: true,
    imageField: 'image_url',
  },
  {
    id: 'fal-ai/wan/v2.2-a14b/image-to-video/lora',
    displayName: 'Wan v2.2 A14B Image to Video LoRA',
    brand: 'Wan',
    icon: 'WanLogo',
    mode: 'image-to-video',
    family: 'Wan v2.2',
    qualityTier: 'Fast',
    description: 'Wan v2.2 A14B image-to-video LoRA endpoint via fal.ai.',
    supportsImageInput: true,
    imageField: 'image_url',
    supportsNegativePrompt: true,
  },
  {
    id: 'nvidia/cosmos-3-super/image-to-video',
    displayName: 'NVIDIA Cosmos 3 Super Image to Video',
    brand: 'NVIDIA',
    icon: 'NvidiaLogo',
    mode: 'image-to-video',
    family: 'Cosmos 3',
    qualityTier: 'Fast',
    description: 'NVIDIA Cosmos 3 Super first-frame image-to-video model served by fal.ai.',
    supportsImageInput: true,
    imageField: 'image_url',
    supportsNegativePrompt: true,
  },
]);

const FAL_VIDEO_BY_ID = new Map();
for (const model of FAL_VIDEO_MODELS) {
  FAL_VIDEO_BY_ID.set(model.id, model);
}
for (const [alias, target] of Object.entries(LEGACY_FAL_VIDEO_ALIASES)) {
  if (FAL_VIDEO_BY_ID.has(target)) {
    FAL_VIDEO_BY_ID.set(alias, FAL_VIDEO_BY_ID.get(target));
  }
}

function normalizeFalVideoId(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'fal-ai/veo3/fast';
  return LEGACY_FAL_VIDEO_ALIASES[raw] || raw;
}

function compactTags(tags) {
  return [...new Set((tags || []).filter(Boolean).map(tag => String(tag).trim()).filter(Boolean))];
}

function inferFalVideoIcon(modelId, fallback = 'FalLogo') {
  const id = String(modelId || '').toLowerCase();
  if (/veo|gemini|google/.test(id)) return 'GeminiLogo';
  if (/sora|openai/.test(id)) return 'SoraLogo';
  if (/kling/.test(id)) return 'KlingLogo';
  if (/seedance|bytedance|doubao/.test(id)) return 'ByteDanceLogo';
  if (/pixverse/.test(id)) return 'PixverseLogo';
  if (/minimax|hailuo/.test(id)) return 'MinimaxLogo';
  if (/wan|alibaba|happy-horse/.test(id)) return 'WanLogo';
  if (/ltx/.test(id)) return 'LtxLogo';
  if (/nvidia|cosmos/.test(id)) return 'NvidiaLogo';
  if (/xai|grok/.test(id)) return 'GrokLogo';
  return fallback;
}

function inferFalVideoMode(modelId, category = '') {
  const haystack = `${modelId || ''} ${category || ''}`.toLowerCase();
  if (haystack.includes('image-to-video')) return 'image-to-video';
  if (haystack.includes('reference-to-video')) return 'reference-to-video';
  if (haystack.includes('video-to-video')) return 'video-to-video';
  if (haystack.includes('audio-to-video')) return 'audio-to-video';
  return 'text-to-video';
}

function tagsForFalVideoModel(definition) {
  const mode = definition.mode || inferFalVideoMode(definition.id);
  return compactTags([
    'fal.ai',
    'video',
    mode,
    definition.qualityTier && `quality:${String(definition.qualityTier).toLowerCase()}`,
    definition.brand && String(definition.brand).toLowerCase().replace(/\s+/g, '-'),
    definition.family && String(definition.family).toLowerCase().replace(/\s+/g, '-'),
    definition.supportsAudio ? 'audio' : null,
    definition.supportsImageInput ? 'image-input' : null,
    definition.supportsImageList ? 'multi-image' : null,
  ]);
}

function toFalVideoModelRecord(definition, index = 0, overrides = {}) {
  const id = normalizeFalVideoId(definition.id || definition.name || definition.endpoint);
  const mode = definition.mode || inferFalVideoMode(id, definition.category);
  const supportsImageInput = definition.supportsImageInput === true || mode === 'image-to-video' || mode === 'reference-to-video';
  const capabilities = {
    mode,
    qualityRank: index + 1,
    qualityTier: definition.qualityTier || 'Live',
    family: definition.family || null,
    brand: definition.brand || null,
    supportsTextPrompt: definition.supportsTextPrompt !== false,
    supportsImageInput,
    supportsAudio: Boolean(definition.supportsAudio),
    supportsNegativePrompt: Boolean(definition.supportsNegativePrompt),
    supportsResolution: Boolean(definition.supportsResolution),
    supportsImageList: Boolean(definition.supportsImageList),
    imageField: definition.imageField || (supportsImageInput ? 'image_url' : null),
    endImageField: definition.endImageField || null,
    audioField: definition.audioField || (definition.supportsAudio ? 'generate_audio' : null),
    pairedTextEndpoint: definition.pairedTextEndpoint || null,
    pairedImageEndpoint: definition.pairedImageEndpoint || null,
    pairedReferenceEndpoint: definition.pairedReferenceEndpoint || null,
  };

  return {
    id,
    name: id,
    displayName: definition.displayName || definition.title || formatFalVideoDisplayName(id),
    provider: FAL_VIDEO_PROVIDER,
    type: 'VIDEO',
    description: definition.description || definition.shortDescription || `${formatFalVideoDisplayName(id)} served by fal.ai.`,
    icon: definition.icon || inferFalVideoIcon(id),
    contextLength: null,
    pricing: {
      provider: FAL_VIDEO_PROVIDER,
      billing: 'per_generation',
      qualityRank: capabilities.qualityRank,
      qualityTier: capabilities.qualityTier,
      mode,
    },
    tags: tagsForFalVideoModel({ ...definition, id, mode, supportsImageInput }),
    syncSource: definition.syncSource || 'static_manifest',
    isActive: definition.isActive !== false,
    apiData: {
      fal: {
        endpoint: id,
        ...capabilities,
      },
      ...(definition.apiData || {}),
    },
    ...overrides,
  };
}

function listFalVideoModels() {
  return FAL_VIDEO_MODELS.map((definition, index) => toFalVideoModelRecord(definition, index));
}

function getFalVideoModelDefinition(modelId) {
  const normalized = normalizeFalVideoId(modelId);
  return FAL_VIDEO_BY_ID.get(normalized) || null;
}

function getFalVideoQualityRank(modelId) {
  const normalized = normalizeFalVideoId(modelId);
  const index = FAL_VIDEO_MODELS.findIndex(model => model.id === normalized);
  return index >= 0 ? index + 1 : 9999;
}

function sortFalVideoModels(models = []) {
  return [...(models || [])].sort((a, b) => {
    const rankA = getFalVideoQualityRank(a?.name || a?.id);
    const rankB = getFalVideoQualityRank(b?.name || b?.id);
    if (rankA !== rankB) return rankA - rankB;
    return String(a?.displayName || a?.name || '').localeCompare(String(b?.displayName || b?.name || ''));
  });
}

function formatFalVideoDisplayName(modelId) {
  const value = String(modelId || '')
    .replace(/^fal-ai\//, '')
    .replace(/^bytedance\//, 'ByteDance ')
    .replace(/^alibaba\//, 'Alibaba ')
    .replace(/^nvidia\//, 'NVIDIA ')
    .replace(/\//g, ' ')
    .replace(/-/g, ' ')
    .replace(/\bv(\d)/gi, 'v$1')
    .replace(/\bo3\b/gi, 'O3')
    .replace(/\bai\b/gi, 'AI')
    .replace(/\bapi\b/gi, 'API');
  return value.replace(/\b\w/g, char => char.toUpperCase()).replace(/\bV(\d)/g, 'v$1');
}

function isFalVideoModelId(modelId) {
  const normalized = normalizeFalVideoId(modelId);
  return FAL_VIDEO_BY_ID.has(normalized)
    || /(^|\/)(text-to-video|image-to-video|reference-to-video|video-to-video|audio-to-video)(\/|$)/i.test(normalized)
    || /veo|kling|sora|seedance|pixverse|hailuo|ltx|wan|happy-horse|cosmos|grok-imagine-video/i.test(normalized);
}

function resolveFalVideoModelRequest(modelId, { hasImage = false, imageCount = 0 } = {}) {
  const requested = normalizeFalVideoId(modelId);
  let definition = getFalVideoModelDefinition(requested);
  let endpoint = requested;
  let usingPairedEndpoint = false;
  const wantsReferenceInput = Boolean(hasImage && Number(imageCount || 0) > 1);

  if (!definition && isFalVideoModelId(requested)) {
    definition = {
      id: requested,
      displayName: formatFalVideoDisplayName(requested),
      icon: inferFalVideoIcon(requested),
      mode: inferFalVideoMode(requested),
      supportsImageInput: requested.includes('image-to-video') || requested.includes('reference-to-video'),
      supportsImageList: requested.includes('reference-to-video'),
      imageField: inferFalImageField(requested),
      supportsAudio: /veo|seedance|kling|pixverse|ltx/i.test(requested),
      supportsNegativePrompt: !/sora|seedance/i.test(requested),
      supportsResolution: /veo|seedance|sora|pixverse|ltx/i.test(requested),
      qualityTier: 'Live',
    };
  }

  if (!definition) {
    return {
      ok: false,
      code: 'UNKNOWN_FAL_VIDEO_MODEL',
      message: `El modelo de video "${requested}" no está registrado en el catálogo fal.ai de SiraGPT.`,
    };
  }

  const mode = definition.mode || inferFalVideoMode(endpoint);
  if (hasImage) {
    if (wantsReferenceInput && definition.pairedReferenceEndpoint) {
      endpoint = definition.pairedReferenceEndpoint;
      definition = getFalVideoModelDefinition(endpoint) || {
        ...definition,
        id: endpoint,
        mode: 'reference-to-video',
        supportsImageInput: true,
        supportsImageList: true,
        imageField: 'image_urls',
      };
      usingPairedEndpoint = true;
    } else if (definition.supportsImageInput || mode === 'image-to-video' || mode === 'reference-to-video') {
      endpoint = definition.id;
    } else if (definition.pairedImageEndpoint) {
      endpoint = definition.pairedImageEndpoint;
      definition = getFalVideoModelDefinition(endpoint) || { ...definition, id: endpoint, mode: inferFalVideoMode(endpoint), supportsImageInput: true };
      usingPairedEndpoint = true;
    } else {
      return {
        ok: false,
        code: 'MODEL_DOES_NOT_SUPPORT_IMAGE_TO_VIDEO',
        message: `${definition.displayName || requested} no soporta imagen a video en la integración actual. Elige un modelo Image to Video.`,
      };
    }
  } else if (mode === 'image-to-video' || mode === 'reference-to-video') {
    if (definition.pairedTextEndpoint) {
      endpoint = definition.pairedTextEndpoint;
      definition = getFalVideoModelDefinition(endpoint) || { ...definition, id: endpoint, mode: inferFalVideoMode(endpoint), supportsImageInput: false };
      usingPairedEndpoint = true;
    } else {
      return {
        ok: false,
        code: 'MODEL_REQUIRES_IMAGE',
        message: `${definition.displayName || requested} necesita una imagen inicial. Adjunta una imagen o elige un modelo Text to Video.`,
      };
    }
  }

  return {
    ok: true,
    requestedModel: requested,
    endpoint,
    model: toFalVideoModelRecord({ ...definition, id: endpoint }, Math.max(getFalVideoQualityRank(endpoint) - 1, 0)),
    usingPairedEndpoint,
  };
}

function inferFalImageField(endpoint) {
  const id = String(endpoint || '').toLowerCase();
  if (id.includes('reference-to-video')) return 'image_urls';
  if (id.includes('kling-video/v3')) return 'start_image_url';
  if (id.includes('pixverse')) return 'first_image_url';
  return 'image_url';
}

function inferFalEndImageField(endpoint) {
  const id = String(endpoint || '').toLowerCase();
  if (!/image-to-video|reference-to-video/.test(id)) return null;
  if (/kling-video\/v2\.(1|5)/.test(id)) return 'tail_image_url';
  if (/kling|seedance|pixverse/.test(id)) return 'end_image_url';
  return null;
}

function buildFalVideoInputPayload({
  endpoint,
  prompt,
  aspectRatio = '16:9',
  duration = '8s',
  negativePrompt,
  imageUrl,
  imageUrls,
  resolution = '720p',
  audio = true,
}) {
  const definition = getFalVideoModelDefinition(endpoint) || {
    id: endpoint,
    mode: inferFalVideoMode(endpoint),
    supportsImageInput: /image-to-video|reference-to-video/i.test(String(endpoint || '')),
    supportsImageList: String(endpoint || '').includes('reference-to-video'),
    imageField: inferFalImageField(endpoint),
    supportsAudio: /veo|seedance|kling|pixverse|ltx/i.test(endpoint),
    supportsNegativePrompt: !/sora|seedance/i.test(endpoint),
    supportsResolution: /veo|seedance|sora|pixverse|ltx/i.test(endpoint),
  };
  const id = String(endpoint || '').toLowerCase();
  const payload = { prompt };

  const normalizedAspectRatio = aspectRatio === 'auto' ? '16:9' : aspectRatio;
  if (!/hailuo/.test(id)) payload.aspect_ratio = normalizedAspectRatio;

  if (!/hailuo|cosmos/.test(id)) {
    payload.duration = normalizeFalDuration(duration, id);
  }

  if (definition.supportsResolution || /veo|seedance|sora|pixverse|ltx/.test(id)) {
    payload.resolution = normalizeFalResolution(resolution, id);
  }

  if ((definition.supportsAudio || /veo|seedance|kling|pixverse|ltx/.test(id)) && !/sora|hailuo|cosmos|wan/.test(id)) {
    payload[definition.audioField || (/pixverse/.test(id) ? 'generate_audio_switch' : 'generate_audio')] = Boolean(audio);
  }

  if (negativePrompt && (definition.supportsNegativePrompt || /veo|kling|pixverse|ltx|wan|cosmos/.test(id)) && !/sora|seedance/.test(id)) {
    payload.negative_prompt = negativePrompt;
  }

  const usableImageUrls = [
    ...(Array.isArray(imageUrls) ? imageUrls : []),
    imageUrl,
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);

  if (usableImageUrls.length > 0) {
    const imageField = definition.imageField || inferFalImageField(endpoint);
    if (definition.supportsImageList || imageField === 'image_urls' || id.includes('reference-to-video')) {
      payload.image_urls = usableImageUrls.slice(0, 9);
    } else {
      payload[imageField] = usableImageUrls[0];
      const endImageField = definition.endImageField || inferFalEndImageField(endpoint);
      if (endImageField && usableImageUrls.length > 1) {
        payload[endImageField] = usableImageUrls[usableImageUrls.length - 1];
      }
    }
  }

  return payload;
}

function normalizeFalDuration(duration, endpoint = '') {
  const raw = typeof duration === 'string' ? duration : `${duration || 8}`;
  const numeric = Math.min(Math.max(parseInt(raw, 10) || 8, 4), 15);
  const id = String(endpoint || '').toLowerCase();
  if (/kling|hailuo|wan|seedance|bytedance/.test(id)) return String(numeric);
  return `${numeric}s`;
}

function normalizeFalResolution(resolution, endpoint = '') {
  const raw = String(resolution || '720p').toLowerCase();
  if (/sora/.test(String(endpoint || '').toLowerCase())) {
    return raw === '480p' ? '720p' : raw;
  }
  return ['480p', '720p', '1080p'].includes(raw) ? raw : '720p';
}

function extractFalVideoUrl(result) {
  const data = result?.data || result || {};
  return data?.video?.url
    || data?.video_url
    || data?.url
    || data?.output?.video?.url
    || (Array.isArray(data?.videos) ? data.videos.find(item => item?.url)?.url : null)
    || (Array.isArray(data?.output) ? data.output.find(item => item?.url)?.url : null);
}

function normalizeFalExploreModel(item, index = 0) {
  const metadata = item?.metadata || {};
  const endpoint = item?.endpoint_id || item?.endpoint || item?.id || item?.modelId || item?.slug || item?.name;
  if (!endpoint || String(endpoint).endsWith('/api')) return null;
  if (!isFalVideoModelId(endpoint)) return null;
  const staticDefinition = getFalVideoModelDefinition(endpoint);
  return toFalVideoModelRecord({
    id: endpoint,
    displayName: metadata?.display_name || item?.title || item?.displayName || staticDefinition?.displayName || formatFalVideoDisplayName(endpoint),
    description: metadata?.description || item?.shortDescription || item?.description || staticDefinition?.description,
    icon: staticDefinition?.icon || inferFalVideoIcon(endpoint),
    brand: staticDefinition?.brand || item?.modelLab || metadata?.model_lab || null,
    family: staticDefinition?.family || item?.modelFamily || metadata?.model_family || null,
    mode: staticDefinition?.mode || inferFalVideoMode(endpoint, metadata?.category || item?.category || item?.group?.label),
    supportsImageInput: staticDefinition?.supportsImageInput,
    supportsAudio: staticDefinition?.supportsAudio,
    supportsNegativePrompt: staticDefinition?.supportsNegativePrompt,
    supportsResolution: staticDefinition?.supportsResolution,
    supportsImageList: staticDefinition?.supportsImageList,
    imageField: staticDefinition?.imageField,
    endImageField: staticDefinition?.endImageField,
    audioField: staticDefinition?.audioField,
    pairedTextEndpoint: staticDefinition?.pairedTextEndpoint,
    pairedImageEndpoint: staticDefinition?.pairedImageEndpoint,
    pairedReferenceEndpoint: staticDefinition?.pairedReferenceEndpoint,
    qualityTier: staticDefinition?.qualityTier || 'Live',
    syncSource: 'fal_live_catalog',
    isActive: true,
    apiData: { raw: item, metadata },
  }, Number.isFinite(index) ? index : 0, { syncSource: 'fal_live_catalog', isActive: true });
}

module.exports = {
  FAL_VIDEO_PROVIDER,
  FAL_VIDEO_MODELS,
  buildFalVideoInputPayload,
  extractFalVideoUrl,
  formatFalVideoDisplayName,
  getFalVideoModelDefinition,
  getFalVideoQualityRank,
  inferFalVideoIcon,
  inferFalVideoMode,
  isFalVideoModelId,
  listFalVideoModels,
  normalizeFalExploreModel,
  normalizeFalVideoId,
  resolveFalVideoModelRequest,
  sortFalVideoModels,
  toFalVideoModelRecord,
};
