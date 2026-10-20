'use strict';

/**
 * isolated-code-runner — run model-authored code inside the hardened
 * document sandbox container instead of the API process's own host.
 *
 * python_exec / bash_exec / create_document execute code an LLM wrote, and an
 * LLM can be steered by an uploaded document or a web page (prompt
 * injection). On the host (agents/code-sandbox.js) that code shares the API
 * container's network, filesystem and same-uid /proc (the parent process
 * environment holds the provider keys and the database URL) — the env
 * scrubbing there is not a boundary. The host interpreter also lacks the
 * libraries the tool descriptions promise.
 *
 * Here every run gets a fresh container from doc-agent/sandbox.js — the same
 * sandbox the document agent uses, built from services/sandbox/runner with
 * the full catalog in agent-runner/sandbox-capabilities.json — and the
 * container is destroyed when the run ends. Isolation always includes a
 * separate container with --network none, non-root, no-new-privileges and
 * cpu/memory/pids limits; the docker driver adds gVisor (runsc), a read-only
 * rootfs and cap-drop ALL. Production currently uses the remote driver (the
 * sandbox microservice, services/sandbox/lib/docker-sandbox.js), which does
 * not add those three; `isolation` reports the driver and gvisor flag.
 * With a `persistKey` (the chat id) the run mounts that
 * conversation's workspace volume — the one the document agent already uses
 * — so the font/matplotlib caches the image seeds into it stay warm and
 * files written outside the run directory survive between calls of the same
 * chat; the run directory itself is removed after every run.
 *
 * Mode (SIRAGPT_CODE_SANDBOX):
 *   auto (default) → isolated in production, host elsewhere (dev/CI keep the
 *                    zero-Docker workflow)
 *   isolated       → always the container
 *   host           → always the host runner (explicit operator opt-out)
 * In isolated mode an unavailable sandbox fails CLOSED with an honest
 * message; it never silently degrades to the host.
 *
 * Result shape matches code-sandbox.run() so callers can swap transparently,
 * plus `isolation` (driver/runtime/gvisor) and `collected` (files read back
 * from the run directory, e.g. create_document's OUT_PATH).
 */

const crypto = require('crypto');
const path = require('path');
const { Semaphore } = require('../../utils/async-semaphore');

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024;
const MAX_INPUT_FILES = 16;
const MAX_COLLECT_FILES = 8;
// Grace for container start + teardown on top of the script's own budget.
const EXEC_GRACE_MS = 15_000;

const LANGUAGES = Object.freeze({
  python: { interpreter: 'python3', filename: 'main.py' },
  javascript: { interpreter: 'node', filename: 'main.js' },
  node: { interpreter: 'node', filename: 'main.js' },
});

const UNAVAILABLE_MESSAGE = 'El entorno aislado de ejecución de código no está disponible en este momento. '
  + 'No se ejecutó el código fuera del aislamiento; inténtalo de nuevo en unos minutos.';

function resolveCodeExecutionMode(env = process.env) {
  const raw = String(env.SIRAGPT_CODE_SANDBOX || 'auto').trim().toLowerCase();
  if (raw === 'isolated' || raw === 'container') return 'isolated';
  if (raw === 'host') return 'host';
  return String(env.NODE_ENV || '').trim().toLowerCase() === 'production' ? 'isolated' : 'host';
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

let sharedSemaphore = null;
let sharedSemaphoreSize = 0;
function semaphoreFor(env) {
  const max = Math.min(32, positiveInt(env.SIRAGPT_CODE_SANDBOX_MAX_CONCURRENT, 4));
  if (!sharedSemaphore || sharedSemaphoreSize !== max) {
    sharedSemaphore = new Semaphore(max);
    sharedSemaphoreSize = max;
  }
  return sharedSemaphore;
}

/** POSIX single-quote so a crafted path can never break out of `bash -c`. */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Relative path inside the run directory: no absolute paths, no traversal,
 * no NULs. Returns null when the name cannot be made safe.
 */
function safeRunRel(name) {
  const raw = String(name == null ? '' : name);
  if (!raw || raw.includes('\0') || path.posix.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) return null;
  const normalized = path.posix.normalize(raw.replace(/\\/g, '/'));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') return null;
  return normalized;
}

function truncateText(value, maxBytes) {
  const text = String(value || '');
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, truncated: false };
  return {
    text: `${buffer.subarray(0, maxBytes).toString('utf8')}\n…[output truncated at ${maxBytes} bytes]`,
    truncated: true,
  };
}

function failure(language, stderr, extra = {}) {
  return {
    ok: false,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr,
    durationMs: 0,
    timedOut: false,
    aborted: false,
    truncated: false,
    language,
    isolation: null,
    collected: {},
    ...extra,
  };
}

/**
 * Run one script in a fresh sandbox container.
 *
 * @param {object} opts
 * @param {'python'|'javascript'|'node'} opts.language
 * @param {string} opts.source
 * @param {string} [opts.stdin]
 * @param {number} [opts.timeoutMs]          script budget (default 10 s, max 120 s)
 * @param {AbortSignal} [opts.signal]
 * @param {Array<{ rel: string, buffer: Buffer }>} [opts.inputs]  files placed in the run dir
 * @param {string[]} [opts.collect]          run-dir relative files read back after the run
 * @param {string|null} [opts.persistKey]   conversation workspace volume (chat id); null = ephemeral tmpfs
 * @param {object} [opts.env]
 * @param {object} [opts.deps]               { createSandbox } for tests
 * @returns {Promise<object>} code-sandbox.run() shape + isolation + collected + runDir
 */
async function runIsolated(opts = {}) {
  const {
    language,
    source,
    stdin = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    inputs = [],
    collect = [],
    persistKey = null,
    env = process.env,
    deps = {},
  } = (opts && typeof opts === 'object') ? opts : {};
  const lang = String(language || '').toLowerCase();
  const cfg = LANGUAGES[lang];
  if (!cfg) return failure(String(language || ''), `unsupported language: ${language}`);
  if (typeof source !== 'string' || !source.trim()) return failure(lang, 'empty source');
  const maxSource = positiveInt(env.SANDBOX_MAX_SOURCE_BYTES, DEFAULT_MAX_SOURCE_BYTES);
  if (Buffer.byteLength(source, 'utf8') > maxSource) {
    return failure(lang, `source too large (max ${Math.round(maxSource / 1024)} KB)`);
  }
  if (signal?.aborted) return failure(lang, 'aborted', { aborted: true, signal: 'SIGABRT' });

  const budgetMs = Math.min(MAX_TIMEOUT_MS, positiveInt(timeoutMs, DEFAULT_TIMEOUT_MS));
  const maxOutputBytes = positiveInt(env.SIRAGPT_CODE_SANDBOX_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES);

  const placedInputs = [];
  for (const item of (Array.isArray(inputs) ? inputs : []).slice(0, MAX_INPUT_FILES)) {
    const rel = safeRunRel(item?.rel);
    if (!rel || !Buffer.isBuffer(item?.buffer)) continue;
    placedInputs.push({ rel, buffer: item.buffer });
  }
  const collectRels = [];
  for (const name of (Array.isArray(collect) ? collect : []).slice(0, MAX_COLLECT_FILES)) {
    const rel = safeRunRel(name);
    if (rel) collectRels.push(rel);
  }

  const createSandbox = deps.createSandbox || require('../doc-agent/sandbox').createSandbox;
  const semaphore = deps.semaphore || semaphoreFor(env);
  const abortSignal = signal && typeof signal.addEventListener === 'function' ? signal : undefined;

  let release = null;
  try {
    release = await semaphore.acquire(abortSignal ? { signal: abortSignal } : undefined);
  } catch {
    return failure(lang, 'aborted', { aborted: true, signal: 'SIGABRT' });
  }

  let sandbox = null;
  const started = Date.now();
  try {
    try {
      sandbox = await createSandbox({
        driver: env.SIRAGPT_CODE_SANDBOX_DRIVER || undefined,
        signal,
        env,
        persistKey: persistKey ? String(persistKey) : null,
      });
    } catch (err) {
      if (signal?.aborted) return failure(lang, 'aborted', { aborted: true, signal: 'SIGABRT' });
      const reason = String(err?.message || err || '').slice(0, 300);
      return failure(lang, UNAVAILABLE_MESSAGE, { unavailable: true, unavailableReason: reason });
    }
    const isolation = {
      driver: sandbox.driver || null,
      runtime: sandbox.runtime || null,
      gvisor: Boolean(sandbox.gvisor),
      persistent: Boolean(sandbox.persistent),
    };

    const runRel = `tmp/run-${crypto.randomBytes(6).toString('hex')}`;
    const runDir = `/workspace/${runRel}`;
    await sandbox.putFile(`${runRel}/${cfg.filename}`, Buffer.from(source, 'utf8'));
    await sandbox.putFile(`${runRel}/.stdin`, Buffer.from(String(stdin || ''), 'utf8'));
    for (const input of placedInputs) {
      await sandbox.putFile(`${runRel}/${input.rel}`, input.buffer);
    }

    // `timeout` (coreutils, always in the sandbox image) enforces the script
    // budget INSIDE the container (exit 124 on expiry, KILL 2 s later if TERM
    // is ignored); the exec timeout is only the outer guard and destroy()
    // reaps anything left. The `command -v` fallback keeps the local dev
    // driver usable on hosts without coreutils `timeout` (macOS).
    const seconds = Math.max(1, Math.ceil(budgetMs / 1000));
    const invocation = `${cfg.interpreter} ${cfg.filename} < .stdin`;
    const command = `cd ${shQuote(runDir)} && if command -v timeout >/dev/null 2>&1; `
      + `then timeout -k 2 ${seconds} ${invocation}; else ${invocation}; fi`;
    const result = await sandbox.exec(command, { timeoutMs: budgetMs + EXEC_GRACE_MS, signal });
    const durationMs = Date.now() - started;
    const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : null;
    const aborted = Boolean(result?.aborted || signal?.aborted);
    const timedOut = !aborted && (Boolean(result?.timedOut) || exitCode === 124
      || (exitCode === 137 && durationMs >= budgetMs));

    const collected = {};
    if (!aborted) {
      for (const rel of collectRels) {
        try {
          collected[rel] = await sandbox.readFile(`${runRel}/${rel}`);
        } catch {
          collected[rel] = null;
        }
      }
    }
    if (isolation.persistent) {
      // The conversation volume outlives this container: drop the run dir
      // (script, stdin, input copies, collected outputs) so it never piles up.
      try {
        await sandbox.exec(`rm -rf -- ${shQuote(runDir)}`, { timeoutMs: 15_000 });
      } catch { /* best effort */ }
    }

    const out = truncateText(result?.stdout, maxOutputBytes);
    const err = truncateText(result?.stderr, maxOutputBytes);
    let stderr = err.text;
    if (timedOut && !stderr) stderr = `timeout after ${seconds}s`;
    if (aborted && !stderr) stderr = 'aborted';
    return {
      ok: !aborted && !timedOut && exitCode === 0,
      exitCode,
      signal: aborted ? 'SIGABRT' : null,
      stdout: out.text,
      stderr,
      durationMs,
      timedOut,
      aborted,
      truncated: out.truncated || err.truncated,
      language: lang,
      isolation,
      collected,
      runDir,
    };
  } catch (err) {
    if (signal?.aborted) return failure(lang, 'aborted', { aborted: true, signal: 'SIGABRT' });
    return failure(lang, `sandbox internal error: ${String(err?.message || err).slice(0, 300)}`);
  } finally {
    if (sandbox && typeof sandbox.destroy === 'function') {
      try { await sandbox.destroy(); } catch { /* best effort: docker rm -f */ }
    }
    if (release) release();
  }
}

module.exports = {
  runIsolated,
  resolveCodeExecutionMode,
  safeRunRel,
  UNAVAILABLE_MESSAGE,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
};
