'use strict';

/**
 * document-pip-reqs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Python pip requirement specifiers (requirements.txt, pyproject.toml,
 * setup.py, setup.cfg):
 *
 *   - exact:    foo==1.2.3
 *   - constraint: foo>=1.0, foo<2.0, foo!=1.1, foo~=1.2
 *   - markers:  foo; python_version >= "3.10"
 *   - extras:   foo[extra1,extra2]==1.0
 *   - editable: -e .[dev]
 *   - VCS:      git+https://github.com/x/y@branch
 *
 * Public API:
 *   extractPipReqs(text)             → { entries, totals, total }
 *   buildPipReqsForFiles(files)      → { perFile, aggregate, totals }
 *   renderPipReqsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const REQ_RE = /^\s*([A-Za-z][A-Za-z0-9_.-]{0,80})(\[[A-Za-z0-9_,-]{1,80}\])?\s*(==|>=|<=|!=|~=|>|<)\s*([0-9][0-9a-zA-Z._-]{0,40})(?:\s*;\s*([^\n]{1,200}))?/gm;
const VCS_RE = /\b(git|svn|hg|bzr)\+https?:\/\/([A-Za-z0-9.\-/_@:]+)/g;
const EDITABLE_RE = /^\s*-e\s+(\S{2,200})/gm;
const RAW_PKG_RE = /^\s*([A-Za-z][A-Za-z0-9_.-]{1,80})(?:\s*$|\s*#)/gm;

const RESERVED = new Set(['python', 'pip', 'setuptools', 'wheel']);

function classifyOp(op) {
  if (op === '==') return 'exact';
  if (op === '~=') return 'compatible';
  if (op === '!=') return 'exclude';
  if (op.startsWith('>')) return 'min-bound';
  if (op.startsWith('<')) return 'max-bound';
  return 'other';
}

function extractPipReqs(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { exact: 0, 'min-bound': 0, 'max-bound': 0, compatible: 0, exclude: 0, vcs: 0, editable: 0, bare: 0 };

  REQ_RE.lastIndex = 0;
  let m;
  while ((m = REQ_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const name = m[1];
    if (RESERVED.has(name.toLowerCase())) continue;
    const extras = m[2] || null;
    const op = m[3];
    const version = m[4];
    const marker = m[5] || null;
    const kind = classifyOp(op);
    const key = `pkg:${name}${extras || ''}:${op}:${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ name, extras, op, version, marker, kind });
    if (totals[kind] != null) totals[kind] += 1;
  }

  if (entries.length < MAX_PER_FILE) {
    VCS_RE.lastIndex = 0;
    while ((m = VCS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const ref = `${m[1]}+${m[2]}`.slice(0, 100);
      const key = `vcs:${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ name: ref, kind: 'vcs', op: 'vcs', version: null });
      totals.vcs += 1;
    }
  }

  if (entries.length < MAX_PER_FILE) {
    EDITABLE_RE.lastIndex = 0;
    while ((m = EDITABLE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const key = `editable:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ name: m[1].slice(0, 80), kind: 'editable', op: 'editable', version: null });
      totals.editable += 1;
    }
  }

  if (entries.length < MAX_PER_FILE) {
    RAW_PKG_RE.lastIndex = 0;
    while ((m = RAW_PKG_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const name = m[1];
      if (RESERVED.has(name.toLowerCase())) continue;
      const key = `bare:${name}`;
      if (seen.has(key)) continue;
      // Only add if not already seen via versioned form
      const versioned = Array.from(seen).some((s) => s.startsWith(`pkg:${name}`));
      if (versioned) continue;
      seen.add(key);
      entries.push({ name, kind: 'bare', op: null, version: null });
      totals.bare += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildPipReqsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { exact: 0, 'min-bound': 0, 'max-bound': 0, compatible: 0, exclude: 0, vcs: 0, editable: 0, bare: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractPipReqs(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}:${e.version || ''}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderPipReqsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## PYTHON PIP REQUIREMENTS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 12)) {
      const ext = e.extras || '';
      const verPart = e.op && e.version ? `${e.op}${e.version}` : '';
      const mark = e.marker ? ` ;${e.marker.slice(0, 50)}` : '';
      lines.push(`- \`${e.name}${ext}${verPart}\`${mark} (${e.kind})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractPipReqs,
  buildPipReqsForFiles,
  renderPipReqsBlock,
  _internal: { classifyOp },
};
