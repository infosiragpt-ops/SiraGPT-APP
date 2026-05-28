'use strict';

/**
 * Hermes plugin bridge — registers Hermes plugin families into SiraGPT plugin-registry.
 */

const { getPluginRegistry } = require('./plugin-registry');
const memoryBridge = require('./hermes-memory-bridge');

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
    return { catalog: catalogEntry };
  };
}

async function bootHermesPlugins(opts = {}) {
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
  return {
    catalog: plugins.length,
    enabled: plugins.filter((p) => p.enabled).length,
    plugins,
  };
}

module.exports = {
  HERMES_PLUGIN_CATALOG,
  bootHermesPlugins,
  listHermesPlugins,
  status,
};
