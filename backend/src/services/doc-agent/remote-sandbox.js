'use strict';

/**
 * Remote sandbox driver — implements the same interface as the local/docker
 * drivers in ./sandbox.js by proxying to the standalone sandbox microservice
 * (services/sandbox) over HTTPS. This is what lets the app (Replit, no Docker)
 * run document tasks: the agentic LOOP stays in the app (with the LLM key),
 * while tool EXECUTION happens in a network-less container on the sandbox host.
 *
 * Selected automatically by createSandbox() when SANDBOX_SERVICE_URL +
 * SANDBOX_API_KEY are set. Injectable `fetchImpl` for offline tests.
 */

const DEFAULT_TIMEOUT_MS = 130_000;
// POST /v1/sessions runs `docker run` on the sandbox host; under load that
// took longer than the old 40 s and surfaced as `remote_sandbox_timeout`.
const DEFAULT_CREATE_TIMEOUT_MS = 60_000;
// The service answers 429 `at_capacity` when its SANDBOX_MAX_CONCURRENCY
// containers are busy (prod: 8, bursts of 3–4 parallel document turns).
// Instead of failing the turn instantly we wait in a bounded queue: poll
// every 2 s, backing off to 5 s, for at most DOC_SANDBOX_QUEUE_WAIT_MS.
const DEFAULT_QUEUE_WAIT_MS = 90_000;
const QUEUE_POLL_MIN_MS = 2_000;
const QUEUE_POLL_MAX_MS = 5_000;
const { composeAbortSignals, throwIfAborted } = require('../../utils/abort-signals');

function positiveInt(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function isAtCapacity(err) {
  return Boolean(err) && Number(err.status) === 429 && /at_capacity/i.test(String(err.message || ''));
}

/** Terminal, retryable capacity failure — classified as `capacity` upstream. */
function capacityError(waitedMs, cause) {
  const err = new Error('El entorno de documentos está ocupado; reintenta en un momento');
  err.code = 'sandbox_at_capacity';
  err.category = 'capacity';
  err.retryable = true;
  err.status = 429;
  err.waitedMs = waitedMs;
  if (cause) err.cause = cause;
  return err;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(signal.reason || new Error('aborted')); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason || new Error('aborted')); };
    const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function createRemoteSandbox({ baseUrl, apiKey, fetchImpl, signal, workspaceKey, onWait, env = process.env, sleepImpl, queueWaitMs } = {}) {
  const base = String(baseUrl || process.env.SANDBOX_SERVICE_URL || '').replace(/\/+$/, '');
  const key = apiKey || process.env.SANDBOX_API_KEY || '';
  const doFetch = fetchImpl || globalThis.fetch;
  const createTimeoutMs = positiveInt(env.SANDBOX_CREATE_TIMEOUT_MS, DEFAULT_CREATE_TIMEOUT_MS) || DEFAULT_CREATE_TIMEOUT_MS;
  const maxQueueWaitMs = queueWaitMs != null ? Number(queueWaitMs) : positiveInt(env.DOC_SANDBOX_QUEUE_WAIT_MS, DEFAULT_QUEUE_WAIT_MS);
  const wait = sleepImpl || sleep;
  if (!base) throw new Error('createRemoteSandbox: SANDBOX_SERVICE_URL is required');
  if (!key) throw new Error('createRemoteSandbox: SANDBOX_API_KEY is required');
  if (typeof doFetch !== 'function') throw new Error('createRemoteSandbox: fetch is not available');

  let sessionId = null;
  let creatingSession = null;
  let destroyed = false;
  let destroying = null;

  async function call(method, p, body, { timeoutMs = DEFAULT_TIMEOUT_MS, ignoreParentAbort = false } = {}) {
    if (!ignoreParentAbort) throwIfAborted(signal);
    const abortScope = composeAbortSignals(ignoreParentAbort ? [] : [signal], {
      timeoutMs,
      timeoutReason: 'remote_sandbox_timeout',
    });
    try {
      const res = await doFetch(`${base}${p}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body),
        signal: abortScope.signal,
      });
      const text = await res.text();
      let json;
      try { json = text ? JSON.parse(text) : {}; } catch { json = { error: 'bad_json', raw: text.slice(0, 300) }; }
      if (!res.ok) {
        const err = new Error(`sandbox service ${res.status}: ${json.error || text.slice(0, 200)}`);
        err.status = res.status; // lets callers classify auth vs server vs transport failures
        throw err;
      }
      return json;
    } finally {
      abortScope.cleanup();
    }
  }

  const persistKey = String(workspaceKey || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || null;

  // Bounded queue in front of the service's capacity limit. Each attempt is
  // a fresh POST with its own create timeout: the queue wait never eats the
  // budget of the command that runs once the container exists.
  async function createSessionWithQueue(body) {
    const startedAt = Date.now();
    let attempt = 0;
    let plannedWaitMs = 0; // sum of sleeps: bounded even under a frozen clock
    let delay = QUEUE_POLL_MIN_MS;
    for (;;) {
      attempt += 1;
      try {
        return await call('POST', '/v1/sessions', body, { timeoutMs: createTimeoutMs });
      } catch (err) {
        if (!isAtCapacity(err)) throw err;
        const waitedMs = Math.max(Date.now() - startedAt, plannedWaitMs);
        if (destroyed || waitedMs + delay > maxQueueWaitMs) throw capacityError(waitedMs, err);
        if (typeof onWait === 'function') {
          try { onWait({ attempt, waitedMs, maxWaitMs: maxQueueWaitMs, nextDelayMs: delay }); } catch (_) { /* progress is best-effort */ }
        }
        await wait(delay, signal);
        throwIfAborted(signal);
        plannedWaitMs += delay;
        delay = Math.min(QUEUE_POLL_MAX_MS, Math.round(delay * 1.5));
      }
    }
  }

  async function ensureSession() {
    if (destroyed) throw new Error('sandbox destroyed');
    if (sessionId) return sessionId;
    // First-use tools can run in parallel. All of them must share the same
    // POST; otherwise each gets a container and destroy() sees only the last.
    if (!creatingSession) {
      creatingSession = (async () => {
        try {
          const body = persistKey ? { workspaceKey: persistKey } : {};
          const r = await createSessionWithQueue(body);
          if (!r.sessionId) throw new Error('sandbox service returned no sessionId');
          sessionId = r.sessionId;
          return sessionId;
        } finally {
          // A failed create can be retried on the same live sandbox object.
          creatingSession = null;
        }
      })();
    }
    const id = await creatingSession;
    if (destroyed) throw new Error('sandbox destroyed');
    return id;
  }

  return {
    driver: 'remote',
    persistent: Boolean(persistKey),
    persistKey,
    root: '/workspace',
    async exec(command, opts = {}) {
      if (destroyed) throw new Error('sandbox destroyed');
      const id = await ensureSession();
      return call('POST', `/v1/sessions/${id}/exec`, { command: String(command), timeoutMs: opts.timeoutMs }, { timeoutMs: (opts.timeoutMs || 120_000) + 10_000 });
    },
    async putFile(relPath, buffer) {
      const id = await ensureSession();
      const r = await call('POST', `/v1/sessions/${id}/put`, { path: relPath, contentBase64: Buffer.from(buffer).toString('base64') });
      return r.path;
    },
    async readFile(relPath) {
      const id = await ensureSession();
      const r = await call('POST', `/v1/sessions/${id}/read`, { path: relPath });
      return Buffer.from(String(r.contentBase64 || ''), 'base64');
    },
    async writeFile(relPath, content) {
      const id = await ensureSession();
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
      await call('POST', `/v1/sessions/${id}/write`, { path: relPath, contentBase64: buf.toString('base64') });
    },
    async listFiles(relDir = '.') {
      const id = await ensureSession();
      const r = await call('POST', `/v1/sessions/${id}/list`, { path: relDir });
      return Array.isArray(r.files) ? r.files : [];
    },
    async collectOutputs() {
      const id = await ensureSession();
      const r = await call('GET', `/v1/sessions/${id}/outputs`, undefined, { timeoutMs: 60_000 });
      return (Array.isArray(r.outputs) ? r.outputs : []).map((o) => ({ name: o.name, buffer: Buffer.from(String(o.contentBase64 || ''), 'base64') }));
    },
    async destroy() {
      if (destroying) return destroying;
      destroyed = true;
      destroying = (async () => {
        // An in-flight POST can succeed after destroy() was requested. Wait
        // for its ID, then DELETE it using a signal independent of Stop.
        if (creatingSession) {
          try { await creatingSession; } catch (_) { /* no ID was issued */ }
        }
        if (sessionId) {
          try {
            await call('DELETE', `/v1/sessions/${sessionId}`, undefined, {
              timeoutMs: 20_000,
              ignoreParentAbort: true,
            });
          } catch (_) { /* server TTL is the final cleanup backstop */ }
        }
      })();
      return destroying;
    },
  };
}

module.exports = { createRemoteSandbox, isAtCapacity, DEFAULT_QUEUE_WAIT_MS, DEFAULT_CREATE_TIMEOUT_MS };
