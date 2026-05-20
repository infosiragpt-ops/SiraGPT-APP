'use strict';

/**
 * heavy-analysis.worker — CPU-bound document analysis worker (SCAFFOLD).
 *
 * Receives messages from the worker-pool manager of the form:
 *   { id, type, payload }
 *
 * Replies with:
 *   { id, ok: true, result }   on success
 *   { id, ok: false, error }   on failure
 *
 * Supported message types (extend as analyzer hooks migrate in):
 *   - 'echo'              : returns payload verbatim (used by tests)
 *   - 'regex-scan'        : runs `regex` over `text` and returns match[]
 *   - 'word-count'        : counts whitespace-separated tokens in `text`
 *   - 'document-analyze'  : TODO — dispatch into document-professional-analyzer
 *                           heavy path once the call-site is wrapped.
 */

const { parentPort } = require('node:worker_threads');

if (!parentPort) {
  // Allow `require()` for tests without throwing.
  module.exports = {};
  return;
}

function handle(message) {
  const { type, payload } = message;
  switch (type) {
    case 'echo':
      return payload;
    case 'regex-scan': {
      const { text, pattern, flags, maxMatches } = payload || {};
      if (typeof text !== 'string' || typeof pattern !== 'string') {
        throw new Error('regex-scan requires {text, pattern}');
      }
      const limit = Number.isInteger(maxMatches) && maxMatches > 0
        ? Math.min(maxMatches, 1_000_000)
        : 1_000_000;
      const re = new RegExp(pattern, flags || 'g');
      const matches = [];
      let m;
      let truncated = false;
      while ((m = re.exec(text)) !== null) {
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        matches.push({ index: m.index, match: m[0] });
        if (!re.global) break;
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      return { count: matches.length, matches, truncated };
    }
    case 'word-count': {
      const { text } = payload || {};
      if (typeof text !== 'string') throw new Error('word-count requires {text}');
      const tokens = text.trim() === '' ? [] : text.trim().split(/\s+/);
      return { words: tokens.length, chars: text.length };
    }
    case 'document-analyze':
      // TODO: dispatch into document-professional-analyzer once the heavy
      // regex/text-parsing step is isolated behind a pure function. For now
      // return a placeholder so the pool round-trip can be verified.
      return { ok: true, todo: 'document-analyze: scaffold only' };
    default:
      throw new Error(`unknown message type: ${type}`);
  }
}

parentPort.on('message', (msg) => {
  const { id } = msg || {};
  try {
    const result = handle(msg);
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({
      id,
      ok: false,
      error: { message: err && err.message ? err.message : String(err) },
    });
  }
});
