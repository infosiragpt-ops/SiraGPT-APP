/**
 * music-model-registry
 *
 * Single source of truth mapping the composer's user-facing music model
 * names to the provider that can actually generate them. Pure module
 * (no network, no side effects) so the chat route, the agent tool and the
 * contract tests all resolve identically.
 *
 * Honest provider map (verified):
 * - "Suno V4" / "Suno V3.5" → Suno-compatible gateway (SUNO_API_KEY +
 *   SUNO_API_BASE). Suno publishes NO official public API; this talks to a
 *   third-party gateway implementing the sunoapi.org contract
 *   (POST /api/v1/generate → poll GET /api/v1/generate/record-info).
 *   Without SUNO_API_KEY these selections fall back to a configured
 *   provider and the response labels the ACTUAL model used.
 * - "MiniMax" (also accepts the legacy "Mimo Max 02HD" spelling) →
 *   official MiniMax music API (MINIMAX_API_KEY).
 * - "ElevenLabs" → ElevenLabs Music (ELEVENLABS_API_KEY).
 * - "Lyria 3 Pro" → Google Lyria via OpenRouter (OPENROUTER_API_KEY).
 *   Lyria is the ONLY music model OpenRouter exposes.
 * - Fully-qualified slugs ("vendor/model") pass through to OpenRouter.
 */

const MODEL_IDS = Object.freeze({
  // Suno-compatible gateway model ids (sunoapi.org contract:
  // chirp-v3-5 / chirp-v4). Overridable per deployment.
  sunoV4: process.env.SUNO_V4_MODEL_ID || 'chirp-v4',
  sunoV35: process.env.SUNO_V35_MODEL_ID || 'chirp-v3-5',
  // Official MiniMax music API model. Overridable (e.g. music-3.0).
  minimax: process.env.MINIMAX_MUSIC_MODEL || process.env.MIMO_MUSIC_MODEL_ID || 'music-2.6',
  // Google Lyria 3 Pro on OpenRouter (streaming audio modalities).
  lyria: process.env.LYRIA_MODEL_ID || 'google/lyria-3-pro-preview',
});

const DISPLAY_LABELS = Object.freeze({
  sunoV4: 'Suno V4',
  sunoV35: 'Suno V3.5',
  minimax: 'MiniMax',
  elevenlabs: 'ElevenLabs Music',
  lyria: 'Lyria 3 Pro',
});

function normalise(value) {
  return String(value || '').toLowerCase().replace(/[\s_\-]+/g, '');
}

/**
 * Resolve any user-facing selection to { key, provider, gatewayModel, label }.
 * - provider ∈ 'suno' | 'minimax' | 'elevenlabs' | 'openrouter'
 * - gatewayModel is the id to send to that provider (MiniMax/Suno) or the
 *   OpenRouter slug (Lyria/custom).
 * - Unknown/empty values fall back to Suno V4 (the composer's default).
 */
function resolveMusicModel(selected) {
  const raw = String(selected || '').trim();
  if (raw.includes('/')) {
    return { key: 'custom', provider: 'openrouter', gatewayModel: raw, label: raw };
  }
  const norm = normalise(raw);
  if (!norm || norm === 'auto' || norm === 'default') {
    return { key: 'sunoV4', provider: 'suno', gatewayModel: MODEL_IDS.sunoV4, label: DISPLAY_LABELS.sunoV4 };
  }
  if (norm.includes('eleven')) {
    return { key: 'elevenlabs', provider: 'elevenlabs', gatewayModel: 'elevenlabs', label: DISPLAY_LABELS.elevenlabs };
  }
  if (norm.includes('lyria')) {
    return { key: 'lyria', provider: 'openrouter', gatewayModel: MODEL_IDS.lyria, label: DISPLAY_LABELS.lyria };
  }
  // "MiniMax" plus the legacy composer spelling "Mimo Max 02HD".
  if (norm.includes('minimax') || norm.includes('mimo') || norm.includes('02hd') || norm.includes('max02')) {
    return { key: 'minimax', provider: 'minimax', gatewayModel: MODEL_IDS.minimax, label: DISPLAY_LABELS.minimax };
  }
  if (norm.includes('suno') || norm === 'v4' || norm === 'chirpv4') {
    const isV35 = norm.includes('3.5') || norm.includes('35') || norm === 'chirpv35';
    return isV35
      ? { key: 'sunoV35', provider: 'suno', gatewayModel: MODEL_IDS.sunoV35, label: DISPLAY_LABELS.sunoV35 }
      : { key: 'sunoV4', provider: 'suno', gatewayModel: MODEL_IDS.sunoV4, label: DISPLAY_LABELS.sunoV4 };
  }
  if (norm === 'v3.5' || norm === 'v35') {
    return { key: 'sunoV35', provider: 'suno', gatewayModel: MODEL_IDS.sunoV35, label: DISPLAY_LABELS.sunoV35 };
  }
  return { key: 'sunoV4', provider: 'suno', gatewayModel: MODEL_IDS.sunoV4, label: DISPLAY_LABELS.sunoV4 };
}

function isElevenLabsSelection(selected) {
  return resolveMusicModel(selected).provider === 'elevenlabs';
}

module.exports = {
  resolveMusicModel,
  isElevenLabsSelection,
  MODEL_IDS,
  DISPLAY_LABELS,
};
