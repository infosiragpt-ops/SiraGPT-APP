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
 * SIRAGPT_AGENTIC_STREAM_FINAL (default ON → progressive token streaming;
 * set it to 0/off/false to restore the single-frame behavior). See isEnabled().
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
  // Default ON: token-stream the final answer progressively so it reveals like
  // ChatGPT (text arrives and fills in) instead of the whole answer popping in
  // one frame after the thinking timeline — which read as a ~1s "dead" gap.
  // Set SIRAGPT_AGENTIC_STREAM_FINAL=0 (or off/false) to restore single-frame.
  const raw = String(process.env.SIRAGPT_AGENTIC_STREAM_FINAL ?? '').trim().toLowerCase();
  if (raw === '') return true;
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

  const isWs = (ch) => ch !== undefined && /\s/.test(ch);
  // A token longer than this is split mid-word (URLs, base64…) — unavoidable,
  // but bounded so one pathological token can't make an arbitrarily long chunk.
  const hardTokenCap = target * 4;

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
      } else if (!isWs(s[end - 1]) && !isWs(s[end])) {
        // `end` would fall inside a word run. Back off to the last whitespace
        // after `i` so the word stays whole. (The previous version floored the
        // back-off at i+0.5·target, which split words that started in the first
        // half of the chunk and crossed the boundary.)
        let ws = -1;
        for (let j = end - 1; j > i; j -= 1) {
          if (isWs(s[j])) { ws = j + 1; break; }
        }
        if (ws > i) {
          end = ws;
        } else {
          // No whitespace in [i, end): the token is longer than `target`.
          // Extend forward to the next whitespace to keep it whole, capping the
          // reach so a pathological token still gets hard-split.
          const hardCap = Math.min(i + hardTokenCap, n);
          let fwd = -1;
          for (let j = end; j < hardCap; j += 1) {
            if (isWs(s[j])) { fwd = j + 1; break; }
          }
          end = fwd !== -1 ? fwd : hardCap;
        }
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
    if (!signal || typeof signal.addEventListener !== 'function') {
      setTimeout(resolve, ms);
      return;
    }
    // Detach the abort listener when the timer fires normally — `{ once: true }`
    // only auto-removes it if abort actually fires, so without this every
    // per-chunk sleep() left a listener on the shared per-turn AbortSignal
    // (dozens-to-160 per long answer → MaxListenersExceededWarning + retained
    // closures). Timing/frames/abort behaviour are unchanged.
    let t;
    const onAbort = () => { clearTimeout(t); resolve(); };
    t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
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
