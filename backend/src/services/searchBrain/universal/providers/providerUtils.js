const crypto = require("crypto");
const { XMLParser } = require("fast-xml-parser");
const Parser = require("rss-parser");
const Bottleneck = require("bottleneck");
const CircuitBreaker = require("opossum");
const UserAgent = require("user-agents");

const rssParser = new Parser({
  headers: { "User-Agent": "siraGPT-search-brain/1.0" },
});

const breakers = new Map();
const limiters = new Map();

function hashId(prefix, value) {
  return `${prefix}:${crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 16)}`;
}

function cleanText(value, max = 600) {
  if (value === null || value === undefined) return "";
  const text = String(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function pickFirst(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) return value[0];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function userAgent() {
  try {
    return new UserAgent({ deviceCategory: "desktop" }).toString();
  } catch {
    return "siraGPT-search-brain/1.0";
  }
}

function limiterFor(id, minTime = 350) {
  if (!limiters.has(id)) {
    limiters.set(id, new Bottleneck({ minTime, maxConcurrent: 2 }));
  }
  return limiters.get(id);
}

function breakerFor(id, action) {
  if (!breakers.has(id)) {
    breakers.set(id, new CircuitBreaker(action, {
      timeout: 12000,
      errorThresholdPercentage: 65,
      resetTimeout: 30000,
    }));
  }
  return breakers.get(id);
}

async function fetchWithTimeout(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || 9000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      Accept: opts.accept || "application/json,text/html;q=0.9,*/*;q=0.8",
      "User-Agent": opts.userAgent || userAgent(),
      ...(opts.headers || {}),
    };
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, opts = {}) {
  const res = await fetchWithTimeout(url, { ...opts, accept: "application/json" });
  return res.json();
}

async function fetchText(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  return res.text();
}

async function guardedSearch(providerId, fn, opts = {}) {
  const limiter = limiterFor(providerId, opts.minTime || 350);
  const breaker = breakerFor(providerId, fn);
  try {
    return await limiter.schedule(() => breaker.fire());
  } catch (err) {
    if (process.env.SEARCH_BRAIN_DEBUG === "1") {
      console.warn(`[search-brain:${providerId}]`, err && err.message ? err.message : err);
    }
    return [];
  }
}

function parseXml(xml) {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    textNodeName: "text",
    trimValues: true,
  }).parse(xml);
}

async function parseRss(url, opts = {}) {
  const text = await fetchText(url, opts);
  return rssParser.parseString(text);
}

function disabledProvider(meta, note) {
  return {
    ...meta,
    enabledByDefault: false,
    async search() {
      return [];
    },
    async fetchDetail() {
      return null;
    },
    metadata: {
      ...(meta.metadata || {}),
      disabledReason: note || "Provider opt-in or key-gated; disabled by default.",
    },
  };
}

module.exports = {
  asArray,
  cleanText,
  disabledProvider,
  fetchJson,
  fetchText,
  guardedSearch,
  hashId,
  parseRss,
  parseXml,
  pickFirst,
};
