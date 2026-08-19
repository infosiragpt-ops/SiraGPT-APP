'use strict';

/**
 * document-cargo-packages.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Rust Cargo dependency references in Cargo.toml / Cargo.lock:
 *
 *   - name = "foo" with version = "1.2.3"
 *   - inline:  serde = "1.0", tokio = { version = "1", features = ["full"] }
 *   - workspace: serde = { workspace = true }
 *   - path / git: foo = { path = "../foo" } / git = "https://..."
 *   - Cargo.lock:  [[package]]\nname = "foo"\nversion = "1.0"
 *
 * Public API:
 *   extractCargoPackages(text)             → { entries, totals, total }
 *   buildCargoPackagesForFiles(files)      → { perFile, aggregate, totals }
 *   renderCargoPackagesBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 100_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const INLINE_RE = /^\s*([a-z0-9][a-z0-9_-]{1,40})\s*=\s*"(\d+(?:\.\d+){0,2}(?:[-+][A-Za-z0-9.-]+)?)"/gm;
const TABLE_RE = /^\s*([a-z0-9][a-z0-9_-]{1,40})\s*=\s*\{\s*([^}\n]{2,200})\}/gm;
const LOCK_RE = /^\[\[package\]\]\s*\n\s*name\s*=\s*"([a-z0-9][a-z0-9_-]{1,60})"\s*\n\s*version\s*=\s*"(\d+(?:\.\d+){0,2}(?:[-+][A-Za-z0-9.-]+)?)"/gm;

function classifySource(value) {
  if (/\bworkspace\s*=\s*true/.test(value)) return 'workspace';
  if (/\bgit\s*=/.test(value)) return 'git';
  if (/\bpath\s*=/.test(value)) return 'path';
  if (/\bversion\s*=/.test(value)) return 'registry';
  return 'unknown';
}

function extractVersion(value) {
  const m = /\bversion\s*=\s*"(\d+(?:\.\d+){0,2}(?:[-+][A-Za-z0-9.-]+)?)"/.exec(value);
  return m ? m[1] : null;
}

function extractCargoPackages(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { registry: 0, workspace: 0, git: 0, path: 0, lock: 0 };

  // Lock file packages (high signal)
  LOCK_RE.lastIndex = 0;
  let m;
  while ((m = LOCK_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const key = `lock:${m[1]}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ name: m[1], version: m[2], source: 'lock' });
    totals.lock += 1;
  }

  // Inline simple form
  if (entries.length < MAX_PER_FILE) {
    INLINE_RE.lastIndex = 0;
    while ((m = INLINE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `inline:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ name: m[1], version: m[2], source: 'registry' });
      totals.registry += 1;
    }
  }

  // Table form
  if (entries.length < MAX_PER_FILE) {
    TABLE_RE.lastIndex = 0;
    while ((m = TABLE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `table:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const source = classifySource(m[2]);
      const version = extractVersion(m[2]);
      entries.push({ name: m[1], version, source });
      if (totals[source] != null) totals[source] += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildCargoPackagesForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { registry: 0, workspace: 0, git: 0, path: 0, lock: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractCargoPackages(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.name}:${e.version || 'workspace'}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.source] != null) totals[e.source] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderCargoPackagesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## RUST / CARGO PACKAGES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 12)) {
      const v = e.version ? ` = "${e.version}"` : '';
      lines.push(`- \`${e.name}\`${v} (${e.source})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractCargoPackages,
  buildCargoPackagesForFiles,
  renderCargoPackagesBlock,
  _internal: { classifySource, extractVersion },
};
