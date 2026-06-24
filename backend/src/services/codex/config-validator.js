'use strict';

/**
 * codex/config-validator — boot-time coherence checks for the Codex Agent V2
 * envs (feature 15 hardening, spec §13). When the flag is on, surfaces clear
 * warnings for incoherent/missing config (no REDIS_URL → no worker/streaming;
 * no CODE_RUNNER_URL default; no LLM key → degraded). Never throws; returns a
 * structured report the boot sequence logs. Style mirrors
 * attribution-config-validator.
 */

const { isCodexV2Enabled } = require('./flags');

function parseIntOr(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @returns {{ enabled:boolean, ok:boolean, warnings:string[], errors:string[], info:string[] }}
 */
function validateCodexConfig(env = process.env) {
  const enabled = isCodexV2Enabled(env);
  const warnings = [];
  const errors = [];
  const info = [];

  if (!enabled) {
    info.push('CODEX_AGENT_V2 is off — the codex subsystem is fully inert.');
    return { enabled, ok: true, warnings, errors, info };
  }

  // Redis is required for the run queue + live SSE pub/sub.
  if (!env.REDIS_URL) {
    warnings.push('CODEX_AGENT_V2 is on but REDIS_URL is not set — the run worker will not start and live streaming falls back to replay-only.');
  }

  // The runner URL has a default; warn only if it points somewhere odd.
  const runnerUrl = env.CODE_RUNNER_URL || 'http://runner:4097';
  try {
    // eslint-disable-next-line no-new
    new URL(runnerUrl);
  } catch {
    errors.push(`CODE_RUNNER_URL is not a valid URL: "${runnerUrl}".`);
  }
  if (!env.CODE_RUNNER_URL) info.push('CODE_RUNNER_URL unset — using the default http://runner:4097.');

  // An LLM provider is needed to actually run agent loops.
  if (!env.CEREBRAS_API_KEY && !env.OPENROUTER_API_KEY) {
    warnings.push('No CEREBRAS_API_KEY or OPENROUTER_API_KEY — agent runs will fail at the LLM step (plan/build cannot proceed).');
  }

  // Numeric envs must be sane when provided.
  const concurrency = parseIntOr(env.CODEX_WORKER_CONCURRENCY, 2);
  if (concurrency < 1) warnings.push(`CODEX_WORKER_CONCURRENCY=${env.CODEX_WORKER_CONCURRENCY} is < 1 — clamped to 1 at runtime.`);

  const timeoutMs = parseIntOr(env.CODEX_RUN_TIMEOUT_MS, 15 * 60_000);
  if (timeoutMs < 60_000) warnings.push(`CODEX_RUN_TIMEOUT_MS=${env.CODEX_RUN_TIMEOUT_MS} is under 60s — runs may time out prematurely.`);

  const maxSteps = parseIntOr(env.CODEX_MAX_STEPS, 24);
  if (maxSteps < 1) warnings.push(`CODEX_MAX_STEPS=${env.CODEX_MAX_STEPS} is < 1 — build runs will do nothing.`);

  const promo = env.CODEX_COST_PROMO_MULTIPLIER;
  if (promo !== undefined && (Number.isNaN(Number(promo)) || Number(promo) < 0 || Number(promo) > 1)) {
    warnings.push(`CODEX_COST_PROMO_MULTIPLIER=${promo} is outside [0,1] — ignored (treated as 1).`);
  }

  return { enabled, ok: errors.length === 0, warnings, errors, info };
}

/** Boot helper: run the check and log it. Never throws. */
function logCodexConfig(env = process.env, logger = console) {
  try {
    const r = validateCodexConfig(env);
    if (!r.enabled) return r;
    for (const e of r.errors) logger.error?.(`[codex-config] ${e}`);
    for (const w of r.warnings) logger.warn?.(`[codex-config] ${w}`);
    if (r.ok && r.warnings.length === 0) logger.info?.('[codex-config] CODEX_AGENT_V2 on — config OK.');
    return r;
  } catch (err) {
    logger.warn?.(`[codex-config] validation failed: ${err?.message || err}`);
    return { enabled: false, ok: true, warnings: [], errors: [], info: [] };
  }
}

module.exports = { validateCodexConfig, logCodexConfig };
