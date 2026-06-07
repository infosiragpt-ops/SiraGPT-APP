'use strict';

/**
 * memory-engine — explainable ranking + prompt assembly on top of the raw
 * active-memory recall. Pure & side-effect free (the caller owns store/recall).
 *
 * Its job: turn raw recalled entries into a ranked, EXPLAINABLE list the UI can
 * show ("recordado por: nombre, react") and a clean prompt block the model can
 * use. Ranking blends the store's relevance score with how many of the user's
 * own message topics the fact matches, plus a small recency/tier nudge.
 */

const STOPWORDS = new Set([
  // ES
  'que', 'cual', 'cuales', 'como', 'donde', 'cuando', 'para', 'por', 'con', 'los', 'las', 'una', 'uno',
  'mis', 'sus', 'del', 'desde', 'sobre', 'esto', 'esta', 'este', 'eso', 'esa', 'recuerdas', 'recuerda',
  'dime', 'dices', 'sabes', 'tengo', 'tienes', 'hace', 'hacer', 'puedes', 'quiero', 'algo', 'todo',
  // EN
  'what', 'which', 'where', 'when', 'how', 'the', 'and', 'for', 'with', 'you', 'your', 'this', 'that',
  'remember', 'know', 'tell', 'about', 'have', 'has', 'can', 'want', 'something', 'anything', 'mine',
]);

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Extract meaningful topic words from the user's message. */
function extractTopics(prompt, max = 10) {
  const seen = new Set();
  const topics = [];
  for (const raw of normalize(prompt).split(/[^a-z0-9.+#]+/)) {
    const w = raw.trim();
    if (w.length < 4 || STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    topics.push(w);
    if (topics.length >= max) break;
  }
  return topics;
}

/** A topic matches a fact if the fact contains it or its 5-char stem. */
function topicMatches(factNorm, topic) {
  if (factNorm.includes(topic)) return true;
  const stem = topic.slice(0, Math.min(5, topic.length));
  return stem.length >= 4 && factNorm.includes(stem);
}

function buildWhy(matchedTopics) {
  if (matchedTopics.length > 0) {
    return `Coincide con: ${matchedTopics.slice(0, 4).join(', ')}`;
  }
  return 'Relacionado con tu mensaje';
}

/**
 * Rank recalled entries by an explainable blended score.
 * @param {string} prompt the user's message
 * @param {Array} items recalled entries (each may carry a `score` from the store)
 * @param {object} [opts] { topics?: string[], limit?: number }
 * @returns ranked array of enriched items: { ...item, matchedTopics, why, rank }
 */
function rankRecall(prompt, items, opts = {}) {
  const list = Array.isArray(items) ? items.filter((m) => m && m.fact) : [];
  const topics = Array.isArray(opts.topics) && opts.topics.length ? opts.topics : extractTopics(prompt);
  const limit = opts.limit || 6;
  const now = Date.now();

  const ranked = list.map((item) => {
    const factNorm = normalize(item.fact);
    const matchedTopics = topics.filter((t) => topicMatches(factNorm, t));
    const storeScore = typeof item.score === 'number' ? Math.min(1, item.score) : 0;
    const topicScore = topics.length ? matchedTopics.length / topics.length : 0;
    const tierBoost = item.tier === 'long_term' ? 0.1 : 0;
    const ageMs = typeof item.createdAt === 'number' ? Math.max(0, now - item.createdAt) : null;
    const recencyBoost = ageMs !== null ? Math.max(0, 0.1 - ageMs / (90 * 86_400_000)) : 0;
    // Blend: store relevance (0.5) + topic overlap (0.35) + tier (0.1) + recency (0.05-ish)
    const blended = storeScore * 0.5 + topicScore * 0.35 + tierBoost + recencyBoost;
    return {
      ...item,
      matchedTopics,
      why: buildWhy(matchedTopics),
      blendedScore: Number(blended.toFixed(3)),
    };
  });

  ranked.sort((a, b) => b.blendedScore - a.blendedScore);
  return ranked.slice(0, limit).map((item, i) => ({ ...item, rank: i + 1 }));
}

/** Build the system-prompt memory block from ranked items. */
function buildBlock(items) {
  const list = Array.isArray(items) ? items.filter((m) => m && m.fact) : [];
  if (list.length === 0) return '';
  const lines = list.map((m) => `- ${m.fact}`).join('\n');
  return `\n\n## Memoria del usuario (recordada para este turno)\nUsa estos datos recordados cuando sean relevantes. No los repitas literalmente si no aportan.\n${lines}`;
}

module.exports = {
  extractTopics,
  topicMatches,
  rankRecall,
  buildBlock,
  STOPWORDS,
};
