'use strict';

/**
 * Durable policy for /code runs that must continue without an open browser.
 *
 * The marker is control-plane metadata stored with the run prompt so the
 * existing Prisma schema remains compatible. It is stripped before the prompt
 * reaches an agent or a public API response.
 */

const AUTOEXEC_PREFIX = '[SIRAGPT_AUTOEXEC_V1]';
const APPS_MODE_MARKER = 'MODO APPS TIPO CODEX:';
const INTERACTIVE_TIMEOUT_MS = 15 * 60_000;
const AUTO_TIMEOUT_MS = 60 * 60_000;
const DEEP_TIMEOUT_MS = 4 * 60 * 60_000;
const INTERACTIVE_MAX_STEPS = 24;
const AUTO_MAX_STEPS = 48;
const DEEP_MAX_STEPS = 120;

// Simple product asks ("haz un CRM", "software como ChatGPT") must escalate to
// multi-hour deep budgets so APPS can compile every layer without stopping early.
const EXPLICIT_DEEP_RE =
  /\b(?:horas?|hours?|long.?running|sin\s+(?:parar|detenerse)|trabaja\s+(?:solo|aut[oó]nomamente)|agentes?\s+aut[oó]nomos?|openclaw|full.?stack|backend|base\s+de\s+datos|database|api|autenticaci[oó]n|pagos?|deploy|desplieg|producci[oó]n|crm|erp|saas|pos|inventario|facturaci[oó]n|n[oó]mina|rrhh|software|plataforma|chat\s*gpt|chatgpt|claude\s*code|como\s+claude|como\s+chatgpt|multi.?capa|todas\s+las\s+capas|compila(?:r)?\s+todas)\b/i;

function isAppsModePrompt(value) {
  return normalizePrompt(value).includes(APPS_MODE_MARKER);
}

function normalizePrompt(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function isAutoExecutePrompt(value) {
  return normalizePrompt(value).startsWith(AUTOEXEC_PREFIX);
}

function stripAutoExecutePrompt(value) {
  const prompt = normalizePrompt(value);
  if (!prompt.startsWith(AUTOEXEC_PREFIX)) return prompt;
  return prompt.slice(AUTOEXEC_PREFIX.length).replace(/^\s*\n?/, '').trim();
}

function withAutoExecutePrompt(value) {
  const prompt = normalizePrompt(value);
  if (!prompt || isAutoExecutePrompt(prompt)) return prompt;
  return `${AUTOEXEC_PREFIX}\n${prompt}`;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isDeepAutonomousRun({ prompt = '', profile = null } = {}) {
  const signals = profile?.signals || {};
  const clean = stripAutoExecutePrompt(prompt);
  return Boolean(
    isAppsModePrompt(clean)
    || signals.externalRepoAdaptation
    || signals.wantsAutonomousAgent
    || signals.massiveSourceFusion
    || signals.nativeRewriteRequired
    || EXPLICIT_DEEP_RE.test(clean),
  );
}

function deriveAutonomousRunPolicy({ run = {}, profile = null, env = process.env } = {}) {
  const autoExecute = isAutoExecutePrompt(run.prompt);
  const deep = autoExecute && isDeepAutonomousRun({ prompt: run.prompt, profile });
  const defaultTimeoutMs = deep
    ? DEEP_TIMEOUT_MS
    : autoExecute
      ? AUTO_TIMEOUT_MS
      : INTERACTIVE_TIMEOUT_MS;
  const defaultMaxSteps = deep
    ? DEEP_MAX_STEPS
    : autoExecute
      ? AUTO_MAX_STEPS
      : INTERACTIVE_MAX_STEPS;

  return {
    autoExecute,
    depth: deep ? 'deep' : autoExecute ? 'standard' : 'interactive',
    timeoutMs: deep
      ? positiveInt(env.CODEX_DEEP_RUN_TIMEOUT_MS, positiveInt(env.CODEX_AUTONOMOUS_RUN_TIMEOUT_MS, defaultTimeoutMs))
      : autoExecute
        ? positiveInt(env.CODEX_AUTONOMOUS_RUN_TIMEOUT_MS, defaultTimeoutMs)
        : positiveInt(env.CODEX_RUN_TIMEOUT_MS, defaultTimeoutMs),
    maxSteps: deep
      ? positiveInt(env.CODEX_DEEP_MAX_STEPS, positiveInt(env.CODEX_AUTONOMOUS_MAX_STEPS, defaultMaxSteps))
      : autoExecute
        ? positiveInt(env.CODEX_AUTONOMOUS_MAX_STEPS, defaultMaxSteps)
        : positiveInt(env.CODEX_MAX_STEPS, defaultMaxSteps),
    maxPlanExtensions: positiveInt(env.CODEX_PLAN_EXTENSIONS, deep ? 4 : autoExecute ? 2 : 2),
    maxVerifyRounds: positiveInt(env.CODEX_MAX_VERIFY_ROUNDS, deep ? 4 : autoExecute ? 3 : 2),
    verifyDevServer: autoExecute || String(env.CODEX_VERIFY_DEV_SERVER || '') === '1',
  };
}

function buildAutonomousRunEnv(env = process.env, policy = {}) {
  if (!policy.autoExecute) return env;

  const next = {
    ...env,
    CODEX_RUN_TIMEOUT_MS: String(policy.timeoutMs || INTERACTIVE_TIMEOUT_MS),
    CODEX_MAX_STEPS: String(policy.maxSteps || INTERACTIVE_MAX_STEPS),
    CODEX_MAX_STEPS_LARGE: String(policy.maxSteps || INTERACTIVE_MAX_STEPS),
    CODEX_PLAN_EXTENSIONS: String(policy.maxPlanExtensions ?? 2),
    CODEX_MAX_VERIFY_ROUNDS: String(policy.maxVerifyRounds ?? 2),
  };
  if (policy.verifyDevServer) {
    next.CODEX_VERIFY_DEV_SERVER = '1';
    next.CODEX_VERIFY_BROWSER = '1';
  }
  return Object.freeze(next);
}

module.exports = {
  AUTOEXEC_PREFIX,
  APPS_MODE_MARKER,
  INTERACTIVE_TIMEOUT_MS,
  AUTO_TIMEOUT_MS,
  DEEP_TIMEOUT_MS,
  INTERACTIVE_MAX_STEPS,
  AUTO_MAX_STEPS,
  DEEP_MAX_STEPS,
  isAutoExecutePrompt,
  isAppsModePrompt,
  stripAutoExecutePrompt,
  withAutoExecutePrompt,
  isDeepAutonomousRun,
  deriveAutonomousRunPolicy,
  buildAutonomousRunEnv,
};
