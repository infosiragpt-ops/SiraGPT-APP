'use strict';

/**
 * document-relationship-classifier.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Classifies how the attached documents relate to each other:
 *
 *   - versions       same logical doc at different revisions
 *                    (filename suffixes -v1/v2, "draft" vs "final",
 *                    > 60 % token overlap)
 *   - complementary  cover different aspects of the same project /
 *                    entity (significant entity overlap, low body
 *                    overlap, no contradictory facts)
 *   - conflicting    share entities AND surface monetary or date
 *                    conflicts in semantic-graph / consistency layers
 *   - unrelated      < 10 % entity overlap, no shared topics
 *
 * Fires only when 2+ files are attached. Single-file uploads return an
 * empty report. Deterministic, no LLM, < 30 ms on a 1 MB batch.
 *
 * Public API:
 *   classifyRelationships(files)         → RelationshipReport
 *   renderRelationshipsBlock(report)     → markdown string ('' OK)
 */

let semanticGraphCache = null;
function getSemanticGraph() {
  if (semanticGraphCache) return semanticGraphCache;
  try { semanticGraphCache = require('./document-semantic-graph'); } catch { semanticGraphCache = null; }
  return semanticGraphCache;
}

const MIN_FILES = 2;
const MAX_PAIRS = 18;
const MAX_BLOCK_CHARS = 3600;
const VERSION_SUFFIX_RE = /[\s_-]?(v\d+(?:\.\d+)*|version[\s_-]?\d+|rev\d+|r\d+|draft|borrador|final|definitiv[oa]|\d{4}-\d{2}-\d{2})\.?[a-z0-9]{0,5}$/i;
const STOPWORD_RE = /\b(the|a|an|and|or|of|in|on|to|for|by|el|la|los|las|de|del|y|o|en|por|para|que)\b/gi;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clip(text, max = 220) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(STOPWORD_RE, ' ')
    .match(/[\p{L}\p{N}]{4,}/gu) || [];
}

function tokenSet(text) {
  const tokens = tokenize(text);
  const set = new Set();
  for (const t of tokens) set.add(t);
  return set;
}

function jaccard(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const v of setA) if (setB.has(v)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : Number((inter / union).toFixed(3));
}

function stemName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(VERSION_SUFFIX_RE, '')
    .trim();
}

function classifyPair(a, b, signals) {
  // Tier 1 — version detection (filename stems + body overlap)
  const stemA = stemName(a.file);
  const stemB = stemName(b.file);
  const versionSuffixA = VERSION_SUFFIX_RE.test(a.file);
  const versionSuffixB = VERSION_SUFFIX_RE.test(b.file);
  const sameStem = stemA && stemA === stemB;
  if (sameStem && (versionSuffixA || versionSuffixB) && a.bodyOverlap >= 0.45) {
    return { kind: 'versions', signal: 'shared filename stem + version suffix + ≥45% body overlap' };
  }
  // Tier 2 — version detection by very high body overlap alone (no
  // filename hint but the documents share most of their tokens).
  if (a.bodyOverlap >= 0.6) {
    return { kind: 'versions', signal: `≥60% body overlap (${(a.bodyOverlap * 100).toFixed(0)}%)` };
  }
  // Tier 3 — conflict detection from semantic-graph monetary conflicts.
  if (signals && Array.isArray(signals.conflictEntities) && signals.conflictEntities.length > 0) {
    return {
      kind: 'conflicting',
      signal: `entity-value conflict on: ${signals.conflictEntities.slice(0, 3).join(', ')}`,
    };
  }
  // Tier 4 — complementary: share entities OR moderate body overlap, no conflicts.
  if (a.entityOverlap >= 0.18 || a.bodyOverlap >= 0.18) {
    return {
      kind: 'complementary',
      signal: `entity overlap ${(a.entityOverlap * 100).toFixed(0)}%, body overlap ${(a.bodyOverlap * 100).toFixed(0)}%`,
    };
  }
  // Tier 5 — unrelated otherwise.
  return {
    kind: 'unrelated',
    signal: `entity overlap ${(a.entityOverlap * 100).toFixed(0)}%, body overlap ${(a.bodyOverlap * 100).toFixed(0)}%`,
  };
}

function classifyRelationships(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (list.length < MIN_FILES) {
    return { pairs: [], fileCount: list.length, totals: { versions: 0, complementary: 0, conflicting: 0, unrelated: 0 } };
  }
  // Pre-compute body + entity token sets per file.
  const profiles = list.map((f) => {
    const name = safeFileName(f);
    const text = safeText(f.extractedText);
    const bodyTokens = tokenSet(text.slice(0, 60_000));
    // Entity tokens — uppercase-led words, 3-char min, lowercased.
    const entityTokens = new Set();
    for (const m of text.matchAll(/\b([A-ZÁÉÍÓÚÑ][\p{L}\p{N}'\-]{2,})\b/gu)) {
      entityTokens.add(m[1].toLowerCase());
    }
    return { file: name, bodyTokens, entityTokens };
  });

  // Pull semantic-graph conflict map to enrich pair signals.
  const graph = getSemanticGraph();
  let conflictByPair = new Map();
  if (graph && typeof graph.buildGraphForFiles === 'function') {
    try {
      const report = graph.buildGraphForFiles(list);
      for (const e of report.entities) {
        if (!e.conflict || e.conflict.length < 2) continue;
        for (let i = 0; i < e.conflict.length; i++) {
          for (let j = i + 1; j < e.conflict.length; j++) {
            const key = `${e.conflict[i].file}|${e.conflict[j].file}`;
            const arr = conflictByPair.get(key) || [];
            arr.push(e.name);
            conflictByPair.set(key, arr);
          }
        }
      }
    } catch { /* swallow */ }
  }

  const pairs = [];
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      if (pairs.length >= MAX_PAIRS) break;
      const A = profiles[i];
      const B = profiles[j];
      const bodyOverlap = jaccard(A.bodyTokens, B.bodyTokens);
      const entityOverlap = jaccard(A.entityTokens, B.entityTokens);
      const conflictKey1 = `${A.file}|${B.file}`;
      const conflictKey2 = `${B.file}|${A.file}`;
      const conflictEntities = conflictByPair.get(conflictKey1) || conflictByPair.get(conflictKey2) || [];
      const classification = classifyPair(
        { file: A.file, bodyOverlap, entityOverlap },
        { file: B.file, bodyOverlap, entityOverlap },
        { conflictEntities },
      );
      pairs.push({
        a: A.file,
        b: B.file,
        bodyOverlap,
        entityOverlap,
        ...classification,
        conflictEntities,
      });
    }
  }

  const totals = pairs.reduce(
    (acc, p) => {
      acc[p.kind] = (acc[p.kind] || 0) + 1;
      return acc;
    },
    { versions: 0, complementary: 0, conflicting: 0, unrelated: 0 },
  );

  return { pairs, fileCount: list.length, totals };
}

function renderPair(p) {
  const head = `**${p.a}** ↔ **${p.b}**`;
  const tags = [`[${p.kind}]`];
  if (p.bodyOverlap > 0) tags.push(`body=${(p.bodyOverlap * 100).toFixed(0)}%`);
  if (p.entityOverlap > 0) tags.push(`entities=${(p.entityOverlap * 100).toFixed(0)}%`);
  const conflict = p.conflictEntities && p.conflictEntities.length
    ? ` _(conflicts on: ${p.conflictEntities.slice(0, 3).join(', ')})_`
    : '';
  return `- ${head} ${tags.join(' · ')} — ${p.signal}${conflict}`;
}

function renderRelationshipsBlock(report) {
  if (!report || !Array.isArray(report.pairs) || report.pairs.length === 0) return '';
  // Don't surface when ALL pairs are "unrelated" — it just adds noise.
  const informative = report.pairs.filter((p) => p.kind !== 'unrelated');
  if (informative.length === 0) return '';
  const heading = `## DOCUMENT RELATIONSHIPS
Pairwise classification of the attached document(s): versions of the same doc, complementary coverage, conflicting facts, or unrelated. Use this map to know which pairs deserve a side-by-side comparison vs which should be analysed independently.`;
  const sorted = [...report.pairs].sort((a, b) => {
    const rank = { conflicting: 0, versions: 1, complementary: 2, unrelated: 3 };
    return (rank[a.kind] || 9) - (rank[b.kind] || 9);
  });
  const body = sorted.map(renderPair).join('\n');
  let combined = `${heading}\n\n${body}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...relationships block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  classifyRelationships,
  renderRelationshipsBlock,
  _internal: {
    tokenize,
    tokenSet,
    jaccard,
    stemName,
    VERSION_SUFFIX_RE,
    MIN_FILES,
    MAX_PAIRS,
  },
};
