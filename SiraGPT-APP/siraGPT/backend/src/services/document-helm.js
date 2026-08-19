'use strict';

/**
 * document-helm.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Helm chart values.yaml / templates / Chart.yaml constructs:
 *
 *   - image.repository + image.tag / image.pullPolicy
 *   - replicaCount / autoscaling.minReplicas / autoscaling.maxReplicas
 *   - resources.limits.cpu / resources.requests.memory
 *   - service.type / service.port / ingress.enabled / ingress.hosts
 *   - persistence.enabled / persistence.size / persistence.storageClass
 *   - serviceAccount.create / serviceAccount.name
 *   - Chart.yaml: name / version / appVersion / type
 *   - Template directives: {{ .Values.X }}, {{- if .Chart.Y -}}, {{ include "..." . }}
 *
 * Public API:
 *   extractHelm(text)             → { entries, totals, total }
 *   buildHelmForFiles(files)      → { perFile, aggregate, totals }
 *   renderHelmBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;

const VALUES_FIELD_RE = /^(image\.repository|image\.tag|image\.pullPolicy|replicaCount|service\.type|service\.port|ingress\.enabled|ingress\.className|persistence\.enabled|persistence\.size|persistence\.storageClass|serviceAccount\.create|serviceAccount\.name)\s*:\s*["']?([^"'\n#]{1,120})["']?/gm;
const NESTED_FIELD_RE = /^[ \t]+(repository|tag|pullPolicy|type|port|className|enabled|size|storageClass|create|create)\s*:\s*["']?([a-zA-Z0-9._\/:-]{1,80})["']?/gm;
const RESOURCES_RE = /\b(cpu|memory|ephemeral-storage)\s*:\s*["']?(\d+(?:\.\d+)?(?:m|Mi|Gi|Ki|Ti|Pi|Ei|G|M|K)?)["']?/g;
const TEMPLATE_VALUES_RE = /\{\{[-]?\s*\.Values\.([a-zA-Z][a-zA-Z0-9_.]{0,80})/g;
const TEMPLATE_CHART_RE = /\{\{[-]?\s*\.Chart\.([a-zA-Z][a-zA-Z0-9_]{0,60})/g;
const TEMPLATE_RELEASE_RE = /\{\{[-]?\s*\.Release\.([a-zA-Z][a-zA-Z0-9_]{0,60})/g;
const INCLUDE_RE = /\{\{[-]?\s*include\s+["']([^"'\n]{1,120})["']/g;
const CHART_NAME_RE = /^(name|version|appVersion|type|description|home|kubeVersion)\s*:\s*["']?([^"'\n#]{1,80})["']?/gm;
const AUTOSCALING_RE = /\bautoscaling\.(?:minReplicas|maxReplicas|targetCPUUtilizationPercentage)\s*:\s*(\d+)/g;

function isHelmLike(body) {
  return /\{\{[-]?\s*\.(?:Values|Chart|Release|Files|Capabilities)/.test(body)
    || /^apiVersion\s*:\s*v[12]\s*$/m.test(body)
    || /^image\.repository\s*:|^replicaCount\s*:/m.test(body);
}

function extractHelm(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isHelmLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    valuesField: 0, resource: 0, templateValues: 0, templateChart: 0,
    templateRelease: 0, include: 0, chartMeta: 0, autoscaling: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  VALUES_FIELD_RE.lastIndex = 0;
  let m;
  while ((m = VALUES_FIELD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('valuesField', m[1], m[2].trim().slice(0, 60));
  }
  if (entries.length < MAX_PER_FILE) {
    RESOURCES_RE.lastIndex = 0;
    while ((m = RESOURCES_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('resource', m[1], m[2]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    TEMPLATE_VALUES_RE.lastIndex = 0;
    while ((m = TEMPLATE_VALUES_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('templateValues', `.Values.${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    TEMPLATE_CHART_RE.lastIndex = 0;
    while ((m = TEMPLATE_CHART_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('templateChart', `.Chart.${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    TEMPLATE_RELEASE_RE.lastIndex = 0;
    while ((m = TEMPLATE_RELEASE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('templateRelease', `.Release.${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    INCLUDE_RE.lastIndex = 0;
    while ((m = INCLUDE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('include', m[1].slice(0, 60), null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    CHART_NAME_RE.lastIndex = 0;
    while ((m = CHART_NAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      if (m[1] === 'name' || m[1] === 'version' || m[1] === 'appVersion' || m[1] === 'type') {
        push('chartMeta', m[1], m[2].trim().slice(0, 40));
      }
    }
  }
  if (entries.length < MAX_PER_FILE) {
    AUTOSCALING_RE.lastIndex = 0;
    while ((m = AUTOSCALING_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('autoscaling', m[0].split(':')[0].trim(), m[1]);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildHelmForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    valuesField: 0, resource: 0, templateValues: 0, templateChart: 0,
    templateRelease: 0, include: 0, chartMeta: 0, autoscaling: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractHelm(txt);
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

function renderHelmBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## HELM CHART CONSTRUCTS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const det = e.detail ? ` = \`${e.detail}\`` : '';
      lines.push(`- [${e.kind}] \`${e.name}\`${det}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractHelm,
  buildHelmForFiles,
  renderHelmBlock,
  _internal: { isHelmLike },
};
