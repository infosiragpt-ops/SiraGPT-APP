'use strict';

/**
 * ndjson — incremental parser + serializer for newline-delimited JSON
 * (a.k.a. JSON Lines). Pairs with the SSE reassembler (#17) and the
 * batch endpoint commit history: NDJSON is the no-fuss alternative to
 * SSE for "stream a sequence of JSON objects" and the agent's batch
 * endpoint already speaks it.
 *
 * Parser semantics:
 *   - push(chunk) feeds bytes/string into the parser.
 *   - Complete `\n`-terminated lines are JSON.parsed and emitted.
 *   - Empty lines are skipped (no-op).
 *   - Lines that fail JSON.parse are reported via onError; the parser
 *     keeps going so one bad row doesn't kill the stream.
 *   - end() flushes a trailing line with no newline, treating it as
 *     a complete record (NDJSON spec is permissive on the last line).
 *
 * Public API:
 *   const p = createNdjsonParser({ onLine, onError })
 *   p.push(chunk)              chunk: string | Buffer | Uint8Array
 *   p.end()                    flush trailing partial line
 *   p.snapshot()               { lines, errors, partialBufferLen }
 *
 *   serializeNdjson(values)    → string (each value on its own line + \n)
 *   stringifyOne(value)        → string + \n
 */

function decodeChunk(chunk) {
  if (chunk == null) return '';
  if (typeof chunk === 'string') return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

function createNdjsonParser(opts = {}) {
  const onLine = typeof opts.onLine === 'function' ? opts.onLine : null;
  const onError = typeof opts.onError === 'function' ? opts.onError : null;
  let buffer = '';
  let lines = 0;
  let errors = 0;

  function deliver(line) {
    if (!line) return;
    try {
      const value = JSON.parse(line);
      lines += 1;
      if (onLine) {
        try { onLine(value); }
        catch (err) {
          errors += 1;
          if (onError) { try { onError(err, line); } catch { /* swallow */ } }
        }
      }
    } catch (err) {
      errors += 1;
      if (onError) { try { onError(err, line); } catch { /* swallow */ } }
    }
  }

  function push(chunk) {
    const text = decodeChunk(chunk);
    if (!text) return;
    buffer += text;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      // Tolerate \r\n line endings.
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const trimmed = line.trim();
      if (trimmed) deliver(trimmed);
    }
  }

  function end() {
    if (buffer.length > 0) {
      const trimmed = buffer.trim();
      buffer = '';
      if (trimmed) deliver(trimmed);
    }
  }

  function snapshot() {
    return { lines, errors, partialBufferLen: buffer.length };
  }

  return { push, end, snapshot };
}

function stringifyOne(value) {
  return JSON.stringify(value) + '\n';
}

function serializeNdjson(values) {
  if (!Array.isArray(values)) throw new TypeError('serializeNdjson: array required');
  return values.map((v) => JSON.stringify(v)).join('\n') + (values.length > 0 ? '\n' : '');
}

module.exports = {
  createNdjsonParser,
  serializeNdjson,
  stringifyOne,
  decodeChunk,
};
