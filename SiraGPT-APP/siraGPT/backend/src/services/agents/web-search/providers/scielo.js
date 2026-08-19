/**
 * scielo — SciELO scientific articles. Free, no API key.
 *
 * SciELO is the largest open-access index for Latin-American /
 * Iberian peer-reviewed science. Two public endpoints we can use,
 * tried in order:
 *
 *   1) https://search.scielo.org/  (Solr-backed full-text search)
 *      `?q=…&output=site&format=json&lang=es&count=N`
 *      → `{ response: { docs: [{ id, ti, ab, au, journal_title, py, … }] } }`
 *
 *   2) https://articlemeta.scielo.org/api/v1/article/
 *      Article metadata API; we use it as a fallback when the Solr
 *      search returns nothing — it accepts a free-text query via
 *      `?body={"query":...}` on some collections. Treated as best-
 *      effort: if shape doesn't match we just return `[]`.
 *
 * Returned entries are scientific articles with title + abstract
 * snippet + canonical SciELO URL. The adapter de-dupes by URL.
 *
 * Priority is intentionally high (5) so that whenever a query has a
 * scientific match, SciELO wins; non-scientific queries return `[]`
 * and the adapter falls through to DuckDuckGo / Wikipedia.
 */

const fetch = require('node-fetch');

const USER_AGENT = 'SiraGPT-WebSearch/1.0 (+https://siragpt.com; contact: hello@siragpt.com)';
const SEARCH_BASE = 'https://search.scielo.org/';
const ARTICLEMETA_BASE = 'https://articlemeta.scielo.org/api/v1/article/';

function pickFirst(v) {
  if (Array.isArray(v)) return v[0];
  return v;
}

function joinNonEmpty(arr, sep = ' · ') {
  return (Array.isArray(arr) ? arr : [arr])
    .filter((x) => typeof x === 'string' && x.trim())
    .join(sep);
}

function langFromLocale(locale) {
  if (typeof locale !== 'string') return null;
  const m = locale.match(/^([a-z]{2})/i);
  if (!m) return null;
  const l = m[1].toLowerCase();
  // SciELO supports es, pt, en — clamp to those.
  if (l === 'es' || l === 'pt' || l === 'en') return l;
  return null;
}

async function searchSolr(query, { maxResults, signal, locale }) {
  const params = new URLSearchParams({
    q: query,
    output: 'site',
    format: 'json',
    count: String(Math.max(1, Math.min(maxResults, 20))),
  });
  const lang = langFromLocale(locale);
  if (lang) params.set('lang', lang);

  const res = await fetch(`${SEARCH_BASE}?${params.toString()}`, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`scielo solr http ${res.status}`);
  const raw = await res.text();
  let body;
  try { body = JSON.parse(raw); } catch (err) {
    // search.scielo.org sometimes returns HTML even with format=json
    // (when an upstream cache misbehaves). Treat as empty so the
    // adapter can fall through to other providers.
    return [];
  }

  const docs = Array.isArray(body?.response?.docs)
    ? body.response.docs
    : Array.isArray(body?.docs)
      ? body.docs
      : [];
  return docs.map(normaliseSolrDoc).filter(Boolean).slice(0, maxResults);
}

function normaliseSolrDoc(d) {
  if (!d || typeof d !== 'object') return null;
  // SciELO Solr docs vary by collection; try the common field names.
  const pid = pickFirst(d.id || d.pid || d.code || d.cluster_id);
  const title = pickFirst(d.ti || d.title || d.ti_pt || d.ti_es || d.ti_en);
  const journal = pickFirst(d.journal_title || d.journal_abbreviated_title || d.in);
  const year = pickFirst(d.py || d.publication_year);
  const authors = Array.isArray(d.au) ? d.au.slice(0, 4) : [];
  const abstractText = pickFirst(d.ab || d.ab_pt || d.ab_es || d.ab_en);
  if (!title) return null;

  // Canonical article URL. SciELO uses PID-based URLs like
  // https://search.scielo.org/?q=...&id=<pid> or per-collection
  // scielo.<cc>/scielo.php?pid=<pid>. The search-engine URL with the
  // pid is the safest universal link.
  const url = pid
    ? `https://search.scielo.org/?q=${encodeURIComponent(String(pid))}&lang=${langFromLocale(null) || 'es'}`
    : null;
  if (!url) return null;

  const meta = joinNonEmpty([journal, year ? String(year) : '', authors.join(', ')]);
  const snippet = joinNonEmpty([meta, String(abstractText || '').trim()], ' — ');
  return {
    title: String(title).trim(),
    url,
    snippet: snippet.slice(0, 600),
    source: 'scielo',
  };
}

async function searchArticleMeta(query, { maxResults, signal }) {
  // ArticleMeta does not expose a true free-text endpoint without a
  // collection, but it has a `/identifiers/` endpoint that can be
  // filtered by issn/doi. We only hit it when the query looks like
  // a DOI (best-effort fallback).
  const doi = String(query).match(/10\.\d{4,9}\/\S+/);
  if (!doi) return [];
  const params = new URLSearchParams({ doi: doi[0] });
  const res = await fetch(`${ARTICLEMETA_BASE}?${params.toString()}`, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`scielo articlemeta http ${res.status}`);
  const body = await res.json();
  const articles = Array.isArray(body) ? body : Array.isArray(body?.articles) ? body.articles : [body];
  const out = [];
  for (const a of articles) {
    if (out.length >= maxResults) break;
    if (!a || typeof a !== 'object') continue;
    const title = a?.title?.[0]?._
      || a?.article?.v12?.[0]?._
      || a?.title
      || null;
    const pid = a?.code || a?.article?.v880?.[0]?._;
    if (!title || !pid) continue;
    out.push({
      title: String(title).trim(),
      url: `https://search.scielo.org/?q=${encodeURIComponent(pid)}`,
      snippet: `DOI ${doi[0]}`,
      source: 'scielo',
    });
  }
  return out;
}

async function search(query, { maxResults = 5, signal, locale } = {}) {
  // 1) Solr full-text first.
  const primary = await searchSolr(query, { maxResults, signal, locale });
  if (primary.length > 0) return primary;
  // 2) DOI fallback via ArticleMeta. If anything throws, surface
  //    empty so the adapter advances to the next provider.
  try {
    return await searchArticleMeta(query, { maxResults, signal });
  } catch (_) {
    return [];
  }
}

module.exports = {
  id: 'scielo',
  name: 'SciELO scientific articles',
  priority: 5,
  enabled: true,
  search,
  // exported for tests
  _normaliseSolrDoc: normaliseSolrDoc,
};
