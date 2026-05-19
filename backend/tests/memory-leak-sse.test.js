'use strict';

/**
 * Memory leak detection for long-running SSE streams.
 *
 * Spins up a tiny HTTP server that serves an SSE stream via `createSSEWriter`,
 * connects 100 clients, lets each receive a few frames, then disconnects.
 * Forces GC (requires `--expose-gc`) and asserts heap growth stays under 10 MB.
 *
 * TODO: if Node is launched without `--expose-gc`, this test logs a TODO and
 *   skips the assertion. To run for real:
 *
 *     node --expose-gc --test backend/tests/memory-leak-sse.test.js
 */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const http = require('node:http');

const { createSSEWriter } = require('../src/utils/sse-writer');

const HEAP_GROWTH_LIMIT_BYTES = 10 * 1024 * 1024;
const CLIENT_COUNT = 100;
const FRAMES_PER_CLIENT = 5;

function forceGc(times = 4) {
  if (typeof global.gc !== 'function') return false;
  for (let i = 0; i < times; i += 1) {
    try { global.gc(); } catch { /* ignore */ }
  }
  return true;
}

function makeServer() {
  return http.createServer(async (req, res) => {
    const sse = createSSEWriter(res, { heartbeatMs: 60_000 });
    try {
      for (let i = 0; i < FRAMES_PER_CLIENT; i += 1) {
        if (sse.closed) break;
        await sse.event({ i, payload: 'x'.repeat(64) });
      }
    } finally {
      sse.close();
    }
  });
}

function connectAndDrain(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/sse', method: 'GET' }, (res) => {
      res.setEncoding('utf8');
      res.on('data', () => { /* discard */ });
      res.on('end', resolve);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('memory-leak-sse', () => {
  it('does not grow heap beyond 10 MB after 100 connect/disconnect cycles', async () => {
    const gcAvailable = forceGc();
    if (!gcAvailable) {
      // eslint-disable-next-line no-console
      console.log('[memory-leak-sse] TODO: --expose-gc not present; skipping heap assertion.');
      return;
    }

    const server = makeServer();
    await new Promise((r) => server.listen(0, r));
    const { port } = server.address();

    // Warm up to JIT + steady-state allocate the SSE writer / heartbeat
    // module objects so they don't count as "growth".
    await connectAndDrain(port);
    forceGc();
    const heapBefore = process.memoryUsage().heapUsed;

    for (let i = 0; i < CLIENT_COUNT; i += 1) {
      // Sequential rather than parallel so the kernel send buffer / Node's
      // per-socket Buffer pool is reused. Parallel would inflate transient
      // heap unrelated to the leak we care about.
      // eslint-disable-next-line no-await-in-loop
      await connectAndDrain(port);
    }

    forceGc();
    // Two more passes — V8 sometimes defers free of large-old-space objects
    // until a second mark-sweep.
    forceGc();
    const heapAfter = process.memoryUsage().heapUsed;

    await new Promise((r) => server.close(r));

    const growth = heapAfter - heapBefore;
    assert.ok(
      growth < HEAP_GROWTH_LIMIT_BYTES,
      `heap grew ${growth} bytes (>${HEAP_GROWTH_LIMIT_BYTES}) across ${CLIENT_COUNT} SSE cycles`
    );
  });
});
