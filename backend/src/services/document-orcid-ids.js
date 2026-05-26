'use strict';

/**
 * document-orcid-ids.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects ORCID author identifiers and similar research-ID patterns:
 *
 *   - ORCID:       0000-0000-0000-000X  (16 digits in 4-4-4-4 form, X = 0-9|X)
 *   - URL form:    https://orcid.org/0000-0000-0000-000X
 *   - ResearcherID: A-1234-2025 (Web of Science author ID)
 *   - Scopus:      "Scopus Author ID: 12345678900"
 *   - Google Scholar: scholar.google.com user/CITATIONS_<id>
 *
 * Public API:
 *   extractOrcidIds(text)             → { entries, totals, total }
 *   buildOrcidIdsForFiles(files)      → { perFile, aggregate, totals }
 *   renderOrcidIdsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4500;

const ORCID_RE = /\b(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\b/g;
const ORCID_LABELED_RE = /\bORCID\s*(?:ID)?\s*[:=]?\s*(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\b/gi;
const ORCID_URL_RE = /\bhttps?:\/\/orcid\.org\/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/g;
const RESEARCHER_ID_RE = /\b(?:ResearcherID|Researcher\s+ID)\s*[:=]?\s*([A-Z]-\d{4}-\d{4})/gi;
const SCOPUS_ID_RE = /\bScopus\s+(?:Author\s+)?(?:ID)?\s*[:=]?\s*(\d{10,12})/gi;
const SCHOLAR_RE = /\bhttps?:\/\/scholar\.google\.com\/citations\?user=([A-Za-z0-9_-]{10,30})/g;

function checksumOrcid(id) {
  const digits = id.replace(/-/g, '');
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    sum = (sum + parseInt(digits[i], 10)) * 2;
  }
  const expected = (12 - (sum % 11)) % 11;
  const last = digits[15] === 'X' ? 10 : parseInt(digits[15], 10);
  return expected === last;
}

function extractOrcidIds(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { orcid: 0, researcherId: 0, scopus: 0, scholar: 0 };

  function push(kind, id, source) {
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, id, source });
    if (totals[kind] != null) totals[kind] += 1;
  }

  // ORCID URL first
  ORCID_URL_RE.lastIndex = 0;
  let m;
  while ((m = ORCID_URL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('orcid', m[1], 'url');
  }
  if (entries.length < MAX_PER_FILE) {
    ORCID_LABELED_RE.lastIndex = 0;
    while ((m = ORCID_LABELED_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('orcid', m[1], 'labeled');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    ORCID_RE.lastIndex = 0;
    while ((m = ORCID_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('orcid', m[1], 'bare');
    }
  }

  // ResearcherID
  if (entries.length < MAX_PER_FILE) {
    RESEARCHER_ID_RE.lastIndex = 0;
    while ((m = RESEARCHER_ID_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('researcherId', m[1], 'labeled');
    }
  }

  // Scopus
  if (entries.length < MAX_PER_FILE) {
    SCOPUS_ID_RE.lastIndex = 0;
    while ((m = SCOPUS_ID_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('scopus', m[1], 'labeled');
    }
  }

  // Google Scholar
  if (entries.length < MAX_PER_FILE) {
    SCHOLAR_RE.lastIndex = 0;
    while ((m = SCHOLAR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('scholar', m[1], 'url');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildOrcidIdsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { orcid: 0, researcherId: 0, scopus: 0, scholar: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractOrcidIds(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.id}`;
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

function renderOrcidIdsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## RESEARCH AUTHOR IDs'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- ${e.kind} (${e.source}): \`${e.id}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractOrcidIds,
  buildOrcidIdsForFiles,
  renderOrcidIdsBlock,
  _internal: { checksumOrcid },
};
