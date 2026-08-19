'use strict';

/**
 * throttle-debounce — small classics. Pairs with the microbatcher
 * (#23, multi-call coalesce) and the SSE keepalive (#38, idle timer):
 * those operate on a stream of items; these operate on a single
 * function the caller wants to slow down.
 *
 *   debounce(fn, ms)  — fn runs `ms` after the LAST call (collapse
 *                       bursts). Optional { leading, trailing }.
 *   throttle(fn, ms)  — fn runs at most once per `ms` window
 *                       (steady-rate). Optional { leading, trailing }.
 *
 * Both return a wrapped function with .cancel() (drop pending) and
 * .flush() (run pending immediately if there is one). Calling the
 * wrapper returns the most recent settled value (debounce/throttle
 * never await the inner fn — they are sync orchestrators).
 *
 * Public API:
 *   const fn = debounce(work, 100, { leading: false, trailing: true })
 *   fn(...args); fn.cancel(); fn.flush();
 *   const fn2 = throttle(work, 250)
 */

function makeTimer(ms, cb) {
  const t = setTimeout(cb, ms);
  if (typeof t.unref === 'function') t.unref();
  return t;
}

function debounce(fn, ms, { leading = false, trailing = true } = {}) {
  if (typeof fn !== 'function') throw new TypeError('debounce: fn required');
  if (!Number.isFinite(ms) || ms < 0) throw new TypeError('debounce: ms must be ≥ 0');
  let timer = null;
  let pendingArgs = null;
  let pendingThis = null;
  let lastResult;

  function trigger() {
    timer = null;
    if (trailing && pendingArgs) {
      lastResult = fn.apply(pendingThis, pendingArgs);
      pendingArgs = null;
      pendingThis = null;
    }
  }

  function wrapped(...args) {
    pendingArgs = args;
    pendingThis = this;
    if (leading && !timer) {
      lastResult = fn.apply(this, args);
      pendingArgs = null;
      pendingThis = null;
    }
    if (timer) clearTimeout(timer);
    timer = makeTimer(ms, trigger);
    return lastResult;
  }

  wrapped.cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    pendingArgs = null;
    pendingThis = null;
  };
  wrapped.flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pendingArgs) {
      lastResult = fn.apply(pendingThis, pendingArgs);
      pendingArgs = null;
      pendingThis = null;
    }
    return lastResult;
  };
  wrapped.pending = () => timer !== null;

  return wrapped;
}

function throttle(fn, ms, { leading = true, trailing = true } = {}) {
  if (typeof fn !== 'function') throw new TypeError('throttle: fn required');
  if (!Number.isFinite(ms) || ms < 0) throw new TypeError('throttle: ms must be ≥ 0');
  let timer = null;
  let pendingArgs = null;
  let pendingThis = null;
  let lastResult;
  let lastInvokeAt = 0;

  function trigger() {
    timer = null;
    if (trailing && pendingArgs) {
      lastInvokeAt = Date.now();
      lastResult = fn.apply(pendingThis, pendingArgs);
      pendingArgs = null;
      pendingThis = null;
      // Re-arm so a fresh call after the window opens isn't lost.
    }
  }

  function wrapped(...args) {
    const now = Date.now();
    const remaining = ms - (now - lastInvokeAt);
    pendingArgs = args;
    pendingThis = this;
    if (remaining <= 0 || lastInvokeAt === 0) {
      if (leading) {
        lastInvokeAt = now;
        lastResult = fn.apply(this, args);
        pendingArgs = null;
        pendingThis = null;
      } else {
        // first call but leading false → schedule trailing
        if (timer) clearTimeout(timer);
        timer = makeTimer(ms, trigger);
      }
    } else if (!timer) {
      timer = makeTimer(remaining, trigger);
    }
    return lastResult;
  }

  wrapped.cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    pendingArgs = null;
    pendingThis = null;
    lastInvokeAt = 0;
  };
  wrapped.flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pendingArgs) {
      lastInvokeAt = Date.now();
      lastResult = fn.apply(pendingThis, pendingArgs);
      pendingArgs = null;
      pendingThis = null;
    }
    return lastResult;
  };

  return wrapped;
}

module.exports = {
  debounce,
  throttle,
};
