/**
 * openalex_search skill — thin adapter over the existing
 * services/marco-teorico/openalex implementation. The marco-teorico
 * pipeline already validates this code path against the live API in
 * production; exposing it as a skill lets *any* chat call it (not
 * just the Marco Teórico generator) without duplicating logic.
 *
 * Output shape is trimmed for the LLM context — full author lists,
 * abstracts, venue. We cap each abstract at 800 chars so a single
 * skill call doesn't blow the agent's prompt budget.
 */

const openalex = require('../../services/marco-teorico/openalex');

const ABSTRACT_CAP = 800;

async function execute(args) {
  const { query, limit, yearFrom, yearTo, lang } = args || {};
  if (!query) return { sources: [], error: 'missing query' };

  const yearRange = (yearFrom && yearTo) ? [Number(yearFrom), Number(yearTo)] : null;
  const sources = await openalex.search({
    query, limit: limit || 20, yearRange, lang: lang || null,
  });

  return {
    count: sources.length,
    sources: sources.map(s => ({
      doi: s.doi,
      title: s.title,
      authors: s.authors,
      year: s.year,
      venue: s.venue,
      type: s.type,
      citedByCount: s.citedByCount,
      openAccessUrl: s.openAccessUrl,
      abstract: s.abstract ? s.abstract.slice(0, ABSTRACT_CAP) + (s.abstract.length > ABSTRACT_CAP ? '…' : '') : null,
    })),
  };
}

module.exports = { execute };
