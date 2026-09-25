'use strict';

/**
 * Minimal, allocation-light Server-Sent Events reader for fetch Responses.
 * Works with WHATWG ReadableStream bodies (undici fetch) and Node Readable
 * streams / async iterables (tests, node-fetch). Yields { event, data } for
 * every dispatched event; `data` is the raw string (callers JSON.parse).
 */

async function* iterateBody(body) {
  if (!body) return;
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        if (value) yield value;
      }
    } finally {
      try { reader.releaseLock(); } catch (_) { /* noop */ }
    }
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) yield chunk;
    return;
  }
  if (typeof body === 'string' || body instanceof Uint8Array) yield body;
}

async function* readSse(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data = [];

  function* flushLine(line) {
    if (line === '') {
      if (data.length) {
        yield { event: event || 'message', data: data.join('\n') };
      }
      event = '';
      data = [];
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }

  for await (const chunk of iterateBody(body)) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = buffer.slice(0, nl);
      const sepLen = buffer[nl] === '\r' && buffer[nl + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(nl + sepLen);
      yield* flushLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer) yield* flushLine(buffer);
  yield* flushLine('');
}

/** Parse JSON SSE payloads, skipping the OpenAI-style `[DONE]` sentinel. */
function parseSseJson(data) {
  if (!data || data === '[DONE]') return null;
  try { return JSON.parse(data); } catch (_) { return undefined; }
}

module.exports = { readSse, parseSseJson, iterateBody };
