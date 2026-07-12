'use strict';

function createAbortError(message = 'Operation aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function isAbortError(error) {
  return Boolean(
    error
    && (error.name === 'AbortError'
      || error.code === 'ABORT_ERR'
      || error.code === 20),
  );
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw createAbortError();
}

function signalWithTimeout(signal, timeoutMs) {
  const boundedTimeout = Math.max(1, Number(timeoutMs) || 1);
  const timeoutSignal = AbortSignal.timeout(boundedTimeout);
  if (!signal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, timeoutSignal]);
  }

  const controller = new AbortController();
  const forwardAbort = (source) => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason || createAbortError());
    }
  };
  if (signal.aborted) forwardAbort(signal);
  else signal.addEventListener('abort', () => forwardAbort(signal), { once: true });
  timeoutSignal.addEventListener('abort', () => forwardAbort(timeoutSignal), { once: true });
  return controller.signal;
}

function bindRequestAbort(req, res) {
  const controller = new AbortController();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    req.removeListener('aborted', abort);
    res.removeListener('close', onClose);
    res.removeListener('finish', cleanup);
  };
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(createAbortError('Client disconnected'));
    }
    cleanup();
  };
  const onClose = () => {
    if (!res.writableFinished) abort();
    else cleanup();
  };

  req.once('aborted', abort);
  res.once('close', onClose);
  res.once('finish', cleanup);

  return {
    signal: controller.signal,
    cleanup,
  };
}

module.exports = {
  bindRequestAbort,
  createAbortError,
  isAbortError,
  signalWithTimeout,
  throwIfAborted,
};
