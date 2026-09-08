'use strict';

/**
 * PageRank-lite + path/frequency heuristics.
 *
 * Aider ranks a tree-sitter tag graph with PageRank so hub files float.
 * This rewrite uses import-degree as edges and a damped PageRank (no
 * numpy, no tree-sitter). Path heuristics keep entrypoints visible even
 * when the header graph is sparse.
 */

const ENTRY_BONUS = /(^|\/)(main|index|App|app|page|mod)\.(tsx?|jsx?|py|go)$/;

function isTestPath(p) {
  return /(^|\/)(test|__tests__|spec|tests)\//.test(p) || /\.(test|spec)\./.test(p);
}

function pathHeuristic(filePath, query) {
  let s = 0;
  if (ENTRY_BONUS.test(filePath)) s += 4;
  if (/(^|\/)src\//.test(filePath)) s += 1.2;
  if (/(^|\/)(lib|services|components|hooks)\//.test(filePath)) s += 0.8;
  if (isTestPath(filePath)) s -= 1.5;
  const depth = String(filePath).split('/').filter(Boolean).length;
  s += Math.max(0, 5 - depth) * 0.25;
  const q = String(query || '').trim().toLowerCase();
  if (q) {
    const lower = String(filePath).toLowerCase();
    const base = lower.split('/').pop() || '';
    if (lower.includes(q)) s += 5;
    if (base.includes(q)) s += 3;
    if (base.replace(/\.[^.]+$/, '') === q) s += 4;
  }
  return s;
}

/**
 * Damped PageRank over a directed graph.
 * @param {string[]} nodes
 * @param {Map<string, string[]>} outgoing node → targets
 * @param {{iterations?: number, damping?: number}} [opts]
 * @returns {Map<string, number>}
 */
function pageRank(nodes, outgoing, opts = {}) {
  const n = nodes.length;
  const scores = new Map();
  if (!n) return scores;
  const damping = Number.isFinite(opts.damping) ? opts.damping : 0.85;
  const iterations = Number.isFinite(opts.iterations) ? opts.iterations : 12;
  const base = (1 - damping) / n;
  for (const node of nodes) scores.set(node, 1 / n);

  const incoming = new Map();
  for (const node of nodes) incoming.set(node, []);
  for (const [from, targets] of outgoing) {
    const unique = [...new Set(targets || [])].filter((t) => incoming.has(t));
    for (const t of unique) incoming.get(t).push(from);
  }

  for (let i = 0; i < iterations; i += 1) {
    const next = new Map();
    for (const node of nodes) {
      let inbound = 0;
      for (const from of incoming.get(node) || []) {
        const outs = (outgoing.get(from) || []).filter((t) => scores.has(t));
        const deg = outs.length || 1;
        inbound += (scores.get(from) || 0) / deg;
      }
      next.set(node, base + damping * inbound);
    }
    for (const node of nodes) scores.set(node, next.get(node));
  }
  return scores;
}

function normalizeScores(entries) {
  const max = entries.reduce((m, e) => Math.max(m, e.raw), 0);
  const min = entries.reduce((m, e) => Math.min(m, e.raw), Infinity);
  const span = max - min;
  return entries.map((e) => {
    const score = span <= 0 ? (entries.length ? 1 : 0) : (e.raw - min) / span;
    return { ...e, score: Number(score.toFixed(4)) };
  });
}

function combineScores({ path, symbols, importedBy, ranks, query }) {
  const pr = ranks.get(path) || 0;
  const refs = importedBy.get(path) || 0;
  return pr * 10 + pathHeuristic(path, query) + refs * 2.5 + Math.min((symbols || []).length, 6);
}

module.exports = {
  ENTRY_BONUS,
  isTestPath,
  pathHeuristic,
  pageRank,
  normalizeScores,
  combineScores,
};
