'use strict';

const {
  DEFAULT_XAI_BASE_URL,
  DEFAULT_XAI_CHAT_MODEL,
} = require('./xai-audio');

const DEFAULT_XAI_MODEL = DEFAULT_XAI_CHAT_MODEL;
const DEFAULT_OPENROUTER_MODEL = 'x-ai/grok-4.3';
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function resolveGrokVoiceProvider(env = process.env) {
  if (env.XAI_API_KEY) {
    return {
      id: 'xai',
      configured: true,
      apiKey: env.XAI_API_KEY,
      baseUrl: env.XAI_API_BASE_URL || env.XAI_BASE_URL || DEFAULT_XAI_BASE_URL,
      model: env.GROK_VOICE_MODEL || env.XAI_GROK_MODEL || DEFAULT_XAI_MODEL,
    };
  }

  if (env.OPENROUTER_API_KEY) {
    return {
      id: 'openrouter',
      configured: true,
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: env.OPENROUTER_API_BASE_URL || DEFAULT_OPENROUTER_BASE_URL,
      model: env.GROK_VOICE_MODEL || env.OPENROUTER_GROK_MODEL || DEFAULT_OPENROUTER_MODEL,
      referer: env.PUBLIC_APP_URL || env.FRONTEND_URL || 'https://siragpt.com',
    };
  }

  return {
    id: 'unconfigured',
    configured: false,
    model: env.GROK_VOICE_MODEL || DEFAULT_XAI_MODEL,
  };
}

function buildGrokVoiceMessages({ session, turn } = {}) {
  const recentTurns = Array.isArray(session?.turns)
    ? session.turns.slice(-6).map((item) => ({
        role: 'user',
        content: item.transcript || item.text || '',
      })).filter((item) => item.content)
    : [];

  return [
    {
      role: 'system',
      content: [
        'Eres el modo de voz lateral de SiraGPT.',
        'Responde en español claro y breve para que pueda leerse en voz alta.',
        'El panel de voz trabaja en paralelo: no bloquees ni reemplaces el chat normal.',
        'Si el usuario pide una accion de escritorio, explica el estado de seguridad sin afirmar que ya se ejecuto.',
      ].join(' '),
    },
    ...recentTurns,
    {
      role: 'user',
      content: turn?.transcript || '',
    },
  ];
}

async function callOpenAICompatibleChat({ provider, messages, fetchImpl }) {
  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== 'function') {
    throw Object.assign(new Error('fetch is not available for Grok voice replies'), {
      code: 'grok_voice_fetch_unavailable',
    });
  }

  const headers = {
    Authorization: `Bearer ${provider.apiKey}`,
    'Content-Type': 'application/json',
  };
  if (provider.id === 'openrouter') {
    headers['HTTP-Referer'] = provider.referer || 'https://siragpt.com';
    headers['X-Title'] = 'SiraGPT Voice Mode';
  }

  const response = await fetcher(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    // Bound the voice-turn reply so a stalled provider can't hang the request.
    // Shares GROK_VOICE_TIMEOUT_MS with the sibling xai-audio STT/TTS path.
    signal: AbortSignal.timeout(Number(process.env.GROK_VOICE_TIMEOUT_MS) || 30000),
    body: JSON.stringify({
      model: provider.model,
      messages,
      temperature: 0.4,
      max_tokens: 360,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `Grok voice request failed with ${response.status}`;
    throw Object.assign(new Error(message), {
      code: 'grok_voice_provider_failed',
      status: response.status,
      provider: provider.id,
    });
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw Object.assign(new Error('Grok voice provider returned an empty reply'), {
      code: 'grok_voice_empty_reply',
      provider: provider.id,
    });
  }

  return content.trim();
}

function buildDesktopActionReply(turn) {
  if (turn?.desktopAction?.status === 'blocked') {
    return 'Por seguridad, no puedo ejecutar esa accion desde el modo de voz. El chat normal sigue disponible.';
  }

  if (turn?.desktopAction?.actionRequired) {
    return 'Tengo preparada esa accion local, pero necesita el puente de escritorio antes de ejecutarse. Puedes seguir usando el chat normal.';
  }

  return null;
}

async function generateGrokVoiceReply({ session, turn, env = process.env, fetchImpl } = {}) {
  const desktopReply = buildDesktopActionReply(turn);
  if (desktopReply) {
    return {
      provider: 'local_policy',
      model: 'sira-voice-policy',
      configured: true,
      text: desktopReply,
      spoken: true,
    };
  }

  const provider = resolveGrokVoiceProvider(env);
  if (!provider.configured) {
    return {
      provider: provider.id,
      model: provider.model,
      configured: false,
      text: 'Recibi tu voz, pero falta configurar XAI_API_KEY u OPENROUTER_API_KEY para responder con Grok. El chat normal sigue disponible.',
      spoken: true,
    };
  }

  const text = await callOpenAICompatibleChat({
    provider,
    messages: buildGrokVoiceMessages({ session, turn }),
    fetchImpl,
  });

  return {
    provider: provider.id,
    model: provider.model,
    configured: true,
    text,
    spoken: true,
  };
}

module.exports = {
  DEFAULT_XAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  resolveGrokVoiceProvider,
  buildGrokVoiceMessages,
  generateGrokVoiceReply,
};
