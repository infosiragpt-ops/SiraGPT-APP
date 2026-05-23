'use strict';

/**
 * document-helm-refs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Helm chart references in shell commands, K8s manifests, and CI
 * pipelines:
 *
 *   - helm install/upgrade NAME CHART [--version V] [-n NAMESPACE]
 *   - helm repo add NAME URL
 *   - source: https://charts.bitnami.com/bitnami
 *   - chart: bitnami/redis (in Argo CD / Flux specs)
 *   - Chart.yaml: name: foo / version: 1.2.3
 *
 * Public API:
 *   extractHelmRefs(text)             → { entries, totals, total }
 *   buildHelmRefsForFiles(files)      → { perFile, aggregate, totals }
 *   renderHelmRefsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 4500;

const HELM_INSTALL_RE = /\bhelm\s+(install|upgrade|template)\s+([a-z][a-z0-9-]{1,60})\s+([a-z][a-z0-9-]{1,30}\/[a-z][a-z0-9-]{1,60})(?:\s+--version\s+([0-9][0-9.a-z-]{1,30}))?/gi;
const HELM_REPO_ADD_RE = /\bhelm\s+repo\s+add\s+([a-z][a-z0-9-]{1,40})\s+(https?:\/\/[A-Za-z0-9.\-/_]{4,200})/gi;
const HELM_CHART_RE = /\bchart\s*:\s*([a-z][a-z0-9-]{1,30}\/[a-z][a-z0-9-]{1,60})\b/gi;
const HELM_REPO_URL_RE = /\b(?:repo|repoURL|repository)\s*:\s*['"]?(https?:\/\/[A-Za-z0-9.\-/_]{4,200})['"]?/gi;
const CHART_YAML_NAME_RE = /^\s*name\s*:\s*([a-z][a-z0-9-]{1,60})/gm;
const CHART_YAML_VERSION_RE = /^\s*version\s*:\s*['"]?([0-9][0-9.a-z-]{0,30})['"]?/gm;

function extractHelmRefs(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { install: 0, repoAdd: 0, chart: 0, repoUrl: 0, chartYaml: 0 };

  function push(kind, ref, ctx) {
    const key = `${kind}:${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, ref, context: ctx });
    if (totals[kind] != null) totals[kind] += 1;
  }

  HELM_INSTALL_RE.lastIndex = 0;
  let m;
  while ((m = HELM_INSTALL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const cmd = m[1];
    const release = m[2];
    const chart = m[3];
    const version = m[4] || null;
    const ref = `${release}@${chart}${version ? `:${version}` : ''}`;
    push('install', ref, cmd);
  }

  if (entries.length < MAX_PER_FILE) {
    HELM_REPO_ADD_RE.lastIndex = 0;
    while ((m = HELM_REPO_ADD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('repoAdd', `${m[1]}=${m[2]}`, 'helm-repo-add');
    }
  }

  if (entries.length < MAX_PER_FILE) {
    HELM_CHART_RE.lastIndex = 0;
    while ((m = HELM_CHART_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('chart', m[1], 'chart-field');
    }
  }

  if (entries.length < MAX_PER_FILE) {
    HELM_REPO_URL_RE.lastIndex = 0;
    while ((m = HELM_REPO_URL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const url = m[1];
      // Filter to chart-repo URLs only (heuristic: contains "charts" or "helm")
      if (!/charts|helm/i.test(url)) continue;
      push('repoUrl', url, 'repo-field');
    }
  }

  // Chart.yaml: name + version pair
  if (entries.length < MAX_PER_FILE) {
    CHART_YAML_NAME_RE.lastIndex = 0;
    CHART_YAML_VERSION_RE.lastIndex = 0;
    const nm = CHART_YAML_NAME_RE.exec(body);
    const vm = CHART_YAML_VERSION_RE.exec(body);
    if (nm) {
      const v = vm ? vm[1] : null;
      push('chartYaml', `${nm[1]}${v ? `@${v}` : ''}`, 'Chart.yaml');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildHelmRefsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { install: 0, repoAdd: 0, chart: 0, repoUrl: 0, chartYaml: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractHelmRefs(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.ref}`;
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

function renderHelmRefsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## HELM CHART REFERENCES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- ${e.kind}: \`${e.ref}\` (${e.context})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractHelmRefs,
  buildHelmRefsForFiles,
  renderHelmRefsBlock,
};
