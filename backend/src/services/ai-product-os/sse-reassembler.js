'use strict';

/**
 * sse-reassembler — incremental Server-Sent-Events parser that
 * normalizes chunks from any LLM provider into a canonical event
 * stream. Pairs with the streaming-budget-governor (#7); the
 * governor counts tokens, this one parses the wire bytes.
 *
 * Why bespoke vs. an off-the-shelf SSE library:
 *   - Provider streams disagree on framing edge cases (Anthropic emits
 *     `event:` lines, OpenAI emits `data:` only, Gemini chunks may
 *     split JSON across packets). A small focused parser matches that
 *     reality without dragging in fetch/whatwg-streams as a dep.
 *   - Buffer state must survive partial chunks: an HTTP body delivered
 *     in 4 packets can split a single SSE frame into 2 lines.
 *   - We need a synchronous push() so the streaming pipeline doesn't
 *     allocate a Promise per byte.
 *
 * Public API:
 *   const r = createSseReassembler({ onEvent, onError })
 *   r.push(chunk)                   // chunk: string | Buffer | Uint8Array
 *   r.end()                         // flush trailing partial frame
 *   r.snapshot()                    // { framesEmitted, partialBufferLen, bytes }
 *
 * Each emitted event:
 *   { event: string|null, data: string, id?: string|null, retry?: number|null }
 *
 * data is the raw payload; the caller decides whether to JSON.parse.
 * `[DONE]` sentinel is emitted as `{ event:'done', data:'[DONE]' }`
 * so the consumer can switch on a single shape regardless of provider.
 */

function decodeChunk(chunk) {
  if (chunk == null) return '';
  if (typeof chunk === 'string') return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

function createSseReassembler(opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
  const onError = typeof opts.onError === 'function' ? opts.onError : null;

  let buffer = '';
  let framesEmitted = 0;
  let bytes = 0;

  function emit(frame) {
    if (!frame) return;
    framesEmitted += 1;
    if (!onEvent) return;
    try { onEvent(frame); } catch (err) {
      if (onError) { try { onError(err); } catch { /* swallow */ } }
    }
  }

  /**
   * Parse one buffered event block (separated by \n\n). Returns the
   * normalized frame or null if the block is empty / comment-only.
   */
  function parseBlock(block) {
    if (!block) return null;
    let event = null;
    let dataLines = [];
    let id = null;
    let retry = null;
    for (const rawLine of block.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (!line) continue;
      if (line[0] === ':') continue; // SSE comment
      const colonIdx = line.indexOf(':');
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      switch (field) {
        case 'event': event = value; break;
        case 'data':  dataLines.push(value); break;
        case 'id':    id = value; break;
        case 'retry': {
          const n = Number(value);
          if (Number.isFinite(n) && n >= 0) retry = Math.floor(n);
          break;
        }
        default: /* unknown field ignored per spec */
      }
    }
    if (dataLines.length === 0 && event == null && id == null && retry == null) return null;
    const data = dataLines.join('\n');
    if (data === '[DONE]') {
      return { event: 'done', data: '[DONE]', id, retry };
    }
    return { event, data, id, retry };
  }

  function push(chunk) {
    const text = decodeChunk(chunk);
    if (!text) return;
    bytes += Buffer.byteLength(text, 'utf8');
    buffer += text;
    let idx;
    // Spec: events are separated by \n\n. Be tolerant of \r\n\r\n too.
    while ((idx = buffer.indexOf('\n\n')) !== -1 || (idx = buffer.indexOf('\r\n\r\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 4 : 2));
      const frame = parseBlock(block);
      if (frame) emit(frame);
    }
  }

  function end() {
    if (buffer.length > 0) {
      const frame = parseBlock(buffer);
      buffer = '';
      if (frame) emit(frame);
    }
  }

  function snapshot() {
    return { framesEmitted, partialBufferLen: buffer.length, bytes };
  }

  return { push, end, snapshot };
}

module.exports = {
  createSseReassembler,
  decodeChunk,
};
