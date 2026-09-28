'use strict';

// The selected provider's raw error may contain a key, prompt, tool arguments,
// or response body. Keep only bounded, non-content fields in internal logs.
const ORIGINS = new Set([
  'preflight',
  'upstream',
  'tool_call_truncated',
  'signed_call_dropped',
  'signed_call_changed',
]);
const PROVIDERS = new Set(['DeepSeek', 'Meta', 'Gemini', 'xAI', 'OpenAI', 'OpenRouter', 'Anthropic']);

function providerFailureDiagnostic(error, iteration) {
  const rawStatus = Number(error?.status || error?.statusCode || error?.response?.status);
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
    ? rawStatus : null;
  const origin = ORIGINS.has(error?.failureOrigin) ? error.failureOrigin : 'unknown';
  const transport = error?.failureTransport === 'direct' || error?.failureTransport === 'aggregator'
    ? error.failureTransport : 'unknown';
  const provider = PROVIDERS.has(error?.failureProvider) ? error.failureProvider : 'unknown';
  let category = 'unknown';
  if (origin.startsWith('signed_call_')) category = 'transcript';
  else if (origin === 'tool_call_truncated') category = 'truncated';
  else if (origin === 'preflight') category = 'candidate_unavailable';
  else if (status === 402) category = 'payment_required';
  else if (status === 429) category = 'quota_or_rate_limit';
  else if (status === 401 || status === 403) category = 'access_denied';
  else if (status === 400 || status === 404 || status === 422) category = 'bad_request';
  else if (status !== null && status >= 500) category = 'provider_error';
  const step = Number.isInteger(iteration) && iteration >= 0 && iteration <= 1000
    ? iteration : null;
  return { origin, transport, provider, category, status, iteration: step };
}

function logProviderFailure(error, iteration) {
  try {
    console.warn(JSON.stringify({
      level: 'warn',
      component: 'agent-runner',
      event: 'selected_model_failure',
      ...providerFailureDiagnostic(error, iteration),
    }));
  } catch (_) { /* diagnostics never change the turn result */ }
}

module.exports = { providerFailureDiagnostic, logProviderFailure };
