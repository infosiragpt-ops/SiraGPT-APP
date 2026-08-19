'use strict';

/**
 * Filters RAG document sources using cross-document intent signals so only
 * relevant files contribute chunks to retrieval context.
 */

function normalizeIntentList(intent) {
  if (!intent) return [];
  const docs = intent.perDocument || intent.documents || [];
  if (!Array.isArray(docs)) return [];
  return docs.map((d) => ({
    fileId: d.fileId || d.id || d.source || null,
    domain: d.domain || d.primaryDomain || 'general',
    relevance: Number(d.relevanceScore ?? d.score ?? 0.5),
    role: d.role || d.intent || 'supporting',
  })).filter((d) => d.fileId);
}

function rankSources(sources, intentAnalysis, opts = {}) {
  const minRelevance = Number(opts.minRelevance ?? 0.35);
  const intents = normalizeIntentList(intentAnalysis);
  if (!intents.length) {
    return { sources: sources || [], gated: false, dropped: 0 };
  }

  const byFile = new Map(intents.map((i) => [String(i.fileId), i]));
  const input = Array.isArray(sources) ? sources : [];
  const scored = input.map((source) => {
    const key = String(source.fileId || source.id || source.source || '');
    const meta = byFile.get(key);
    const relevance = meta ? meta.relevance : 0.4;
    return { source, relevance, meta };
  });

  const kept = scored
    .filter((row) => row.relevance >= minRelevance || row.meta?.role === 'primary')
    .sort((a, b) => b.relevance - a.relevance);

  const finalSources = kept.length > 0
    ? kept.map((r) => r.source)
    : input.slice(0, Math.min(3, input.length));

  return {
    sources: finalSources,
    gated: true,
    dropped: Math.max(0, input.length - finalSources.length),
    rankings: kept.map((r) => ({ id: r.source.fileId || r.source.source, relevance: r.relevance })),
  };
}

module.exports = {
  normalizeIntentList,
  rankSources,
};
