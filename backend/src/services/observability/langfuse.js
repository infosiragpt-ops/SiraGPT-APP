'use strict';

/**
 * langfuse — open-source LLM observability. Captures per-generation
 * traces (latency, model, prompt, completion, token usage, cost) so
 * agent runs can be inspected in a Langfuse dashboard.
 *
 * Why this exists alongside Langsmith:
 *   - Langsmith (already wired via LANGSMITH_TRACING) is the LangChain
 *     team's hosted product. It works well but is closed-source and
 *     SaaS-only — for self-hosted deploys with data-residency
 *     constraints we need an OSS alternative.
 *   - Langfuse is MIT-licensed (client and server). The same trace API
 *     can write to Langfuse Cloud or to a self-hosted Langfuse server,
 *     so customers with stricter data policies can run the dashboard
 *     in their own VPC.
 *   - Both can run simultaneously: a generation can emit to Langsmith
 *     AND Langfuse with no conflict, so this is purely additive.
 *
 * Disabled by default. Activates when LANGFUSE_PUBLIC_KEY and
 * LANGFUSE_SECRET_KEY are both set (auto-enables) or when
 * LANGFUSE_ENABLED=true is also requested. When disabled, every helper
 * exported here is a safe no-op so call sites don't need to branch.
 *
 * Mirrors the shape of `sentry.js` and `otel.js` in this directory:
 *   - resolveLangfuseConfig(env)
 *   - getLangfuseStatus()
 *   - startLangfuse()        called from index.js boot before route mounting
 *   - getLangfuseClient()    raw Langfuse SDK handle for callers that
 *                            want the full surface (langchain callbacks,
 *                            observeOpenAI wrappers, etc.)
 *   - traceLLMGeneration()   thin convenience for the common case:
 *                            "I called a model, here are inputs / outputs
 *                            / usage / latency, persist it."
 *   - shutdownLangfuse()     awaitable flush, called from the SIGTERM
 *                            shutdown path so in-flight events ship.
 */

let langfuseClient = null;
let runtimeStatus = {
  enabled: false,
  configured: false,
  requested: false,
  started: false,
  reason: 'not_started',
};

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseSampleRate(value, fallback = 1) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

function resolveLangfuseConfig(env = process.env) {
  const publicKey = String(env.LANGFUSE_PUBLIC_KEY || '').trim();
  const secretKey = String(env.LANGFUSE_SECRET_KEY || '').trim();
  const baseUrl = String(env.LANGFUSE_HOST || env.LANGFUSE_BASE_URL || '').trim();
  const configured = Boolean(publicKey && secretKey);
  // Auto-enable when both keys are set; let LANGFUSE_ENABLED=false
  // explicitly opt out for staging deploys that share the secret.
  const explicitToggle = env.LANGFUSE_ENABLED;
  const requested = explicitToggle === undefined || explicitToggle === ''
    ? configured
    : parseBoolean(explicitToggle, configured);
  return {
    configured,
    requested,
    enabled: requested && configured,
    publicKey,
    secretKey,
    baseUrl: baseUrl || 'https://cloud.langfuse.com',
    release: env.LANGFUSE_RELEASE || env.npm_package_version || undefined,
    environment: env.LANGFUSE_ENVIRONMENT || env.NODE_ENV || 'development',
    sampleRate: parseSampleRate(env.LANGFUSE_SAMPLE_RATE, 1),
    flushAt: Number.parseInt(env.LANGFUSE_FLUSH_AT, 10) || 15,
    flushIntervalMs: Number.parseInt(env.LANGFUSE_FLUSH_INTERVAL_MS, 10) || 10_000,
  };
}

function getLangfuseStatus() {
  return { ...runtimeStatus };
}

function getLangfuseClient() {
  return langfuseClient;
}

function startLangfuse(env = process.env) {
  if (runtimeStatus.started) return runtimeStatus;
  const config = resolveLangfuseConfig(env);
  runtimeStatus = {
    ...runtimeStatus,
    configured: config.configured,
    requested: config.requested,
    enabled: config.enabled,
    started: true,
  };
  if (!config.enabled) {
    runtimeStatus.reason = config.configured
      ? 'disabled_by_env'
      : 'missing_keys';
    return runtimeStatus;
  }
  try {
    // Lazy require — package is optional in dev (the file may exist
    // before `npm install` runs against the new dep on a teammate's
    // machine). The require is intentionally inside the start() flow
    // so module load doesn't fail at boot.
    const { Langfuse } = require('langfuse');
    langfuseClient = new Langfuse({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
      release: config.release,
      environment: config.environment,
      sampleRate: config.sampleRate,
      flushAt: config.flushAt,
      flushInterval: config.flushIntervalMs,
    });
    runtimeStatus.reason = 'running';
  } catch (err) {
    runtimeStatus.enabled = false;
    runtimeStatus.reason = `init_failed: ${err && err.message ? err.message : 'unknown'}`;
  }
  return runtimeStatus;
}

/**
 * traceLLMGeneration — record one LLM call.
 *
 * No-op when Langfuse is not enabled, so callers can drop this in
 * unconditionally without `if (langfuseEnabled) { … }` boilerplate.
 *
 * @param {Object} params
 * @param {string} params.name      Human-friendly label, e.g. "chat-turn".
 * @param {string} params.model     Provider/model id, e.g. "gpt-4-turbo".
 * @param {unknown} params.input    Whatever the model received (string or messages).
 * @param {unknown} params.output   Whatever the model returned.
 * @param {Object} [params.usage]   { promptTokens, completionTokens, totalTokens }.
 * @param {string} [params.userId]  External user id for grouping in the dashboard.
 * @param {string} [params.sessionId] Conversation / chat thread id.
 * @param {Object} [params.metadata] Any additional context (route, intent, latency).
 * @returns {boolean} `true` when an event was queued.
 */
function traceLLMGeneration(params) {
  if (!langfuseClient) return false;
  try {
    const trace = langfuseClient.trace({
      name: params.name || 'llm-generation',
      userId: params.userId,
      sessionId: params.sessionId,
      metadata: params.metadata,
      input: params.input,
      output: params.output,
    });
    const gen = trace.generation({
      name: params.name || 'llm-generation',
      model: params.model,
      input: params.input,
      output: params.output,
      usage: params.usage,
    });
    gen.end();
    return true;
  } catch (_err) {
    // Observability must not break the request path.
    return false;
  }
}

async function shutdownLangfuse() {
  if (!langfuseClient) return;
  try {
    await langfuseClient.flushAsync();
  } catch (_err) {
    // best-effort
  }
  langfuseClient = null;
  runtimeStatus.started = false;
  runtimeStatus.reason = 'shutdown';
}

module.exports = {
  resolveLangfuseConfig,
  getLangfuseStatus,
  getLangfuseClient,
  startLangfuse,
  traceLLMGeneration,
  shutdownLangfuse,
};
