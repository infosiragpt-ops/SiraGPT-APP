'use strict';

/**
 * document-comparison-engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Synthesises a "cross-document analysis" block from 2+ attached files so the
 * model receives explicit signal about how the documents relate to each other
 * BEFORE it tries to reason about them. This is the layer that makes the chat
 * feel like a real research assistant when the user drops a folder of related
 * files (contracts to compare, multiple CVs, a quarter's worth of invoices).
 *
 * Sits next to document-insights-engine.js: that engine works per-document and
 * aggregates raw signals, this engine works ACROSS documents and surfaces
 * comparisons. Both run from buildEnrichedFileContext().
 *
 * Public API:
 *   compareDocuments(files)             → ComparisonReport
 *   renderComparisonBlock(report, opts) → markdown string
 *
 * Constraints (same envelope as document-professional-analyzer):
 *  - Pure function, deterministic, no LLM call, no network.
 *  - <40 ms for 10 files × 100 KB on a warm V8.
 *  - Resilient: tolerates empty / malformed file entries; returns null when
 *    fewer than two files have extractable text.
 *  - Token budget: rendered block stays under ~3 KB even for many files.
 */

const insightsEngine = require('./document-insights-engine');

const MAX_FILES_COMPARED = 20;
const MAX_SHARED_ENTITIES = 15;
const MAX_UNIQUE_ENTITIES_PER_DOC = 6;
const MAX_TIMELINE_ENTRIES = 12;
const MAX_NUMERIC_CONFLICTS = 8;
const SCAN_HEAD_BYTES = 24_000;

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

function tokenize(text) {
  // Lowercase alphanumerics, length ≥ 4 — keeps content tokens, drops noise.
  return (text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []);
}

function toSet(values) {
  return new Set(values.map((v) => v.toLowerCase()));
}

function intersect(a, b) {
  const out = [];
  for (const v of a) if (b.has(v.toLowerCase())) out.push(v);
  return out;
}

function difference(a, b) {
  const out = [];
  for (const v of a) if (!b.has(v.toLowerCase())) out.push(v);
  return out;
}

/**
 * Jaccard similarity over content tokens (length ≥ 4, lowercased).
 * 0..1. Symmetric. Returns 0 when both sets are empty.
 */
function jaccardSimilarity(textA, textB) {
  const a = new Set(tokenize(textA.slice(0, SCAN_HEAD_BYTES)));
  const b = new Set(tokenize(textB.slice(0, SCAN_HEAD_BYTES)));
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : Number((inter / union).toFixed(4));
}

/**
 * Compare two documents and return a per-pair summary.
 */
function comparePair(fileA, fileB) {
  return {
    a: fileA.label,
    b: fileB.label,
    similarity: jaccardSimilarity(fileA.text, fileB.text),
    sharedPersons: intersect(fileA.insights.entities.persons, toSet(fileB.insights.entities.persons)).slice(0, 6),
    sharedOrgs: intersect(fileA.insights.entities.organizations, toSet(fileB.insights.entities.organizations)).slice(0, 6),
    sharedDates: intersect(fileA.insights.dates.absolute, toSet(fileB.insights.dates.absolute)).slice(0, 6),
  };
}

/**
 * Aggregate shared/unique entities across the whole file set.
 */
function aggregateEntities(perFile) {
  const tally = (key) => {
    const counts = new Map();
    for (const f of perFile) {
      const seenInFile = new Set();
      for (const v of f.insights.entities[key] || []) {
        const k = v.toLowerCase();
        if (seenInFile.has(k)) continue;
        seenInFile.add(k);
        const entry = counts.get(k) || { value: v, files: 0 };
        entry.files += 1;
        counts.set(k, entry);
      }
    }
    return Array.from(counts.values()).sort((x, y) => y.files - x.files);
  };

  const persons = tally('persons');
  const orgs = tally('organizations');

  const shared = {
    persons: persons.filter((e) => e.files >= 2).slice(0, MAX_SHARED_ENTITIES).map((e) => ({ name: e.value, fileCount: e.files })),
    organizations: orgs.filter((e) => e.files >= 2).slice(0, MAX_SHARED_ENTITIES).map((e) => ({ name: e.value, fileCount: e.files })),
  };

  // "Unique to file" — entity appears in only one file across the set.
  const uniqueByFile = perFile.map((f) => {
    const personSet = new Set(persons.filter((e) => e.files === 1).map((e) => e.value.toLowerCase()));
    const orgSet = new Set(orgs.filter((e) => e.files === 1).map((e) => e.value.toLowerCase()));
    return {
      file: f.label,
      uniquePersons: (f.insights.entities.persons || []).filter((p) => personSet.has(p.toLowerCase())).slice(0, MAX_UNIQUE_ENTITIES_PER_DOC),
      uniqueOrgs: (f.insights.entities.organizations || []).filter((o) => orgSet.has(o.toLowerCase())).slice(0, MAX_UNIQUE_ENTITIES_PER_DOC),
    };
  });

  return { shared, uniqueByFile };
}

/**
 * Build a chronological timeline merging the absolute dates of every file.
 * Each entry: { date, file }. Sorted ascending by date string (ISO sorts
 * naturally). Other formats are coerced via Date.parse when reasonable.
 */
function buildTimeline(perFile) {
  const items = [];
  for (const f of perFile) {
    for (const d of (f.insights.dates.absolute || []).slice(0, 8)) {
      items.push({ date: d, file: f.label });
    }
  }
  // Stable sort by parseable date, with raw strings as fallback comparator.
  items.sort((a, b) => {
    const ta = Date.parse(a.date);
    const tb = Date.parse(b.date);
    if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta - tb;
    return a.date.localeCompare(b.date);
  });
  return items.slice(0, MAX_TIMELINE_ENTRIES);
}

/**
 * Find numeric conflicts: same field-like context appears with different
 * monetary or percentage values across files. Cheap heuristic — looks for
 * money/percentage values prefixed by short labels (3-30 chars) and groups
 * by label.
 *
 * False positives are acceptable: the cross-doc block FLAGS these so the
 * model can investigate, not assert them.
 */
function findNumericConflicts(perFile) {
  const LABEL_VALUE = /([A-Za-zÁÉÍÓÚÑáéíóúñ][\w\s]{2,28}?)[:=]\s*((?:[$€£¥]|US\$|S\/\.?|R\$|MX\$|EUR|USD|GBP|JPY|BRL|ARS|MXN|PEN|COP|CLP)\s?\d[\d.,]*|\d{1,3}(?:[.,]\d+)?\s?%)/g;
  const labelMap = new Map(); // label -> Map<file, Set<value>>

  for (const f of perFile) {
    const head = f.text.slice(0, SCAN_HEAD_BYTES);
    let m;
    while ((m = LABEL_VALUE.exec(head)) !== null) {
      const label = m[1].trim().toLowerCase();
      const value = m[2].trim();
      if (!labelMap.has(label)) labelMap.set(label, new Map());
      const perFileVals = labelMap.get(label);
      if (!perFileVals.has(f.label)) perFileVals.set(f.label, new Set());
      perFileVals.get(f.label).add(value);
    }
    LABEL_VALUE.lastIndex = 0;
  }

  const conflicts = [];
  for (const [label, perFileVals] of labelMap.entries()) {
    if (perFileVals.size < 2) continue; // need ≥ 2 files mentioning this label
    const observations = [];
    const seenValues = new Set();
    for (const [file, vals] of perFileVals.entries()) {
      const valArr = Array.from(vals);
      observations.push({ file, value: valArr.join(' / ') });
      for (const v of valArr) seenValues.add(v);
    }
    if (seenValues.size >= 2) {
      conflicts.push({ label, observations });
      if (conflicts.length >= MAX_NUMERIC_CONFLICTS) break;
    }
  }
  return conflicts;
}

function detectKindCoverage(perFile) {
  // Heuristic doc-type distribution — relies on caller-supplied mimeType or
  // filename hints. Useful for the prompt to know "you have 3 invoices and
  // 2 contracts" without re-running the heavy classifier.
  const counts = new Map();
  for (const f of perFile) {
    const k = f.kindHint || 'unknown';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return Array.from(counts.entries()).map(([kind, count]) => ({ kind, count }));
}

/**
 * Main entry point.
 *
 * @param {Array<{
 *   originalName?: string, filename?: string, name?: string,
 *   mimeType?: string, type?: string,
 *   extractedText?: string, text?: string,
 *   kind?: string, classification?: { type?: string }
 * }>} files
 * @returns {ComparisonReport|null}
 */
function compareDocuments(files) {
  if (!Array.isArray(files)) return null;
  const valid = [];
  for (const f of files) {
    if (!f || typeof f !== 'object') continue;
    const text = safeText(f.extractedText || f.text || '');
    if (!text.trim()) continue;
    if (valid.length >= MAX_FILES_COMPARED) break;
    valid.push({
      label: f.originalName || f.filename || f.name || `file-${valid.length + 1}`,
      text,
      kindHint: f.classification?.type || f.kind || f.mimeType || null,
      insights: insightsEngine.extractDocumentInsights(text),
    });
  }
  if (valid.length < 2) return null;

  const pairs = [];
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      pairs.push(comparePair(valid[i], valid[j]));
    }
  }
  // Highest similarity first — most actionable comparisons rise to the top.
  pairs.sort((a, b) => b.similarity - a.similarity);

  const entities = aggregateEntities(valid);
  const timeline = buildTimeline(valid);
  const conflicts = findNumericConflicts(valid);
  const kindCoverage = detectKindCoverage(valid);

  // Concentration ratio — how dominated the set is by the single largest doc.
  const totalWords = valid.reduce((acc, f) => acc + f.insights.metrics.words, 0);
  const largest = Math.max(...valid.map((f) => f.insights.metrics.words));
  const dominanceRatio = totalWords > 0 ? Number((largest / totalWords).toFixed(3)) : 0;

  return {
    fileCount: valid.length,
    files: valid.map((f) => ({ label: f.label, words: f.insights.metrics.words, kindHint: f.kindHint })),
    pairs: pairs.slice(0, 10),
    entities,
    timeline,
    numericConflicts: conflicts,
    kindCoverage,
    dominanceRatio,
  };
}

function fmtPercent(v) {
  return `${Math.round(v * 100)}%`;
}

function renderComparisonBlock(report, opts = {}) {
  if (!report || report.fileCount < 2) return '';
  const lines = [];
  const title = opts.title || 'CROSS-DOCUMENT SYNTHESIS';
  lines.push(`## ${title}`);
  lines.push(`Comparing ${report.fileCount} files. Use this block to spot agreement, divergence, and contradictions BEFORE drafting your answer. Cite the exact file label whenever you reference a finding.`);

  if (report.kindCoverage.length > 0) {
    const summary = report.kindCoverage
      .sort((a, b) => b.count - a.count)
      .map((k) => `${k.count} × ${k.kind || 'unknown'}`)
      .join(' · ');
    lines.push(`**Kind coverage:** ${summary}`);
  }

  if (report.dominanceRatio > 0.7) {
    lines.push(`**Note:** one file accounts for ${fmtPercent(report.dominanceRatio)} of the total content — the synthesis may skew toward it.`);
  }

  if (report.pairs.length > 0) {
    lines.push('### Pairwise similarity (Jaccard, top pairs)');
    const top = report.pairs.slice(0, 5);
    lines.push('| File A | File B | Similarity | Shared persons | Shared orgs | Shared dates |');
    lines.push('|---|---|---|---|---|---|');
    for (const p of top) {
      lines.push(`| ${p.a} | ${p.b} | ${fmtPercent(p.similarity)} | ${p.sharedPersons.join(', ') || '—'} | ${p.sharedOrgs.join(', ') || '—'} | ${p.sharedDates.join(', ') || '—'} |`);
    }
  }

  if (report.entities.shared.persons.length > 0 || report.entities.shared.organizations.length > 0) {
    lines.push('### Entities shared across files');
    if (report.entities.shared.persons.length > 0) {
      lines.push(`**People:** ${report.entities.shared.persons.map((e) => `${e.name} (×${e.fileCount})`).join(' · ')}`);
    }
    if (report.entities.shared.organizations.length > 0) {
      lines.push(`**Organizations:** ${report.entities.shared.organizations.map((e) => `${e.name} (×${e.fileCount})`).join(' · ')}`);
    }
  }

  const hasUnique = report.entities.uniqueByFile.some((u) => u.uniquePersons.length > 0 || u.uniqueOrgs.length > 0);
  if (hasUnique) {
    lines.push('### Entities unique to a single file');
    for (const u of report.entities.uniqueByFile) {
      const bits = [];
      if (u.uniquePersons.length > 0) bits.push(`people: ${u.uniquePersons.join(', ')}`);
      if (u.uniqueOrgs.length > 0) bits.push(`orgs: ${u.uniqueOrgs.join(', ')}`);
      if (bits.length > 0) lines.push(`- **${u.file}** — ${bits.join(' · ')}`);
    }
  }

  if (report.timeline.length > 0) {
    lines.push('### Merged timeline');
    for (const item of report.timeline) {
      lines.push(`- ${item.date} — ${item.file}`);
    }
  }

  if (report.numericConflicts.length > 0) {
    lines.push('### Numeric divergences (same label, different values)');
    for (const c of report.numericConflicts) {
      const obs = c.observations.map((o) => `${o.file}: ${o.value}`).join(' · ');
      lines.push(`- **${c.label}** — ${obs}`);
    }
  }

  return lines.join('\n\n');
}

module.exports = {
  compareDocuments,
  renderComparisonBlock,
  _internal: {
    jaccardSimilarity,
    aggregateEntities,
    buildTimeline,
    findNumericConflicts,
  },
};
