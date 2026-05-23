'use strict';

/**
 * document-versions.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects software/document version references and release-note markers:
 *
 *   - SemVer: "1.2.3", "1.2.3-rc.1", "1.2.3+build.42", "v2.0.0"
 *   - "Version: X.Y.Z" labeled lines (English + Spanish "Versión:")
 *   - Release headers: "## v1.2.3 (2024-03-15)", "Release 1.2.3"
 *   - CalVer YYYY.MM.DD-like markers
 *
 * Different from document-identifiers (ISBN/DOI etc.) and
 * document-dependencies (per-package) by focusing on document-level
 * release versioning. Routes "what version is this?", "what's the
 * latest release?" to a citeable list.
 *
 * Public API:
 *   extractVersions(text)         → VersionReport
 *   buildVersionsForFiles(files)  → { perFile, aggregate, totals }
 *   renderVersionsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_KIND = 8;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4500;
const MAX_VALUE_LEN = 80;

// Strict SemVer with optional v prefix, optional pre-release / build
const SEMVER_RE = /(?:^|[\s`'"<>(,;:])(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=[\s`'"<>):,;.!?]|$)/g;
// Version: X.Y.Z labeled lines
const VERSION_LABEL_RE = /^[\t ]*(?:Version|Versi[óo]n|Release|Lanzamiento|Tag)\s*[:\-—]\s*(v?\d+(?:\.\d+){0,3}(?:[-+][\w.-]+)?)/gim;
// Release headers
const RELEASE_HEADER_RE = /^[\t ]*(?:#{1,6}\s+)?(?:Release|Version|Lanzamiento|Versi[óo]n)\s+(v?\d+(?:\.\d+){0,3}(?:[-+][\w.-]+)?)(?:\s*\(([^)]+)\))?/gim;
// CalVer (YYYY.MM.DD or YYYY.M.D)
const CALVER_RE = /(?:^|[\s`'"<>(])(20\d{2}\.(?:0?[1-9]|1[0-2])\.(?:0?[1-9]|[12]\d|3[01]))(?=[\s`'"<>):,;.!?]|$)/g;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipText(s) {
  const t = String(s || '').trim();
  if (t.length <= MAX_VALUE_LEN) return t;
  return `${t.slice(0, MAX_VALUE_LEN - 1)}…`;
}

function normaliseVersion(v) {
  const s = String(v || '').trim();
  return s.replace(/^v/i, '');
}

function isLikelySemver(v) {
  return /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(v);
}

function emptyTotals() {
  return { semver: 0, calver: 0, labeled: 0, release: 0 };
}

function extractVersions(input) {
  const text = safeText(input);
  if (!text) return { versions: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const versions = [];
  const seen = new Set();
  const totals = emptyTotals();

  function add(kind, value, date) {
    if (versions.length >= MAX_PER_FILE) return;
    if (totals[kind] >= MAX_PER_KIND) return;
    const v = clipText(value);
    if (!v) return;
    const key = `${kind}|${v.toLowerCase()}|${date || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    versions.push({ kind, value: v, version: normaliseVersion(v), date: date || null });
    totals[kind] += 1;
  }

  // Labeled lines first (highest confidence)
  for (const m of head.matchAll(VERSION_LABEL_RE)) {
    add('labeled', m[1]);
  }
  // Release headers
  for (const m of head.matchAll(RELEASE_HEADER_RE)) {
    add('release', m[1], m[2] ? clipText(m[2]) : null);
  }
  // SemVer anywhere
  for (const m of head.matchAll(SEMVER_RE)) {
    if (!isLikelySemver(m[1])) continue;
    add('semver', m[1]);
  }
  // CalVer
  for (const m of head.matchAll(CALVER_RE)) {
    add('calver', m[1]);
  }

  return { versions, total: versions.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildVersionsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractVersions(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, versions: r.versions, totals: r.totals });
    aggregate = aggregate.concat(r.versions.map((v) => ({ ...v, file: name })));
    for (const k of Object.keys(totals)) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderVersion(v, opts = {}) {
  const file = opts.includeFile && v.file ? ` _(${v.file})_` : '';
  const date = v.date ? ` — ${v.date}` : '';
  return `- [${v.kind}] \`${v.value}\`${date}${file}`;
}

function renderVersionsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## VERSIONS / RELEASES
Version markers detected in the document(s): SemVer (X.Y.Z, X.Y.Z-rc.1, X.Y.Z+build), labeled "Version: …" lines (English + Spanish "Versión: …"), release headers ("## v1.2.3 (date)"), and CalVer (YYYY.MM.DD). Different from per-package dependency versions. Routes "what version is this?" / "what's the latest release?" to a citeable list.

**Totals:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const v of only.versions) sections.push(renderVersion(v));
  } else {
    sections.push('### Aggregate versions across all files');
    for (const v of report.aggregate) sections.push(renderVersion(v, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const v of p.versions) sections.push(renderVersion(v));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...versions block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractVersions,
  buildVersionsForFiles,
  renderVersionsBlock,
  _internal: {
    SEMVER_RE,
    VERSION_LABEL_RE,
    RELEASE_HEADER_RE,
    CALVER_RE,
    isLikelySemver,
    normaliseVersion,
  },
};
