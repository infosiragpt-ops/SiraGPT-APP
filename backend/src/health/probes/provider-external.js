'use strict';

/**
 * External (non-LLM) provider reachability probes.
 *
 * Reuses the `createLlmProviderProbe` factory — same shape (HEAD/GET
 * against a base URL with short timeout, no auth header sent, any
 * HTTP status counts as reachable). Lives in its own file so the
 * naming reflects the domain split:
 *
 *   - provider-llm    → text/audio model providers (OpenAI, Anthropic, …)
 *   - provider-external → other paid integrations (Stripe billing,
 *                          Fal.ai image/video generation, Tavily/EXA
 *                          web search)
 *
 * All probes are DEGRADED — none of these going down should take the
 * whole app offline (chat keeps working without billing/imagegen/search).
 * Operators who want stricter behaviour can change the category at
 * registration time.
 */

const { createLlmProviderProbe } = require('./provider-llm');

const EXTERNAL_PROVIDERS = [
  { name: 'provider-stripe',     baseUrl: 'https://api.stripe.com/v1',           apiKeyEnv: 'STRIPE_SECRET_KEY' },
  { name: 'provider-fal',        baseUrl: 'https://fal.run/health',              apiKeyEnv: process.env.FAL_KEY ? 'FAL_KEY' : 'FAL_API_KEY' },
  { name: 'provider-tavily',     baseUrl: 'https://api.tavily.com',              apiKeyEnv: 'TAVILY_API_KEY' },
  { name: 'provider-exa',        baseUrl: 'https://api.exa.ai',                  apiKeyEnv: 'EXA_API_KEY' },
  { name: 'provider-firecrawl',  baseUrl: 'https://api.firecrawl.dev',           apiKeyEnv: 'FIRECRAWL_API_KEY' },
  { name: 'provider-elevenlabs', baseUrl: 'https://api.elevenlabs.io/v1',        apiKeyEnv: 'ELEVENLABS_API_KEY' },
];

function createConfiguredExternalProbes(opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl;
  const probes = [];
  for (const cfg of EXTERNAL_PROVIDERS) {
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
  createConfiguredExternalProbes,
  EXTERNAL_PROVIDERS,
};
