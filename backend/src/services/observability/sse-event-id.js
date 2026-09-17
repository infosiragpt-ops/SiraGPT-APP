'use strict';

/**
 * 3H-BE-001/002/003 — shared SSE event-id + Last-Event-ID resume helper.
 * Remaining streams (agent-task, cowork, codex) were writing `data:` without `id:`.
 */

function parseLastEventId(req) {
  if (!req) return 0;
  const headers = req.headers || {};
  const raw = headers['last-event-id']
    || headers['Last-Event-ID']
    || headers['x-last-event-id']
    || (req.query && (req.query.lastEventId || req.query.lastEventID || req.query.afterSeq))
    || '';
  const text = String(raw).trim();
  if (!text) return 0;
  const tail = text.includes(':') ? text.split(':').pop() : text;
  const n = Number.parseInt(tail, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function createSseEventCounter(start = 0) {
  let n = Number.isFinite(Number(start)) ? Math.max(0, Number(start)) : 0;
  return {
    next() {
      n += 1;
      return n;
    },
    current() {
      return n;
    },
    write(res, payload, eventName) {
      if (!res || res.writableEnded) return 0;
      const id = this.next();
      const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
      const ev = eventName ? `event: ${eventName}\n` : '';
      res.write(`${ev}id: ${id}\ndata: ${data}\n\n`);
      return id;
    },
  };
}

function formatSseFrame({ id, eventName, data }) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  const ev = eventName ? `event: ${eventName}\n` : '';
  const idLine = id != null && id !== '' ? `id: ${id}\n` : '';
  return `${idLine}${ev}data: ${payload}\n\n`;
}

/**
 * 3H2-BE-004 — wrap res.write so leftover SSE streams that only emit `data:`
 * get `id: N` without rewriting every call site. Comments (`: ping`) and
 * frames that already have `id:` are left untouched. Split event/data writes
 * should use createSseEventCounter.write instead (see chats.js).
 */
function attachSseIds(res, req, options = {}) {
  // 3H5 leftover: fresh POST generate must not honor Last-Event-ID from a prior run
  // (would offset ids / skip client-side). GET reconnect streams still resume.
  const method = String((req && req.method) || '').toUpperCase();
  const freshPost = options.freshPost === true || (method === 'POST' && options.resume !== true);
  const startId = freshPost ? 0 : parseLastEventId(req);
  if (!res) return createSseEventCounter(startId);
  if (res._siragptSseAttached && res._sseCounter) return res._sseCounter;
  const counter = createSseEventCounter(startId);
  res._siragptSseAttached = true;
  res._sseCounter = counter;
  const rawWrite = typeof res.write === 'function' ? res.write.bind(res) : null;
  if (!rawWrite) return counter;
  res.write = function sseIdWrite(chunk, encoding, cb) {
    let s;
    if (Buffer.isBuffer(chunk)) s = chunk.toString(typeof encoding === 'string' ? encoding : 'utf8');
    else s = String(chunk == null ? '' : chunk);
    if (!s || s.startsWith(':') || /^id:\s?/m.test(s)) {
      return rawWrite(chunk, encoding, cb);
    }
    if (s.startsWith('data:') || s.startsWith('event:')) {
      const id = counter.next();
      return rawWrite(`id: ${id}\n${s}`, encoding, cb);
    }
    return rawWrite(chunk, encoding, cb);
  };
  return counter;
}

module.exports = {
  parseLastEventId,
  createSseEventCounter,
  formatSseFrame,
  attachSseIds,
};
