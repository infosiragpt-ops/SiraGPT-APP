'use strict';

/**
 * source-confidence — classify the trustworthiness of a web-search source.
 *
 * Spec §7.18 / §3.7-3.9 require the system to differentiate verified
 * information from inferred. We attach a confidence label to every
 * source surfaced from external web search so the LLM (and any UI
 * that surfaces sources directly) can warn the user when an answer
 * leans on an unvetted page.
 *
 * Conservative whitelist: a domain only gets `verified` if it belongs
 * to a recognised authoritative class (government, peer-reviewed
 * academia, established standards body, official public-health). The
 * rest stays `unverified` — not "wrong", just "not whitelist-confirmed".
 * Pure LLM synthesis with no URL is `inferred`.
 *
 * Pure functions, deterministic, zero deps.
 */

// Suffixes / domain patterns recognised as verified sources. Lowercased
// at classification time; new entries should also be lowercased.
const VERIFIED_SUFFIXES = [
  // Government TLDs (US, UK, EU national codes, multi-national orgs)
  '.gov',
  '.gov.uk',
  '.gov.au',
  '.gov.ca',
  '.gov.br',
  '.gov.mx',
  '.gob.mx',
  '.gob.pe',
  '.gob.ar',
  '.gob.cl',
  '.gob.co',
  '.gob.es',
  '.gouv.fr',
  '.bund.de',
  '.europa.eu',
  // Academic TLDs
  '.edu',
  '.edu.au',
  '.edu.mx',
  '.edu.pe',
  '.edu.ar',
  '.ac.uk',
  '.ac.jp',
  '.ac.kr',
  '.ac.in',
  '.ac.nz',
];

// Exact second-level domains (matched at the host root, e.g. "nature.com",
// "who.int"). Curated list of well-recognised authoritative sources.
const VERIFIED_DOMAINS = new Set([
  // Public-health authorities
  'who.int',
  'paho.org',
  'cdc.gov',
  'nih.gov',
  'fda.gov',
  'medlineplus.gov',
  'ema.europa.eu',
  // Peer-reviewed academic publishers / preprint servers
  'arxiv.org',
  'biorxiv.org',
  'medrxiv.org',
  'pubmed.ncbi.nlm.nih.gov',
  'ncbi.nlm.nih.gov',
  'scholar.google.com',
  'semanticscholar.org',
  'doi.org',
  'crossref.org',
  'orcid.org',
  'nature.com',
  'science.org',
  'cell.com',
  'pnas.org',
  'nejm.org',
  'thelancet.com',
  'bmj.com',
  'springer.com',
  'springeropen.com',
  'wiley.com',
  'onlinelibrary.wiley.com',
  'tandfonline.com',
  'sagepub.com',
  'mdpi.com',
  'plos.org',
  'frontiersin.org',
  // Standards bodies
  'iso.org',
  'ieee.org',
  'w3.org',
  'ietf.org',
  'rfc-editor.org',
  'nist.gov',
  'iana.org',
  'unicode.org',
  // International organisations
  'un.org',
  'unesco.org',
  'worldbank.org',
  'imf.org',
  'oecd.org',
]);

function _normalizeHost(host) {
  if (typeof host !== 'string') return '';
  return host.trim().toLowerCase().replace(/^www\./, '');
}

function _matchesVerifiedSuffix(host) {
  for (const suffix of VERIFIED_SUFFIXES) {
    if (host === suffix.slice(1)) return suffix;
    if (host.endsWith(suffix)) return suffix;
  }
  return null;
}

/**
 * Classify a single source.
 *
 * @param {object} source
 * @param {string} [source.url] — full URL of the source. Missing/empty
 *   URLs are treated as LLM-synthesised (inferred).
 * @param {boolean} [source.llmSynthesized] — explicit override: true
 *   forces `inferred` regardless of URL (used when the gateway routes
 *   an answer through an LLM without grounding context).
 * @returns {{ confidence: 'verified'|'unverified'|'inferred', reason: string, host: string|null }}
 */
function classifySource(source = {}) {
  const url = typeof source.url === 'string' ? source.url.trim() : '';
  if (source.llmSynthesized || !url) {
    return {
      confidence: 'inferred',
      reason: 'no_source_url',
      host: null,
    };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return { confidence: 'unverified', reason: 'invalid_url', host: null };
  }

  const host = _normalizeHost(parsed.hostname);
  if (!host) {
    return { confidence: 'unverified', reason: 'missing_host', host: null };
  }

  if (VERIFIED_DOMAINS.has(host)) {
    return { confidence: 'verified', reason: 'authoritative_domain', host };
  }

  const matchedSuffix = _matchesVerifiedSuffix(host);
  if (matchedSuffix) {
    return {
      confidence: 'verified',
      reason: `authoritative_tld:${matchedSuffix}`,
      host,
    };
  }

  return { confidence: 'unverified', reason: 'unrecognised_domain', host };
}

/**
 * Human-readable label for a confidence value. Lowercase Spanish to
 * match the UI conventions used elsewhere (the prompt master is in es).
 */
function labelFor(confidence) {
  switch (confidence) {
    case 'verified':
      return 'verificada';
    case 'inferred':
      return 'inferida';
    case 'unverified':
    default:
      return 'sin verificar';
  }
}

module.exports = {
  classifySource,
  labelFor,
  VERIFIED_DOMAINS,
  VERIFIED_SUFFIXES,
};
