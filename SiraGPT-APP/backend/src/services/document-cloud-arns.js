'use strict';

/**
 * document-cloud-arns.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects cloud resource identifiers across major providers:
 *
 *   - AWS ARNs:    arn:aws:<service>:<region>:<account>:<resource>
 *   - AWS Account IDs (12 digits, masked: first-4…last-4)
 *   - GCP project IDs:  projects/<project-id>/...
 *   - GCP resource paths: //<service>.googleapis.com/projects/<id>/<type>/<name>
 *   - Azure resource IDs: /subscriptions/<guid>/resourceGroups/<rg>/...
 *
 * Account IDs / subscription GUIDs are partially masked.
 *
 * Public API:
 *   extractCloudArns(text)             → { entries, totals, total }
 *   buildCloudArnsForFiles(files)      → { perFile, aggregate, totals }
 *   renderCloudArnsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 4500;

const AWS_ARN_RE = /\barn:aws:([a-z0-9-]{2,30}):([a-z0-9-]{0,20}):(\d{12}|\*?):([A-Za-z0-9_\-./:*]{1,200})/g;
const AWS_ACCOUNT_RE = /\b(?:aws[_-]?account[_-]?id|account[_-]?id)\s*[:=]\s*"?(\d{12})\b/gi;
const GCP_PROJECT_RE = /\bprojects\/([a-z][a-z0-9-]{4,28}[a-z0-9])(?:\/|\b)/g;
const GCP_RESOURCE_RE = /\/\/([a-z0-9-]+\.googleapis\.com)\/projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/([a-z]+)\/([A-Za-z0-9_\-./]+)/g;
const AZURE_RESOURCE_RE = /\/subscriptions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/resourceGroups\/([A-Za-z0-9_-]+)(?:\/providers\/([A-Za-z0-9.]+)(?:\/([A-Za-z0-9._-]+))?)?/gi;

function maskAccount(id) {
  if (typeof id !== 'string' || id.length < 8) return '****';
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function maskGuid(g) {
  if (typeof g !== 'string' || g.length < 12) return '****';
  return `${g.slice(0, 4)}…${g.slice(-4)}`;
}

function extractCloudArns(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { aws: 0, awsAccount: 0, gcp: 0, azure: 0 };

  // AWS ARNs
  AWS_ARN_RE.lastIndex = 0;
  let m;
  while ((m = AWS_ARN_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const [, svc, region, account, resource] = m;
    const masked = `arn:aws:${svc}:${region || '-'}:${account === '*' ? '*' : maskAccount(account)}:${resource.slice(0, 60)}`;
    if (seen.has(masked)) continue;
    seen.add(masked);
    entries.push({ kind: 'aws-arn', service: svc, region, masked });
    totals.aws += 1;
  }

  // AWS Account labels
  if (entries.length < MAX_PER_FILE) {
    AWS_ACCOUNT_RE.lastIndex = 0;
    while ((m = AWS_ACCOUNT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const masked = maskAccount(m[1]);
      const key = `aws-account:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'aws-account', masked });
      totals.awsAccount += 1;
    }
  }

  // GCP resource paths (more specific first)
  if (entries.length < MAX_PER_FILE) {
    GCP_RESOURCE_RE.lastIndex = 0;
    while ((m = GCP_RESOURCE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const masked = `//${m[1]}/projects/${m[2]}/${m[3]}/${m[4].slice(0, 40)}`;
      if (seen.has(masked)) continue;
      seen.add(masked);
      entries.push({ kind: 'gcp-resource', service: m[1], project: m[2], masked });
      totals.gcp += 1;
    }
  }

  // GCP project-only references
  if (entries.length < MAX_PER_FILE) {
    GCP_PROJECT_RE.lastIndex = 0;
    while ((m = GCP_PROJECT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const proj = m[1];
      const key = `gcp-project:${proj}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'gcp-project', project: proj, masked: `projects/${proj}` });
      totals.gcp += 1;
    }
  }

  // Azure resource IDs
  if (entries.length < MAX_PER_FILE) {
    AZURE_RESOURCE_RE.lastIndex = 0;
    while ((m = AZURE_RESOURCE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const masked = `/subscriptions/${maskGuid(m[1])}/resourceGroups/${m[2]}${m[3] ? `/providers/${m[3]}` : ''}${m[4] ? `/${m[4].slice(0, 40)}` : ''}`;
      if (seen.has(masked)) continue;
      seen.add(masked);
      entries.push({ kind: 'azure-resource', resourceGroup: m[2], provider: m[3], masked });
      totals.azure += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildCloudArnsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { aws: 0, awsAccount: 0, gcp: 0, azure: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractCloudArns(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.masked)) continue;
      aggSeen.add(e.masked);
      aggregate.push(e);
      const bucket = e.kind === 'aws-arn' ? 'aws' :
                     e.kind === 'aws-account' ? 'awsAccount' :
                     e.kind.startsWith('gcp') ? 'gcp' : 'azure';
      totals[bucket] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderCloudArnsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## CLOUD RESOURCE IDs', '- Account / subscription IDs masked first-4…last-4'];
  const t = report.totals || {};
  const parts = [];
  if (t.aws) parts.push(`AWS ARNs: ${t.aws}`);
  if (t.awsAccount) parts.push(`AWS accounts: ${t.awsAccount}`);
  if (t.gcp) parts.push(`GCP: ${t.gcp}`);
  if (t.azure) parts.push(`Azure: ${t.azure}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- ${e.kind}: \`${e.masked}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractCloudArns,
  buildCloudArnsForFiles,
  renderCloudArnsBlock,
  _internal: { maskAccount, maskGuid },
};
