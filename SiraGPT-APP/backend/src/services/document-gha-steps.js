'use strict';

/**
 * document-gha-steps.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects GitHub Actions step references in workflow YAML files:
 *
 *   - uses: actions/checkout@v4
 *   - uses: actions/setup-node@v3 (with version pinning)
 *   - uses: ./local-action (local action)
 *   - uses: docker://image:tag (docker action)
 *
 * Also captures workflow `name:` and `on:` triggers for context.
 *
 * Public API:
 *   extractGhaSteps(text)            → { entries, totals, total }
 *   buildGhaStepsForFiles(files)     → { perFile, aggregate, totals }
 *   renderGhaStepsBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 26;
const MAX_BLOCK_CHARS = 4800;

const USES_RE = /^\s*-?\s*uses\s*:\s*['"]?([A-Za-z0-9./_-]{2,120}@[A-Za-z0-9._-]{1,60}|\.\/[A-Za-z0-9._/-]{1,120}|docker:\/\/[A-Za-z0-9.:/_-]{2,200})['"]?/gim;
const WORKFLOW_NAME_RE = /^\s*name\s*:\s*['"]?([^'"\n]{2,80})['"]?/m;
const TRIGGERS_RE = /^\s*on\s*:\s*(.{1,200})$/m;

function classifyAction(ref) {
  if (ref.startsWith('./')) return 'local';
  if (ref.startsWith('docker://')) return 'docker';
  const [owner] = ref.split('/');
  if (owner === 'actions') return 'official';
  if (owner === 'github' || owner === 'github-actions') return 'official';
  return 'community';
}

function parseRef(ref) {
  if (ref.startsWith('./')) return { kind: 'local', path: ref.slice(2), version: null };
  if (ref.startsWith('docker://')) return { kind: 'docker', path: ref.slice(9), version: null };
  const at = ref.indexOf('@');
  if (at < 0) return { kind: 'unknown', path: ref, version: null };
  return { kind: 'marketplace', path: ref.slice(0, at), version: ref.slice(at + 1) };
}

function extractGhaSteps(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0, workflow: null, triggers: null };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { official: 0, community: 0, local: 0, docker: 0 };

  const nameMatch = WORKFLOW_NAME_RE.exec(body);
  const workflow = nameMatch ? nameMatch[1].trim().slice(0, 80) : null;
  const triggerMatch = TRIGGERS_RE.exec(body);
  const triggers = triggerMatch ? triggerMatch[1].trim().slice(0, 120) : null;

  USES_RE.lastIndex = 0;
  let m;
  while ((m = USES_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const ref = m[1];
    if (seen.has(ref)) continue;
    seen.add(ref);
    const parsed = parseRef(ref);
    const ownership = classifyAction(ref);
    entries.push({
      ref,
      path: parsed.path,
      version: parsed.version,
      kind: parsed.kind,
      ownership,
    });
    if (totals[ownership] != null) totals[ownership] += 1;
  }

  return { entries, totals, total: entries.length, workflow, triggers };
}

function buildGhaStepsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { official: 0, community: 0, local: 0, docker: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractGhaSteps(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.ref)) continue;
      aggSeen.add(e.ref);
      aggregate.push(e);
      if (totals[e.ownership] != null) totals[e.ownership] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderGhaStepsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## GITHUB ACTIONS STEPS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    if (r.workflow) lines.push(`- Workflow: ${r.workflow}`);
    if (r.triggers) lines.push(`- Triggers: ${r.triggers}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- [${e.ownership}] \`${e.ref}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractGhaSteps,
  buildGhaStepsForFiles,
  renderGhaStepsBlock,
  _internal: { classifyAction, parseRef },
};
