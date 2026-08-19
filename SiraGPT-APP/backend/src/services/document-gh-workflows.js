'use strict';

/**
 * document-gh-workflows.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects GitHub Actions workflow YAML constructs (.github/workflows/*.yml):
 *
 *   - name: ... / on: [push, pull_request, schedule, workflow_dispatch]
 *   - jobs:    job-name: declarations
 *   - runs-on: ubuntu-latest / macos / windows / self-hosted
 *   - uses:    org/action-name@ref
 *   - steps:   inline step counts
 *   - secrets: ${{ secrets.X }} reference names (MASKED — only names emitted)
 *   - env:     env: NAME at top-level
 *   - permissions: contents/issues/pull-requests/...
 *   - concurrency: group-name / cancel-in-progress
 *
 * Public API:
 *   extractGhWorkflows(text)             → { entries, totals, total }
 *   buildGhWorkflowsForFiles(files)      → { perFile, aggregate, totals }
 *   renderGhWorkflowsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;

const JOBS_RE = /^jobs\s*:\s*$/m;
const JOB_NAME_RE = /^[ ]{2}([a-z][a-zA-Z0-9_-]{0,40})\s*:\s*$/gm;
const RUNS_ON_RE = /\bruns-on\s*:\s*(?:\[[^\]]{0,100}\]|["']?([a-zA-Z0-9._\/-]{2,60})["']?)/g;
const USES_RE = /\buses\s*:\s*["']?([a-zA-Z0-9._\/-]+@[a-zA-Z0-9._/-]+|\.\/[a-zA-Z0-9._\/-]+)["']?/g;
const ON_RE = /^on\s*:\s*(\[[^\]]{0,200}\]|["']?([a-z_]+)["']?|$)/m;
const ON_EVENTS_RE = /^[ \t]+([a-z_]+)\s*:/gm;
const SECRET_RE = /\$\{\{\s*secrets\.([A-Z_][A-Z0-9_]{0,60})\s*\}\}/g;
const PERMISSIONS_RE = /^[ \t]+(contents|issues|pull-requests|deployments|checks|statuses|actions|packages|id-token|attestations|security-events|pages)\s*:\s*(read|write|none|read-all|write-all)/gm;
const CONCURRENCY_RE = /^concurrency\s*:\s*\n((?:[ \t]+[^\n]{1,120}\n){1,5})/gm;
const CANCEL_IN_PROGRESS_RE = /\bcancel-in-progress\s*:\s*(true|false)/g;
const ENV_KEY_RE = /^[ \t]+([A-Z][A-Z0-9_]{1,60})\s*:\s*(?:["']|\$\{\{|[^\n]{1,80})/gm;

function isGhWorkflowLike(body) {
  return JOBS_RE.test(body) && (/\bon\s*:/.test(body) || /\bruns-on\s*:/.test(body));
}

function extractGhWorkflows(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isGhWorkflowLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    job: 0, runsOn: 0, uses: 0, event: 0, secret: 0,
    permission: 0, concurrency: 0, env: 0, cancelInProgress: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  JOB_NAME_RE.lastIndex = 0;
  let m;
  while ((m = JOB_NAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('job', m[1], null);
  }
  if (entries.length < MAX_PER_FILE) {
    RUNS_ON_RE.lastIndex = 0;
    while ((m = RUNS_ON_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('runsOn', m[1] || 'matrix', null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    USES_RE.lastIndex = 0;
    while ((m = USES_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('uses', m[1].slice(0, 80), null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SECRET_RE.lastIndex = 0;
    while ((m = SECRET_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('secret', m[1], '*** masked ***');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    PERMISSIONS_RE.lastIndex = 0;
    while ((m = PERMISSIONS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('permission', m[1], m[2]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    CANCEL_IN_PROGRESS_RE.lastIndex = 0;
    while ((m = CANCEL_IN_PROGRESS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('cancelInProgress', m[1], null);
    }
  }

  let concCount = 0;
  CONCURRENCY_RE.lastIndex = 0;
  while (CONCURRENCY_RE.exec(body) && concCount < 5) concCount += 1;
  totals.concurrency = concCount;

  return { entries, totals, total: entries.length };
}

function buildGhWorkflowsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    job: 0, runsOn: 0, uses: 0, event: 0, secret: 0,
    permission: 0, concurrency: 0, env: 0, cancelInProgress: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractGhWorkflows(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}`;
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

function renderGhWorkflowsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## GITHUB ACTIONS WORKFLOW'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const det = e.detail ? ` (${e.detail})` : '';
      lines.push(`- [${e.kind}] \`${e.name}\`${det}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractGhWorkflows,
  buildGhWorkflowsForFiles,
  renderGhWorkflowsBlock,
  _internal: { isGhWorkflowLike },
};
