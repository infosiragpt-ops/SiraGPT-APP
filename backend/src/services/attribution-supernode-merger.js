'use strict';

/**
 * attribution-supernode-merger.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Clusters semantically-similar attribution features into "supernodes"
 * (themes) so downstream prompt blocks don't drown the model in a long
 * list of near-duplicates. Inspired by the supernode aggregation used in
 * Anthropic's circuit-tracing toolkit.
 *
 * Greedy single-link clustering by lexical jaccard (default ≥ 0.30) +
 * optional embedding cosine (default ≥ 0.85). Different feature kinds
 * never merge with each other. Aggregate weight = seed weight + a
 * diminishing log-bonus for group size.
 *
 * Public API:
 *   mergeFeatures(features, opts?)        → { supernodes, residuals, stats }
 *   buildSupernodeBlock(merge, opts?)     → inert prompt-block string
 *   tokenize / tokenSet / jaccard / cosineSim — helpers exported for tests
 *
 * Tunables (env):
 *   SIRAGPT_SUPERNODE_LEX_THRESHOLD    (default 0.30)
 *   SIRAGPT_SUPERNODE_SEM_THRESHOLD    (default 0.85)
 *   SIRAGPT_SUPERNODE_MAX_INPUT        (default 256)
 */

const STOP = new Set([
  'a','an','the','of','to','in','for','on','with','and','or','that','this','it','is',
  'are','was','were','as','at','by','from','de','la','el','los','las','un','una','y',
  'o','que','en','para','por','con','sin','sobre','del','al','mi','tu','su','sus','me',
  'te','se','lo','le','sea','sean','si',
]);

const TOKEN_RE = /[a-záéíóúñü0-9_]+/giu;

const DEFAULT_LEX_THRESHOLD = Number(process.env.SIRAGPT_SUPERNODE_LEX_THRESHOLD) || 0.30;
const DEFAULT_SEM_THRESHOLD = Number(process.env.SIRAGPT_SUPERNODE_SEM_THRESHOLD) || 0.85;
const MAX_FEATURES = Number(process.env.SIRAGPT_SUPERNODE_MAX_INPUT) || 256;

function tokenize(text) {
  const out = [];
  if (!text) return out;
  const matches = String(text).toLowerCase().match(TOKEN_RE);
  if (!matches) return out;
  for (const t of matches) {
    if (t.length < 2 || STOP.has(t)) continue;
    if (/^\d+$/.test(t) && t.length < 4) continue;
    out.push(t);
  }
  return out;
}

const tokenSet = (text) => new Set(tokenize(text));

function jaccard(setA, setB) {
  if (!setA || !setB || setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  const [s, l] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const v of s) if (l.has(v)) inter += 1;
  if (inter === 0) return 0;
  return inter / (setA.size + setB.size - inter);
}

function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = Number(a[i]) || 0;
    const bi = Number(b[i]) || 0;
    dot += ai * bi; na += ai * ai; nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function normalizeFeature(raw, idx) {
  const surface = String(raw?.label || raw?.value || raw?.text || raw?.surface || '').trim();
  if (!surface) return null;
  const kind = String(raw?.kind || raw?.category || 'feature').toLowerCase();
  const weight = Math.max(0, Math.min(1, Number(raw?.weight ?? raw?.confidence ?? 0.5)));
  return {
    id: raw?.id ? String(raw.id).slice(0, 64) : `f_${idx}`,
    kind, label: surface, weight,
    tokens: tokenSet(surface),
    embedding: Array.isArray(raw?.embedding) ? raw.embedding : null,
    raw,
  };
}

function shouldMerge(a, b, opts) {
  if (a.embedding && b.embedding && cosineSim(a.embedding, b.embedding) >= opts.semThreshold) return true;
  if (jaccard(a.tokens, b.tokens) >= opts.lexThreshold) return true;
  return false;
}

function clusterByKind(features, opts) {
  const byKind = new Map();
  for (const f of features) {
    const list = byKind.get(f.kind) || [];
    list.push(f);
    byKind.set(f.kind, list);
  }
  const clusters = [];
  for (const list of byKind.values()) {
    list.sort((a, b) => b.weight - a.weight);
    const assigned = new Set();
    for (let i = 0; i < list.length; i += 1) {
      if (assigned.has(list[i].id)) continue;
      const seed = list[i];
      const members = [seed];
      assigned.add(seed.id);
      for (let j = i + 1; j < list.length; j += 1) {
        if (assigned.has(list[j].id)) continue;
        if (shouldMerge(seed, list[j], opts)) {
          members.push(list[j]);
          assigned.add(list[j].id);
        }
      }
      clusters.push({ kind: seed.kind, members });
    }
  }
  return clusters;
}

function buildSupernode(cluster) {
  const sorted = [...cluster.members].sort((a, b) => b.weight - a.weight);
  const seed = sorted[0];
  const maxW = seed.weight;
  const sizeBonus = Math.min(0.25, Math.log2(1 + cluster.members.length - 1) * 0.06);
  const aggregateWeight = Math.min(1, maxW + sizeBonus);
  const memberLabels = sorted.map((m) => m.label).slice(0, 8);
  return {
    id: `super_${seed.id}`,
    kind: cluster.kind,
    label: seed.label,
    aggregateWeight: Number(aggregateWeight.toFixed(3)),
    memberCount: cluster.members.length,
    members: memberLabels,
    seedWeight: Number(maxW.toFixed(3)),
  };
}

function mergeFeatures(features, opts = {}) {
  const t0 = Date.now();
  const lexThreshold = Number(opts.lexThreshold) > 0 ? Number(opts.lexThreshold) : DEFAULT_LEX_THRESHOLD;
  const semThreshold = Number(opts.semThreshold) > 0 ? Number(opts.semThreshold) : DEFAULT_SEM_THRESHOLD;
  const limit = Math.min(MAX_FEATURES, Math.max(1, Number(opts.maxInput) || MAX_FEATURES));
  const raw = (Array.isArray(features) ? features : []).slice(0, limit);
  const normalized = raw.map(normalizeFeature).filter(Boolean);
  if (normalized.length === 0) {
    return { supernodes: [], residuals: [], stats: { input: 0, clusters: 0, mergedPairs: 0, durationMs: Date.now() - t0 } };
  }
  const clusters = clusterByKind(normalized, { lexThreshold, semThreshold });
  const supernodes = clusters
    .filter((c) => c.members.length >= 2)
    .map(buildSupernode)
    .sort((a, b) => b.aggregateWeight - a.aggregateWeight);
  const residuals = clusters
    .filter((c) => c.members.length === 1)
    .map((c) => ({ kind: c.kind, label: c.members[0].label, weight: c.members[0].weight, id: c.members[0].id }));
  const mergedPairs = clusters.reduce((acc, c) => acc + Math.max(0, c.members.length - 1), 0);
  return {
    supernodes, residuals,
    stats: { input: normalized.length, clusters: clusters.length, mergedPairs, durationMs: Date.now() - t0 },
  };
}

function buildSupernodeBlock(merge, opts = {}) {
  if (!merge || !Array.isArray(merge.supernodes) || merge.supernodes.length === 0) return '';
  const maxSupernodes = Number(opts.maxSupernodes) || 6;
  const lines = ['\n\n<feature_supernodes>'];
  lines.push('Temas detectados al agrupar señales similares (peso agregado, mayor primero).');
  lines.push('Trátalos como ejes principales del mensaje del usuario.');
  for (const s of merge.supernodes.slice(0, maxSupernodes)) {
    const members = s.members.length > 1 ? ` [agrupa: ${s.members.slice(1, 5).join(', ')}]` : '';
    lines.push(`  • [${s.kind}] ${s.label} (peso ${s.aggregateWeight}, ${s.memberCount} miembros)${members}`);
  }
  lines.push('</feature_supernodes>');
  const text = lines.join('\n');
  const max = Number(opts.maxChars) || 900;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

module.exports = {
  mergeFeatures, buildSupernodeBlock,
  tokenize, tokenSet, jaccard, cosineSim,
  DEFAULT_LEX_THRESHOLD, DEFAULT_SEM_THRESHOLD,
};
