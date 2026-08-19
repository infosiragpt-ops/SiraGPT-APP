'use strict';

/**
 * document-k8s-resources.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Kubernetes resource manifest structure:
 *
 *   - apiVersion / kind:  Deployment / Service / Ingress / ConfigMap / Secret /
 *                         StatefulSet / DaemonSet / Job / CronJob / Pod /
 *                         PersistentVolumeClaim / Namespace / ServiceAccount /
 *                         Role / RoleBinding / NetworkPolicy / HorizontalPodAutoscaler
 *   - metadata.name / metadata.namespace / metadata.labels
 *   - spec.replicas / spec.containers[].image
 *   - spec.type (ClusterIP / NodePort / LoadBalancer)
 *   - spec.rules.host / spec.tls.hosts (Ingress)
 *   - resources.limits.cpu / memory and requests.cpu / memory
 *
 * Public API:
 *   extractK8sResources(text)             → { entries, totals, total }
 *   buildK8sResourcesForFiles(files)      → { perFile, aggregate, totals }
 *   renderK8sResourcesBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;

const APIVERSION_RE = /^apiVersion\s*:\s*["']?([a-z][a-z0-9.\/-]{1,60})["']?/gm;
const KIND_RE = /^kind\s*:\s*["']?([A-Z][a-zA-Z]{2,60})["']?/gm;
const NAME_RE = /^[ \t]+name\s*:\s*["']?([a-z][a-z0-9-]{0,60})["']?\s*$/gm;
const NAMESPACE_RE = /^[ \t]+namespace\s*:\s*["']?([a-z][a-z0-9-]{0,60})["']?/gm;
const REPLICAS_RE = /^[ \t]+replicas\s*:\s*(\d+)/gm;
const IMAGE_RE = /^[ \t]+image\s*:\s*["']?([a-zA-Z0-9.\/_-]+(?::[a-zA-Z0-9._-]+)?(?:@sha256:[a-f0-9]+)?)["']?/gm;
const SERVICE_TYPE_RE = /^[ \t]+type\s*:\s*["']?(ClusterIP|NodePort|LoadBalancer|ExternalName)["']?/gm;
const PORT_RE = /^[ \t]+(?:-\s+)?(?:port|targetPort|containerPort|nodePort)\s*:\s*(\d+)/gm;
const RESOURCE_LIMITS_RE = /^[ \t]+(cpu|memory|ephemeral-storage)\s*:\s*["']?([0-9]+(?:\.[0-9]+)?(?:m|Mi|Gi|Ki|Ti|Pi|Ei|G|M|K)?)["']?/gm;
const HOST_RE = /^[ \t]+(?:-\s+)?(?:host|hostname)\s*:\s*["']?([a-z][a-zA-Z0-9.-]{0,80})["']?/gm;
const KIND_VALUES = new Set([
  'Deployment', 'Service', 'Ingress', 'ConfigMap', 'Secret', 'Pod',
  'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'ReplicaSet',
  'PersistentVolumeClaim', 'PersistentVolume', 'StorageClass',
  'Namespace', 'ServiceAccount', 'Role', 'RoleBinding',
  'ClusterRole', 'ClusterRoleBinding', 'NetworkPolicy', 'PodSecurityPolicy',
  'HorizontalPodAutoscaler', 'VerticalPodAutoscaler', 'PodDisruptionBudget',
  'CustomResourceDefinition', 'MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration',
  'Endpoints', 'EndpointSlice', 'Event', 'LimitRange', 'ResourceQuota',
]);

function isK8sLike(body) {
  if (!/^apiVersion\s*:/m.test(body)) return false;
  if (!/^kind\s*:\s*[A-Z]/m.test(body)) return false;
  return true;
}

function extractK8sResources(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isK8sLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    apiVersion: 0, kind: 0, name: 0, namespace: 0, replicas: 0,
    image: 0, serviceType: 0, port: 0, resource: 0, host: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  APIVERSION_RE.lastIndex = 0;
  let m;
  while ((m = APIVERSION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('apiVersion', m[1], null);
  }
  if (entries.length < MAX_PER_FILE) {
    KIND_RE.lastIndex = 0;
    while ((m = KIND_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      if (!KIND_VALUES.has(m[1])) continue;
      push('kind', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    NAME_RE.lastIndex = 0;
    while ((m = NAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('name', m[1].slice(0, 50), null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    NAMESPACE_RE.lastIndex = 0;
    while ((m = NAMESPACE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('namespace', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    REPLICAS_RE.lastIndex = 0;
    while ((m = REPLICAS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('replicas', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    IMAGE_RE.lastIndex = 0;
    while ((m = IMAGE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('image', m[1].slice(0, 80), null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SERVICE_TYPE_RE.lastIndex = 0;
    while ((m = SERVICE_TYPE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('serviceType', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    PORT_RE.lastIndex = 0;
    while ((m = PORT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('port', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    RESOURCE_LIMITS_RE.lastIndex = 0;
    while ((m = RESOURCE_LIMITS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('resource', m[1], m[2]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    HOST_RE.lastIndex = 0;
    while ((m = HOST_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('host', m[1], null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildK8sResourcesForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    apiVersion: 0, kind: 0, name: 0, namespace: 0, replicas: 0,
    image: 0, serviceType: 0, port: 0, resource: 0, host: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractK8sResources(txt);
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

function renderK8sResourcesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## KUBERNETES RESOURCES'];
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
  extractK8sResources,
  buildK8sResourcesForFiles,
  renderK8sResourcesBlock,
  _internal: { isK8sLike, KIND_VALUES },
};
