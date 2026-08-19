"use strict";

/**
 * goldenset — small deterministic test set for retrieval quality.
 *
 * Each chunk has a stable id. Each query lists which chunk ids are
 * relevant, with a graded label (2 = fully on-topic, 1 = tangential).
 * Topics are deliberately distinct (cooking, software, medicine,
 * astronomy) so we can verify topical separation, and queries are
 * intentionally vague ("habla del tema X") so HyDE has room to help.
 *
 * Embeddings are deterministic 64-dim hash vectors derived from token
 * presence — no real model required, but topical chunks share enough
 * tokens that cosine ranks them roughly correctly. This lets the
 * eval suite run hermetically in CI.
 */

const CHUNKS = [
  // Cooking — pasta
  { id: "ck_pasta_1", topic: "cooking", text: "Boil pasta in salted water until al dente. Reserve a cup of starchy water before draining; it helps the sauce cling to the noodles." },
  { id: "ck_pasta_2", topic: "cooking", text: "A classic carbonara uses guanciale, pecorino, eggs, and black pepper. The heat of the drained pasta cooks the egg into a silky sauce." },
  { id: "ck_pasta_3", topic: "cooking", text: "For a tomato sauce, simmer crushed San Marzano tomatoes with garlic and olive oil for at least twenty minutes to mellow the acidity." },
  // Software — caching
  { id: "sw_cache_1", topic: "software", text: "An LRU cache evicts the least recently used entry when full. It approximates the optimal page replacement policy under temporal locality." },
  { id: "sw_cache_2", topic: "software", text: "Two-tier caches combine an in-process layer with a shared Redis layer. The local tier absorbs hot keys; Redis serves warm misses across instances." },
  { id: "sw_cache_3", topic: "software", text: "Cache stampede happens when many requests miss the same key simultaneously. Use a single-flight lock or probabilistic early refresh to mitigate it." },
  // Medicine — diabetes
  { id: "md_diab_1", topic: "medicine", text: "Type 2 diabetes is characterised by insulin resistance and relative insulin deficiency. First-line treatment is usually metformin alongside lifestyle changes." },
  { id: "md_diab_2", topic: "medicine", text: "Continuous glucose monitors give a near-real-time picture of blood sugar trends, replacing fingerstick readings for many patients on intensive regimens." },
  { id: "md_diab_3", topic: "medicine", text: "Diabetic retinopathy progresses silently for years. Annual dilated eye exams catch microaneurysms before vision loss occurs." },
  // Astronomy — exoplanets
  { id: "as_exo_1", topic: "astronomy", text: "Transit photometry detects exoplanets by the periodic dip in stellar brightness as a planet crosses its host star. Kepler used this method to find thousands of candidates." },
  { id: "as_exo_2", topic: "astronomy", text: "Radial velocity measures a star's wobble caused by an orbiting planet. The technique favours massive planets on short orbits around quiet stars." },
  { id: "as_exo_3", topic: "astronomy", text: "Direct imaging of exoplanets requires coronagraphs that block the host star's light. So far it works mainly for young, hot, widely separated giants." },
];

const QUERIES = [
  {
    id: "q_pasta",
    query: "habla del tema de la pasta",
    relevance: { ck_pasta_1: 2, ck_pasta_2: 2, ck_pasta_3: 2 },
  },
  {
    id: "q_carbonara_specific",
    query: "what is in a real carbonara sauce",
    relevance: { ck_pasta_2: 2, ck_pasta_1: 1 },
  },
  {
    id: "q_cache_vague",
    query: "tell me about caching strategies",
    relevance: { sw_cache_1: 2, sw_cache_2: 2, sw_cache_3: 2 },
  },
  {
    id: "q_stampede",
    query: "how do I avoid the thundering herd on cache misses",
    relevance: { sw_cache_3: 2, sw_cache_2: 1 },
  },
  {
    id: "q_diabetes_vague",
    query: "habla del tema de la diabetes",
    relevance: { md_diab_1: 2, md_diab_2: 2, md_diab_3: 2 },
  },
  {
    id: "q_glucose",
    query: "modern way to track blood sugar without pricking the finger",
    relevance: { md_diab_2: 2 },
  },
  {
    id: "q_exo_vague",
    query: "tell me about finding planets around other stars",
    relevance: { as_exo_1: 2, as_exo_2: 2, as_exo_3: 2 },
  },
  {
    id: "q_transit",
    query: "method that watches a star dim when a planet passes",
    relevance: { as_exo_1: 2 },
  },
];

/**
 * Deterministic 64-dim embedding driven by token presence.
 * Each unique token contributes to two coordinates (hash mod dim).
 * Topical chunks share enough tokens to land near each other.
 */
function embed(text, dim = 64) {
  const tokens = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3);
  const v = new Array(dim).fill(0);
  for (const t of tokens) {
    const h1 = hash(t) % dim;
    const h2 = hash(t + "#") % dim;
    v[h1] += 1;
    v[h2] += 0.5;
  }
  let n = 0;
  for (let i = 0; i < dim; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n === 0) return v;
  for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function buildEmbeddedChunks(dim = 64) {
  return CHUNKS.map(c => ({
    id: c.id,
    text: c.text,
    metadata: { topic: c.topic, source_id: c.id },
    embedding: embed(c.text, dim),
  }));
}

module.exports = {
  CHUNKS,
  QUERIES,
  embed,
  buildEmbeddedChunks,
};
