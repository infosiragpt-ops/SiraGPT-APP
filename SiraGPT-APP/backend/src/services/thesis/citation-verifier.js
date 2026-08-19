'use strict';

/**
 * citation-verifier — anti-hallucination for thesis generation.
 *
 * Spec §7.22 rule 1: "No inventar autores, artículos, DOI, tesis,
 * estadísticas ni fuentes." When the LLM writes a chapter, it might
 * cite DOIs or author/year pairs that don't exist in the verified
 * references list. This module:
 *
 *   1. Extracts citations from generated text (DOIs + APA-style
 *      (Author, Year) markers).
 *   2. Checks each citation against the canonical references list
 *      that came out of scientific-search (filterVerifiedPapers).
 *   3. Optionally verifies DOIs online via CrossRef when references
 *      came from outside the scientific-search pipeline.
 *   4. Replaces unverified citations with a "[no verificado]" marker
 *      instead of allowing fabricated sources through.
 *
 * Default behavior is strict (mark inventions). Disable with env
 * `THESIS_STRICT_CITATIONS=false` if a workflow needs the raw LLM
 * output — e.g. for debugging the citation prompt.
 */

const DOI_RE = /\b10\.\d{4,9}\/[^\s)\]"',;]+/gi;

const APA_CITATION_RE = /\(([A-ZÁÉÍÓÚÑÜ][\p{L}'’-]+(?:\s+et\s+al\.?|(?:\s+(?:y|and|&)\s+[A-ZÁÉÍÓÚÑÜ][\p{L}'’-]+))?)\s*,\s*(\d{4})\)/gu;

const CROSSREF_LOOKUP_BASE = 'https://api.crossref.org/works/';

function normaliseDoi(value) {
  if (!value) return null;
  return String(value)
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/[.,;]+$/, '')
    .trim() || null;
}

function normaliseAuthor(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '')
    .trim();
}

function extractDois(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(DOI_RE) || [];
  const set = new Set();
  for (const raw of matches) {
    const doi = normaliseDoi(raw);
    if (doi) set.add(doi);
  }
  return [...set];
}

function extractApaCitations(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const seen = new Set();
  APA_CITATION_RE.lastIndex = 0;
  let m;
  while ((m = APA_CITATION_RE.exec(text)) !== null) {
    const author = m[1].trim();
    const year = parseInt(m[2], 10);
    const key = `${normaliseAuthor(author)}::${year}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ author, year, raw: m[0] });
  }
  return out;
}

function buildReferenceIndex(references = []) {
  const byDoi = new Map();
  const byAuthorYear = new Map();
  for (const ref of references) {
    const paper = ref?.paper || ref;
    const doi = normaliseDoi(paper?.doi);
    if (doi) byDoi.set(doi, paper);
    const year = Number(paper?.year) || 0;
    const authors = Array.isArray(paper?.authors) ? paper.authors : [];
    for (const author of authors) {
      const family = typeof author === 'string'
        ? author.split(/\s+/).pop()
        : (author?.family || author?.last || author?.name?.split(/\s+/).pop());
      const key = normaliseAuthor(family);
      if (key && year) {
        const k = `${key}::${year}`;
        if (!byAuthorYear.has(k)) byAuthorYear.set(k, paper);
      }
    }
  }
  return { byDoi, byAuthorYear };
}

function verifyCitations(text, references = []) {
  const index = buildReferenceIndex(references);
  const dois = extractDois(text);
  const apa = extractApaCitations(text);

  const verifiedDois = [];
  const unverifiedDois = [];
  for (const doi of dois) {
    if (index.byDoi.has(doi)) verifiedDois.push(doi);
    else unverifiedDois.push(doi);
  }

  const verifiedApa = [];
  const unverifiedApa = [];
  for (const cite of apa) {
    const lastWord = cite.author.split(/\s+/).pop();
    const family = normaliseAuthor(lastWord);
    const k = `${family}::${cite.year}`;
    if (index.byAuthorYear.has(k)) verifiedApa.push(cite);
    else unverifiedApa.push(cite);
  }

  return {
    dois: { verified: verifiedDois, unverified: unverifiedDois },
    apa: { verified: verifiedApa, unverified: unverifiedApa },
    totalUnverified: unverifiedDois.length + unverifiedApa.length,
    totalVerified: verifiedDois.length + verifiedApa.length,
  };
}

function markUnverified(text, references = [], opts = {}) {
  if (!text || typeof text !== 'string') return { text: text || '', report: verifyCitations(text, references) };
  const marker = opts.marker || '[no verificado]';
  const report = verifyCitations(text, references);

  let out = text;
  for (const doi of report.dois.unverified) {
    const re = new RegExp(`\\b${doi.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    out = out.replace(re, `${doi} ${marker}`);
  }
  for (const cite of report.apa.unverified) {
    const escaped = cite.raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'g');
    out = out.replace(re, `${cite.raw} ${marker}`);
  }

  return { text: out, report };
}

async function verifyDoiOnline(doi, opts = {}) {
  const normalised = normaliseDoi(doi);
  if (!normalised) return { ok: false, doi, error: 'invalid_doi' };
  const fetcher = opts.fetcher || (typeof fetch === 'function' ? fetch : null);
  if (!fetcher) return { ok: false, doi: normalised, error: 'no_fetch_available' };
  const timeoutMs = opts.timeoutMs || 8_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetcher(`${CROSSREF_LOOKUP_BASE}${encodeURIComponent(normalised)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, doi: normalised, error: `http_${res.status}` };
    const body = await res.json();
    const msg = body && body.message;
    if (!msg || !msg.DOI) return { ok: false, doi: normalised, error: 'no_message' };
    return {
      ok: true,
      doi: normalised,
      paper: {
        doi: msg.DOI,
        title: Array.isArray(msg.title) ? msg.title[0] : msg.title,
        year: msg.issued?.['date-parts']?.[0]?.[0],
        venue: msg['container-title']?.[0],
        authors: (msg.author || []).map((a) => ({ family: a.family, given: a.given })),
      },
    };
  } catch (err) {
    return { ok: false, doi: normalised, error: err?.name === 'AbortError' ? 'timeout' : (err?.message || 'fetch_failed') };
  } finally {
    clearTimeout(timer);
  }
}

function strictModeEnabled() {
  const v = process.env.THESIS_STRICT_CITATIONS;
  if (v === undefined || v === null || v === '') return true;
  return !/^(0|false|off|no)$/i.test(String(v).trim());
}

function onlineFallbackEnabled() {
  const v = process.env.THESIS_VERIFY_ONLINE_FALLBACK;
  if (v === undefined || v === null || v === '') return false;
  return /^(1|true|on|yes)$/i.test(String(v).trim());
}

function hallucinationThreshold() {
  const v = Number(process.env.THESIS_HALLUCINATION_THRESHOLD);
  if (!Number.isFinite(v) || v <= 0 || v > 1) return 0.3;
  return v;
}

/**
 * Verify a batch of DOIs against CrossRef with bounded concurrency.
 * Returns a Map<normalisedDoi, { ok, paper?, error? }>. Network failures
 * are silently captured per-DOI (the caller treats absence as "still
 * unverified") so a CrossRef outage never blocks thesis generation.
 *
 * @param {string[]} dois
 * @param {object} [opts]
 * @param {number} [opts.concurrency=5]
 * @param {number} [opts.timeoutMs] — passed to verifyDoiOnline
 * @param {Function} [opts.fetcher]
 */
async function verifyDoisBatch(dois, opts = {}) {
  const out = new Map();
  if (!Array.isArray(dois) || dois.length === 0) return out;

  const concurrency = Math.max(1, Math.min(opts.concurrency || 5, 16));
  const queue = [...new Set(dois.map(normaliseDoi).filter(Boolean))];

  async function worker() {
    while (queue.length > 0) {
      const doi = queue.shift();
      if (!doi || out.has(doi)) continue;
      const result = await verifyDoiOnline(doi, opts);
      out.set(doi, result);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

module.exports = {
  DOI_RE,
  APA_CITATION_RE,
  normaliseDoi,
  extractDois,
  extractApaCitations,
  buildReferenceIndex,
  verifyCitations,
  markUnverified,
  verifyDoiOnline,
  verifyDoisBatch,
  strictModeEnabled,
  onlineFallbackEnabled,
  hallucinationThreshold,
};
