/**
 * crossref_verify skill — batch DOI validation + metadata lookup.
 *
 * Delegates to services/marco-teorico/crossref's verifyBatch (6-way
 * parallel, polite User-Agent, 6s per-call timeout). Caps input at
 * 30 DOIs per skill invocation to stay within reasonable round-trip
 * times when the agent calls this from a chat — anything bigger
 * should go through the Marco Teórico orchestrator which streams
 * progress as each verification completes.
 */

const crossref = require('../../services/marco-teorico/crossref');

const MAX_DOIS = 30;

function normalize(doi) {
  if (typeof doi !== 'string') return null;
  const trimmed = doi.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  return trimmed.length > 0 ? trimmed : null;
}

async function execute(args) {
  const dois = Array.isArray(args?.dois) ? args.dois.map(normalize).filter(Boolean) : [];
  if (dois.length === 0) return { results: [], error: 'no DOIs provided' };
  if (dois.length > MAX_DOIS) return { results: [], error: `too many DOIs (max ${MAX_DOIS})` };

  const results = await crossref.verifyBatch(dois);

  // Keep the response shape predictable for the LLM: one entry per
  // input DOI, in input order. Invalid entries surface explicitly so
  // the agent can decide whether to retry / discard.
  return {
    count: results.length,
    valid: results.filter(r => r.valid).length,
    results: results.map(r => r.valid ? {
      doi: r.doi,
      valid: true,
      title: r.title,
      authors: r.authors,
      year: r.year,
      container: r.container,
      volume: r.volume,
      issue: r.issue,
      pages: r.pages,
      publisher: r.publisher,
      type: r.type,
      url: r.url,
    } : {
      doi: r.doi,
      valid: false,
    }),
  };
}

module.exports = { execute };
