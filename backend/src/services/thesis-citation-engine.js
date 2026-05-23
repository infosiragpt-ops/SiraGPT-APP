'use strict';

/**
 * thesis-citation-engine — fetches verifiable scholarly references
 * (2020+) from OpenAlex. DOIs are resolved for APA 7 bibliography.
 * Used by the thesis generator pipeline; never fabricates citations.
 */

const MIN_PUBLICATION_YEAR = 2020;
const OPENALEX_BASE = 'https://api.openalex.org/works';
const DEFAULT_PER_PAGE = 12;
const REQUEST_TIMEOUT_MS = 15_000;

function buildOpenAlexSearchUrl(query, { perPage = DEFAULT_PER_PAGE, year = MIN_PUBLICATION_YEAR } = {}) {
  const params = new URLSearchParams({
    search: String(query || '').trim(),
    per_page: String(Math.min(Math.max(perPage, 1), 25)),
    filter: `from_publication_date:${year}-01-01,type:article`,
    sort: 'cited_by_count:desc',
  });
  return `${OPENALEX_BASE}?${params.toString()}`;
}

function formatAuthorsApa7(authorships = []) {
  const names = authorships
    .slice(0, 8)
    .map((a) => a?.author?.display_name)
    .filter(Boolean);

  if (names.length === 0) return 'Autor desconocido';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} y ${names[1]}`;
  const last = names.pop();
  return `${names.join(', ')}, y ${last}`;
}

function extractDoi(work) {
  const raw = work?.doi || work?.ids?.doi || null;
  if (!raw) return null;
  return String(raw).replace(/^https?:\/\/doi\.org\//i, '').trim();
}

function extractYear(work) {
  const y = work?.publication_year;
  if (Number.isFinite(y) && y >= MIN_PUBLICATION_YEAR) return y;
  const d = work?.publication_date;
  if (typeof d === 'string' && d.length >= 4) {
    const parsed = Number.parseInt(d.slice(0, 4), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toApa7Reference(work) {
  const authors = formatAuthorsApa7(work.authorships);
  const year = extractYear(work);
  const title = String(work?.title || work?.display_name || '').replace(/\.$/, '');
  const journal = work?.primary_location?.source?.display_name || work?.host_venue?.display_name || '';
  const doi = extractDoi(work);
  const volume = work?.biblio?.volume;
  const issue = work?.biblio?.issue;
  const pages = work?.biblio?.first_page && work?.biblio?.last_page
    ? `${work.biblio.first_page}-${work.biblio.last_page}`
    : work?.biblio?.first_page || null;

  let ref = `${authors} (${year || 's.f.'}). ${title}.`;
  if (journal) {
    ref += ` ${journal}`;
    if (volume) ref += `, ${volume}`;
    if (issue) ref += `(${issue})`;
    if (pages) ref += `, ${pages}`;
  }
  ref += '.';
  if (doi) ref += ` https://doi.org/${doi}`;
  else if (work?.id) ref += ` ${work.id}`;

  return {
    apa7: ref,
    doi,
    title,
    authors,
    year,
    journal,
    openAlexId: work?.id || null,
    citedByCount: work?.cited_by_count ?? 0,
    sciteUrl: doi ? `https://scite.ai/reports/${encodeURIComponent(doi)}` : null,
  };
}

async function fetchWithTimeout(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'siraGPT-thesis/1.0' },
    });
    if (!res.ok) {
      throw new Error(`OpenAlex HTTP ${res.status}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * searchScholarlyArticles — returns real articles from OpenAlex.
 * Filters out works without a valid year >= MIN_PUBLICATION_YEAR.
 */
async function searchScholarlyArticles(topic, options = {}) {
  const q = String(topic || '').trim();
  if (!q) return [];

  const url = buildOpenAlexSearchUrl(q, options);
  let payload;
  try {
    payload = await fetchWithTimeout(url, options.timeoutMs);
  } catch (err) {
    console.warn('[thesis-citation-engine] OpenAlex fetch failed:', err?.message || err);
    return [];
  }

  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results
    .map(toApa7Reference)
    .filter((r) => r.year && r.year >= MIN_PUBLICATION_YEAR && r.title);
}

module.exports = {
  MIN_PUBLICATION_YEAR,
  buildOpenAlexSearchUrl,
  searchScholarlyArticles,
  toApa7Reference,
};
