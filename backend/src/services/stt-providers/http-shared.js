'use strict';

/**
 * Shared plumbing of the speech-to-text adapters: a request bound that fails
 * as a TIMEOUT (code ETIMEDOUT, no «aborted» wording), never as the user's
 * abort — the engine classifies the former as transient (retry, then the
 * next rung) and the latter as the end of the job — plus small helpers.
 */

function timeoutError(ms, provider) {
  const err = new Error(`${provider} request timed out after ${Math.round(ms / 1000)} s`);
  err.code = 'ETIMEDOUT';
  err.provider = provider;
  return err;
}

/**
 * An AbortSignal that fires with the TIMEOUT error after `ms` or with the
 * caller's own reason when `signal` aborts. `fetch` rejects with the
 * signal's reason, so a budget overrun surfaces as that typed error.
 */
function boundedSignal(signal, ms, provider) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(timeoutError(ms, provider)); }, Math.max(1, ms));
  timer.unref?.();
  const onAbort = () => controller.abort(signal?.reason || Object.assign(new Error('aborted by user'), { name: 'AbortError', code: 'ABORT_ERR' }));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); },
  };
}

function headersObject(headers) {
  const out = {};
  try {
    if (headers && typeof headers.forEach === 'function') headers.forEach((value, key) => { out[String(key).toLowerCase()] = value; });
    else if (headers && typeof headers === 'object') for (const [key, value] of Object.entries(headers)) out[String(key).toLowerCase()] = value;
  } catch { /* advisory */ }
  return out;
}

function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

module.exports = { boundedSignal, headersObject, round3, timeoutError };
