'use strict';

/**
 * document-pubmed-ids.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects NIH / NCBI biomedical identifiers:
 *
 *   - PMID:   PubMed ID (1-8 digits, labeled or in pubmed.ncbi URL)
 *   - PMC:    PubMed Central ID (PMC + 1-8 digits)
 *   - NCBI accessions: NM_, NC_, NP_, XM_, XP_, NR_ prefixes
 *   - ClinicalTrials.gov: NCT + 8 digits
 *   - dbSNP rs IDs: rs followed by 1-12 digits
 *
 * Public API:
 *   extractPubmedIds(text)             → { entries, totals, total }
 *   buildPubmedIdsForFiles(files)      → { perFile, aggregate, totals }
 *   renderPubmedIdsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const PMID_LABELED_RE = /\bPMID\s*[:=]?\s*(\d{1,8})\b/gi;
const PMID_URL_RE = /\bhttps?:\/\/(?:www\.)?(?:ncbi\.nlm\.nih\.gov\/pubmed\/|pubmed\.ncbi\.nlm\.nih\.gov\/)(\d{1,8})/g;
const PMC_RE = /\bPMC\s*(\d{1,8})\b/g;
const NCBI_ACCESSION_RE = /\b(N[MCPR]|XM|XP|XR|YP|AP)_\d{1,9}(?:\.\d{1,3})?\b/g;
const NCT_RE = /\b(NCT\d{8})\b/g;
const RS_RE = /\b(rs\d{1,12})\b/g;

function extractPubmedIds(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { pmid: 0, pmc: 0, ncbi: 0, nct: 0, rs: 0 };

  function push(kind, id, source) {
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, id, source });
    if (totals[kind] != null) totals[kind] += 1;
  }

  PMID_URL_RE.lastIndex = 0;
  let m;
  while ((m = PMID_URL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('pmid', m[1], 'url');
  }
  if (entries.length < MAX_PER_FILE) {
    PMID_LABELED_RE.lastIndex = 0;
    while ((m = PMID_LABELED_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('pmid', m[1], 'labeled');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    PMC_RE.lastIndex = 0;
    while ((m = PMC_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('pmc', `PMC${m[1]}`, 'bare');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    NCBI_ACCESSION_RE.lastIndex = 0;
    while ((m = NCBI_ACCESSION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('ncbi', m[0], 'accession');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    NCT_RE.lastIndex = 0;
    while ((m = NCT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('nct', m[1], 'trial');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    RS_RE.lastIndex = 0;
    while ((m = RS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const id = m[1];
      // require min 5 digits to avoid e.g. "rs1" false positives
      if (id.length < 5) continue;
      push('rs', id, 'dbSNP');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildPubmedIdsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { pmid: 0, pmc: 0, ncbi: 0, nct: 0, rs: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractPubmedIds(txt);
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

function renderPubmedIdsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## NIH / NCBI IDENTIFIERS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- ${e.kind} (${e.source}): \`${e.id}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractPubmedIds,
  buildPubmedIdsForFiles,
  renderPubmedIdsBlock,
};
