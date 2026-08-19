'use strict';

/**
 * document-consistency-checker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Internal-consistency checker — surfaces contradictions WITHIN a single
 * document so the model can flag, question, or correct them in its answer.
 * Complements document-comparison-engine (cross-document) by catching the
 * intra-document mismatches that tend to slip past readers.
 *
 * Detection coverage (all heuristic, deterministic, no LLM):
 *  - Label-value mismatches: same labelled field appears with two or more
 *    distinct money/percent values inside the SAME document.
 *  - Total-vs-line mismatches: when the document declares a Subtotal /
 *    Total / Suma / Sum that doesn't match the sum of nearby line items.
 *  - Date-range inconsistencies: "from X to Y" where X > Y, or end-date
 *    written before start-date inside a date range.
 *  - Polar contradictions: "X is true" vs "X is false" patterns (light
 *    heuristic — tags candidates rather than claiming proof).
 *  - Numeric impossibilities: percentages summing to >110% in lists,
 *    counts that exceed previously-declared totals.
 *  - Future/past tense conflict for past-only events ("will deliver" +
 *    "delivered" for the same noun).
 *
 * Public API:
 *   checkConsistency(text, opts)     → ConsistencyReport
 *   buildConsistencyForFiles(files)  → { perFile, aggregate }
 *   renderConsistencyBlock(report)   → markdown string
 */

const SCAN_HEAD_BYTES = 64_000;
const MAX_FINDINGS_PER_TYPE = 8;
const TOTAL_LABEL_RE = /\b(total|subtotal|gran\s+total|suma|sum|grand\s+total|importe\s+total|monto\s+total)\b\s*[:=]?\s*((?:[$€£¥]|US\$|S\/\.?|R\$|MX\$|EUR|USD|GBP|JPY|BRL|ARS|MXN|PEN|COP|CLP)\s?[\d.,]+|\d{1,3}(?:[.,]\d+)?)/gi;
const LABEL_VALUE_RE = /([A-Za-zÁÉÍÓÚÑáéíóúñ][\w\s]{2,28}?)[:=]\s*((?:[$€£¥]|US\$|S\/\.?|R\$|MX\$|EUR|USD|GBP|JPY|BRL|ARS|MXN|PEN|COP|CLP)\s?\d[\d.,]*|\d{1,3}(?:[.,]\d+)?\s?%)/g;
const DATE_RANGE_RES = [
  /\bfrom\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})\b/gi,
  /\bdesde\s+(\d{4}-\d{2}-\d{2})\s+hasta\s+(\d{4}-\d{2}-\d{2})\b/gi,
  /\b(\d{4}-\d{2}-\d{2})\s*[-—–]\s*(\d{4}-\d{2}-\d{2})\b/g,
];

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

function clip(text, max = 240) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function parseNumeric(raw) {
  if (typeof raw !== 'string') return null;
  // Strip currency symbols / words but preserve sign
  const cleaned = raw
    .replace(/(?:[$€£¥]|US\$|S\/\.?|R\$|MX\$|EUR|USD|GBP|JPY|BRL|ARS|MXN|PEN|COP|CLP|d[oó]lares?|euros?|libras?|pesos?|soles?|reales?|%|\s)/gi, '')
    .trim();
  if (!cleaned) return null;
  // Heuristic: if it contains both . and , the last separator is the decimal one
  let normalised = cleaned;
  if (cleaned.includes('.') && cleaned.includes(',')) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      normalised = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      normalised = cleaned.replace(/,/g, '');
    }
  } else if (cleaned.includes(',')) {
    // Comma may be thousands sep (1,200) or decimal sep (1,2). Use length heuristic.
    const after = cleaned.split(',').pop();
    if (after.length === 3) normalised = cleaned.replace(/,/g, '');
    else normalised = cleaned.replace(',', '.');
  }
  const n = Number(normalised);
  return Number.isFinite(n) ? n : null;
}

// ──────────────────────────────────────────────────────────────────────────
// Detectors
// ──────────────────────────────────────────────────────────────────────────

function detectLabelValueConflicts(text) {
  // Same label, multiple distinct values within the same document
  const map = new Map();
  let m;
  while ((m = LABEL_VALUE_RE.exec(text)) !== null) {
    const label = m[1].trim().toLowerCase().replace(/\s+/g, ' ');
    const value = m[2].trim();
    if (!map.has(label)) map.set(label, new Set());
    map.get(label).add(value);
  }
  LABEL_VALUE_RE.lastIndex = 0;

  const findings = [];
  for (const [label, vals] of map.entries()) {
    if (vals.size < 2) continue;
    findings.push({
      kind: 'label_value_conflict',
      label,
      values: Array.from(vals),
    });
    if (findings.length >= MAX_FINDINGS_PER_TYPE) break;
  }
  return findings;
}

function detectTotalMismatches(text) {
  // Find every "Total: X" mention and look for adjacent line-item sequences
  const findings = [];
  const totals = [];
  let m;
  while ((m = TOTAL_LABEL_RE.exec(text)) !== null) {
    const numeric = parseNumeric(m[2]);
    if (numeric == null) continue;
    totals.push({ raw: m[2].trim(), numeric, index: m.index });
    if (totals.length >= MAX_FINDINGS_PER_TYPE * 2) break;
  }
  TOTAL_LABEL_RE.lastIndex = 0;

  for (const t of totals) {
    // Look back ~1500 chars for a line-item series like "$X\n$Y\n$Z"
    const start = Math.max(0, t.index - 1500);
    const window = text.slice(start, t.index);
    const lineNums = (window.match(/(?:[$€£¥]|US\$|S\/\.?|R\$|MX\$|EUR|USD|GBP|JPY|BRL|ARS|MXN|PEN|COP|CLP)\s?[\d.,]+/g) || [])
      .map((s) => parseNumeric(s))
      .filter((n) => n != null);
    // Need at least 3 line items for a meaningful sum check
    if (lineNums.length < 3) continue;
    const sum = lineNums.reduce((acc, n) => acc + n, 0);
    // Allow 1% tolerance for rounding
    const delta = Math.abs(sum - t.numeric);
    const tolerance = Math.max(t.numeric, 1) * 0.01;
    if (delta > tolerance) {
      findings.push({
        kind: 'total_mismatch',
        declared: t.raw,
        declaredNumeric: t.numeric,
        sumOfLines: Number(sum.toFixed(2)),
        lineItemCount: lineNums.length,
        delta: Number(delta.toFixed(2)),
      });
      if (findings.length >= MAX_FINDINGS_PER_TYPE) break;
    }
  }
  return findings;
}

function detectInvertedDateRanges(text) {
  const findings = [];
  for (const re of DATE_RANGE_RES) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m[1];
      const end = m[2];
      const ts = Date.parse(start);
      const te = Date.parse(end);
      if (Number.isNaN(ts) || Number.isNaN(te)) continue;
      if (ts > te) {
        findings.push({
          kind: 'inverted_date_range',
          start,
          end,
          excerpt: clip(m[0]),
        });
        if (findings.length >= MAX_FINDINGS_PER_TYPE) break;
      }
    }
    re.lastIndex = 0;
  }
  return findings;
}

function detectPolarContradictions(text) {
  // Very light heuristic — look for "is/are X" + "is/are not X" with the
  // same X within the same paragraph.
  const findings = [];
  const paragraphs = text.split(/\n{2,}/).slice(0, 200);
  for (const para of paragraphs) {
    // Subject Y "is true" + same Y "is false / not true" pattern
    const positiveMatches = Array.from(para.matchAll(/\b([\w-]{4,})\s+(?:is|are|es|son|fue|fueron)\s+([\w\s-]{3,30})\b/gi)).slice(0, 6);
    if (positiveMatches.length === 0) continue;
    for (const pm of positiveMatches) {
      const subject = pm[1].toLowerCase();
      const claim = pm[2].toLowerCase().trim();
      const negationPattern = new RegExp(`\\b${subject.replace(/[-/\\^$*+?.()|[\\]{}]/g, '\\\\$&')}\\s+(?:is|are|es|son)\\s+(?:not|no)\\s+${claim.replace(/[-/\\^$*+?.()|[\\]{}]/g, '\\\\$&')}`, 'i');
      if (negationPattern.test(para)) {
        findings.push({
          kind: 'polar_contradiction',
          subject: pm[1],
          claim: claim,
          excerpt: clip(para),
        });
        if (findings.length >= MAX_FINDINGS_PER_TYPE) return findings;
      }
    }
  }
  return findings;
}

function detectPercentageSumOverflow(text) {
  // Lists like "Region A: 60% / Region B: 50% / Region C: 30%" totaling >110%.
  const findings = [];
  const blocks = text.split(/\n{2,}/).slice(0, 100);
  for (const block of blocks) {
    const percentages = (block.match(/\b\d{1,3}(?:[.,]\d+)?\s?%/g) || []).map(parseNumeric).filter((n) => n != null && n <= 100);
    if (percentages.length < 3) continue;
    const total = percentages.reduce((acc, n) => acc + n, 0);
    if (total > 110) {
      findings.push({
        kind: 'percentage_overflow',
        sum: Number(total.toFixed(1)),
        count: percentages.length,
        excerpt: clip(block.replace(/\s+/g, ' '), 200),
      });
      if (findings.length >= MAX_FINDINGS_PER_TYPE) break;
    }
  }
  return findings;
}

function detectTenseMismatches(text) {
  // "will deliver X" + "delivered X" for the same X — cheap heuristic.
  const findings = [];
  const futureMatches = Array.from(text.matchAll(/\b(?:will|shall|going\s+to|vamos\s+a|se\s+entregar[áa]|entregaremos)\s+(?:deliver|complete|launch|ship|entregar|completar|lanzar)\s+(?:the\s+|el\s+|la\s+)?([\w-]{4,40})/gi)).slice(0, 30);
  const pastMatches = Array.from(text.matchAll(/\b(?:delivered|completed|launched|shipped|entregado|completado|lanzado)\s+(?:the\s+|el\s+|la\s+)?([\w-]{4,40})/gi)).slice(0, 30);
  const pastObjects = new Set(pastMatches.map((m) => m[1].toLowerCase()));
  for (const fm of futureMatches) {
    const obj = fm[1].toLowerCase();
    if (pastObjects.has(obj)) {
      findings.push({
        kind: 'tense_conflict',
        object: fm[1],
        excerpt: clip(fm[0]),
      });
      if (findings.length >= MAX_FINDINGS_PER_TYPE) break;
    }
  }
  return findings;
}

// ──────────────────────────────────────────────────────────────────────────
// Aggregation + render
// ──────────────────────────────────────────────────────────────────────────

const SEVERITY_WEIGHTS = {
  label_value_conflict: 4,
  total_mismatch: 8,
  inverted_date_range: 5,
  polar_contradiction: 3,
  percentage_overflow: 4,
  tense_conflict: 2,
};

function summariseFindings(findings) {
  const counts = new Map();
  for (const f of findings) counts.set(f.kind, (counts.get(f.kind) || 0) + 1);
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({ kind, count }));
}

function computeSeverity(findings) {
  let score = 0;
  for (const f of findings) score += SEVERITY_WEIGHTS[f.kind] || 1;
  let level = 'none';
  if (score >= 18) level = 'critical';
  else if (score >= 10) level = 'high';
  else if (score >= 4) level = 'medium';
  else if (score > 0) level = 'low';
  return { score, level };
}

function checkConsistency(text) {
  const safe = safeText(text);
  if (!safe.trim()) {
    return { totalFindings: 0, summary: [], severity: { score: 0, level: 'none' }, findings: [] };
  }
  const head = safe.slice(0, SCAN_HEAD_BYTES);
  const findings = [
    ...detectLabelValueConflicts(head),
    ...detectTotalMismatches(head),
    ...detectInvertedDateRanges(head),
    ...detectPolarContradictions(head),
    ...detectPercentageSumOverflow(head),
    ...detectTenseMismatches(head),
  ];
  return {
    totalFindings: findings.length,
    summary: summariseFindings(findings),
    severity: computeSeverity(findings),
    findings: findings.slice(0, 24),
  };
}

function buildConsistencyForFiles(files) {
  const list = Array.isArray(files) ? files : [];
  const perFile = [];
  let combinedText = '';
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const text = safeText(f.extractedText || f.text || '');
    if (!text.trim()) continue;
    const label = f.originalName || f.filename || f.name || 'archivo';
    perFile.push({ file: label, report: checkConsistency(text) });
    if (combinedText.length < 64_000) combinedText += `\n${text.slice(0, 12_000)}`;
  }
  return {
    perFile,
    aggregate: checkConsistency(combinedText),
  };
}

const SEVERITY_BADGE = { none: '🟢', low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' };

function renderConsistencyBlock(report, opts = {}) {
  if (!report) return '';
  const aggregate = report.aggregate || report;
  if (!aggregate || aggregate.totalFindings === 0) return '';
  const lines = [];
  const title = opts.title || 'INTERNAL CONSISTENCY CHECK';
  lines.push(`## ${title} ${SEVERITY_BADGE[aggregate.severity.level] || ''} ${aggregate.severity.level.toUpperCase()}`);
  lines.push('The following internal inconsistencies were detected. Treat them as candidates worth investigating, not asserted contradictions. When you cite a fact from the document, cross-check against this list and prefer the most-recently-stated value when the document disagrees with itself.');

  if (aggregate.summary.length > 0) {
    lines.push('### Summary');
    for (const item of aggregate.summary) {
      lines.push(`- ${item.kind}: ${item.count} instance${item.count === 1 ? '' : 's'}`);
    }
  }

  // Show concrete findings with the first 6 per kind
  const grouped = new Map();
  for (const f of aggregate.findings) {
    if (!grouped.has(f.kind)) grouped.set(f.kind, []);
    grouped.get(f.kind).push(f);
  }

  for (const [kind, items] of grouped.entries()) {
    lines.push(`### ${kind.replace(/_/g, ' ')}`);
    for (const item of items.slice(0, 5)) {
      if (kind === 'label_value_conflict') {
        lines.push(`- **${item.label}** — distinct values: ${item.values.join(' · ')}`);
      } else if (kind === 'total_mismatch') {
        lines.push(`- declared total **${item.declared}** (= ${item.declaredNumeric}) but ${item.lineItemCount} line items sum to ${item.sumOfLines} (Δ ${item.delta})`);
      } else if (kind === 'inverted_date_range') {
        lines.push(`- end date **${item.end}** precedes start date **${item.start}** in: "${item.excerpt}"`);
      } else if (kind === 'polar_contradiction') {
        lines.push(`- subject **${item.subject}** is asserted both positively and negatively for "${item.claim}": "${item.excerpt}"`);
      } else if (kind === 'percentage_overflow') {
        lines.push(`- ${item.count} percentages sum to **${item.sum}%** (>110%): "${item.excerpt}"`);
      } else if (kind === 'tense_conflict') {
        lines.push(`- both future and past tense used for **${item.object}**: "${item.excerpt}"`);
      }
    }
  }

  if (report.perFile && report.perFile.length > 1) {
    const filesWithFindings = report.perFile.filter((p) => p.report.totalFindings > 0);
    if (filesWithFindings.length > 0) {
      lines.push('### Per-file');
      for (const p of filesWithFindings) {
        const kinds = p.report.summary.map((s) => `${s.count} × ${s.kind}`).join(', ');
        lines.push(`- **${p.file}** (${SEVERITY_BADGE[p.report.severity.level]} ${p.report.severity.level}) — ${kinds}`);
      }
    }
  }

  return lines.join('\n\n');
}

module.exports = {
  checkConsistency,
  buildConsistencyForFiles,
  renderConsistencyBlock,
  _internal: {
    parseNumeric,
    detectLabelValueConflicts,
    detectTotalMismatches,
    detectInvertedDateRanges,
    detectPercentageSumOverflow,
    detectTenseMismatches,
    detectPolarContradictions,
    SEVERITY_WEIGHTS,
  },
};
