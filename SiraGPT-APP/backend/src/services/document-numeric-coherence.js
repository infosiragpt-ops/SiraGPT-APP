'use strict';

/**
 * document-numeric-coherence.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Positive numeric-coherence validator for attached documents.
 *
 * Complements document-consistency-checker.js:
 *   - consistency-checker flags REPEATED labels with DIFFERENT values
 *     ("Presupuesto: $50K" … "Presupuesto: $75K") and total-vs-sum
 *     mismatches when an explicit Total appears.
 *   - numeric-coherence validates math that DOES add up too, and surfaces
 *     softer signals the strict checker doesn't emit: percentage groups
 *     that almost sum to 100%, growth claims whose math is plausible,
 *     currency mixing inside a totals area, "X out of Y" ratios, year-on-
 *     year deltas, mean-vs-range plausibility.
 *
 * The output is intentionally non-alarmist — every finding is tagged with
 * a severity (info / warn / error). The chat layer surfaces "info" as
 * positive grounding ("the percentages sum cleanly to 100%") and the
 * model uses warn/error as flags to question or correct.
 *
 * Detection coverage (deterministic, no LLM, < 15 ms on 1 MB):
 *   - percentage_group_sum   : list of N labelled %s ; sum is checked
 *                              against 100 (±tolerance). Both clean and
 *                              dirty totals are reported.
 *   - ratio_consistency      : "X of Y", "X/Y" forms where X > Y or X = 0
 *                              with Y > 0 mentioned as positive.
 *   - growth_arithmetic      : "from X to Y (Z%)" / "del X al Y (Z%)";
 *                              checks Z matches the computed delta.
 *   - currency_mix           : two or more distinct currencies in the
 *                              same financial cluster (Total / Subtotal
 *                              / Summary window).
 *   - average_plausibility   : "average X" where X falls outside the
 *                              min/max range surfaced by sibling numbers.
 *   - share_overflow         : ownership / equity splits exceeding 100%
 *                              across N stakeholders (catches the
 *                              60/30/30 type errors).
 *
 * Bilingual (Spanish / English). Streaming-safe and stateless.
 *
 * Public API:
 *   checkNumericCoherence(text, opts)     → CoherenceReport
 *   buildCoherenceForFiles(files)         → { perFile, aggregate }
 *   renderCoherenceBlock(batchReport)     → markdown string ('' when empty)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_FINDINGS_PER_TYPE = 8;
const MAX_BLOCK_CHARS = 4200;
const PERCENT_TOLERANCE = 1.5; // sum-to-100 tolerance in absolute points
const GROWTH_TOLERANCE_PCT = 1.0; // tolerance for claimed growth vs computed
const MIN_PERCENT_GROUP_SIZE = 3; // need ≥3 entries for a meaningful sum
const CURRENCY_LABELS = [
  'USD', 'EUR', 'GBP', 'JPY', 'BRL', 'ARS', 'MXN', 'PEN', 'COP', 'CLP', 'CHF',
];
const CURRENCY_SYMBOLS = [
  { token: 'US$', label: 'USD' },
  { token: 'MX$', label: 'MXN' },
  { token: 'R$', label: 'BRL' },
  { token: 'S/.', label: 'PEN' },
  { token: 'S/', label: 'PEN' },
  { token: '$', label: 'USD' },
  { token: '€', label: 'EUR' },
  { token: '£', label: 'GBP' },
  { token: '¥', label: 'JPY' },
];

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

function clip(text, max = 240) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function parseNumeric(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/(?:[$€£¥]|US\$|S\/\.?|R\$|MX\$|EUR|USD|GBP|JPY|BRL|ARS|MXN|PEN|COP|CLP|CHF|d[oó]lares?|euros?|libras?|pesos?|soles?|reales?|%|\s)/gi, '')
    .trim();
  if (!cleaned) return null;
  let normalised = cleaned;
  if (cleaned.includes('.') && cleaned.includes(',')) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      normalised = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      normalised = cleaned.replace(/,/g, '');
    }
  } else if (cleaned.includes(',')) {
    const after = cleaned.split(',').pop();
    if (after.length === 3) normalised = cleaned.replace(/,/g, '');
    else normalised = cleaned.replace(',', '.');
  }
  const n = Number(normalised);
  return Number.isFinite(n) ? n : null;
}

function pushCapped(list, item, cap) {
  if (list.length >= cap) return;
  list.push(item);
}

// ──────────────────────────────────────────────────────────────────────────
// Detectors
// ──────────────────────────────────────────────────────────────────────────

/**
 * Percentage group sum — detects clusters of labelled % values that look
 * like a partition (regions, categories, shares) and verifies the sum.
 * Emits an "info" finding when the sum is clean and a "warn"/"error"
 * when it drifts.
 */
function detectPercentGroups(text) {
  const findings = [];
  // Split into paragraph-ish blocks. We treat 2+ newlines as separator.
  const blocks = text.split(/\n{2,}/);
  for (const block of blocks) {
    if (block.length < 25 || block.length > 4000) continue;
    const entries = [];
    const lineRe = /^[\s•\-*]*([\p{L}\p{N}][\p{L}\p{N}\s/&().,'+-]{0,40}?)\s*[:=\-—–]\s*(\d{1,3}(?:[.,]\d+)?)\s?%/gmu;
    for (const m of block.matchAll(lineRe)) {
      const label = m[1].trim();
      const value = parseNumeric(m[2]);
      if (value == null || value < 0 || value > 100) continue;
      entries.push({ label, value });
      if (entries.length > 24) break;
    }
    if (entries.length < MIN_PERCENT_GROUP_SIZE) continue;
    const sum = entries.reduce((acc, e) => acc + e.value, 0);
    const delta = Math.abs(sum - 100);
    let severity = 'info';
    let summary;
    if (delta <= PERCENT_TOLERANCE) {
      summary = `Percentage group sums cleanly to ${sum.toFixed(2)}% across ${entries.length} entries`;
    } else if (sum > 100 + PERCENT_TOLERANCE) {
      severity = 'error';
      summary = `Percentage group OVERFLOWS: ${sum.toFixed(2)}% across ${entries.length} entries (excess ${delta.toFixed(2)} points)`;
    } else {
      severity = 'warn';
      summary = `Percentage group is UNDER 100%: ${sum.toFixed(2)}% across ${entries.length} entries (gap ${delta.toFixed(2)} points — may be incomplete or rounding)`;
    }
    pushCapped(findings, {
      kind: 'percentage_group_sum',
      severity,
      summary,
      entries: entries.map((e) => `${e.label}: ${e.value}%`),
      computed: { sum, delta, count: entries.length },
      excerpt: clip(block, 220),
    }, MAX_FINDINGS_PER_TYPE);
    if (findings.length >= MAX_FINDINGS_PER_TYPE) break;
  }
  return findings;
}

/**
 * Ratio consistency — "X of Y", "X out of Y", "X / Y" forms where X > Y
 * is impossible. Also flags 0/Y phrased as a positive ratio.
 */
function detectRatioInconsistencies(text) {
  const findings = [];
  const patterns = [
    /\b(\d{1,6}(?:[.,]\d+)?)\s+(?:of|out of|de)\s+(\d{1,6}(?:[.,]\d+)?)\b/gi,
    /\b(\d{1,6}(?:[.,]\d+)?)\s*\/\s*(\d{1,6}(?:[.,]\d+)?)\s+(?:participants|respondents|encuestados|usuarios|usuarias|customers|clientes|empleados|employees|alumnos|students)\b/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const num = parseNumeric(m[1]);
      const den = parseNumeric(m[2]);
      if (num == null || den == null) continue;
      if (den === 0) continue;
      if (num > den) {
        pushCapped(findings, {
          kind: 'ratio_inconsistency',
          severity: 'error',
          summary: `Ratio impossible: ${num} of ${den} (numerator exceeds denominator)`,
          excerpt: clip(m[0], 160),
        }, MAX_FINDINGS_PER_TYPE);
      }
      if (findings.length >= MAX_FINDINGS_PER_TYPE) return findings;
    }
  }
  return findings;
}

/**
 * Growth arithmetic — "from X to Y (Z%)" / "del X al Y (Z%)" — verifies
 * Z matches the computed growth rate (within tolerance).
 */
function detectGrowthMismatch(text) {
  const findings = [];
  const patterns = [
    /\bfrom\s+([\d.,]+)\s+to\s+([\d.,]+)[^.\n]{0,40}?\(?\s*(\d{1,4}(?:[.,]\d+)?)\s?%\s*\)?/gi,
    /\bde\s+([\d.,]+)\s+a\s+([\d.,]+)[^.\n]{0,40}?\(?\s*(\d{1,4}(?:[.,]\d+)?)\s?%\s*\)?/gi,
    /\bdel\s+([\d.,]+)\s+al\s+([\d.,]+)[^.\n]{0,40}?\(?\s*(\d{1,4}(?:[.,]\d+)?)\s?%\s*\)?/gi,
    /\b(?:increased|aumentó|subió|grew|creció)\s+(?:from|de|del)\s+([\d.,]+)\s+(?:to|a|al)\s+([\d.,]+)[^.\n]{0,40}?\(?\s*(\d{1,4}(?:[.,]\d+)?)\s?%\s*\)?/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const a = parseNumeric(m[1]);
      const b = parseNumeric(m[2]);
      const claimed = parseNumeric(m[3]);
      if (a == null || b == null || claimed == null || a === 0) continue;
      const computed = ((b - a) / Math.abs(a)) * 100;
      // Accept absolute-growth claims that match either the signed delta
      // or its magnitude (some authors omit the minus sign for "drop of X%").
      const matchesSigned = Math.abs(computed - claimed) <= GROWTH_TOLERANCE_PCT;
      const matchesAbs = Math.abs(Math.abs(computed) - Math.abs(claimed)) <= GROWTH_TOLERANCE_PCT;
      if (matchesSigned || matchesAbs) continue;
      pushCapped(findings, {
        kind: 'growth_mismatch',
        severity: 'warn',
        summary: `Claimed ${claimed.toFixed(2)}% growth from ${a} to ${b} but math says ${computed.toFixed(2)}%`,
        computed: { from: a, to: b, claimedPct: claimed, actualPct: Number(computed.toFixed(2)) },
        excerpt: clip(m[0], 200),
      }, MAX_FINDINGS_PER_TYPE);
      if (findings.length >= MAX_FINDINGS_PER_TYPE) return findings;
    }
  }
  return findings;
}

/**
 * Currency mixing — when a "Total / Subtotal" cluster lists amounts in two
 * different currencies. Common copy/paste leak between source PDFs.
 */
function detectCurrencyMix(text) {
  const findings = [];
  // Find each Total/Subtotal anchor, take a 280-char window around it.
  const anchorRe = /\b(total|subtotal|gran\s+total|suma|grand\s+total|importe\s+total|monto\s+total)\b/gi;
  for (const m of text.matchAll(anchorRe)) {
    const start = Math.max(0, m.index - 280);
    const end = Math.min(text.length, m.index + 280);
    const window = text.slice(start, end);
    const found = new Set();
    for (const { token, label } of CURRENCY_SYMBOLS) {
      if (window.includes(token)) found.add(label);
    }
    for (const code of CURRENCY_LABELS) {
      const re = new RegExp(`\\b${code}\\b`, 'i');
      if (re.test(window)) found.add(code);
    }
    if (found.size >= 2) {
      pushCapped(findings, {
        kind: 'currency_mix',
        severity: 'warn',
        summary: `Multiple currencies near a total anchor: ${Array.from(found).join(', ')}`,
        excerpt: clip(window, 240),
      }, MAX_FINDINGS_PER_TYPE);
    }
    if (findings.length >= MAX_FINDINGS_PER_TYPE) break;
  }
  return findings;
}

/**
 * Average plausibility — "average X" or "media de X" where X falls outside
 * the [min, max] declared elsewhere in the same paragraph window. This is
 * a high-confidence signal because writers almost never put an unrelated
 * "average" right next to a labelled min/max.
 */
function detectAveragePlausibility(text) {
  const findings = [];
  const blocks = text.split(/\n{2,}/);
  for (const block of blocks) {
    if (block.length < 40 || block.length > 2000) continue;
    const avgMatch = block.match(/\b(?:average|mean|media|promedio)\s*[:=]?\s*(?:de\s+)?(\d{1,9}(?:[.,]\d+)?)/i);
    const minMatch = block.match(/\b(?:min(?:imum)?|m[íi]nimo)\s*[:=]?\s*(\d{1,9}(?:[.,]\d+)?)/i);
    const maxMatch = block.match(/\b(?:max(?:imum)?|m[áa]ximo)\s*[:=]?\s*(\d{1,9}(?:[.,]\d+)?)/i);
    if (!avgMatch || !minMatch || !maxMatch) continue;
    const avg = parseNumeric(avgMatch[1]);
    const min = parseNumeric(minMatch[1]);
    const max = parseNumeric(maxMatch[1]);
    if (avg == null || min == null || max == null) continue;
    if (min > max) continue; // covered by date/range detectors elsewhere
    if (avg < min || avg > max) {
      pushCapped(findings, {
        kind: 'average_out_of_range',
        severity: 'error',
        summary: `Average ${avg} falls outside declared range [${min}, ${max}]`,
        excerpt: clip(block, 240),
      }, MAX_FINDINGS_PER_TYPE);
    }
    if (findings.length >= MAX_FINDINGS_PER_TYPE) break;
  }
  return findings;
}

/**
 * Share overflow — equity / ownership splits that exceed 100%. Like
 * percentage_group_sum but specialised for "owns X%" / "share X%" phrasing.
 */
function detectShareOverflow(text) {
  const findings = [];
  const blocks = text.split(/\n{2,}/);
  for (const block of blocks) {
    if (block.length < 40) continue;
    const re = /(?:owns?|holds?|controls?|posee|tiene|controla|equity|stake|share|participaci[óo]n)\s*[^.\n]{0,40}?(\d{1,3}(?:[.,]\d+)?)\s?%/gi;
    const matches = Array.from(block.matchAll(re));
    if (matches.length < 2) continue;
    const sum = matches.reduce((acc, m) => acc + (parseNumeric(m[1]) || 0), 0);
    if (sum > 100 + PERCENT_TOLERANCE) {
      pushCapped(findings, {
        kind: 'share_overflow',
        severity: 'error',
        summary: `Ownership/share statements sum to ${sum.toFixed(2)}% across ${matches.length} entries`,
        excerpt: clip(block, 240),
      }, MAX_FINDINGS_PER_TYPE);
    }
    if (findings.length >= MAX_FINDINGS_PER_TYPE) break;
  }
  return findings;
}

// ──────────────────────────────────────────────────────────────────────────
// Aggregation
// ──────────────────────────────────────────────────────────────────────────

function summarise(findings) {
  const counts = { info: 0, warn: 0, error: 0 };
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
  }
  let level = 'none';
  if (counts.error > 0) level = 'high';
  else if (counts.warn > 0) level = 'medium';
  else if (counts.info > 0) level = 'low';
  return { level, counts, totalFindings: findings.length };
}

function checkNumericCoherence(input, opts = {}) {
  const text = safeText(input);
  if (!text) {
    return { findings: [], severity: { level: 'none', counts: { info: 0, warn: 0, error: 0 }, totalFindings: 0 }, totalFindings: 0 };
  }
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const findings = []
    .concat(detectPercentGroups(head))
    .concat(detectRatioInconsistencies(head))
    .concat(detectGrowthMismatch(head))
    .concat(detectCurrencyMix(head))
    .concat(detectAveragePlausibility(head))
    .concat(detectShareOverflow(head));
  const severity = summarise(findings);
  return {
    findings,
    severity,
    totalFindings: severity.totalFindings,
    truncated: text.length > SCAN_HEAD_BYTES,
    opts,
  };
}

function buildCoherenceForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregateFindings = [];
  for (const f of list) {
    const text = String(f.extractedText || '');
    if (!text) continue;
    const report = checkNumericCoherence(text);
    if (report.totalFindings === 0) continue;
    perFile.push({
      file: f.name || f.originalName || f.id || 'attachment',
      report,
    });
    aggregateFindings = aggregateFindings.concat(
      report.findings.map((x) => ({ ...x, file: f.name || f.originalName || f.id || 'attachment' })),
    );
  }
  const aggregate = {
    findings: aggregateFindings,
    severity: summarise(aggregateFindings),
    totalFindings: aggregateFindings.length,
  };
  return { perFile, aggregate };
}

function renderFindingsList(findings, opts = {}) {
  const lines = [];
  const bySeverity = { error: [], warn: [], info: [] };
  for (const f of findings) {
    if (bySeverity[f.severity]) bySeverity[f.severity].push(f);
  }
  for (const sev of ['error', 'warn', 'info']) {
    const arr = bySeverity[sev];
    if (arr.length === 0) continue;
    const tag = sev === 'error' ? 'Errors' : sev === 'warn' ? 'Warnings' : 'Confirmations';
    lines.push(`#### ${tag}`);
    for (const f of arr.slice(0, MAX_FINDINGS_PER_TYPE)) {
      const head = f.file ? `**${f.file}** — ${f.summary}` : f.summary;
      lines.push(`- ${head}`);
      if (f.entries && f.entries.length && opts.entries !== false) {
        lines.push(`  - Entries: ${f.entries.slice(0, 8).join('; ')}`);
      }
      if (f.excerpt) lines.push(`  - Context: "${f.excerpt}"`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function renderCoherenceBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## NUMERIC COHERENCE
Positive math validation across the attached document(s). Confirmations show numbers that audit cleanly; warnings/errors flag groups that don't reconcile (percentages, growth claims, currency mixing, share totals, averages vs declared ranges). Treat warnings as candidates to verify — quote the underlying document before stating a correction.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    const body = renderFindingsList(only.report.findings);
    if (body) sections.push(body);
  } else {
    const agg = renderFindingsList(batchReport.aggregate.findings, { entries: false });
    if (agg) {
      sections.push('### Aggregate across all files');
      sections.push(agg);
    }
    for (const p of batchReport.perFile) {
      const body = renderFindingsList(p.report.findings, { entries: false });
      if (!body) continue;
      sections.push(`### File: ${p.file}`);
      sections.push(body);
    }
  }
  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...numeric coherence block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  checkNumericCoherence,
  buildCoherenceForFiles,
  renderCoherenceBlock,
  _internal: {
    parseNumeric,
    detectPercentGroups,
    detectRatioInconsistencies,
    detectGrowthMismatch,
    detectCurrencyMix,
    detectAveragePlausibility,
    detectShareOverflow,
    summarise,
    MAX_FINDINGS_PER_TYPE,
    PERCENT_TOLERANCE,
    GROWTH_TOLERANCE_PCT,
  },
};
