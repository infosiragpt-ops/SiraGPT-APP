const crypto = require("crypto");
const prisma = require("../../../config/database");

const TTL_SECONDS = Object.freeze({
  academic: 30 * 24 * 60 * 60,
  jobs: 6 * 60 * 60,
  shopping: 2 * 60 * 60,
  web: 24 * 60 * 60,
  news: 30 * 60,
  government: 7 * 24 * 60 * 60,
  finance: 5 * 60,
  weather: 15 * 60,
  geo: 24 * 60 * 60,
  media: 24 * 60 * 60,
  travel: 2 * 60 * 60,
  realestate: 2 * 60 * 60,
  food: 24 * 60 * 60,
  health: 7 * 24 * 60 * 60,
  education: 7 * 24 * 60 * 60,
  legal: 7 * 24 * 60 * 60,
  social: 60 * 60,
  china: 60 * 60,
});

function hashQuery({ query, categories, region, provider }) {
  const raw = JSON.stringify({
    q: String(query || "").trim().toLowerCase(),
    categories: [...(categories || [])].sort(),
    region: region || "global",
    provider: provider || "*",
  });
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function ttlFor(categories = []) {
  if (!Array.isArray(categories) || categories.length === 0) return TTL_SECONDS.web;
  return Math.min(...categories.map((c) => TTL_SECONDS[c] || TTL_SECONDS.web));
}

function modelAvailable() {
  return Boolean(prisma && prisma.universalSearchCache);
}

async function getCached(args) {
  if (!modelAvailable()) return null;
  const queryHash = hashQuery(args);
  const row = await prisma.universalSearchCache.findFirst({
    where: { queryHash },
    orderBy: { cachedAt: "desc" },
  }).catch(() => null);
  if (!row) return null;
  const ageSeconds = (Date.now() - new Date(row.cachedAt).getTime()) / 1000;
  if (ageSeconds > row.ttlSeconds) return null;
  return {
    queryHash,
    results: Array.isArray(row.resultJson) ? row.resultJson : [],
    metadata: row.metadata || {},
  };
}

async function setCached(args, results, metadata = {}) {
  if (!modelAvailable()) return null;
  const queryHash = hashQuery(args);
  const ttlSeconds = ttlFor(args.categories);
  return prisma.universalSearchCache.upsert({
    where: { queryHash_provider: { queryHash, provider: args.provider || "*" } },
    create: {
      queryHash,
      intentCategories: args.categories || [],
      region: args.region || "global",
      provider: args.provider || "*",
      resultJson: results || [],
      embeddingJson: null,
      metadata,
      ttlSeconds,
    },
    update: {
      intentCategories: args.categories || [],
      region: args.region || "global",
      resultJson: results || [],
      metadata,
      ttlSeconds,
      cachedAt: new Date(),
    },
  }).catch(() => null);
}

module.exports = {
  TTL_SECONDS,
  getCached,
  hashQuery,
  setCached,
  ttlFor,
  INTERNAL: { modelAvailable },
};
