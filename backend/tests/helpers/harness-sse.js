'use strict';

/** Test helpers: fake streaming fetch Responses for the harness adapters. */

function sseText(events) {
  return events.map((e) => {
    if (typeof e === 'string') return `data: ${e}\n\n`;
    const lines = [];
    if (e.event) lines.push(`event: ${e.event}`);
    lines.push(`data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}`);
    return `${lines.join('\n')}\n\n`;
  }).join('');
}

function chunked(text, chunkSize) {
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= bytes.length) { controller.close(); return; }
      const size = typeof chunkSize === 'function' ? chunkSize() : chunkSize;
      controller.enqueue(bytes.slice(i, i + size));
      i += size;
    },
  });
}

function sseResponse(events, { chunkSize = 17, status = 200, headers = {} } = {}) {
  return new Response(chunked(sseText(events), chunkSize), { status, headers: { 'content-type': 'text/event-stream', ...headers } });
}

/** Anthropic event list helper: data objects get `event:` = their type. */
function anthropicEvents(list) {
  return list.map((data) => ({ event: data.type, data }));
}

/** fetch mock that serves queued responses and records requests. */
function createFetchMock(queue) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, headers: init.headers, body });
    const next = queue.shift();
    if (!next) throw new Error('unexpected fetch');
    return typeof next === 'function' ? next({ url, body, init }) : next;
  };
  return { fetchImpl, calls };
}

module.exports = { sseText, sseResponse, anthropicEvents, createFetchMock, chunked };
