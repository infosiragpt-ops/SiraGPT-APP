'use strict';

/**
 * Media generation (image / video / music / voice) inside «Fallos de
 * respuesta». A generation that errors or returns a degenerate result (0-byte
 * file, blank image, moderation refusal, timeout) is a failed request even
 * when the chat text reads fine: the user asked for a picture and got none.
 * Pure helpers shared by the agentic tools path (turn note) and the direct
 * composer routes (/ai/generate-image, -video, -music, -speech).
 */

const GENERATION_KINDS = {
  image: { subtype: 'generacion_imagen', label: 'Generación de imagen' },
  video: { subtype: 'generacion_video', label: 'Generación de video' },
  music: { subtype: 'generacion_musica', label: 'Generación de música' },
  speech: { subtype: 'generacion_voz', label: 'Generación de voz' },
};

const TOOL_KINDS = {
  generate_image: 'image',
  edit_image: 'image',
  generate_video: 'video',
  generate_music: 'music',
  generate_speech: 'speech',
};

const DEGENERATE_LABELS = {
  archivo_vacio: 'archivo vacío (0 bytes)',
  imagen_en_blanco: 'imagen en blanco',
};

// Order matters: the first match names the reason.
const REASONS = [
  { code: 'moderacion', label: 'rechazada por moderación', re: /moderat|safety|content[\s_-]?policy|policy[\s_-]?violation|prohibited|inappropriate|nsfw|content[\s_-]?filter|no\s+permitid|pol[ií]tica\s+de\s+contenido/i },
  { code: 'tiempo_agotado', label: 'tiempo agotado', re: /time[\s_-]?out|timed\s+out|ETIMEDOUT|deadline|tard[oó]\s+demasiado|tiempo\s+agotado/i },
  { code: 'sin_credito', label: 'sin saldo en el proveedor', re: /insufficient|credit|billing|payment\s+required|\b402\b|saldo|cr[eé]ditos/i },
  { code: 'limite', label: 'límite de peticiones del proveedor', re: /rate[\s_-]?limit|too\s+many\s+requests|RESOURCE_EXHAUSTED|quota|\b429\b/i },
  { code: 'clave', label: 'clave rechazada por el proveedor', re: /api[\s_-]?key|unauthori[sz]ed|\b401\b|forbidden|\b403\b/i },
  { code: 'vacio', label: 'el proveedor no devolvió resultado', re: /no\s+devolvi[oó]|did\s+not\s+return|no\s+(?:image|audio|video)\s+data|empty\s+(?:result|response)|sin\s+resultado/i },
  { code: 'ocupado', label: 'servicio ocupado', re: /busy|ocupad[oa]|overloaded|unavailable|\b503\b/i },
];

const PROVIDER_NAMES = {
  openai: 'OpenAI', google: 'Gemini', gemini: 'Gemini', fal: 'fal.ai', 'fal.ai': 'fal.ai',
  xai: 'xAI', openrouter: 'OpenRouter', elevenlabs: 'ElevenLabs', voicestudio: 'Sira Voz',
  minimax: 'MiniMax', suno: 'Suno', runway: 'Runway', luma: 'Luma', veo: 'Veo', replicate: 'Replicate',
};

function str(value, max = 300) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function generationKindOfTool(tool) {
  return TOOL_KINDS[String(tool || '').toLowerCase()] || null;
}

function generationMeta(kind) {
  return GENERATION_KINDS[kind] || null;
}

function providerName(provider) {
  const key = str(provider, 60).toLowerCase();
  if (!key) return '';
  return PROVIDER_NAMES[key] || str(provider, 40);
}

function generationReason({ message, code, degenerate } = {}) {
  if (degenerate) return { code: String(degenerate), label: DEGENERATE_LABELS[degenerate] || 'resultado inválido' };
  const text = `${str(code, 80)} ${str(message, 600)}`;
  for (const reason of REASONS) {
    if (reason.re.test(text)) return { code: reason.code, label: reason.label };
  }
  return { code: 'error', label: 'error del proveedor' };
}

/** «Generación de imagen: tiempo agotado · Gemini» — stable enough to group. */
function generationCause({ kind, provider, message, code, degenerate } = {}) {
  const meta = generationMeta(kind) || { label: 'Generación' };
  const reason = generationReason({ message, code, degenerate });
  const who = providerName(provider);
  return `${meta.label}: ${reason.label}${who ? ` · ${who}` : ''}`;
}

/**
 * Blank-image check for generated pictures: every colour channel flat
 * (stdev < 2 on 0..255). Best-effort: false on any decode problem, bounded
 * by `timeoutMs` so it never delays a response for long.
 */
async function isBlankImage(buffer, { timeoutMs = 1500 } = {}) {
  if (!buffer || !buffer.length) return false;
  let sharp;
  try { sharp = require('sharp'); } catch (_) { return false; }
  let timer;
  try {
    const stats = await Promise.race([
      sharp(buffer, { failOn: 'none', limitInputPixels: 64 * 1024 * 1024 }).stats(),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    if (!stats || !Array.isArray(stats.channels) || !stats.channels.length) return false;
    const colour = stats.channels.slice(0, 3);
    return colour.every((c) => Number.isFinite(c.stdev) && c.stdev < 2);
  } catch (_) {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  GENERATION_KINDS,
  TOOL_KINDS,
  DEGENERATE_LABELS,
  generationKindOfTool,
  generationMeta,
  generationReason,
  generationCause,
  providerName,
  isBlankImage,
};
