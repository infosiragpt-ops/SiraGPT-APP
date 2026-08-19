'use strict';

/**
 * document-frontmatter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects markdown frontmatter blocks: YAML (delimited by ---), TOML
 * (delimited by +++), and JSON ({…} at top). Extracts top-level keys without
 * a full YAML/TOML/JSON parser — just regex-based key:value pairs.
 *
 * Public API:
 *   extractFrontmatter(text)             → { entries, totals, total }
 *   buildFrontmatterForFiles(files)      → { perFile, aggregate, totals }
 *   renderFrontmatterBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 30_000;
const MAX_KEYS_PER_FILE = 16;
const MAX_AGGREGATE_KEYS = 22;
const MAX_BLOCK_CHARS = 4500;

// Anchored to absolute start of text (no /m flag — `^` matches start-of-string only)
const YAML_RE = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;
const TOML_RE = /^\+\+\+\s*\n([\s\S]*?)\n\+\+\+\s*(?:\n|$)/;
const JSON_RE = /^\s*\{([\s\S]{2,2000}?)\}\s*\n/;

function parseYaml(body) {
  const out = {};
  const lines = body.split('\n');
  for (const line of lines) {
    const m = /^([A-Za-z][A-Za-z0-9_-]{0,40}):\s*(.{0,500})$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function parseToml(body) {
  const out = {};
  const lines = body.split('\n');
  for (const line of lines) {
    const m = /^([A-Za-z][A-Za-z0-9_-]{0,40})\s*=\s*(.{0,200})$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function parseJson(body) {
  const out = {};
  const re = /"([A-Za-z][A-Za-z0-9_-]{0,40})"\s*:\s*(?:"((?:\\.|[^"\\]){0,200})"|([0-9.]+|true|false|null))/g;
  let m;
  while ((m = re.exec(body))) {
    out[m[1]] = m[2] != null ? m[2] : m[3];
    if (Object.keys(out).length >= 30) break;
  }
  return out;
}

function summariseValue(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.length > 80) return `${s.slice(0, 80)}…`;
  return s;
}

function extractFrontmatter(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const totals = { yaml: 0, toml: 0, json: 0 };

  const yaml = YAML_RE.exec(body);
  if (yaml) {
    const parsed = parseYaml(yaml[1]);
    const keys = Object.keys(parsed).slice(0, MAX_KEYS_PER_FILE);
    if (keys.length) {
      entries.push({ format: 'yaml', keys, values: keys.map((k) => summariseValue(parsed[k])) });
      totals.yaml += 1;
    }
  }

  const toml = TOML_RE.exec(body);
  if (toml) {
    const parsed = parseToml(toml[1]);
    const keys = Object.keys(parsed).slice(0, MAX_KEYS_PER_FILE);
    if (keys.length) {
      entries.push({ format: 'toml', keys, values: keys.map((k) => summariseValue(parsed[k])) });
      totals.toml += 1;
    }
  }

  if (entries.length === 0) {
    // Only try JSON if no YAML/TOML detected (avoid double-counting)
    const json = JSON_RE.exec(body);
    if (json && json[1].includes(':')) {
      const parsed = parseJson(json[1]);
      const keys = Object.keys(parsed).slice(0, MAX_KEYS_PER_FILE);
      if (keys.length) {
        entries.push({ format: 'json', keys, values: keys.map((k) => summariseValue(parsed[k])) });
        totals.json += 1;
      }
    }
  }

  return { entries, totals, total: entries.length };
}

function buildFrontmatterForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggregate = [];
  const totals = { yaml: 0, toml: 0, json: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractFrontmatter(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      aggregate.push({ ...e, file: file.name || '(unnamed)' });
      if (totals[e.format] != null) totals[e.format] += 1;
      if (aggregate.length >= MAX_AGGREGATE_KEYS) break;
    }
    if (aggregate.length >= MAX_AGGREGATE_KEYS) break;
  }
  return { perFile, aggregate, totals };
}

function renderFrontmatterBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## DOCUMENT FRONTMATTER'];
  const t = report.totals || {};
  const parts = [];
  if (t.yaml) parts.push(`yaml: ${t.yaml}`);
  if (t.toml) parts.push(`toml: ${t.toml}`);
  if (t.json) parts.push(`json: ${t.json}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 4)) {
      lines.push(`- Format: ${e.format}`);
      for (let i = 0; i < Math.min(e.keys.length, 10); i++) {
        lines.push(`  - \`${e.keys[i]}\`: ${e.values[i] || ''}`);
      }
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractFrontmatter,
  buildFrontmatterForFiles,
  renderFrontmatterBlock,
  _internal: { parseYaml, parseToml, parseJson },
};
