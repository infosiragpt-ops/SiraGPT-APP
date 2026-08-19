/**
 * progress-stream — structured progress reporter for long-running
 * agent operations (document generation, artifact creation, RAG
 * retrieval, LLM calls).
 *
 * The reporter wraps an SSE / onEvent callback and adds:
 *   - Stage transitions with completion percentage
 *   - Elapsed wall-clock time tracking
 *   - Automatic heartbeat via sse-heartbeat.js when a res object
 *     is provided, keeping CDN/load-balancer connections alive
 *     during silent phases (e.g. a 20 s Python subprocess).
 *   - Integration with ErrorTelemetry for structured error capture
 *     (best-effort, never throws from the reporter).
 *   - Immutable timeline of all stages for after-action diagnostics.
 *
 * Event format (compatible with the frontend's SSE parser):
 *   { type: 'stage', label: 'Ejecutando script Python', pct: 35 }
 *   { type: 'progress', stage: 'formatting cells', pct: 72, meta: { sheet: 5, totalSheets: 10 } }
 *
 * Usage:
 *   const ps = createProgressStream(send, { res, taskId: '...' });
 *   ps.stage('Generando script', 5);
 *   ps.update('Instalando dependencias', 12);
 *   // ... long-running work ...
 *   ps.done({ ok: true, artifactId: 'abc' });
 *
 *   On error:
 *   ps.fail(new Error('timeout'));
 *   // returns { ok: false, error: 'timeout', elapsedMs: ... }
 */

'use strict';

const { startSSEHeartbeat } = require('../utils/sse-heartbeat');
const errorTelemetry = require('../utils/error-telemetry');

const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Create a progress stream bound to an event-emitting callback.
 *
 * @param {(event: object) => void} send - Function that writes each
 *        event (typically `res.write('data: ...\n\n')`). Must be
 *        idempotent after the stream ends.
 * @param {object} [options]
 * @param {import('http').ServerResponse} [options.res] - HTTP response
 *        for SSE heartbeat attachment. If omitted no heartbeat runs.
 * @param {string} [options.taskId] - Optional identifier included in
 *        error-telemetry metadata.
 * @param {number} [options.heartbeatMs] - Heartbeat interval (default
 *        25 s). Ignored when `options.res` is not provided.
 * @param {number} [options.maxDurationMs] - If non-zero, the reporter
 *        auto-fails after this wall-clock duration.
 * @param {(event: object) => boolean} [options.canSend] - Guard
 *        returning false to suppress sends (e.g. client disconnected).
 *        Defaults to always-true.
 * @param {(label: string) => string} [options.translateLabel] - Optional
 *        label translation/normalisation function.
 * @param {object} [options.errorTelemetry] - Override for the
 *        ErrorTelemetry module (used in tests).
 * @returns {ProgressStream}
 *
 * @typedef {object} ProgressStream
 * @property {(label: string, pct: number, meta?: object) => void} stage
 *           Emit a named stage transition. `pct` is 0-100. Returns void.
 * @property {(label: string, pct: number, meta?: object) => void} update
 *           Incremental progress update within the current stage.
 * @property {(result: any) => any} done - Mark the operation as
 *           completed. Calls `send({ type: 'done', ...result })`.
 *           Returns `result` for chaining.
 * @property {(err: Error|string) => object} fail - Mark as failed.
 *           Calls `send({ type: 'error', error: ..., elapsedMs })`.
 *           Returns `{ ok: false, error: ..., elapsedMs }`.
 * @property {() => boolean} cancel - Prematurely end the stream
 *           (e.g. client disconnect). No further events are emitted.
 * @property {() => number} get elapsed - Milliseconds since creation.
 * @property {() => number} get startedAt - Unix ms of creation.
 * @property {() => number} get finishedAt - Unix ms of finish, or 0.
 * @property {() => boolean} get finished - Whether done/fail/cancel
 *           has been called.
 * @property {() => Array<{label: string, pct: number, elapsedMs: number}>} get timeline
 *           Ordered stage snapshots since creation.
 * @property {() => number} get lastPct - Highest percentage seen,
 *           useful for estimating a "current" progress when no new
 *           stage has been pushed.
 */
function createProgressStream(send, options = {}) {
  // ── Normalise inputs ────────────────────────────────────────────
  const _send = typeof send === 'function' ? send : () => {};
  const _opts = options || {};
  const _res = _opts.res || null;
  const _taskId = _opts.taskId || null;
  const _heartbeatMs = _opts.heartbeatMs || DEFAULT_HEARTBEAT_INTERVAL_MS;
  const _maxDurationMs = _opts.maxDurationMs || 0;
  const _canSend = typeof _opts.canSend === 'function' ? _opts.canSend : () => true;
  const _translateLabel = typeof _opts.translateLabel === 'function' ? _opts.translateLabel : (l) => l;

  // ── Internal state ──────────────────────────────────────────────
  const _startedAt = Date.now();
  let _finished = false;
  let _finishedAt = 0;
  let _cancelled = false;
  let _lastPct = 0;
  let _timeline = [];
  let _maxDurationTimer = null;

  // ── Error telemetry helper (best-effort) ────────────────────────
  const _et = _opts.errorTelemetry || errorTelemetry;

  function _safeEmit(event) {
    if (_finished || _cancelled) return;
    if (!_canSend(event)) return;
    try { _send(event); } catch (_err) {
      // Swallow write errors; the caller may have already ended the
      // HTTP response (e.g. client disconnected mid-frame).
    }
  }

  // ── Heartbeat ───────────────────────────────────────────────────
  let _cancelHeartbeat = () => {};
  if (_res && typeof _res.write === 'function' && _res.setTimeout !== false) {
    try {
      _cancelHeartbeat = startSSEHeartbeat(_res, {
        intervalMs: _heartbeatMs,
        setIntervalFn: _opts.setIntervalFn,
        clearIntervalFn: _opts.clearIntervalFn,
      });
    } catch (_hbErr) {
      // Heartbeat is a best-effort keepalive; failure is non-fatal.
    }
  }

  // ── Max-duration watchdog ───────────────────────────────────────
  if (_maxDurationMs > 0) {
    _maxDurationTimer = setTimeout(() => {
      if (!_finished && !_cancelled) {
        const err = new Error(`operation exceeded max duration of ${_maxDurationMs}ms`);
        err.code = 'MAX_DURATION_EXCEEDED';
        _fail(err);
      }
    }, _maxDurationMs).unref();
  }

  // ── Internal helpers ────────────────────────────────────────────
  function _recordStage(label, pct) {
    const clamped = Math.min(100, Math.max(0, pct));
    _lastPct = clamped;
    _timeline.push({ label, pct: clamped, elapsedMs: Date.now() - _startedAt });
  }

  function _cleanup() {
    _finished = true;
    _finishedAt = Date.now();
    _cancelHeartbeat();
    _cancelHeartbeat = () => {};
    if (_maxDurationTimer) {
      clearTimeout(_maxDurationTimer);
      _maxDurationTimer = null;
    }
  }

  function _fail(err) {
    if (_finished || _cancelled) return;
    const message = typeof err === 'string' ? err : (err?.message || 'unknown error');
    const elapsedMs = Date.now() - _startedAt;

    _safeEmit({ type: 'error', error: message, elapsedMs });

    // Error telemetry (best-effort, never throws from progress stream)
    if (_et && typeof _et.captureError === 'function') {
      try {
        _et.captureError(err instanceof Error ? err : new Error(message), {
          module: 'progress-stream',
          taskId: _taskId,
          elapsedMs,
          lastPct: _lastPct,
          timeline: _timeline, // immutable snapshot
        });
      } catch (_ete) { /* swallow telemetry failure */ }
    }

    _cleanup();
  }

  // ── Public API ──────────────────────────────────────────────────

  const api = {
    /**
     * Emit a named stage transition. Records the stage in the
     * internal timeline and sends `{ type: 'stage', label, pct }`.
     *
     * @param {string} label  Human-readable stage name.
     * @param {number} pct    Estimated completion (0–100).
     * @param {object} [meta] Optional metadata payload merged into
     *                        the event under a `meta` key.
     */
    stage(label, pct, meta) {
      if (_finished || _cancelled) return;
      const translated = _translateLabel(String(label));
      const clamped = Math.min(100, Math.max(0, Number(pct) || 0));
      _recordStage(translated, clamped);
      const event = { type: 'stage', label: translated, pct: clamped };
      if (meta !== undefined && meta !== null) event.meta = meta;
      _safeEmit(event);
    },

    /**
     * Incremental progress update within the current stage.
     * Does NOT push a timeline entry (use `stage` for milestones).
     *
     * @param {string} label  Current sub-task description.
     * @param {number} pct    Estimated completion (0–100).
     * @param {object} [meta] Optional metadata.
     */
    update(label, pct, meta) {
      if (_finished || _cancelled) return;
      const translated = _translateLabel(String(label));
      const clamped = Math.min(100, Math.max(0, Number(pct) || 0));
      _lastPct = clamped;
      if (clamped === pct) {
        // Only record non-regressive steps in timeline for updates
        const last = _timeline[_timeline.length - 1];
        if (!last || last.pct < clamped) {
          _timeline.push({ label: translated, pct: clamped, elapsedMs: Date.now() - _startedAt });
        }
      }
      const event = { type: 'progress', label: translated, pct: clamped };
      if (meta !== undefined && meta !== null) event.meta = meta;
      _safeEmit(event);
    },

    /**
     * Mark the operation as successfully completed. Emits a
     * `{ type: 'done' }` event with the result payload merged.
     *
     * @param {*} result  Any serialisable value to send as the
     *                    done event payload.
     * @returns {*}  The same `result` for chaining / return from
     *               the calling function.
     */
    done(result) {
      if (_finished || _cancelled) return result;
      _safeEmit({
        type: 'done',
        elapsedMs: Date.now() - _startedAt,
        ...(result !== undefined ? { result } : {}),
      });
      _cleanup();
      return result;
    },

    /**
     * Mark the operation as failed. Emits an `{ type: 'error' }`
     * event and a structured return value.
     *
     * @param {Error|string} err  The error.
     * @returns {{ ok: false, error: string, elapsedMs: number }}
     */
    fail(err) {
      _fail(err);
      return {
        ok: false,
        error: typeof err === 'string' ? err : (err?.message || 'unknown error'),
        elapsedMs: Date.now() - _startedAt,
      };
    },

    /**
     * Prematurely end the stream without a conclusion event.
     * No further sends will occur.
     *
     * @returns {boolean}  True if cancel was applied, false if
     *                     already finished.
     */
    cancel() {
      if (_finished) return false;
      _cancelled = true;
      _cleanup();
      return true;
    },

    // ── Getters ────────────────────────────────────────────────────

    get elapsed() { return Date.now() - _startedAt; },
    get startedAt() { return _startedAt; },
    get finishedAt() { return _finishedAt; },
    get finished() { return _finished; },
    get cancelled() { return _cancelled; },
    get timeline() { return _timeline.slice(); }, // immutable copy
    get lastPct() { return _lastPct; },
  };

  return api;
}

module.exports = { createProgressStream };
