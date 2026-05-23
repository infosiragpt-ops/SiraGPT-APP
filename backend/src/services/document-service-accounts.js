'use strict';

/**
 * document-service-accounts.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects cloud service-account email-like identifiers (these look like
 * regular emails but are machine identities). Local parts are MASKED.
 *
 * Targets:
 *   - GCP service account: name@PROJECT_ID.iam.gserviceaccount.com
 *   - AWS IAM role ARNs:   already covered in document-cloud-arns.js (avoid dup)
 *   - GitHub Apps:         <slug>[bot] commit committer emails ending @users.noreply.github.com
 *   - Azure AD service principals:  <app-id>@<tenant>.onmicrosoft.com
 *
 * Public API:
 *   extractServiceAccounts(text)             → { entries, totals, total }
 *   buildServiceAccountsForFiles(files)      → { perFile, aggregate, totals }
 *   renderServiceAccountsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4500;

const GCP_SA_RE = /\b([a-z0-9][a-z0-9-]{1,29})@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com\b/g;
const GITHUB_BOT_RE = /\b(\d+\+)?([a-zA-Z0-9-]+\[bot\])@users\.noreply\.github\.com\b/g;
const AZURE_AD_SP_RE = /\b([0-9a-f-]{16,36})@([a-zA-Z0-9-]{2,40})\.onmicrosoft\.com\b/g;

function maskLocal(s) {
  if (typeof s !== 'string' || s.length < 2) return '*';
  if (s.length === 2) return `${s[0]}*`;
  if (s.length === 3) return `${s[0]}*${s[2]}`;
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

function extractServiceAccounts(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { gcp: 0, github: 0, azure: 0 };

  function push(provider, masked, project) {
    const key = `${provider}:${masked}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ provider, masked, project });
    if (totals[provider] != null) totals[provider] += 1;
  }

  GCP_SA_RE.lastIndex = 0;
  let m;
  while ((m = GCP_SA_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const masked = `${maskLocal(m[1])}@${m[2]}.iam.gserviceaccount.com`;
    push('gcp', masked, m[2]);
  }

  if (entries.length < MAX_PER_FILE) {
    GITHUB_BOT_RE.lastIndex = 0;
    while ((m = GITHUB_BOT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const masked = `${m[1] || ''}${m[2]}@users.noreply.github.com`;
      push('github', masked, null);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    AZURE_AD_SP_RE.lastIndex = 0;
    while ((m = AZURE_AD_SP_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const masked = `${maskLocal(m[1])}@${m[2]}.onmicrosoft.com`;
      push('azure', masked, m[2]);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildServiceAccountsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { gcp: 0, github: 0, azure: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractServiceAccounts(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.provider}:${e.masked}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.provider] != null) totals[e.provider] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderServiceAccountsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## CLOUD SERVICE ACCOUNTS', '- Local parts masked first-2…last-2'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- ${e.provider}: \`${e.masked}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractServiceAccounts,
  buildServiceAccountsForFiles,
  renderServiceAccountsBlock,
  _internal: { maskLocal },
};
