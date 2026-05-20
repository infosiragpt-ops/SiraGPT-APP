'use strict';

function createSSEReplayBuffer({ maxEvents = 500, heartbeatMs = 15000 } = {}) {
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

function attachSSEStream(req, res, buffer = createSSEReplayBuffer()) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  for (const evt of buffer.since(req.headers['last-event-id'])) writeSSE(res, evt);
  const heartbeat = setInterval(() => {
    if (!res.destroyed) writeSSE(res, { event: 'heartbeat', data: { ts: Date.now() } });
  }, buffer.heartbeatMs);

  req.on('close', () => clearInterval(heartbeat));

  return {
    send(event, data) {
      const record = buffer.push(event, data);
      const ok = res.write(`id: ${record.id}\nevent: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
      return ok;
    },
    end() {
      clearInterval(heartbeat);
      res.end();
    },
  };
}

module.exports = { attachSSEStream, createSSEReplayBuffer, writeSSE };
