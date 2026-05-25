'use strict';

/**
 * conversational-momentum-tracker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Tracks whether the user is pushing toward a single coherent goal
 * (high momentum) or jumping between unrelated tasks (low momentum).
 * The orchestrator can use the signal to adapt response style:
 *
 *   • High momentum (≥ 0.7): user is iterating on one thing — keep
 *     answers concise, reference prior turns, skip the recap.
 *   • Medium momentum (0.4–0.7): user is exploring a domain — answer
 *     normally, recap when shifting sub-topics.
 *   • Low momentum (< 0.4): user is task-hopping — front-load context,
 *     ask clarifying questions, avoid assuming continuity.
 *
 * Momentum signal is computed from a per-(userId, chatId) buffer of
 * recent turn profiles. Three components blend:
 *
 *   • intentContinuity: fraction of the last N turns with the same
 *     dominant intent kind as the current one.
 *   • topicContinuity: jaccard between the current turn's top-features
 *     set and the union of the last N turns' top-features.
 *   • temporalCohesion: 1 minus the variance of inter-turn time gaps
 *     (rapid back-and-forth = high cohesion; long pauses between
 *     unrelated turns = low cohesion).
 *
 * Stored in-memory, capped per chat. Pure JS, < 1 ms per call.
 *
 * Public API:
 *   recordTurn({ userId, chatId, intentKind?, features?, now? })
 *       → void
 *   computeMomentum({ userId, chatId })
 *       → MomentumReport
 *   buildMomentumBlock(report, opts?)
 *       → string (prompt block — empty when low confidence)
 *   getRecent({ userId, chatId, limit? })
 *       → turn buffer slice
 *   clear({ userId, chatId? })
 *       → void
 *   stats()
 *       → { chats, totalTurns }
 *
 * Tunables (env):
 *   SIRAGPT_MOMENTUM_BUFFER_SIZE       (default 12)
 *   SIRAGPT_MOMENTUM_MIN_TURNS         (default 2)
 *   SIRAGPT_MOMENTUM_HIGH_THRESHOLD    (default 0.70)
 *   SIRAGPT_MOMENTUM_LOW_THRESHOLD     (default 0.40)
 */

const BUFFER_SIZE = Math.max(2, Number(process.env.SIRAGPT_MOMENTUM_BUFFER_SIZE) || 12);
const MIN_TURNS = Math.max(1, Number(process.env.SIRAGPT_MOMENTUM_MIN_TURNS) || 2);
const HIGH_THRESHOLD = Number(process.env.SIRAGPT_MOMENTUM_HIGH_THRESHOLD) || 0.70;
const LOW_THRESHOLD = Number(process.env.SIRAGPT_MOMENTUM_LOW_THRESHOLD) || 0.40;

const buffers = new Map();

const keyFor = (userId, chatId) => `${userId || 'anon'}::${chatId || 'default'}`;

function getOrCreate(userId, chatId) {
  const k = keyFor(userId, chatId);
  let buf = buffers.get(k);
  if (!buf) { buf = []; buffers.set(k, buf); }
  return buf;
}

function topFeaturesFromArray(features = []) {
  if (!Array.isArray(features)) return new Set();
  return new Set(
    features.slice(0, 12)
      .map((f) => String(f?.label || f?.value || f).toLowerCase())
      .filter(Boolean),
  );
}

function recordTurn({ userId, chatId, intentKind = null, features = [], now = Date.now() } = {}) {
  const buf = getOrCreate(userId, chatId);
  buf.push({
    intentKind: intentKind ? String(intentKind).toLowerCase() : null,
    features: topFeaturesFromArray(features),
    timestamp: now,
  });
  while (buf.length > BUFFER_SIZE) buf.shift();
}

function jaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [s, l] = a.size <= b.size ? [a, b] : [b, a];
  for (const v of s) if (l.has(v)) inter += 1;
  if (inter === 0) return 0;
  return inter / (a.size + b.size - inter);
}

function temporalCohesion(turns) {
  if (turns.length < 3) return 0.5;
  const gaps = [];
  for (let i = 1; i < turns.length; i += 1) gaps.push(turns[i].timestamp - turns[i - 1].timestamp);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (mean <= 0) return 0.5;
  const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
  const stddev = Math.sqrt(variance);
  const coefficient = stddev / mean;
  // Normalise coefficient → cohesion (high CoV = low cohesion).
  return Math.max(0, Math.min(1, 1 - Math.min(1, coefficient / 2)));
}

function classify(value) {
  if (value >= HIGH_THRESHOLD) return 'high';
  if (value >= LOW_THRESHOLD) return 'medium';
  return 'low';
}

function computeMomentum({ userId, chatId } = {}) {
  const buf = buffers.get(keyFor(userId, chatId));
  if (!buf || buf.length < MIN_TURNS) {
    return { momentum: 0, classification: 'unknown', samples: buf?.length || 0, reason: 'insufficient turns' };
  }
  const current = buf[buf.length - 1];
  const earlier = buf.slice(0, -1);
  // intentContinuity
  let intentMatches = 0;
  for (const t of earlier) if (t.intentKind && current.intentKind && t.intentKind === current.intentKind) intentMatches += 1;
  const intentContinuity = earlier.length === 0 ? 0 : intentMatches / earlier.length;
  // topicContinuity
  const earlierUnion = new Set();
  for (const t of earlier) for (const f of t.features) earlierUnion.add(f);
  const topicContinuity = jaccard(current.features, earlierUnion);
  // temporalCohesion
  const cohesion = temporalCohesion(buf);
  // blend
  const momentum = Number((0.5 * intentContinuity + 0.35 * topicContinuity + 0.15 * cohesion).toFixed(3));

  return {
    momentum,
    classification: classify(momentum),
    samples: buf.length,
    components: {
      intentContinuity: Number(intentContinuity.toFixed(3)),
      topicContinuity: Number(topicContinuity.toFixed(3)),
      temporalCohesion: Number(cohesion.toFixed(3)),
    },
    currentIntent: current.intentKind,
    currentFeatures: [...current.features],
  };
}

function buildMomentumBlock(report, opts = {}) {
  if (!report || report.classification === 'unknown') return '';
  const lines = ['\n\n<conversational_momentum>'];
  lines.push(`Nivel: ${report.classification} (momentum ${report.momentum}).`);
  if (report.components) {
    lines.push(`Componentes: intent=${report.components.intentContinuity}, topic=${report.components.topicContinuity}, temporal=${report.components.temporalCohesion}.`);
  }
  if (report.classification === 'high') {
    lines.push('El usuario está iterando sobre un mismo tema — respuestas concisas, evita re-introducir contexto que ya manejamos.');
  } else if (report.classification === 'medium') {
    lines.push('Conversación en exploración — responde normalmente y reconecta cuando cambies de sub-tema.');
  } else {
    lines.push('Tema saltando — front-loadea contexto, valida supuestos antes de profundizar.');
  }
  lines.push('</conversational_momentum>');
  const text = lines.join('\n');
  const max = Number(opts.maxChars) || 700;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function getRecent({ userId, chatId, limit = 8 } = {}) {
  const buf = buffers.get(keyFor(userId, chatId));
  if (!buf) return [];
  const n = Math.max(1, Math.min(buf.length, limit));
  return buf.slice(-n).map((t) => ({ intentKind: t.intentKind, timestamp: t.timestamp, featureCount: t.features.size }));
}

function clear({ userId, chatId } = {}) {
  if (userId && chatId) {
    buffers.delete(keyFor(userId, chatId));
    return;
  }
  if (userId) {
    const prefix = `${userId}::`;
    for (const k of buffers.keys()) if (k.startsWith(prefix)) buffers.delete(k);
    return;
  }
  buffers.clear();
}

function stats() {
  let totalTurns = 0;
  for (const buf of buffers.values()) totalTurns += buf.length;
  return { chats: buffers.size, totalTurns };
}

const __resetForTests = () => buffers.clear();

module.exports = {
  recordTurn,
  computeMomentum,
  buildMomentumBlock,
  getRecent,
  clear,
  stats,
  __resetForTests,
  BUFFER_SIZE,
  HIGH_THRESHOLD,
  LOW_THRESHOLD,
};
