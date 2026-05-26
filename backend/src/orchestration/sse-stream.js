'use strict';

const zlib = require('node:zlib');

const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_HEARTBEAT_MS = 15000;
const DEFAULT_MAX_BACKPRESSURE_MS = 5000;
const DEFAULT_MAX_RETRIES = 5;

function createSSEReplayBuffer({ maxEvents = DEFAULT_MAX_EVENTS, heartbeatMs = DEFAULT_HEARTBEAT_MS } = {}) {
  const events = [];
  let nextId = 1;

  function push(event, data) {
    const record = { id: String(nextId++), event, data, ts: Date.now() };
    events.push(record);
    while (events.length > maxEvents) events.shift();
    return record;
  }

  function since(lastEventId) {
    if (!lastEventId) return [];
    const numeric = Number(lastEventId);
    return events.filter(evt => Number(evt.id) > numeric);
  }

  return { heartbeatMs, push, since, size: () => events.length };
}

function writeSSE(res, { id, event, data }) {
  if (id) res.write(`id: ${id}\n`);
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data ?? {})}\n\n`);
}

function drainPromise(res, maxWaitMs = DEFAULT_MAX_BACKPRESSURE_MS) {
  if (res.writableNeedDrain !== true) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      res.off('drain', onDrain);
      resolve();
    }, maxWaitMs);
    function onDrain() {
      clearTimeout(timer);
      res.off('drain', onDrain);
      resolve();
    }
    res.once('drain', onDrain);
  });
}

function createSSEBatchWriter({ maxBatchSize = 16, flushMs = 50 } = {}) {
  let queue = [];
  let flushTimer = null;
  let writer = null;

  function enqueue(record, res) {
    queue.push(record);
    if (!writer) writer = { res, flush: () => doFlush(res) };
    if (queue.length >= maxBatchSize) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      doFlush(res);
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (queue.length > 0) doFlush(res);
      }, flushMs);
    }
  }

  function doFlush(res) {
    const batch = queue;
    queue = [];
    if (batch.length === 0) return;
    let payload = '';
    for (const rec of batch) {
      if (rec.id) payload += `id: ${rec.id}\n`;
      if (rec.event) payload += `event: ${rec.event}\n`;
      payload += `data: ${JSON.stringify(rec.data ?? {})}\n\n`;
    }
    res.write(payload);
  }

  function flushAndClear(res) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    doFlush(res);
    writer = null;
  }

  return { enqueue, flushAndClear };
}

function attachSSEStream(req, res, buffer = createSSEReplayBuffer()) {
  const acceptsGzip = String(req.headers['accept-encoding'] || '').includes('gzip');
  const compressionEnabled = acceptsGzip;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  if (compressionEnabled) {
    res.setHeader('Content-Encoding', 'gzip');
    const gzip = zlib.createGzip({ level: 3 });
    gzip.pipe(res);
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    let gzipClosed = false;

    gzip.on('close', () => { gzipClosed = true; });
    gzip.on('error', () => { gzipClosed = true; });

    res.write = function (chunk, ...args) {
      if (gzipClosed) return false;
      return gzip.write(chunk, ...args);
    };
    res.end = function (chunk, ...args) {
      if (!gzipClosed) {
        if (chunk) gzip.write(chunk);
        gzip.end();
      }
      return originalEnd.call(res);
    };
    res.flushHeaders?.();
  } else {
    res.flushHeaders?.();
  }

  const replayEvents = buffer.since(req.headers['last-event-id']);
  for (const evt of replayEvents) writeSSE(res, evt);

  const heartbeat = setInterval(() => {
    if (res.destroyed) return;
    writeSSE(res, { event: 'heartbeat', data: { ts: Date.now() } });
  }, buffer.heartbeatMs);

  req.on('close', () => clearInterval(heartbeat));
  res.on('close', () => clearInterval(heartbeat));

  return {
    send(event, data) {
      const record = buffer.push(event, data);
      return res.write(`id: ${record.id}\nevent: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
    },

    async sendSafe(event, data) {
      const success = this.send(event, data);
      if (success === false) await drainPromise(res);
      return success;
    },

    async end() {
      clearInterval(heartbeat);
      res.end();
    },

    get writable() { return !res.destroyed; },
    get bufferSize() { return buffer.size(); },
  };
}

module.exports = {
  attachSSEStream,
  createSSEBatchWriter,
  createSSEReplayBuffer,
  drainPromise,
  writeSSE,
};
