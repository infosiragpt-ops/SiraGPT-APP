'use strict';

/**
 * document-cloud-storage.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects cloud object-storage URIs across providers:
 *
 *   - AWS S3:    s3://bucket-name/key/path
 *                https://s3.amazonaws.com/bucket/key
 *                https://bucket.s3.amazonaws.com/key
 *   - GCP GCS:   gs://bucket/object
 *                https://storage.googleapis.com/bucket/object
 *   - Azure:     az://container/blob (legacy)
 *                abfs://container@account.dfs.core.windows.net/path (ADLS Gen2)
 *                wasb(s)://container@account.blob.core.windows.net/path
 *                https://account.blob.core.windows.net/container/blob
 *   - Hadoop:    hdfs://namenode/path
 *
 * Public API:
 *   extractCloudStorage(text)             → { entries, totals, total }
 *   buildCloudStorageForFiles(files)      → { perFile, aggregate, totals }
 *   renderCloudStorageBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

const S3_RE = /\bs3:\/\/([a-z0-9][a-z0-9.-]{1,62}[a-z0-9])(?:\/([A-Za-z0-9_\-./]{1,200}))?/g;
const S3_HTTPS_HOST_BUCKET_RE = /\bhttps?:\/\/([a-z0-9][a-z0-9.-]{1,62}[a-z0-9])\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com(?:\/([A-Za-z0-9_\-./]{1,200}))?/gi;
const S3_HTTPS_PATH_RE = /\bhttps?:\/\/s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com\/([a-z0-9][a-z0-9.-]{1,62}[a-z0-9])(?:\/([A-Za-z0-9_\-./]{1,200}))?/gi;
const GS_RE = /\bgs:\/\/([a-z0-9][a-z0-9._-]{1,62}[a-z0-9])(?:\/([A-Za-z0-9_\-./]{1,200}))?/g;
const GS_HTTPS_RE = /\bhttps?:\/\/storage\.googleapis\.com\/([a-z0-9][a-z0-9._-]{1,62}[a-z0-9])(?:\/([A-Za-z0-9_\-./]{1,200}))?/gi;
const ABFS_RE = /\babfss?:\/\/([A-Za-z0-9_-]{1,80})@([a-z0-9][a-z0-9-]{1,60})\.dfs\.core\.windows\.net(?:\/([A-Za-z0-9_\-./]{1,200}))?/gi;
const WASB_RE = /\bwasbs?:\/\/([A-Za-z0-9_-]{1,80})@([a-z0-9][a-z0-9-]{1,60})\.blob\.core\.windows\.net(?:\/([A-Za-z0-9_\-./]{1,200}))?/gi;
const AZURE_HTTPS_RE = /\bhttps?:\/\/([a-z0-9][a-z0-9-]{1,60})\.blob\.core\.windows\.net\/([A-Za-z0-9_-]{1,80})(?:\/([A-Za-z0-9_\-./]{1,200}))?/gi;
const HDFS_RE = /\bhdfs:\/\/([a-z0-9][a-z0-9.-]{0,80})(?:\/([A-Za-z0-9_\-./]{1,200}))?/gi;

function extractCloudStorage(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { s3: 0, gcs: 0, azure: 0, hdfs: 0 };

  function push(provider, bucket, key, normalised) {
    if (seen.has(normalised)) return;
    seen.add(normalised);
    entries.push({ provider, bucket, key: key || null, normalised });
    if (totals[provider] != null) totals[provider] += 1;
  }

  // S3
  S3_RE.lastIndex = 0;
  let m;
  while ((m = S3_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('s3', m[1], m[2], `s3://${m[1]}${m[2] ? '/' + m[2] : ''}`);
  }
  if (entries.length < MAX_PER_FILE) {
    S3_HTTPS_HOST_BUCKET_RE.lastIndex = 0;
    while ((m = S3_HTTPS_HOST_BUCKET_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('s3', m[1], m[2], `s3://${m[1]}${m[2] ? '/' + m[2] : ''}`);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    S3_HTTPS_PATH_RE.lastIndex = 0;
    while ((m = S3_HTTPS_PATH_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('s3', m[1], m[2], `s3://${m[1]}${m[2] ? '/' + m[2] : ''}`);
    }
  }

  // GCS
  if (entries.length < MAX_PER_FILE) {
    GS_RE.lastIndex = 0;
    while ((m = GS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('gcs', m[1], m[2], `gs://${m[1]}${m[2] ? '/' + m[2] : ''}`);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    GS_HTTPS_RE.lastIndex = 0;
    while ((m = GS_HTTPS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('gcs', m[1], m[2], `gs://${m[1]}${m[2] ? '/' + m[2] : ''}`);
    }
  }

  // Azure
  if (entries.length < MAX_PER_FILE) {
    ABFS_RE.lastIndex = 0;
    while ((m = ABFS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('azure', `${m[1]}@${m[2]}`, m[3], `abfs://${m[1]}@${m[2]}.dfs.core.windows.net${m[3] ? '/' + m[3] : ''}`);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    WASB_RE.lastIndex = 0;
    while ((m = WASB_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('azure', `${m[1]}@${m[2]}`, m[3], `wasb://${m[1]}@${m[2]}.blob.core.windows.net${m[3] ? '/' + m[3] : ''}`);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    AZURE_HTTPS_RE.lastIndex = 0;
    while ((m = AZURE_HTTPS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('azure', `${m[2]}@${m[1]}`, m[3], `azure://${m[2]}@${m[1]}.blob.core.windows.net${m[3] ? '/' + m[3] : ''}`);
    }
  }

  // HDFS
  if (entries.length < MAX_PER_FILE) {
    HDFS_RE.lastIndex = 0;
    while ((m = HDFS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('hdfs', m[1] || '<default>', m[2], `hdfs://${m[1] || ''}${m[2] ? '/' + m[2] : ''}`);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildCloudStorageForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { s3: 0, gcs: 0, azure: 0, hdfs: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractCloudStorage(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.normalised)) continue;
      aggSeen.add(e.normalised);
      aggregate.push(e);
      if (totals[e.provider] != null) totals[e.provider] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderCloudStorageBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## CLOUD STORAGE PATHS'];
  const t = report.totals || {};
  const parts = [];
  if (t.s3) parts.push(`S3: ${t.s3}`);
  if (t.gcs) parts.push(`GCS: ${t.gcs}`);
  if (t.azure) parts.push(`Azure: ${t.azure}`);
  if (t.hdfs) parts.push(`HDFS: ${t.hdfs}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- \`${e.normalised}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractCloudStorage,
  buildCloudStorageForFiles,
  renderCloudStorageBlock,
};
