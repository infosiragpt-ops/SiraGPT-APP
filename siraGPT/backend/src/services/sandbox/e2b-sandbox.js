'use strict';

/**
 * e2b-sandbox — thin wrapper around `@e2b/code-interpreter` that
 * gives the platform a code-execution surface (Cursor / ChatGPT
 * "code interpreter" tier feature). Disabled by default; the wrapper
 * activates only when E2B_API_KEY is present.
 *
 * Why the wrapper exists:
 *   The raw E2B SDK ships its own auth + lifecycle. Calling it
 *   directly from a route handler couples that handler to the
 *   third-party API, making it hard to:
 *     1. Operate when E2B is not configured (tests, fresh checkouts,
 *        deploys that haven't enabled it). The wrapper degrades to
 *        `{ ok: false, code: 'sandbox_disabled' }` so callers
 *        don't need `if (process.env.E2B_API_KEY)` boilerplate.
 *     2. Bound the surface area (timeout, language allowlist) at
 *        one place rather than per-call.
 *     3. Translate provider errors into the platform's MCP error
 *        shape if/when the wrapper gets exposed as an MCP tool.
 *
 * No route is wired to this wrapper in this commit — it ships as a
 * scaffold that can be wired into the agent surface in a follow-up
 * once the operator has decided E2B Cloud vs self-hosted Firecracker
 * (the SDK speaks both via the apiKey + domain config).
 *
 * Public API:
 *   - resolveE2BConfig(env)       env-vars → config (pure)
 *   - getSandboxStatus()          observe whether the wrapper is active
 *   - createSandbox()             returns a Sandbox handle or null
 *   - executeCode({ code, language?, timeoutMs?, sandbox? }) →
 *       { ok: true, stdout, stderr, exitCode, durationMs }
 *     | { ok: false, code, message }
 *   - shutdownSandbox(sandbox)    awaitable cleanup
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const HARD_MAX_TIMEOUT_MS = 5 * 60_000;
const ALLOWED_LANGUAGES = new Set(['python', 'javascript', 'typescript', 'bash', 'r']);

let runtimeStatus = {
  enabled: false,
  configured: false,
  reason: 'not_configured',
};

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function resolveE2BConfig(env = process.env) {
  const apiKey = String(env.E2B_API_KEY || '').trim();
  const domain = String(env.E2B_DOMAIN || '').trim();
  const configured = Boolean(apiKey);
  const explicit = env.E2B_ENABLED;
  const enabled = explicit === undefined || explicit === ''
    ? configured
    : parseBoolean(explicit, configured);
  return {
    configured,
    enabled: enabled && configured,
    apiKey,
    // E2B Cloud (default) or self-hosted Firecracker via E2B_DOMAIN.
    domain: domain || undefined,
    defaultTimeoutMs: clampInt(env.E2B_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, HARD_MAX_TIMEOUT_MS),
  };
}

function getSandboxStatus() {
  return { ...runtimeStatus };
}

/**
 * createSandbox — async factory. Returns the SDK Sandbox handle on
 * success, or `null` when the wrapper is disabled. Callers should
 * either call this directly (long-lived sandboxes for an agent
 * session) or pass a `sandbox` option to executeCode (one-shot).
 */
async function createSandbox(env = process.env, options = {}) {
  const config = resolveE2BConfig(env);
  if (!config.enabled) {
    runtimeStatus = { configured: config.configured, enabled: false, reason: config.configured ? 'disabled_by_env' : 'not_configured' };
    return null;
  }
  let SandboxCtor;
  try {
    ({ Sandbox: SandboxCtor } = require('@e2b/code-interpreter'));
  } catch (err) {
    runtimeStatus = { configured: true, enabled: false, reason: `sdk_load_failed: ${err && err.message}` };
    return null;
  }
  try {
    const sandbox = await SandboxCtor.create({
      apiKey: config.apiKey,
      domain: config.domain,
      timeoutMs: clampInt(options.timeoutMs, config.defaultTimeoutMs, 1000, HARD_MAX_TIMEOUT_MS),
    });
    runtimeStatus = { configured: true, enabled: true, reason: 'running' };
    return sandbox;
  } catch (err) {
    runtimeStatus = { configured: true, enabled: false, reason: `create_failed: ${err && err.message}` };
    return null;
  }
}

async function shutdownSandbox(sandbox) {
  if (!sandbox) return;
  try {
    if (typeof sandbox.kill === 'function') {
      await sandbox.kill();
    }
  } catch (_err) {
    // best-effort
  }
}

/**
 * executeCode — one-shot or sandbox-attached code execution.
 *
 * Returns a discriminated union so the caller does not need to
 * `try/catch` for control flow. SDK exceptions are translated to
 * `{ ok: false, code: '...' }` codes that mirror the WebFetchError
 * style used elsewhere in the platform.
 */
async function executeCode(args = {}, env = process.env, options = {}) {
  const language = String(args.language || 'python').trim().toLowerCase();
  if (!ALLOWED_LANGUAGES.has(language)) {
    return {
      ok: false,
      code: 'sandbox_language_not_allowed',
      message: `language "${language}" is not allowed; supported: ${Array.from(ALLOWED_LANGUAGES).join(', ')}`,
    };
  }
  const code = String(args.code || '');
  if (!code.trim()) {
    return { ok: false, code: 'sandbox_empty_code', message: 'code argument is required' };
  }

  const config = resolveE2BConfig(env);
  if (!config.enabled) {
    return {
      ok: false,
      code: 'sandbox_disabled',
      message: 'code-interpreter sandbox is disabled on this deployment',
    };
  }

  const timeoutMs = clampInt(args.timeoutMs, config.defaultTimeoutMs, 1000, HARD_MAX_TIMEOUT_MS);
  // Allow tests to inject a fake sandbox; production passes nothing
  // and the wrapper creates one per-call.
  let sandbox = options.sandbox;
  let createdHere = false;
  if (!sandbox) {
    sandbox = await createSandbox(env, { timeoutMs });
    createdHere = true;
    if (!sandbox) {
      return {
        ok: false,
        code: 'sandbox_create_failed',
        message: 'failed to create sandbox; see /health for E2B status',
        details: getSandboxStatus(),
      };
    }
  }

  const startedAt = Date.now();
  try {
    const execution = await sandbox.runCode(code, { language, timeoutMs });
    const stdout = (execution && execution.logs && Array.isArray(execution.logs.stdout))
      ? execution.logs.stdout.join('')
      : '';
    const stderr = (execution && execution.logs && Array.isArray(execution.logs.stderr))
      ? execution.logs.stderr.join('')
      : '';
    return {
      ok: true,
      stdout,
      stderr,
      exitCode: execution && typeof execution.exitCode === 'number' ? execution.exitCode : 0,
      durationMs: Date.now() - startedAt,
      error: execution && execution.error ? {
        name: execution.error.name,
        value: execution.error.value,
        traceback: Array.isArray(execution.error.traceback)
          ? execution.error.traceback.join('\n').slice(0, 4000)
          : String(execution.error.traceback || '').slice(0, 4000),
      } : null,
    };
  } catch (err) {
    return {
      ok: false,
      code: err && err.name === 'TimeoutError' ? 'sandbox_timeout' : 'sandbox_runtime_error',
      message: err && err.message ? err.message : 'unknown sandbox error',
    };
  } finally {
    if (createdHere) await shutdownSandbox(sandbox);
  }
}

module.exports = {
  resolveE2BConfig,
  getSandboxStatus,
  createSandbox,
  executeCode,
  shutdownSandbox,
  ALLOWED_LANGUAGES,
  DEFAULT_TIMEOUT_MS,
  HARD_MAX_TIMEOUT_MS,
};
