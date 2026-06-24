'use strict';

/**
 * sandbox/remote-driver — HTTPS client for the remote Docker sandbox service.
 *
 * When SANDBOX_SERVICE_URL + SANDBOX_API_KEY are set, executeCode calls are
 * forwarded to the deployed sandbox microservice (services/sandbox — live at
 * sandbox.chatagic.com) instead of running locally. This gives full Docker
 * isolation (--network none, 1 CPU, 1 GB RAM, 100 PID limit) without
 * requiring Docker inside the app host (Replit).
 *
 * Protocol: the microservice speaks a SESSION lifecycle, not a stateless
 * /exec — POST /v1/sessions → put/exec/read/list → DELETE /v1/sessions/:id.
 * This driver reuses the tested doc-agent client (createRemoteSandbox) and,
 * per call: creates an ephemeral session, syncs args.workdir files UP
 * (recursive, bounded), writes the code as /workspace/__sira_exec.*, runs the
 * right interpreter, syncs changed files back DOWN into the local workdir
 * (confined), and destroys the session in `finally` — so the 15-container
 * pool on the service is never held between tool calls.
 *
 * Error contract (router falls through to other backends ONLY on
 * 'remote_unreachable'):
 *   remote_auth_error    — HTTP 401/403 (bad/rotated SANDBOX_API_KEY); terminal
 *   remote_server_error  — any other non-2xx (404/429/5xx incl. at_capacity);
 *                          terminal — NEVER mapped to a fake success
 *   remote_unreachable   — transport-level only (DNS/refused/abort/timeout,
 *                          i.e. errors WITHOUT an HTTP status)
 *   sandbox_timeout      — command ran but hit its in-sandbox time limit
 *   sandbox_aborted      — opts.signal fired mid-call (terminal: never retried
 *                          on another backend)
 *
 * Public API (unchanged — router.js depends on it):
 *   resolveRemoteConfig(env)          — pure config reader
 *   isRemoteAvailable(env)            — boolean probe
 *   executeRemote(args, env, opts)    — result shape matches local-sandbox
 */

const fs   = require('fs');
const path = require('path');
const { createRemoteSandbox } = require('../doc-agent/remote-sandbox');

const DEFAULT_TIMEOUT_MS = 120_000; // 2 min — mirrors local sandbox hard max
const MAX_SYNC_FILES     = 200;     // upload bound per call
const MAX_SYNC_DEPTH     = 5;       // directory recursion bound
const MAX_SYNC_BYTES     = 45 * 1024 * 1024; // < the service's 64MB JSON cap after base64 inflation
const EXEC_HELPER_PREFIX = '__sira_exec';

const RUNNERS = {
  python: { ext: 'py', cmd: 'python3' },
  bash:   { ext: 'sh', cmd: 'bash' },
  // 'node' intentionally absent: the deployed runner image ships bash+python3
  // (+ LibreOffice) but NO node — emitting `node …` would 127 opaquely.
};

function resolveRemoteConfig(env = process.env) {
  const url    = String(env.SANDBOX_SERVICE_URL || '').trim();
  const apiKey = String(env.SANDBOX_API_KEY     || '').trim();
  const enabled = Boolean(url && apiKey);
  return {
    enabled,
    url,
    apiKey,
    timeoutMs: parseInt(env.SANDBOX_REMOTE_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10),
    remoteOnly: ['1', 'true'].includes(String(env.SANDBOX_REMOTE_ONLY || '').toLowerCase()),
  };
}

function isRemoteAvailable(env = process.env) {
  return resolveRemoteConfig(env).enabled;
}

/** Recursive bounded walk of a local dir → [{ rel, abs, size }]. */
function walkLocalFiles(rootDir, depth = 0, prefix = '', acc = { files: [], skipped: [] }) {
  if (depth > MAX_SYNC_DEPTH) return acc;
  let entries;
  try { entries = fs.readdirSync(path.join(rootDir, prefix), { withFileTypes: true }); } catch (_) { return acc; }
  for (const ent of entries) {
    if (acc.files.length >= MAX_SYNC_FILES) { acc.skipped.push(`${prefix}… (file-count cap ${MAX_SYNC_FILES})`); break; }
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.name.startsWith(EXEC_HELPER_PREFIX)) continue;
    if (ent.isSymbolicLink()) continue; // never follow links out of the workdir
    if (ent.isDirectory()) { walkLocalFiles(rootDir, depth + 1, rel, acc); continue; }
    if (!ent.isFile()) continue;
    let size = 0;
    try { size = fs.statSync(path.join(rootDir, rel)).size; } catch (_) { continue; }
    if (size > MAX_SYNC_BYTES) { acc.skipped.push(`${rel} (${size}b > ${MAX_SYNC_BYTES}b cap)`); continue; }
    acc.files.push({ rel, abs: path.join(rootDir, rel), size });
  }
  return acc;
}

function classifyError(err) {
  const status = Number(err && err.status);
  if (status === 401 || status === 403) return 'remote_auth_error';
  if (Number.isFinite(status) && status > 0) return 'remote_server_error';
  return 'remote_unreachable'; // transport only: DNS / refused / abort / fetch timeout
}

/**
 * Execute code on the remote sandbox service through an ephemeral session.
 *
 * @param {object} args
 * @param {string} args.language   — 'python' | 'bash' ('node' → sandbox_language_not_allowed)
 * @param {string} args.code       — code string to run
 * @param {number} [args.timeoutMs]
 * @param {string} [args.workdir]  — LOCAL session dir whose files are synced in/out
 */
async function executeRemote(args = {}, env = process.env, opts = {}) {
  const cfg = resolveRemoteConfig(env);
  if (!cfg.enabled) {
    return { ok: false, code: 'remote_not_configured', stdout: '', stderr: '', backend: 'remote' };
  }
  const language = String(args.language || 'bash').toLowerCase();
  const runner = RUNNERS[language];
  if (!runner) {
    return {
      ok: false, code: 'sandbox_language_not_allowed', backend: 'remote', exitCode: 127,
      stdout: '', stderr: `language "${language}" is not available on the remote runner (supported: ${Object.keys(RUNNERS).join(', ')})`,
    };
  }
  const aborted = () => Boolean(opts.signal && opts.signal.aborted);
  if (aborted()) return { ok: false, code: 'sandbox_aborted', stdout: '', stderr: 'aborted', backend: 'remote' };

  // Explicit config — never let the client default to process.env, so the
  // (args, env, opts) injection contract holds and tests can't hit prod.
  const session = createRemoteSandbox({ baseUrl: cfg.url, apiKey: cfg.apiKey });
  const notes = [];
  try {
    // ── sync UP: local session workdir → /workspace (recursive, bounded) ──
    const workdir = args.workdir && fs.existsSync(args.workdir) ? path.resolve(args.workdir) : null;
    if (workdir) {
      const { files, skipped } = walkLocalFiles(workdir);
      for (const f of files) {
        if (aborted()) return { ok: false, code: 'sandbox_aborted', stdout: '', stderr: 'aborted during upload', backend: 'remote' };
        await session.putFile(f.rel, fs.readFileSync(f.abs));
      }
      if (skipped.length) notes.push(`[sync] skipped: ${skipped.join('; ')}`);
    }

    // ── run: helper script + interpreter, preserving the script's exit code ──
    const helper = `${EXEC_HELPER_PREFIX}.${runner.ext}`;
    await session.writeFile(helper, String(args.code || ''));
    const timeoutMs = args.timeoutMs || cfg.timeoutMs;
    if (aborted()) return { ok: false, code: 'sandbox_aborted', stdout: '', stderr: 'aborted before exec', backend: 'remote' };
    const r = await session.exec(
      `${runner.cmd} /workspace/${helper}; rc=$?; rm -f /workspace/${EXEC_HELPER_PREFIX}.*; exit $rc`,
      { timeoutMs },
    );

    // ── sync DOWN: /workspace → local workdir (confined, dirs recreated) ──
    if (workdir && !aborted()) {
      const remoteFiles = await session.listFiles('.');
      for (const rf of remoteFiles) {
        const rel = String(rf.path || '').replace(/^\.\//, '');
        if (!rel || path.posix.basename(rel).startsWith(EXEC_HELPER_PREFIX)) continue;
        const dest = path.resolve(workdir, rel);
        if (dest !== workdir && !dest.startsWith(workdir + path.sep)) continue; // confinement
        try {
          const buf = await session.readFile(rel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, buf);
        } catch (_) { notes.push(`[sync] could not download ${rel}`); }
      }
    }

    const stderr = [String(r.stderr || ''), ...notes].filter(Boolean).join('\n');
    if (r.timedOut) {
      return { ok: false, code: 'sandbox_timeout', stdout: String(r.stdout || ''), stderr, exitCode: 124, backend: 'remote' };
    }
    const exitCode = Number.isFinite(Number(r.exitCode)) ? Number(r.exitCode) : 1;
    return { ok: exitCode === 0, stdout: String(r.stdout || ''), stderr, exitCode, truncated: false, backend: 'remote' };
  } catch (err) {
    const code = classifyError(err);
    return { ok: false, code, stdout: '', stderr: String(err && err.message || err), backend: 'remote' };
  } finally {
    try { await session.destroy(); } catch (_) { /* best effort */ }
  }
}

module.exports = { resolveRemoteConfig, isRemoteAvailable, executeRemote };
