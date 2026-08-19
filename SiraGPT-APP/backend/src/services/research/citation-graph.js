'use strict';

const { normaliseDoi } = require('./source-integrity');

function shortOpenAlexId(value) {
  const match = String(value || '').match(/(?:openalex\.org\/)?(W\d+)/i);
  return match ? match[1].toUpperCase() : null;
}

function graphNode(work, role = 'related') {
  const id = shortOpenAlexId(work?.id) || normaliseDoi(work?.doi) || String(work?.id || work?.title || 'unknown');
  return {
    id,
    title: work?.display_name || work?.title || id,
    year: work?.publication_year || work?.year || null,
    doi: normaliseDoi(work?.doi),
    citedByCount: Number(work?.cited_by_count ?? work?.citationCount) || 0,
    role,
    url: work?.id || work?.url || null,
  };
}

function addNode(nodes, node) {
  if (!nodes.has(node.id)) nodes.set(node.id, node);
  else if (node.role === 'seed') nodes.set(node.id, { ...nodes.get(node.id), ...node });
}

async function fetchJson(fetchImpl, url, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`openalex_http_${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function apiUrl(path, env = process.env) {
  const url = new URL(path, 'https://api.openalex.org');
  if (env.OPENALEX_API_KEY) url.searchParams.set('api_key', env.OPENALEX_API_KEY);
  else if (env.SIRAGPT_RESEARCH_EMAIL || env.OPENALEX_MAILTO) {
    url.searchParams.set('mailto', env.SIRAGPT_RESEARCH_EMAIL || env.OPENALEX_MAILTO);
  }
  return url.toString();
}

async function buildCitationGraph(references, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const seeds = (Array.isArray(references) ? references : []).slice(0, Math.min(10, options.limit || 5));
  const nodes = new Map();
  const edges = [];
  const errors = [];

  for (const reference of seeds) {
    const localSeed = graphNode({
      id: reference.metadata?.openAlexId || reference.url || reference.id,
      title: reference.title,
      year: reference.year,
      doi: reference.doi,
      citationCount: reference.citationCount,
    }, 'seed');
    addNode(nodes, localSeed);
    const doi = normaliseDoi(reference.doi);
    if (!doi || typeof fetchImpl !== 'function') continue;
    try {
      const work = await fetchJson(fetchImpl, apiUrl(`/works/https://doi.org/${encodeURIComponent(doi)}`, options.env), options);
      const seedNode = graphNode(work, 'seed');
      addNode(nodes, seedNode);
      const seedId = seedNode.id;
      for (const cited of (work.referenced_works || []).slice(0, 8)) {
        const citedId = shortOpenAlexId(cited);
        if (!citedId) continue;
        addNode(nodes, { id: citedId, title: citedId, year: null, doi: null, citedByCount: 0, role: 'reference', url: `https://openalex.org/${citedId}` });
        edges.push({ from: seedId, to: citedId, type: 'cites' });
      }
      const citers = await fetchJson(fetchImpl, apiUrl(`/works?filter=cites:${seedId}&sort=-cited_by_count&per_page=8&select=id,display_name,publication_year,doi,cited_by_count`, options.env), options);
      for (const citer of citers.results || []) {
        const citerNode = graphNode(citer, 'citing');
        addNode(nodes, citerNode);
        edges.push({ from: citerNode.id, to: seedId, type: 'cites' });
      }
    } catch (error) {
      errors.push({ referenceId: reference.id || null, code: String(error?.message || 'citation_graph_failed').slice(0, 120) });
      for (const cited of reference.metadata?.referencedWorks || []) {
        const citedId = shortOpenAlexId(cited) || String(cited);
        addNode(nodes, { id: citedId, title: citedId, year: null, doi: null, citedByCount: 0, role: 'reference', url: null });
        edges.push({ from: localSeed.id, to: citedId, type: 'cites' });
      }
    }
  }

  return {
    nodes: Array.from(nodes.values()),
    edges: Array.from(new Map(edges.map((edge) => [`${edge.from}:${edge.to}:${edge.type}`, edge])).values()),
    errors,
    meta: { seeds: seeds.length, nodeCount: nodes.size, edgeCount: edges.length, provider: 'OpenAlex' },
  };
}

module.exports = { buildCitationGraph, graphNode, shortOpenAlexId };
