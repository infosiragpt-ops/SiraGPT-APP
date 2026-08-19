'use strict';

/**
 * web_search (harness-native definition) — thin wrapper over the EXISTING
 * provider chain (agents/web-search: Crossref → … → Brave → DuckDuckGo → …).
 *
 * The interactive chat toolset already ships a web_search tool; attachHarness
 * only registers THIS definition when the turn's toolset lacks one (API
 * callers, tests, future standalone runners), so there is exactly one
 * web_search per turn and it is always backed by the same provider chain.
 */

const { z } = require('zod');

const inputSchema = z.object({
  query: z.string().min(2).max(400).describe('Free-text search query'),
  maxResults: z.number().int().min(1).max(10).optional().describe('How many results (default 5)'),
  freshness: z.enum(['day', 'week', 'month', 'year']).optional()
    .describe('Restrict to recent results when the question is time-sensitive'),
}).strict();

function buildWebSearchTool() {
  return {
    name: 'web_search',
    description: [
      'Search the public web and return ranked results (title, url, snippet, source).',
      'WHEN TO USE: facts that may have changed, current events, prices, versions, niche topics, or anything you are not certain about.',
      'WHEN NOT TO USE: content you must READ in full (call web_fetch on a result url afterwards); private/user documents (use the RAG/document tools).',
    ].join(' '),
    inputSchema,
    permissionTier: 'auto',
    humanDescription: (args = {}) => `Buscando «${String(args.query || '').slice(0, 60)}»`,
    execute: async (args) => {
      const webSearch = require('../../agents/web-search');
      const result = await webSearch.search(args.query, {
        limit: args.maxResults || 5,
        ...(args.freshness ? { freshness: args.freshness } : {}),
      });
      return {
        provider: result.provider || null,
        results: (result.results || []).slice(0, args.maxResults || 5),
      };
    },
  };
}

module.exports = { buildWebSearchTool };
