'use strict';

function createHeliconeProxy({ env = process.env } = {}) {
  const apiKey = env.HELICONE_API_KEY;
  const configured = Boolean(apiKey);
  const baseUrl = env.HELICONE_BASE_URL || 'https://oai.helicone.ai';

  function wrapHeaders(headers = {}) {
    if (!configured) return headers;
    return { ...headers, 'Helicone-Auth': `Bearer ${apiKey}`, 'Helicone-Property-App': 'siragpt' };
  }

  function wrapBaseUrl(provider, original) {
    if (!configured) return original;
    if (provider === 'openai') return `${baseUrl}/v1`;
    return original;
  }

  return { enabled: configured, apiKey: configured ? `${apiKey.slice(0, 8)}...` : null, wrapHeaders, wrapBaseUrl };
}

module.exports = { createHeliconeProxy };
