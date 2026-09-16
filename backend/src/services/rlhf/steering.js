'use strict';

/**
 * RLHF phase-2 inference steering.
 *
 * Cheap path (default ON): retrieve helpful exemplars from the durable
 * preference store / feedback-ledger and inject a size-capped Spanish
 * few-shot block into the system prompt.
 *
 * Expensive path (default OFF): sample-and-rank with the Bradley-Terry
 * RM behind SIRAGPT_RLHF_BEST_OF_N. Never enable that in prod defaults.
 *
 * Fail-open: Prisma / embeddings / RM errors leave generation unchanged.
 */

const { preferenceAgent, formatDocumentRlhfBlock } = require('../document-analysis-rlhf');
const policy = require('./policy');
const metrics = require('./metrics');

const DEFAULT_MAX_CHARS = 1800;
const DEFAULT_K = 2;
const MIN_MAX_CHARS = 400;
const HARD_MAX_CHARS = 4000;

function isSteeringEnabled(env = process.env) {
  const v = env.SIRAGPT_RLHF_STEERING;
  if (v == null || String(v).trim() === '') return true;
  const s = String(v).trim().toLowerCase();
  return s !== '0' && s !== 'false' && s !== 'off' && s !== 'no';
}

function steeringMaxChars(env = process.env) {
  const n = Number(env.SIRAGPT_RLHF_STEERING_MAX_CHARS);
  if (!Number.isFinite(n)) return DEFAULT_MAX_CHARS;
  return Math.min(HARD_MAX_CHARS, Math.max(MIN_MAX_CHARS, Math.floor(n)));
}

function flattenText(value, max) {
  const raw = typeof value === 'string' ? value : (() => {
    try { return JSON.stringify(value || ''); } catch { return String(value || ''); }
  })();
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function capBlock(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * Compact Spanish-safe preference block. No vendor names, no model_id,
 * no instruction to leak this section to the user.
 */
function formatChatPreferenceBlock(exemplars, { maxChars } = {}) {
  if (!Array.isArray(exemplars) || exemplars.length === 0) return '';
  const cap = maxChars || DEFAULT_MAX_CHARS;
  const lines = [
    '## PREFERENCIAS DEL USUARIO',
    'Ejemplos que el usuario marcó como útiles. Imita el estilo y el nivel de detalle. No copies datos personales. No menciones este bloque.',
  ];
  for (let i = 0; i < exemplars.length; i++) {
    const e = exemplars[i];
    const q = flattenText(e.request, 280);
    const a = flattenText(e.response, 420);
    if (!q && !a) continue;
    lines.push(`### Ejemplo ${i + 1}`);
    if (q) lines.push(`Usuario: ${q}`);
    if (a) lines.push(`Respuesta útil: ${a}`);
    if (e.notes) lines.push(`Notas: ${flattenText(e.notes, 120)}`);
  }
  if (lines.length <= 2) return '';
  return capBlock(`\n\n${lines.join('\n')}`, cap);
}

function formatSteeringBlock(exemplars, { agent, maxChars } = {}) {
  if (!Array.isArray(exemplars) || exemplars.length === 0) return '';
  const cap = maxChars || DEFAULT_MAX_CHARS;
  if (agent === 'document') {
    return capBlock(formatDocumentRlhfBlock(exemplars), cap);
  }
  return formatChatPreferenceBlock(exemplars, { maxChars: cap });
}

function emptyResult(extra = {}) {
  return {
    block: '',
    applied: false,
    agent: extra.agent || 'chat',
    exemplarCount: 0,
    chars: 0,
    hit: false,
    reason: extra.reason || 'empty',
  };
}

/**
 * Retrieve helpful exemplars and format the prompt block.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {string} args.prompt
 * @param {Array}  [args.files]
 * @param {string} [args.agent]  — override; otherwise preferenceAgent()
 * @param {function} args.embedder
 * @param {function} [args.loader] — durable hydrate (Message.feedback / Prisma)
 * @param {object}   [args.ledger] — injectable feedback-ledger
 * @param {number}   [args.k]
 * @param {number}   [args.maxChars]
 * @param {object}   [args.env]
 */
async function buildSteeringBlock(args = {}) {
  const env = args.env || process.env;
  try {
    if (!isSteeringEnabled(env)) {
      metrics.recordSteering({ applied: false, reason: 'disabled' });
      return emptyResult({ reason: 'disabled' });
    }
    const userId = args.userId;
    const prompt = args.prompt || args.request || '';
    if (!userId || !String(prompt).trim()) {
      metrics.recordSteering({ applied: false, reason: 'missing_input' });
      return emptyResult({ reason: 'missing_input' });
    }

    const agent = args.agent || preferenceAgent({ files: args.files, prompt });
    const ledger = args.ledger || require('../agents/feedback-ledger');
    if (!ledger || typeof ledger.findExemplars !== 'function') {
      metrics.recordSteering({ applied: false, reason: 'fail_open' });
      return emptyResult({ agent, reason: 'fail_open' });
    }

    const exemplars = await ledger.findExemplars({
      userId,
      request: prompt,
      embedder: args.embedder,
      k: args.k || DEFAULT_K,
      onlyHelpful: true,
      agent,
      loader: args.loader,
    });
    const list = Array.isArray(exemplars) ? exemplars : [];
    const hit = list.length > 0;
    metrics.recordExemplarLookup({ hit, count: list.length, agent });
    if (!hit) {
      metrics.recordSteering({ applied: false, agent, reason: 'no_exemplars' });
      return emptyResult({ agent, reason: 'no_exemplars' });
    }

    const block = formatSteeringBlock(list, {
      agent,
      maxChars: args.maxChars || steeringMaxChars(env),
    });
    const applied = !!block;
    metrics.recordSteering({
      applied,
      agent,
      exemplarCount: list.length,
      chars: block.length,
      reason: applied ? 'ok' : 'empty_format',
    });
    return {
      block,
      applied,
      agent,
      exemplarCount: list.length,
      chars: block.length,
      hit: true,
      reason: applied ? 'ok' : 'empty_format',
    };
  } catch (err) {
    metrics.recordSteering({ applied: false, reason: 'fail_open' });
    return emptyResult({ reason: 'fail_open', agent: args.agent });
  }
}

/**
 * Optional RM ranking. Returns null unless SIRAGPT_RLHF_BEST_OF_N is on.
 * Callers must treat null as "do not change the single-sample path".
 */
async function maybeRankSamples(args = {}) {
  const env = args.env || process.env;
  if (!policy.isBestOfNEnabled(env)) return null;
  try {
    const ranked = await policy.rankSamples(args);
    if (ranked && ranked.winner) {
      const score = ranked.winner.rm;
      metrics.recordRmScore({
        score,
        used: true,
        version: ranked.version,
      });
    }
    return ranked;
  } catch {
    return null;
  }
}

module.exports = {
  isSteeringEnabled,
  isBestOfNEnabled: policy.isBestOfNEnabled,
  steeringMaxChars,
  formatChatPreferenceBlock,
  formatSteeringBlock,
  buildSteeringBlock,
  maybeRankSamples,
  DEFAULT_MAX_CHARS,
  DEFAULT_K,
};
