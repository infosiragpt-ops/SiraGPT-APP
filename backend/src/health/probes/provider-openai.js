/**
 * OpenAI provider probe — issues a short HEAD/GET against the configured
 * base URL with an aggressive timeout. We do NOT include the API key:
 * we only care that the host is reachable and responds in time. A 4xx
 * (e.g. 401) still signals reachability and is treated as `pass`.
 */

'use strict';

const { Probe, CATEGORY } = require('../probe');

function createOpenAIProbe({
  name = 'provider-openai',
  category = CATEGORY.DEGRADED,
  timeoutMs = 1500,
  ttlMs = 15_000,
  baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  fetchImpl = (...args) => globalThis.fetch(...args),
  method = 'HEAD',
} = {}) {
  return new Probe({
    name,
    category,
    timeoutMs,
    ttlMs,
    check: async ({ timeoutMs: tm }) => {
      const ac = new AbortController();
      // The Probe runner already enforces the outer timeout; we add an
      // inner abort so the underlying fetch does not leak past that
      // window.
      const inner = setTimeout(() => ac.abort(), Math.max(50, tm - 50));
      if (typeof inner.unref === 'function') inner.unref();

      try {
        const t0 = Date.now();
        const res = await fetchImpl(baseUrl, { method, signal: ac.signal });
        const elapsedMs = Date.now() - t0;
        const code = res.status | 0;
        const reachable = code > 0 && code < 600;
        const status = reachable ? 'pass' : 'fail';
        return {
          status,
          details: { baseUrl, httpStatus: code, driverElapsedMs: elapsedMs, method },
        };
      } finally {
        clearTimeout(inner);
      }
    },
  });
}

module.exports = { createOpenAIProbe };
