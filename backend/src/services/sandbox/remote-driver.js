'use strict';

/**
 * sandbox/remote-driver — HTTPS client for the Lenovo Docker sandbox.
 *
 * When SANDBOX_SERVICE_URL + SANDBOX_API_KEY are set, all executeCode calls
 * are forwarded to that service instead of running locally. This gives full
 * Docker isolation (--network none, 1 CPU, 1 GB RAM, 100 PID limit) without
 * requiring Docker inside the Replit environment.
 *
 * The remote service's API is expected to match the microservice built by the
 * Lenovo agent (POST /exec, Bearer token auth). If the remote is unreachable,
 * falls back to the local sandbox automatically unless SANDBOX_REMOTE_ONLY=1.
 *
 * Public API:
 *   resolveRemoteConfig(env)          — pure config reader
 *   isRemoteAvailable(env)            — boolean probe
 *   executeRemote(args, env, opts)    — forward to remote, result shape matches
 *                                       local-sandbox.executeLocal output
 */

const https = require('https');
const http  = require('http');

const DEFAULT_TIMEOUT_MS = 120_000; // 2 min — mirrors local sandbox hard max

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

function httpPost(url, body, { apiKey, timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const payload = JSON.stringify(body);

    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization':  `Bearer ${apiKey}`,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (_) { resolve({ status: res.statusCode, body: raw }); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('remote_sandbox_timeout')); });
    if (signal) signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    req.write(payload);
    req.end();
  });
}

/**
 * Execute code on the remote sandbox service.
 *
 * @param {object} args
 * @param {string} args.language   — 'python' | 'bash' | 'node'
 * @param {string} args.code       — code string to run
 * @param {number} [args.timeoutMs]
 * @param {string} [args.workdir]  — relative path hint forwarded to service
 */
async function executeRemote(args = {}, env = process.env, opts = {}) {
  const cfg = resolveRemoteConfig(env);
  if (!cfg.enabled) {
    return { ok: false, code: 'remote_not_configured', stdout: '', stderr: '', backend: 'remote' };
  }

  const endpoint = cfg.url.replace(/\/$/, '') + '/exec';

  try {
    const { status, body } = await httpPost(endpoint, {
      language:  args.language  || 'bash',
      code:      args.code      || '',
      timeoutMs: args.timeoutMs || cfg.timeoutMs,
      workdir:   args.workdir   || null,
    }, {
      apiKey:    cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
      signal:    opts.signal,
    });

    if (status === 401 || status === 403) {
      return { ok: false, code: 'remote_auth_error', stdout: '', stderr: `HTTP ${status}`, backend: 'remote' };
    }
    if (status >= 500) {
      return { ok: false, code: 'remote_server_error', stdout: '', stderr: `HTTP ${status}: ${JSON.stringify(body)}`, backend: 'remote' };
    }

    return {
      ok:       body.ok     !== false,
      stdout:   String(body.stdout  || ''),
      stderr:   String(body.stderr  || ''),
      exitCode: body.exitCode ?? body.exit_code ?? 0,
      truncated: Boolean(body.truncated),
      backend:  'remote',
    };
  } catch (err) {
    return { ok: false, code: 'remote_unreachable', stdout: '', stderr: err.message, backend: 'remote' };
  }
}

module.exports = { resolveRemoteConfig, isRemoteAvailable, executeRemote };
