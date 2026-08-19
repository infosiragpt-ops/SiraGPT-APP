'use strict';

/**
 * document-container-refs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects container/image references in Dockerfile / k8s / CI docs:
 *
 *   - Plain image: nginx:1.25, postgres:16-alpine, node:20
 *   - Registry-qualified: gcr.io/project/image:tag, quay.io/...,
 *     ghcr.io/org/image:tag, registry.example.com/foo:bar
 *   - Digest-pinned: image@sha256:abc...
 *   - Library scope: library/nginx:1.25
 *
 * Routes "what container?" / "what image?" to a citeable list.
 *
 * Public API:
 *   extractContainerRefs(text)         → ContainerReport
 *   buildContainerRefsForFiles(files)  → { perFile, aggregate, totals }
 *   renderContainerRefsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;
const MAX_VALUE_LEN = 160;

const PATTERNS = [
  // Registry-qualified with tag or digest
  { kind: 'registry', re: /\b([a-z0-9.-]+\.(?:io|com|net|dev|cloud|amazonaws\.com|gcr\.io|azurecr\.io)\/[a-z0-9._\-\/]+(?::[a-zA-Z0-9._\-]+|@sha256:[a-f0-9]{12,64}))/g },
  // Digest-pinned bare
  { kind: 'digest', re: /\b([a-z][a-z0-9._\-\/]{2,80}@sha256:[a-f0-9]{12,64})\b/g },
  // Plain image:tag (common base images only — small whitelist to reduce false positives)
  { kind: 'plain', re: /\b(nginx|postgres|mysql|mariadb|redis|mongo|memcached|alpine|ubuntu|debian|fedora|centos|busybox|node|python|golang|rust|openjdk|nginx-unprivileged|httpd|caddy|traefik|envoy|haproxy|kafka|zookeeper|rabbitmq|elasticsearch|kibana|prometheus|grafana|jaeger|cassandra|clickhouse|minio|vault|consul|nomad|etcd):([a-zA-Z0-9._\-]+)\b/g },
];

const KINDS = PATTERNS.map((p) => p.kind);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipValue(s) {
  const t = String(s || '').trim();
  if (t.length <= MAX_VALUE_LEN) return t;
  return `${t.slice(0, MAX_VALUE_LEN - 1)}…`;
}

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractContainerRefs(input) {
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
      const ref = clipValue(m[0]);
      const key = `${kind}|${ref.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind, ref });
      totals[kind] += 1;
    }
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildContainerRefsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractContainerRefs(safeText(f.extractedText));
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
  return `- [${e.kind}] \`${e.ref}\`${file}`;
}

function renderContainerRefsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## CONTAINER / IMAGE REFS
Container image references detected: registry-qualified (gcr.io / ghcr.io / quay.io / registry.example.com / *.amazonaws.com), digest-pinned (image@sha256:...), and plain image:tag from a curated whitelist of ~40 common base images (nginx / postgres / redis / alpine / node / golang / kafka / prometheus / grafana / …). Routes "what container?" / "what image?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate container refs across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...container refs block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractContainerRefs,
  buildContainerRefsForFiles,
  renderContainerRefsBlock,
  _internal: {
    PATTERNS,
    KINDS,
  },
};
