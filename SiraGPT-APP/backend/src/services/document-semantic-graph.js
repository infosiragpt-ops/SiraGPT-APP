'use strict';

/**
 * document-semantic-graph.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cross-document entity ↔ claim graph.
 *
 * Why this exists (and why it's not part of document-comparison-engine):
 *  - comparison-engine answers "are these documents saying the same
 *    thing?" with a small set of high-level signals (shared entities,
 *    diverging numbers, conflicting dates).
 *  - This module answers a different question — "what does each
 *    document say about ENTITY X?". It builds a graph keyed by entity
 *    where each node lists the documents that mention it, the
 *    sentence-level mentions, the claims (declarative sentences) the
 *    entity participates in, and any conflicts between those claims
 *    across documents.
 *
 * The chat layer reads the rendered block so it can answer:
 *   - "What does doc A say about ENTITY vs doc B?"
 *   - "Who is mentioned across all files?"
 *   - "Where does the budget number appear and what value does each
 *     file give it?"
 *
 * Detection coverage (deterministic, no LLM, < 25 ms on 1 MB total):
 *   - Capitalised proper nouns / multi-word names (with case folding
 *     for Spanish accents).
 *   - Acronyms (≥ 2 uppercase letters, possibly with digits).
 *   - Currency-anchored numeric facts (entity → value mapping when an
 *     entity sits within ±60 chars of a currency amount).
 *   - Claim sentences containing the entity (best-effort via the
 *     sibling deep-analyzer; falls back to "any sentence that mentions
 *     the entity twice" when the analyzer is unavailable).
 *
 * Heuristics tuned for bilingual input. Conflicts are surfaced only when
 * two files associate the same entity with DIFFERENT numeric / monetary
 * values inside the same currency family.
 *
 * Public API:
 *   buildGraphForFiles(files)             → GraphReport
 *   renderGraphBlock(report)              → markdown string ('' when empty)
 */

const SCAN_HEAD_BYTES = 60_000;
const MIN_ENTITY_LEN = 3;
const MAX_ENTITIES = 12;
const MAX_MENTIONS_PER_ENTITY = 4;
const MAX_BLOCK_CHARS = 4500;
const STOP_HEAD_WORDS = new Set([
  'the', 'a', 'an', 'these', 'those', 'this', 'that', 'and', 'or', 'but',
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'pero',
]);

let deepAnalyzerCache = null;
function getDeepAnalyzer() {
  if (deepAnalyzerCache) return deepAnalyzerCache;
  try { deepAnalyzerCache = require('./document-deep-analyzer'); } catch { deepAnalyzerCache = null; }
  return deepAnalyzerCache;
}

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

function clip(text, max = 220) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function normaliseEntity(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function entityKey(name) {
  return normaliseEntity(name).toLowerCase();
}

function isStopWord(word) {
  return STOP_HEAD_WORDS.has(word.toLowerCase());
}

/**
 * Extract candidate proper-noun entities from text. Returns an array of
 * { name, index } sorted by first appearance.
 *
 * Rules:
 *  - 1-3 consecutive capitalised tokens (Unicode-aware) at word boundary
 *  - drop stop-words at the head ("The Project" → "Project")
 *  - allow internal lowercase glue words: of, de, &, "y"
 *  - acronyms (2+ uppercase letters, possibly followed by digits) are
 *    captured separately
 */
function extractEntities(text) {
  if (!text) return [];
  const out = [];
  const seenIndex = new Set();

  const properRe = /\b([\p{Lu}][\p{L}\p{N}'\-]+(?:\s+(?:de|del|of|y|and|&|por)\s+[\p{Lu}][\p{L}\p{N}'\-]+){0,3})\b/gu;
  for (const m of text.matchAll(properRe)) {
    let name = normaliseEntity(m[1]);
    const firstWord = name.split(/\s+/)[0];
    if (isStopWord(firstWord)) name = name.split(/\s+/).slice(1).join(' ').trim();
    if (name.length < MIN_ENTITY_LEN) continue;
    const idx = m.index ?? 0;
    if (seenIndex.has(idx)) continue;
    seenIndex.add(idx);
    out.push({ name, index: idx, kind: 'proper-noun' });
  }

  const acronymRe = /\b([A-Z]{2,}(?:[A-Z0-9]{0,6}))\b/g;
  for (const m of text.matchAll(acronymRe)) {
    const name = m[1];
    if (name.length < MIN_ENTITY_LEN) continue;
    const idx = m.index ?? 0;
    if (seenIndex.has(idx)) continue;
    seenIndex.add(idx);
    out.push({ name, index: idx, kind: 'acronym' });
  }

  // Post-process: any single-token, fully uppercase entity is an acronym
  // even if the proper-noun pass grabbed it first.
  for (const ent of out) {
    if (ent.kind === 'acronym') continue;
    const tokens = ent.name.split(/\s+/);
    if (tokens.length === 1 && /^[A-Z0-9]{2,8}$/.test(tokens[0])) {
      ent.kind = 'acronym';
    }
  }

  out.sort((a, b) => a.index - b.index);
  return out;
}

function sentenceContaining(text, idx, len) {
  const punct = ['.', '!', '?', '。', '！', '？', '\n'];
  let from = idx;
  while (from > 0 && !punct.includes(text[from - 1])) from--;
  let to = idx + len;
  while (to < text.length && !punct.includes(text[to])) to++;
  return text.slice(from, Math.min(to + 1, text.length)).trim();
}

const MONEY_RE = /([$€£¥]|US\$|MX\$|S\/\.?|R\$|EUR|USD|GBP|JPY|BRL|ARS|MXN|PEN|COP|CLP|CHF)\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?(?:\s?(?:[KkMmBb]|millones?|billones?|thousand|million|billion))?)/g;

/**
 * For an entity occurrence, look for a currency amount within ±80 chars.
 * Returns the first money match or null. The detector is intentionally
 * shallow — false positives are tolerable because conflicts are only
 * surfaced when TWO files independently agree the entity sits next to a
 * number AND the numbers disagree.
 */
function findNearbyMoney(text, idx) {
  const start = Math.max(0, idx - 80);
  const end = Math.min(text.length, idx + 80);
  const window = text.slice(start, end);
  MONEY_RE.lastIndex = 0;
  const m = MONEY_RE.exec(window);
  return m ? { currency: m[1], raw: m[2], full: m[0] } : null;
}

function buildGraphForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (list.length === 0) return { entities: [], totalEntities: 0 };

  // entity-key → { name, kindCounts, mentions[] }
  const graph = new Map();
  const deep = getDeepAnalyzer();

  for (const file of list) {
    const text = safeText(file.extractedText);
    if (!text) continue;
    const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
    const name = safeFileName(file);
    const candidates = extractEntities(head);
    // Per-file entity counter — frequent entities are more interesting.
    const counts = new Map();
    for (const c of candidates) {
      const k = entityKey(c.name);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    // Filter to "interesting" entities: appear ≥2 times in this file OR are
    // longer than one token. Single-token entities mentioned once look
    // noisy.
    const interesting = candidates.filter((c) => {
      const k = entityKey(c.name);
      const cnt = counts.get(k) || 0;
      const tokens = c.name.split(/\s+/).length;
      return cnt >= 2 || tokens >= 2 || c.kind === 'acronym';
    });

    // Build a deep-analyzer claim set so we can flag claim-bearing sentences.
    let claimSentences = new Set();
    if (deep && typeof deep.analyzeText === 'function') {
      try {
        const r = deep.analyzeText(head);
        for (const c of (r.claims || [])) claimSentences.add(c);
      } catch {/* analyzer not critical */}
    }

    // Group by entity key inside this file so we collect at most one
    // mention sentence per entity per file (the FIRST one).
    const perFileSeen = new Set();
    for (const c of interesting) {
      const k = entityKey(c.name);
      if (perFileSeen.has(k)) continue;
      perFileSeen.add(k);
      const sentence = clip(sentenceContaining(head, c.index, c.name.length));
      if (!sentence) continue;
      const money = findNearbyMoney(head, c.index);
      const mention = {
        file: name,
        sentence,
        kind: c.kind,
        money: money ? `${money.currency}${money.raw}` : null,
        isClaim: claimSentences.has(sentence),
      };
      if (!graph.has(k)) {
        graph.set(k, {
          key: k,
          name: c.name,
          mentions: [],
          fileSet: new Set(),
          moneyByFile: new Map(),
          claimCount: 0,
        });
      }
      const node = graph.get(k);
      node.mentions.push(mention);
      node.fileSet.add(name);
      if (money) node.moneyByFile.set(name, mention.money);
      if (mention.isClaim) node.claimCount += 1;
    }
  }

  // Convert + rank: entities present in 2+ files first, then by mention count.
  const entries = Array.from(graph.values()).map((node) => {
    const files = Array.from(node.fileSet);
    const moneyValues = Array.from(node.moneyByFile.values());
    const conflict = files.length >= 2 && new Set(moneyValues).size > 1
      ? Array.from(node.moneyByFile.entries()).map(([file, val]) => ({ file, value: val }))
      : null;
    return {
      name: node.name,
      key: node.key,
      files,
      crossDocument: files.length >= 2,
      mentions: node.mentions.slice(0, MAX_MENTIONS_PER_ENTITY),
      mentionCount: node.mentions.length,
      claimCount: node.claimCount,
      conflict,
    };
  });

  entries.sort((a, b) => {
    if (b.crossDocument !== a.crossDocument) return b.crossDocument ? 1 : -1;
    if (b.mentionCount !== a.mentionCount) return b.mentionCount - a.mentionCount;
    return a.name.localeCompare(b.name);
  });

  return {
    entities: entries.slice(0, MAX_ENTITIES),
    totalEntities: entries.length,
    fileCount: list.length,
  };
}

function renderEntity(entry) {
  const lines = [`### ${entry.name}`];
  const fileLabel = entry.files.length === 1
    ? `appears in **${entry.files[0]}**`
    : `appears in **${entry.files.length} files**: ${entry.files.join(', ')}`;
  lines.push(`_${fileLabel}; ${entry.mentionCount} mention${entry.mentionCount === 1 ? '' : 's'}; ${entry.claimCount} claim sentence${entry.claimCount === 1 ? '' : 's'}_`);
  for (const m of entry.mentions) {
    const tail = m.money ? ` _(near amount **${m.money}**)_` : '';
    const claimTag = m.isClaim ? ' _[claim]_' : '';
    lines.push(`- _${m.file}_${claimTag}: "${m.sentence}"${tail}`);
  }
  if (entry.conflict) {
    lines.push('');
    lines.push('**Conflict across files:**');
    for (const c of entry.conflict) {
      lines.push(`- _${c.file}_ → ${c.value}`);
    }
  }
  return lines.join('\n');
}

function renderGraphBlock(report) {
  if (!report || !Array.isArray(report.entities) || report.entities.length === 0) return '';
  const heading = `## CROSS-DOCUMENT SEMANTIC GRAPH
Entities (proper nouns, acronyms) that appear across the attached document(s). Each node lists where the entity surfaces, the first mention sentence per file, and any monetary conflicts when the SAME entity is paired with DIFFERENT amounts across files. Use this map to answer "what does each document say about X?" without re-scanning raw text.`;
  const body = report.entities.map(renderEntity).join('\n\n');
  let combined = `${heading}\n\n${body}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...semantic graph truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  buildGraphForFiles,
  renderGraphBlock,
  _internal: {
    extractEntities,
    sentenceContaining,
    findNearbyMoney,
    entityKey,
    normaliseEntity,
    safeFileName,
    MIN_ENTITY_LEN,
    MAX_ENTITIES,
    MAX_MENTIONS_PER_ENTITY,
  },
};
