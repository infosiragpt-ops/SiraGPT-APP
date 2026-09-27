'use strict';

/**
 * index-mentions — «busca papers sobre telemedicina en arxiv»: the index is
 * where to look, not what to look for. Searched as a term, «arxiv» ranked
 * arXiv's own blog posts and FAQs above the telemedicine papers (prod
 * 2026-09-27). A named index picks the providers and leaves the query.
 */

// Provider ids from the SearchBrain registry. CORE is left out on purpose:
// «core» is an ordinary word in both languages.
const INDEX_PATTERNS = [
  ['arxiv', 'arxiv(?:\\.org)?'],
  ['biorxiv', 'bio-?rxiv'],
  ['medrxiv', 'med-?rxiv'],
  ['pubmed', 'pub-?med'],
  ['europepmc', 'europe\\s*pmc'],
  ['crossref', 'cross-?ref'],
  ['openalex', 'open-?alex'],
  ['semantic', 'semantic\\s+scholar'],
  ['scielo', 'scielo'],
  ['redalyc', 'redalyc'],
  ['doaj', 'doaj'],
  ['dblp', 'dblp'],
  ['datacite', 'data-?cite'],
  ['scopus', 'scopus'],
  ['wos', 'web\\s+of\\s+science'],
];
// «en arxiv», «de PubMed», «in Scopus», «usando arXiv», «desde la base SciELO».
const LEAD_IN = '(?:(?:en|de|del|desde|usando|con|in|on|from|using|via)\\s+(?:(?:el|la|los|las|the)\\s+)?(?:(?:(?:base|bases)(?:\\s+de\\s+datos)?|repositorio|índice|indice|index|database)\\s+(?:de\\s+)?)?)?';
const BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}])';
const BOUNDARY_AFTER = '(?![\\p{L}\\p{N}])';

function mentionRegex(pattern) {
  return new RegExp(`${BOUNDARY_BEFORE}${LEAD_IN}${pattern}${BOUNDARY_AFTER}`, 'giu');
}

/**
 * @param {string} query
 * @param {Record<string, unknown>} [registry] only ids present here count
 * @returns {{ providers: string[], topicQuery: string }}
 */
function extractIndexMentions(query, registry) {
  const original = String(query || '').trim();
  let topic = original;
  const providers = [];
  for (const [id, pattern] of INDEX_PATTERNS) {
    if (registry && !(id in registry)) continue;
    if (!mentionRegex(pattern).test(topic)) continue;
    providers.push(id);
    topic = topic.replace(mentionRegex(pattern), ' ');
  }
  if (!providers.length) return { providers, topicQuery: original };
  topic = topic
    .replace(/\s+([,.;:?!])/g, '$1')
    .replace(/(?:\s*(?:,|\by\b|\bo\b|\be\b|\band\b|\bor\b))+\s*([.?!]?)\s*$/iu, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { providers, topicQuery: topic || original };
}

module.exports = { extractIndexMentions, INDEX_PATTERNS };
