'use strict';

/**
 * Hybrid chat search — FTS rank blended with optional semantic boost via Turbopuffer.
 */

function blendRank(ftsRank, semanticScore, weight = 0.3) {
  const fts = Number(ftsRank) || 0;
  const sem = Number(semanticScore) || 0;
  const w = Math.max(0, Math.min(1, weight));
  return fts * (1 - w) + sem * w;
}

async function semanticBoostForMessages({ userId, query, messageIds = [] }) {
  if (!process.env.TURBOPUFFER_API_KEY || !messageIds.length) return new Map();
  try {
    const Turbopuffer = require('@turbopuffer/turbopuffer');
    const client = new Turbopuffer({ apiKey: process.env.TURBOPUFFER_API_KEY });
    const ns = client.namespace(`chat-${String(userId).slice(0, 32)}`);
    const exists = await ns.exists();
    if (!exists) return new Map();

    const response = await ns.query({
      rank_by: ['content', 'BM25', query],
      top_k: Math.min(messageIds.length, 50),
      filters: ['id', 'In', messageIds],
      include_attributes: ['messageId'],
    });

    const map = new Map();
    for (const row of response.rows || []) {
      const id = row.messageId || row.id;
      const dist = row.$dist != null ? Number(row.$dist) : 0;
      map.set(String(id), Math.max(0, 1 - dist));
    }
    return map;
  } catch {
    return new Map();
  }
}

function mergeHybridResults(ftsResults, semanticMap, opts = {}) {
  const weight = opts.semanticWeight ?? 0.25;
  return ftsResults
    .map((row) => {
      const sem = semanticMap.get(String(row.messageId)) || 0;
      const hybridRank = blendRank(row.rank, sem, weight);
      return { ...row, semanticScore: sem, hybridRank };
    })
    .sort((a, b) => b.hybridRank - a.hybridRank);
}

module.exports = {
  blendRank,
  semanticBoostForMessages,
  mergeHybridResults,
};
