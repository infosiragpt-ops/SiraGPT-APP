'use strict';

/**
 * followup-suggestions — genera 3-5 preguntas de seguimiento que el usuario
 * podría hacer a continuación, a partir de la cola de la conversación.
 *
 * Functionality pattern inspired by Open WebUI's follow_up_generation task
 * (https://github.com/open-webui/open-webui — Open WebUI License); the
 * implementation below is an original rewrite for SiraGPT: Spanish-first
 * prompt, free-tier model (Cerebras/FlashGPT — zero marginal cost), strict
 * JSON parsing with fail-open, and hard caps so the endpoint can never be
 * abused into a general chat proxy.
 *
 * Injectable client for offline tests.
 */

const { createCerebrasClient, getCerebrasConfig, isFreeIaConfigured } = require('./ai/cerebras-client');
const { normalizeStructuredPromptSection } = require('./agents/prompt-cache-stability');

const MAX_HISTORY_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 2000;
const MAX_SUGGESTIONS = 5;
const MIN_SUGGESTIONS = 3;
const MAX_SUGGESTION_CHARS = 160;

const SYSTEM_PROMPT = [
  'Genera preguntas de seguimiento que el USUARIO podría hacer a continuación en esta conversación.',
  'Reglas:',
  `- Devuelve entre ${MIN_SUGGESTIONS} y ${MAX_SUGGESTIONS} preguntas, escritas desde el punto de vista del usuario, dirigidas al asistente.`,
  '- Concretas, cortas (máx ~15 palabras) y directamente relacionadas con lo conversado.',
  '- No repitas lo que ya se respondió; profundiza o abre el siguiente paso natural.',
  '- Usa el idioma dominante de la conversación (español si es mixta).',
  '- Responde SOLO un objeto JSON: {"follow_ups": ["¿…?", "¿…?", "¿…?"]} — sin texto extra, sin markdown.',
].join('\n');

/** Trim + cap the conversation tail into a compact transcript for the prompt. */
function buildTranscript(messages) {
  const rows = [];
  const tail = (Array.isArray(messages) ? messages : []).slice(-MAX_HISTORY_MESSAGES);
  for (const m of tail) {
    const role = String(m?.role || '').toLowerCase() === 'assistant' ? 'ASISTENTE' : 'USUARIO';
    const content = normalizeStructuredPromptSection(String(m?.content || '')).slice(0, MAX_MESSAGE_CHARS);
    if (content) rows.push(`${role}: ${content}`);
  }
  return rows.join('\n\n');
}

/** Tolerant JSON extraction: bare object, fenced block, or prose-wrapped. */
function parseFollowUps(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);
  const brace = text.indexOf('{');
  if (brace > 0) candidates.push(text.slice(brace));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const list = Array.isArray(parsed?.follow_ups) ? parsed.follow_ups : null;
      if (!list) continue;
      const cleaned = list
        .map((s) => String(s || '').trim().slice(0, MAX_SUGGESTION_CHARS))
        .filter(Boolean)
        .slice(0, MAX_SUGGESTIONS);
      if (cleaned.length >= 1) return cleaned;
    } catch { /* try next candidate */ }
  }
  return null;
}

/**
 * Generate follow-up suggestions for a conversation tail.
 * @param {Array<{role:string,content:string}>} messages — chat tail (user+assistant)
 * @param {object} [deps] — { createClient, env } injectable for tests
 * @returns {Promise<{ok:boolean, followUps?:string[], error?:string}>}
 */
async function generateFollowUps(messages, deps = {}) {
  const env = deps.env || process.env;
  const transcript = buildTranscript(messages);
  if (!transcript) return { ok: false, error: 'empty_conversation' };
  if (!isFreeIaConfigured({ env })) return { ok: false, error: 'ai_unavailable' };

  try {
    const client = deps.createClient ? deps.createClient({ env }) : createCerebrasClient({ env });
    if (!client) return { ok: false, error: 'ai_unavailable' };
    const { model } = getCerebrasConfig({ env });
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Conversación:\n\n${transcript}\n\nJSON:` },
      ],
      max_tokens: 300,
      temperature: 0.6,
    });
    const raw = completion?.choices?.[0]?.message?.content || '';
    const followUps = parseFollowUps(raw);
    if (!followUps) return { ok: false, error: 'parse_failed' };
    return { ok: true, followUps };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 160) };
  }
}

module.exports = {
  generateFollowUps,
  buildTranscript,
  parseFollowUps,
  SYSTEM_PROMPT,
  MAX_HISTORY_MESSAGES,
  MAX_SUGGESTIONS,
};