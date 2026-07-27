'use strict';

/**
 * Hermes plugin bridge — registers Hermes plugin families into SiraGPT plugin-registry.
 */

const { getPluginRegistry } = require('./plugin-registry');
const memoryBridge = require('./hermes-memory-bridge');
const { redactString } = require('../../utils/secret-redactor');

let _bootPromise = null;

const HERMES_PLUGIN_CATALOG = Object.freeze([
  {
    id: 'hermes-memory',
    name: 'Hermes Memory',
    version: '1.0.0',
    description: 'Active memory + session search (Honcho/mem0-style semantics via SiraGPT active-memory).',
    author: 'SiraGPT',
    hooks: ['agent:beforeRun', 'agent:afterRun'],
    capabilities: ['memory', 'hooks'],
    upstream: 'plugins/memory',
  },
  {
    id: 'hermes-web',
    name: 'Hermes Web Search',
    version: '1.0.0',
    description: 'Multi-provider web search (DDG, Wikipedia, arXiv, PubMed, …).',
    author: 'SiraGPT',
    hooks: [],
    capabilities: ['tools'],
    upstream: 'plugins/web',
  },
  {
    id: 'hermes-image-gen',
    name: 'Hermes Image Generation',
    version: '1.0.0',
    description: 'SVG/PNG image generation via visual-media-tools.',
    author: 'SiraGPT',
    hooks: [],
    capabilities: ['tools'],
    upstream: 'plugins/image_gen',
  },
  {
    id: 'hermes-video-gen',
    name: 'Hermes Video Generation',
    version: '1.0.0',
    description: 'Storyboard/video generation via visual-media-tools.',
    author: 'SiraGPT',
    hooks: [],
    capabilities: ['tools'],
    upstream: 'plugins/video_gen',
  },
  {
    id: 'hermes-browser',
    name: 'Hermes Browser',
    version: '1.0.0',
    description: 'Browser/computer-use automation bridge.',
    author: 'SiraGPT',
    hooks: [],
    capabilities: ['tools'],
    upstream: 'plugins/browser',
  },
  {
    id: 'hermes-kanban',
    name: 'Hermes Kanban',
    version: '1.0.0',
    description: 'Multi-agent kanban coordination via delegate bridge.',
    author: 'SiraGPT',
    hooks: ['agent:afterRun'],
    capabilities: ['hooks'],
    upstream: 'plugins/kanban',
  },
  {
    id: 'hermes-observability',
    name: 'Hermes Observability',
    version: '1.0.0',
    description: 'Agent telemetry and structured logging.',
    author: 'SiraGPT',
    hooks: ['agent:toolCall', 'agent:toolResult', 'agent:error'],
    capabilities: ['hooks'],
    upstream: 'plugins/observability',
  },
]);

function buildFactory(catalogEntry) {
  return async (api) => {
    if (catalogEntry.id === 'hermes-memory') {
      api.on('agent:beforeRun', async (ctx) => {
        if (!ctx?.userId) return;
        ctx.memoryPrompt = memoryBridge.buildMemoryPrompt(ctx.userId);
        memoryBridge.nudgePromotion(ctx.userId);
      });
    }
    if (catalogEntry.id === 'hermes-observability') {
      api.on('agent:toolCall', async (ctx) => {
        ctx.observed = true;
      });
    }
    if (catalogEntry.id === 'hermes-web') {
      api.registerSkill(buildScientificFederatedSearchSkill());
    }
    return { catalog: catalogEntry };
  };
}

function buildScientificFederatedSearchSkill() {
  return {
    id: 'scientific_federated_search',
    name: 'Scientific federated search',
    description: 'Search and rank scientific literature across SiraGPT federated sources, deduplicate records, preserve provider provenance, and return DOI/open-access links.',
    capabilities: ['net:outbound'],
    timeoutMs: 25000,
    params: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 500, description: 'Scientific topic or research question.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum deduplicated papers to return. Default 20.' },
        providers: {
          type: 'array',
          maxItems: 16,
          uniqueItems: true,
          items: {
            type: 'string',
            enum: ['arxiv', 'openalex', 'semanticscholar', 'crossref', 'pubmed', 'europepmc', 'core', 'doaj', 'dblp', 'datacite', 'scielo', 'scopus', 'wos', 'redalyc', 'biorxiv', 'medrxiv'],
          },
          description: 'Optional provider allowlist. Omit to fan out across all configured sources.',
        },
        yearFrom: { type: 'integer', minimum: 1900, maximum: 2100 },
        yearTo: { type: 'integer', minimum: 1900, maximum: 2100 },
        openAccessOnly: { type: 'boolean', description: 'Return only records marked open access.' },
      },
    },
    async execute(args = {}, ctx = {}) {
      const scientificSearch = require('../scientific-search');
      const query = String(args.query || '').replace(/\s+/g, ' ').trim();
      if (!query) return { count: 0, papers: [], errors: [{ provider: 'input', message: 'query is empty' }] };
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
      const providers = Array.isArray(args.providers)
        ? args.providers.filter((provider) => scientificSearch.PROVIDERS.includes(provider))
        : undefined;
      const result = await scientificSearch.search(query, {
        limit: Math.min(10, limit),
        ...(providers?.length ? { providers } : {}),
        totalTimeoutMs: 20000,
        signal: ctx.signal,
      });
      let papers = Array.isArray(result.papers) ? result.papers : [];
      const yearFrom = Number(args.yearFrom) || null;
      const yearTo = Number(args.yearTo) || null;
      if (yearFrom) papers = papers.filter((paper) => Number(paper.year) >= yearFrom);
      if (yearTo) papers = papers.filter((paper) => Number(paper.year) <= yearTo);
      if (args.openAccessOnly === true) papers = papers.filter((paper) => paper.openAccess === true);
      papers = papers.slice(0, limit).map((paper) => ({
        title: String(paper.title || '').slice(0, 500),
        doi: paper.doi || null,
        year: paper.year || null,
        venue: paper.venue || null,
        authors: (paper.authors || []).slice(0, 8).map((author) => author?.name || author).filter(Boolean),
        citations: paper.citations ?? null,
        openAccess: paper.openAccess ?? null,
        pdfUrl: paper.pdfUrl || null,
        htmlUrl: paper.htmlUrl || null,
        sources: Array.from(new Set([paper.source, ...(paper.sources || [])].filter(Boolean))),
        abstract: paper.abstract ? String(paper.abstract).slice(0, 1200) : null,
      }));
      return {
        count: papers.length,
        providers: result.providers || providers || [],
        errors: (result.errors || []).slice(0, 16).map((error) => ({
          provider: String(error.provider || 'unknown').slice(0, 40),
          message: redactString(String(error.message || 'provider failed')).slice(0, 240),
        })),
        papers,
      };
    },
  };
}

async function runBootHermesPlugins(opts = {}) {
  const registry = getPluginRegistry();
  const registered = [];
  const skipped = [];

  for (const catalogEntry of HERMES_PLUGIN_CATALOG) {
    if (registry.getPlugin(catalogEntry.id)) {
      skipped.push(catalogEntry.id);
      continue;
    }
    if (opts.only && !opts.only.includes(catalogEntry.id)) continue;

    const manifest = {
      id: catalogEntry.id,
      name: catalogEntry.name,
      version: catalogEntry.version,
      description: catalogEntry.description,
      author: catalogEntry.author,
      hooks: catalogEntry.hooks,
      capabilities: catalogEntry.capabilities,
      trusted: true,
      hookDefaults: { timeoutMs: 750 },
    };

    try {
      await registry.register(manifest, buildFactory(catalogEntry));
      registered.push(catalogEntry.id);
    } catch (err) {
      if (!String(err.message || '').includes('already registered')) {
        console.warn(`[hermes-plugin-bridge] failed to register ${catalogEntry.id}:`, err.message);
      } else {
        skipped.push(catalogEntry.id);
      }
    }
  }

  return { registered, skipped, total: HERMES_PLUGIN_CATALOG.length };
}

async function bootHermesPlugins(opts = {}) {
  if (_bootPromise) return _bootPromise;
  _bootPromise = runBootHermesPlugins(opts);
  try {
    return await _bootPromise;
  } finally {
    _bootPromise = null;
  }
}

function listHermesPlugins() {
  const registry = getPluginRegistry();
  return HERMES_PLUGIN_CATALOG.map((entry) => {
    const live = registry.getPlugin(entry.id);
    return {
      ...entry,
      state: live?.state || 'not_registered',
      enabled: live?.state === 'enabled',
    };
  });
}

function status() {
  const plugins = listHermesPlugins();
  const hookHealth = getPluginRegistry().hookHealth();
  return {
    catalog: plugins.length,
    enabled: plugins.filter((p) => p.enabled).length,
    lifecycle: {
      hooksObserved: hookHealth.length,
      totalRuns: hookHealth.reduce((sum, hook) => sum + hook.totalRuns, 0),
      successfulRuns: hookHealth.reduce((sum, hook) => sum + hook.successfulRuns, 0),
      errors: hookHealth.reduce((sum, hook) => sum + hook.errors, 0),
      timeouts: hookHealth.reduce((sum, hook) => sum + hook.timeouts, 0),
      circuitsOpen: hookHealth.filter((hook) => hook.breakerUntil && new Date(hook.breakerUntil).getTime() > Date.now()).length,
    },
    plugins,
  };
}

module.exports = {
  HERMES_PLUGIN_CATALOG,
  bootHermesPlugins,
  listHermesPlugins,
  status,
  buildScientificFederatedSearchSkill,
};
