'use strict';

/**
 * document-k8s-refs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Kubernetes manifest field references in YAML configs / docs:
 *
 *   - apiVersion: apps/v1 / v1 / networking.k8s.io/v1
 *   - kind: Deployment / Service / Ingress / ConfigMap / Secret / etc.
 *   - namespace: production
 *   - replicas: 3
 *   - kubectl commands: kubectl apply / kubectl get / kubectl delete
 *
 * Routes "what K8s resources?" / "what kind?" to a citeable list.
 *
 * Public API:
 *   extractK8sRefs(text)         → K8sReport
 *   buildK8sRefsForFiles(files)  → { perFile, aggregate, totals }
 *   renderK8sRefsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 26;
const MAX_BLOCK_CHARS = 5000;

const KNOWN_KINDS = new Set([
  'Pod', 'Service', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob',
  'ConfigMap', 'Secret', 'PersistentVolume', 'PersistentVolumeClaim',
  'Ingress', 'NetworkPolicy', 'Endpoints', 'EndpointSlice',
  'ServiceAccount', 'Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding',
  'Namespace', 'Node', 'Event', 'LimitRange', 'ResourceQuota',
  'HorizontalPodAutoscaler', 'VerticalPodAutoscaler', 'PodDisruptionBudget',
  'StorageClass', 'VolumeAttachment', 'CSIDriver', 'CSINode',
  'CustomResourceDefinition', 'APIService',
  'PodSecurityPolicy', 'PodTemplate', 'ReplicaSet', 'ReplicationController',
  'MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration',
  'IngressClass', 'GatewayClass', 'Gateway', 'HTTPRoute', 'TCPRoute',
  'ServiceMonitor', 'PrometheusRule', 'AlertmanagerConfig',
  'Certificate', 'ClusterIssuer', 'Issuer',
  'Application', 'AppProject', 'ArgoRollout',
  'HelmRelease', 'HelmRepository',
]);

const PATTERNS = [
  { kind: 'apiVersion', re: /^[\t ]*apiVersion\s*:\s*([\w.\-]+\/?[\w.\-]*)/gim },
  { kind: 'kind', re: /^[\t ]*kind\s*:\s*([A-Z][A-Za-z]+)/gm },
  { kind: 'namespace', re: /^[\t ]*namespace\s*:\s*([a-z0-9][a-z0-9-]{1,62})/gm },
  { kind: 'kubectl', re: /\bkubectl\s+(apply|get|delete|describe|create|patch|edit|logs|exec|rollout|scale|expose|port-forward|cp|drain|taint|cordon|uncordon|top|wait|debug|attach|set|label|annotate|run|version|config|auth)\b/g },
];

const KINDS = PATTERNS.map((p) => p.kind);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractK8sRefs(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of head.matchAll(re)) {
      if (entries.length >= MAX_PER_FILE) break;
      const value = m[1];
      if (kind === 'kind' && !KNOWN_KINDS.has(value)) continue;
      const key = `${kind}|${value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind, value });
      totals[kind] += 1;
    }
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildK8sRefsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractK8sRefs(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of KINDS) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [${e.kind}] \`${e.value}\`${file}`;
}

function renderK8sRefsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## KUBERNETES MANIFEST REFS
Kubernetes manifest fields detected: apiVersion (e.g. apps/v1, networking.k8s.io/v1), kind (whitelist of ~50 K8s + CRD resource kinds), namespace, and kubectl commands (apply / get / delete / describe / patch / logs / exec / rollout / scale / port-forward / drain / taint / debug). Routes "what K8s resources?" / "what kind?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate K8s refs across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...K8s refs block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractK8sRefs,
  buildK8sRefsForFiles,
  renderK8sRefsBlock,
  _internal: {
    PATTERNS,
    KINDS,
    KNOWN_KINDS,
  },
};
