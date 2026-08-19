'use strict';

/**
 * document-container-registries.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects fully-qualified container image references with registry host:
 *
 *   - GCR:    gcr.io/project/image:tag
 *   - GAR:    us-central1-docker.pkg.dev/proj/repo/image:tag
 *   - ECR:    123456789012.dkr.ecr.us-east-1.amazonaws.com/image:tag
 *   - GHCR:   ghcr.io/owner/image:tag
 *   - Docker Hub:  docker.io/library/image:tag, library/image
 *   - Quay:   quay.io/org/image:tag
 *   - ACR:    myregistry.azurecr.io/image:tag
 *
 * Distinct from document-container-refs.js which detects bare image refs.
 *
 * Public API:
 *   extractContainerRegistries(text)             → { entries, totals, total }
 *   buildContainerRegistriesForFiles(files)      → { perFile, aggregate, totals }
 *   renderContainerRegistriesBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

const GCR_RE = /\b(gcr\.io|asia\.gcr\.io|eu\.gcr\.io|us\.gcr\.io)\/([a-z0-9-]{4,40})\/([a-z0-9][a-z0-9._/-]{2,80})(?:[:@]([a-z0-9._-]{1,60}))?/g;
const GAR_RE = /\b([a-z0-9-]{2,30}-docker\.pkg\.dev)\/([a-z0-9-]{4,40})\/([a-z0-9-]{2,40})\/([a-z0-9][a-z0-9._/-]{1,80})(?:[:@]([a-z0-9._-]{1,60}))?/g;
const ECR_RE = /\b(\d{12}\.dkr\.ecr\.[a-z0-9-]{4,30}\.amazonaws\.com)\/([a-z0-9][a-z0-9._/-]{2,80})(?:[:@]([a-z0-9._-]{1,60}))?/g;
const GHCR_RE = /\b(ghcr\.io)\/([a-z0-9-]{2,40})\/([a-z0-9][a-z0-9._/-]{1,80})(?:[:@]([a-z0-9._-]{1,60}))?/g;
const DOCKER_HUB_RE = /\b(docker\.io)\/([a-z0-9-]{2,40})\/([a-z0-9][a-z0-9._/-]{1,80})(?:[:@]([a-z0-9._-]{1,60}))?/g;
const QUAY_RE = /\b(quay\.io)\/([a-z0-9-]{2,40})\/([a-z0-9][a-z0-9._/-]{1,80})(?:[:@]([a-z0-9._-]{1,60}))?/g;
const ACR_RE = /\b([a-z0-9]{4,40}\.azurecr\.io)\/([a-z0-9][a-z0-9._/-]{2,80})(?:[:@]([a-z0-9._-]{1,60}))?/g;

function isDigest(tag) {
  return typeof tag === 'string' && /^sha256:[a-f0-9]{64}$/.test(tag);
}

function maskDigest(tag) {
  if (!isDigest(tag)) return tag;
  return `sha256:${tag.slice(7, 13)}…${tag.slice(-4)}`;
}

function extractContainerRegistries(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { gcr: 0, gar: 0, ecr: 0, ghcr: 0, dockerHub: 0, quay: 0, acr: 0 };

  function push(provider, host, path, tag) {
    const safeTag = tag ? maskDigest(tag) : null;
    const ref = `${host}/${path}${safeTag ? (isDigest(tag) ? '@' : ':') + safeTag : ''}`;
    if (seen.has(ref)) return;
    seen.add(ref);
    entries.push({ provider, host, path, tag: safeTag, ref });
    if (totals[provider] != null) totals[provider] += 1;
  }

  GAR_RE.lastIndex = 0;
  let m;
  while ((m = GAR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('gar', m[1], `${m[2]}/${m[3]}/${m[4]}`, m[5]);
  }
  if (entries.length < MAX_PER_FILE) {
    GCR_RE.lastIndex = 0;
    while ((m = GCR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('gcr', m[1], `${m[2]}/${m[3]}`, m[4]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    ECR_RE.lastIndex = 0;
    while ((m = ECR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('ecr', m[1], m[2], m[3]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    GHCR_RE.lastIndex = 0;
    while ((m = GHCR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('ghcr', m[1], `${m[2]}/${m[3]}`, m[4]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    DOCKER_HUB_RE.lastIndex = 0;
    while ((m = DOCKER_HUB_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('dockerHub', m[1], `${m[2]}/${m[3]}`, m[4]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    QUAY_RE.lastIndex = 0;
    while ((m = QUAY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('quay', m[1], `${m[2]}/${m[3]}`, m[4]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    ACR_RE.lastIndex = 0;
    while ((m = ACR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('acr', m[1], m[2], m[3]);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildContainerRegistriesForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { gcr: 0, gar: 0, ecr: 0, ghcr: 0, dockerHub: 0, quay: 0, acr: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractContainerRegistries(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.ref)) continue;
      aggSeen.add(e.ref);
      aggregate.push(e);
      if (totals[e.provider] != null) totals[e.provider] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderContainerRegistriesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## CONTAINER REGISTRIES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- ${e.provider}: \`${e.ref}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractContainerRegistries,
  buildContainerRegistriesForFiles,
  renderContainerRegistriesBlock,
  _internal: { isDigest, maskDigest },
};
