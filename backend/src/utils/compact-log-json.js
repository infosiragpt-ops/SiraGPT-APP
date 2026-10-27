'use strict';

/**
 * compact-log-json — JSON for a log line that can never balloon.
 *
 * The nightly RLHF job returned the trained reward model, and system-cron
 * printed it with JSON.stringify: every «rlhf-phase3 done» line carried the
 * whole 1536-weight vector (tens of KB of floats in Admin → Logs). Results
 * small enough print EXACTLY as JSON.stringify would; long arrays, wide
 * objects and long strings are summarised, and the line is capped.
 */

const DEFAULTS = Object.freeze({ maxChars: 2000, maxArray: 20, maxKeys: 40, maxString: 300 });

/**
 * @param {*} value
 * @param {{ maxChars?: number, maxArray?: number, maxKeys?: number, maxString?: number }} [opts]
 * @returns {string}
 */
function compactLogJson(value, opts = {}) {
  const { maxChars, maxArray, maxKeys, maxString } = { ...DEFAULTS, ...(opts || {}) };
  let text;
  try {
    text = JSON.stringify(value, (_key, v) => {
      if (typeof v === 'bigint') return String(v);
      if (typeof v === 'string' && v.length > maxString) return `${v.slice(0, maxString)}…(+${v.length - maxString})`;
      if (Array.isArray(v)) {
        if (v.length <= maxArray) return v;
        return `[${v.length} ${v.every((x) => typeof x === 'number') ? 'numbers' : 'items'}]`;
      }
      if (v && typeof v === 'object') {
        const keys = Object.keys(v);
        if (keys.length > maxKeys) return `{${keys.length} keys}`;
      }
      return v;
    });
  } catch (_) {
    return '"[unserializable]"';
  }
  if (text === undefined) return 'undefined';
  return text.length > maxChars ? `${text.slice(0, maxChars)}…(+${text.length - maxChars} chars)` : text;
}

module.exports = { compactLogJson };
