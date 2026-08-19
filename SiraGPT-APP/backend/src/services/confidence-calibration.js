'use strict';

/**
 * confidence-calibration.js — "know when you don't know".
 * ───────────────────────────────────────────────────────────────────────────
 * Frontier assistants don't confidently fabricate when they lack information —
 * they hedge, ask a focused clarifying question, or state what's missing. This
 * module gives SiraGPT that judgment BEFORE it answers: it assesses how
 * answerable + unambiguous a request is and picks a response POSTURE, then
 * injects a directive so the model behaves accordingly.
 *
 * Postures (conservative — DEFAULT is just "answer"):
 *   answer             — clear + answerable → respond normally.
 *   answer_with_caveat — answerable but uncertain/high-stakes → answer + state
 *                        confidence and assumptions.
 *   clarify            — genuinely ambiguous/underspecified → ask ONE focused
 *                        question before committing (only when guessing is risky).
 *   ground_or_abstain  — needs info not available (real-time without search,
 *                        private data, a referenced doc not in scope) → don't
 *                        invent; say what's missing and answer what you can.
 *
 * Integrates existing signals (semantic intent `needs_clarification`, intent
 * triage `clarify`) rather than re-deriving them. Pure, deterministic, ES/EN.
 *
 * Public API:
 *   calibrate(input)            → CalibrationResult
 *   buildPostureDirective(res, opts?) → string (system-prompt block)
 *   summarizeForLog(res)        → string
 *   POSTURES
 */

const POSTURES = Object.freeze(['answer', 'answer_with_caveat', 'clarify', 'ground_or_abstain']);

// Real-time / freshness need: an answer that depends on "now" the model can't know.
const REALTIME_RX = /\b(precio|cotizaci[óo]n|tipo de cambio|clima|el tiempo|pron[óo]stico del tiempo|noticias?|resultado del partido|score|stock price|exchange rate|weather|news|headlines?)\b/i;
const FRESHNESS_RX = /\b(hoy|ahora|ahora mismo|actual(?:es|mente)?|en este momento|[úu]ltim[oa]s?|reciente(?:s|mente)?|este (?:a[ñn]o|mes|semana)|current(?:ly)?|latest|today|right now|this (?:year|month|week)|as of)\b/i;

// Private / account-bound data the assistant has no access to.
const PRIVATE_RX = /\b(mi (?:cuenta|pedido|saldo|factura|suscripci[óo]n|orden|tarjeta|contrase[ñn]a)|my (?:account|order|balance|invoice|subscription|card|password))\b/i;

// Reference to a document/file/image that may not be in scope.
const REFERENCE_RX = /\b(?:el|este|ese|la|esta|esa|mi|the|this|that|my)\s+(documento|archivo|imagen|pdf|c[óo]digo|adjunto|captura|foto|file|document|image|attachment|screenshot|code)\b/i;

// First-turn dangling imperatives with no object — "do it" / "fix it" with no
// referent and no history is genuinely ambiguous.
const DANGLING_IMPERATIVE_RX = /^\s*(h[áa]zlo|hazme(?:lo)?|mej[óo]ralo|arr[ée]glalo|corr[íi]gelo|anal[íi]zalo|res[úu]melo|tradu[czc]elo|optim[íi]zalo|contin[úu]a|sigue|dale|termina|complétalo|do it|fix it|improve it|analyze it|summari[sz]e it|continue|go on|finish it)\s*[.!?]*\s*$/i;
const VAGUE_OPENER_RX = /^\s*(ayuda(?:me)?|help|qu[ée] opinas|what do you think|y\s+(?:ahora|bien)|opciones|options)\s*[.!?]*\s*$/i;

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function detectMissingInfo(prompt, { hasGrounding, hasWebSearch, hasHistory } = {}) {
  const text = String(prompt || '');
  const missing = [];
  if (REALTIME_RX.test(text) && FRESHNESS_RX.test(text) && !hasWebSearch) {
    missing.push('real_time_data');
  }
  if (PRIVATE_RX.test(text)) {
    missing.push('private_account_data');
  }
  // A reference to "the document/file/image" with nothing in scope and no prior
  // turn that could have introduced it.
  if (REFERENCE_RX.test(text) && !hasGrounding && !hasHistory) {
    missing.push('referenced_artifact_not_in_scope');
  }
  return missing;
}

function detectAmbiguity(prompt, { hasHistory, hasGrounding } = {}) {
  const text = String(prompt || '').trim();
  const ambiguities = [];
  // Dangling imperatives are only ambiguous with NO history/grounding to bind to.
  if (DANGLING_IMPERATIVE_RX.test(text) && !hasHistory && !hasGrounding) {
    ambiguities.push('underspecified_target');
  }
  if (VAGUE_OPENER_RX.test(text) && !hasHistory) {
    ambiguities.push('vague_open_request');
  }
  return ambiguities;
}

function calibrate(rawInput) {
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const {
    prompt = '',
    difficulty = null,
    risk = null,
    hasGrounding = false,
    hasWebSearch = false,
    hasHistory = false,
    needsClarification = false,
    triageAction = null,
  } = input;

  const missingInfo = detectMissingInfo(prompt, { hasGrounding, hasWebSearch, hasHistory });
  const ambiguities = detectAmbiguity(prompt, { hasHistory, hasGrounding });
  const riskLevel = (risk && risk.level) || 'low';
  const bucket = (difficulty && difficulty.bucket) || 'simple';

  const reasons = [];
  let confidence = 0.85;
  if (missingInfo.length) { confidence -= 0.4; reasons.push(`missing:${missingInfo.join('/')}`); }
  if (ambiguities.length) { confidence -= 0.35; reasons.push(`ambiguous:${ambiguities.join('/')}`); }
  if (needsClarification) { confidence -= 0.3; reasons.push('semantic_needs_clarification'); }
  if (triageAction === 'clarify') { confidence -= 0.3; reasons.push('triage_clarify'); }
  if (riskLevel === 'high' && !hasGrounding) { confidence -= 0.15; reasons.push('high_risk_ungrounded'); }
  if (bucket === 'trivial') { confidence = Math.max(confidence, 0.8); } // small talk is fine
  confidence = clamp01(confidence);

  const band = confidence >= 0.7 ? 'high' : confidence >= 0.45 ? 'medium' : 'low';

  // ── Posture decision (conservative; default = answer) ───────────────
  let posture = 'answer';
  const wantsClarify = (ambiguities.length > 0) || needsClarification || triageAction === 'clarify';
  if (wantsClarify && bucket !== 'trivial') {
    posture = 'clarify';
  } else if (missingInfo.length > 0) {
    posture = 'ground_or_abstain';
  } else if ((riskLevel === 'high' && !hasGrounding && bucket !== 'trivial')
    || (band === 'medium' && (riskLevel !== 'low' || bucket === 'complex'))) {
    posture = 'answer_with_caveat';
  }

  return {
    posture,
    confidence: Math.round(confidence * 100) / 100,
    band,
    reasons,
    ambiguities,
    missingInfo,
  };
}

function buildPostureDirective(result, opts = {}) {
  if (!result || result.posture === 'answer') return '';
  const lang = (opts.language || 'es').slice(0, 2).toLowerCase();
  const es = lang !== 'en';
  let body = '';

  if (result.posture === 'clarify') {
    body = es
      ? 'La solicitud parece ambigua o incompleta. Si NO puedes inferir la intención con seguridad a partir del contexto, haz UNA sola pregunta de aclaración concreta y específica antes de responder. Si el contexto ya es suficiente, procede con tu mejor interpretación y dilo.'
      : 'The request seems ambiguous or incomplete. If you CANNOT confidently infer intent from context, ask ONE concrete, specific clarifying question before answering. If context is already enough, proceed with your best interpretation and say so.';
  } else if (result.posture === 'ground_or_abstain') {
    const what = result.missingInfo.includes('real_time_data')
      ? (es ? 'datos en tiempo real (precios/clima/noticias actuales)' : 'real-time data (current prices/weather/news)')
      : result.missingInfo.includes('private_account_data')
        ? (es ? 'datos privados de la cuenta del usuario' : "the user's private account data")
        : (es ? 'un documento/archivo que no está disponible en esta conversación' : 'a document/file not available in this conversation');
    body = es
      ? `Esta solicitud podría requerir ${what}, que no tienes. NO inventes ni adivines esos datos: indica explícitamente qué información falta y por qué, y luego entrega la mejor respuesta posible con lo que SÍ está disponible (principios generales, pasos, o cómo obtener el dato).`
      : `This request may require ${what}, which you don't have. Do NOT fabricate or guess it: state explicitly what's missing and why, then give the best answer you can with what IS available (general principles, steps, or how to get the data).`;
  } else if (result.posture === 'answer_with_caveat') {
    body = es
      ? `Tu confianza en este tema es media (${result.confidence}). Responde, pero indica tu nivel de confianza y señala explícitamente cualquier supuesto o limitación.`
      : `Your confidence here is medium (${result.confidence}). Answer, but state your confidence level and explicitly flag any assumptions or limitations.`;
  }
  if (!body) return '';
  const header = es ? 'POSTURA DE RESPUESTA' : 'RESPONSE POSTURE';
  const block = `\n\n## ${header} (${result.posture}, confianza ${result.confidence})\n${body}`;
  const max = Number(opts.maxChars) || 900;
  return block.length <= max ? block : `${block.slice(0, max - 1)}…`;
}

function summarizeForLog(result) {
  if (!result) return '[confidence-calibration] (no result)';
  return `[confidence-calibration] posture=${result.posture} confidence=${result.confidence} band=${result.band} `
    + `ambig=[${(result.ambiguities || []).join(',') || '-'}] missing=[${(result.missingInfo || []).join(',') || '-'}]`;
}

module.exports = {
  calibrate,
  buildPostureDirective,
  summarizeForLog,
  detectMissingInfo,
  detectAmbiguity,
  POSTURES,
};
