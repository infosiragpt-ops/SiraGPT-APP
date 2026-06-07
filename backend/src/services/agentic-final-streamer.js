'use strict';

/**
 * agentic-final-streamer.js — Phase 5 of the cognitive core.
 * ───────────────────────────────────────────────────────────────────────────
 * The agentic chat path computes the whole final answer, then emits it in a
 * SINGLE SSE frame — so the user watches a step timeline and then the entire
 * answer appears at once (worse perceived latency than ChatGPT's streamed
 * tool-use). This module token-streams that already-computed final answer:
 * it chunks the text on word/sentence boundaries and emits progressive
 * `replace` frames (sentinel timeline + growing answer), giving the
 * incremental-render feel without re-architecting the agent loop.
 *
 * The chunker is pure + deterministic (unit-tested). The streamer is a thin
 * async writer with a hard fallback to the original single-frame behavior on
 * any error, so it can never break the response. Gated by
 * SIRAGPT_AGENTIC_STREAM_FINAL (default off → unchanged behavior).
 *
 * Public API:
 *   isEnabled()                                   → boolean
 *   chunkForStreaming(text, opts?)                → string[]
 *   streamFinalAnswer({ res, writeSse, prefix, finalAnswer, signal, ... }) → Promise<void>
 */

const DEFAULT_TARGET_CHARS = Number(process.env.SIRAGPT_AGENTIC_STREAM_CHUNK_CHARS) || 64;
const DEFAULT_MAX_CHUNKS = Number(process.env.SIRAGPT_AGENTIC_STREAM_MAX_CHUNKS) || 160;
const DEFAULT_DELAY_MS = Number(process.env.SIRAGPT_AGENTIC_STREAM_DELAY_MS) || 14;
const MIN_STREAM_CHARS = Number(process.env.SIRAGPT_AGENTIC_STREAM_MIN_CHARS) || 160;

function isEnabled() {
  const raw = String(process.env.SIRAGPT_AGENTIC_STREAM_FINAL || '').trim().toLowerCase();
  return raw === '1' || raw === 'on' || raw === 'true';
}

/**
 * Split text into ~targetChars chunks at safe boundaries. Prefers sentence
 * ends, then whitespace, never mid-word. Caps the number of chunks (folding
 * the remainder into the last) so very long answers don't flood the socket.
 */
function chunkForStreaming(text, opts = {}) {
  const s = String(text == null ? '' : text);
  if (!s) return [];
  const target = Math.max(8, Number(opts.targetChars) || DEFAULT_TARGET_CHARS);
  const maxChunks = Math.max(1, Number(opts.maxChunks) || DEFAULT_MAX_CHUNKS);

  const chunks = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    let end = Math.min(i + target, n);
    if (end < n) {
      // Try to extend to the next sentence boundary within a small window…
      const windowEnd = Math.min(end + Math.ceil(target * 0.6), n);
      let boundary = -1;
      for (let j = end; j < windowEnd; j += 1) {
        if (/[.!?…\n]/.test(s[j])) { boundary = j + 1; break; }
      }
      if (boundary !== -1) {
        end = boundary;
      } else {
        // …else back off to the previous whitespace so we never split a word.
        let ws = -1;
        for (let j = end; j > i + Math.floor(target * 0.5); j -= 1) {
          if (/\s/.test(s[j])) { ws = j + 1; break; }
        }
        if (ws !== -1) end = ws;
      }
    }
    chunks.push(s.slice(i, end));
    i = end;
  }

  if (chunks.length <= maxChunks) return chunks;
  // Fold the overflow into the last allowed chunk.
  const head = chunks.slice(0, maxChunks - 1);
  head.push(chunks.slice(maxChunks - 1).join(''));
  return head;
}

function sleep(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    }
  });
}

/**
 * Stream the final answer progressively. `prefix` is the constant sentinel
 * timeline string; each frame replaces the message with prefix + grown answer.
 *
 * @param {object} p
 * @param {object} p.res                Express response (for writableEnded check)
 * @param {Function} p.writeSse         async (res, payload) => void
 * @param {string} p.prefix             constant sentinel prefix
 * @param {string} p.finalAnswer        the complete answer to stream
 * @param {AbortSignal} [p.signal]
 * @param {boolean} [p.enabled]         override env gate (for tests)
 */
async function streamFinalAnswer({ res, writeSse, prefix = '', finalAnswer = '', signal = null, enabled = undefined, delayMs = DEFAULT_DELAY_MS } = {}) {
  const sep = prefix ? `${prefix}\n\n` : '';
  const on = typeof enabled === 'boolean' ? enabled : isEnabled();

  // Disabled, too short, or aborted → original single-frame behavior.
  if (!on || finalAnswer.length < MIN_STREAM_CHARS) {
    await writeSse(res, { replace: true, content: `${sep}${finalAnswer}` });
    return;
  }

  try {
    const chunks = chunkForStreaming(finalAnswer);
    let acc = '';
    for (let k = 0; k < chunks.length; k += 1) {
      if (signal && signal.aborted) break;
      if (res && res.writableEnded) break;
      acc += chunks[k];
      await writeSse(res, { replace: true, content: `${sep}${acc}` });
      if (k < chunks.length - 1) await sleep(delayMs, signal);
    }
    // Guarantee the full answer is the final state (in case of early break).
    if (acc !== finalAnswer && !(res && res.writableEnded)) {
      await writeSse(res, { replace: true, content: `${sep}${finalAnswer}` });
    }
  } catch (_) {
    // Hard fallback: never let streaming break the response.
    try { await writeSse(res, { replace: true, content: `${sep}${finalAnswer}` }); } catch (_e) { /* socket gone */ }
  }
}

module.exports = {
  isEnabled,
  chunkForStreaming,
  streamFinalAnswer,
  MIN_STREAM_CHARS,
  DEFAULT_TARGET_CHARS,
};
