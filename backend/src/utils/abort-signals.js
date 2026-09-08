'use strict';

/**
 * Compose caller cancellation with an optional wall-clock deadline without
 * depending on AbortSignal.any() (keeps the backend compatible with the Node
 * versions used by local tooling and production workers).
 *
 * The returned cleanup function must be called once the operation settles so
 * long-lived parent signals do not retain listeners.
 */
function composeAbortSignals(signals = [], { timeoutMs = 0, timeoutReason = 'operation_timeout' } = {}) {
  const controller = new AbortController();
  const cleanups = [];
  let timer = null;

  const abortFrom = (source, fallbackReason) => {
    if (controller.signal.aborted) return;
    const reason = source && source.reason !== undefined
      ? source.reason
      : fallbackReason;
    try { controller.abort(reason); } catch { controller.abort(); }
  };

  for (const signal of signals) {
    if (!signal || typeof signal.addEventListener !== 'function') continue;
    if (signal.aborted) {
      abortFrom(signal, new Error('operation_aborted'));
      break;
    }
    const onAbort = () => abortFrom(signal, new Error('operation_aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', onAbort));
  }

  const timeout = Number(timeoutMs);
  if (!controller.signal.aborted && Number.isFinite(timeout) && timeout > 0) {
    timer = setTimeout(() => {
      const error = new Error(String(timeoutReason || 'operation_timeout'));
      error.name = 'TimeoutError';
      error.code = 'OPERATION_TIMEOUT';
      abortFrom(null, error);
    }, Math.floor(timeout));
    timer.unref?.();
  }

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    for (const detach of cleanups.splice(0)) {
      try { detach(); } catch { /* best-effort listener cleanup */ }
    }
  };

  return { controller, signal: controller.signal, cleanup };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('operation_aborted');
  error.name = 'AbortError';
  error.code = 'ABORTED';
  throw error;
}

module.exports = { composeAbortSignals, throwIfAborted };
