'use strict';

/**
 * deterministic-sampler — seedable PRNG + reservoir sampling.
 *
 * Why deterministic? Reproducing incidents and rerunning A/B sampling
 * decisions both require the same "random" choice given the same seed.
 * `Math.random()` cannot do that. We use mulberry32 — a fast 32-bit
 * PRNG with reasonable statistical quality (sufficient for sampling,
 * NOT for crypto). Pairs with the structured-logger and trace-context
 * helpers: log only the sampled spans, but make the sampling decision
 * reproducible per request id.
 *
 * Public API:
 *   hash32(str)                — fnv1a-ish 32-bit string hash
 *   mulberry32(seed)           — () => float in [0, 1)
 *   sampleByKey(key, rate)     — true if hash(key) ∈ first `rate` of [0,1)
 *   reservoir(iter, k, rng?)   — Algorithm R (Vitter 1985) reservoir sample
 *   weightedChoice(items, rng?) — items: [{ value, weight }]
 *   shuffle(arr, rng?)         — Fisher-Yates in place; returns the array
 */

function hash32(str) {
  if (typeof str !== 'string') str = String(str);
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let s = (seed >>> 0) || 1;
  return function next() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0)) / 4294967296;
  };
}

function sampleByKey(key, rate) {
  const r = Number(rate);
  if (!(r > 0)) return false;
  if (r >= 1) return true;
  // Map hash → [0, 1) and compare.
  const u = hash32(key) / 4294967296;
  return u < r;
}

function reservoir(iterable, k, rng) {
  if (!iterable || typeof iterable[Symbol.iterator] !== 'function') {
    throw new TypeError('deterministic-sampler: iterable required');
  }
  const size = Math.max(0, Math.floor(k));
  if (size === 0) return [];
  const random = typeof rng === 'function' ? rng : Math.random;
  const out = [];
  let i = 0;
  for (const item of iterable) {
    if (i < size) {
      out.push(item);
    } else {
      const j = Math.floor(random() * (i + 1));
      if (j < size) out[j] = item;
    }
    i++;
  }
  return out;
}

function weightedChoice(items, rng) {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  let total = 0;
  for (const it of items) {
    const w = Number(it && it.weight);
    if (w > 0) total += w;
  }
  if (total <= 0) return undefined;
  const random = typeof rng === 'function' ? rng : Math.random;
  let r = random() * total;
  for (const it of items) {
    const w = Number(it && it.weight);
    if (!(w > 0)) continue;
    r -= w;
    if (r < 0) return it.value;
  }
  // Floating-point fall-through: return last positive-weight item.
  for (let i = items.length - 1; i >= 0; i--) {
    if (Number(items[i] && items[i].weight) > 0) return items[i].value;
  }
  return undefined;
}

function shuffle(arr, rng) {
  if (!Array.isArray(arr)) throw new TypeError('deterministic-sampler: array required');
  const random = typeof rng === 'function' ? rng : Math.random;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    if (j !== i) {
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
  }
  return arr;
}

module.exports = {
  hash32,
  mulberry32,
  sampleByKey,
  reservoir,
  weightedChoice,
  shuffle,
};
