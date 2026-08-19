"use strict";

const { Runnable } = require("./runnable");

class BaseRetriever extends Runnable {
  constructor({ name, retrieve, k = 5, metadata = {} } = {}) {
    if (typeof retrieve !== "function") {
      throw new Error("BaseRetriever requires retrieve(query, context)");
    }
    super({
      name,
      invoke: async (query, context = {}) => {
        if (typeof query !== "string" || query.trim().length === 0) {
          return [];
        }
        return retrieve(query, { ...context, k });
      },
      inputSchema: { type: "string" },
      outputSchema: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "text", "metadata"],
        },
      },
      config: { k, metadata },
    });
    this.k = k;
    this.metadata = metadata;
  }
}

function createInMemoryRetriever({ name = "in_memory_retriever", documents = [], k = 5 } = {}) {
  const normalized = documents.map((doc, index) => ({
    id: String(doc.id || `doc_${index + 1}`),
    text: String(doc.text || doc.page_content || doc.content || ""),
    metadata: doc.metadata || {},
  })).filter((doc) => doc.text.trim().length > 0);

  return new BaseRetriever({
    name,
    k,
    retrieve: async (query, context = {}) => {
      const limit = Number(context.k || k);
      const q = tokenize(query);
      return normalized
        .map((doc) => ({ ...doc, score: lexicalScore(q, tokenize(doc.text)) }))
        .filter((doc) => doc.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },
    metadata: { document_count: normalized.length },
  });
}

function tokenize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

function lexicalScore(queryTokens, docTokens) {
  if (queryTokens.length === 0 || docTokens.length === 0) return 0;
  const docSet = new Set(docTokens);
  const hits = queryTokens.filter((token) => docSet.has(token)).length;
  return hits / Math.sqrt(queryTokens.length * docSet.size);
}

module.exports = {
  BaseRetriever,
  createInMemoryRetriever,
};
