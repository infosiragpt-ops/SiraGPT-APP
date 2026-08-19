/**
 * Generic LLM provider reachability probe + named factories.
 *
 * Each probe issues an unauthenticated HEAD/GET against the provider's
 * base URL with a short timeout. We do NOT send API keys — we only
 * check that the upstream host is reachable and responding. Any HTTP
 * status (including 4xx) counts as `pass` because reachability is
 * what we want to detect, not auth.
 *
 * Why this lives next to provider-openai.js instead of replacing it:
 * the OpenAI probe predates this generic factory and keeping it
 * separate avoids breaking imports that already use it. New providers
 * go through `createLlmProviderProbe`.
 */

'use strict';

const { Probe, CATEGORY } = require('../probe');

function createLlmProviderProbe({
  name,
  baseUrl,
  apiKeyEnv = null,
  category = CATEGORY.DEGRADED,
  timeoutMs = 1500,
  ttlMs = 15_000,
  method = 'HEAD',
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  if (!name || typeof name !== 'string') {
    throw new TypeError('createLlmProviderProbe: "name" is required');
  }
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new TypeError(`createLlmProviderProbe[${name}]: "baseUrl" is required`);
  }

  return new Probe({
    name,
    category,
    timeoutMs,
    ttlMs,
    check: async ({ timeoutMs: tm }) => {
      const ac = new AbortController();
      const inner = setTimeout(() => ac.abort(), Math.max(50, tm - 50));
      if (typeof inner.unref === 'function') inner.unref();
      try {
        const t0 = Date.now();
        const res = await fetchImpl(baseUrl, { method, signal: ac.signal });
        const elapsedMs = Date.now() - t0;
        const code = res.status | 0;
        const reachable = code > 0 && code < 600;
        return {
          status: reachable ? 'pass' : 'fail',
          details: {
            provider: name,
            baseUrl,
            httpStatus: code,
            driverElapsedMs: elapsedMs,
            method,
            gatedBy: apiKeyEnv || null,
          },
        };
      } finally {
        clearTimeout(inner);
      }
    },
  });
}

const PROVIDERS = [
  { name: 'provider-anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  { name: 'provider-google',    baseUrl: 'https://generativelanguage.googleapis.com', apiKeyEnv: 'GOOGLE_AI_API_KEY' },
  { name: 'provider-mistral',   baseUrl: 'https://api.mistral.ai/v1', apiKeyEnv: 'MISTRAL_API_KEY' },
  { name: 'provider-groq',      baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY' },
  { name: 'provider-deepseek',  baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  { name: 'provider-openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
];

function createConfiguredLlmProbes(opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl;
  const probes = [];
  for (const cfg of PROVIDERS) {
    const keyPresent = !!(env[cfg.apiKeyEnv] && String(env[cfg.apiKeyEnv]).trim());
    if (!keyPresent && !opts.includeUnconfigured) continue;
    probes.push(createLlmProviderProbe({
      name: cfg.name,
      baseUrl: cfg.baseUrl,
      apiKeyEnv: cfg.apiKeyEnv,
      ...(fetchImpl ? { fetchImpl } : {}),
    }));
  }
  return probes;
}

module.exports = {
  createLlmProviderProbe,
  createConfiguredLlmProbes,
  PROVIDERS,
};
