'use strict';

/**
 * streaming/bench.js — micro-benchmark for SSE TTFB and tokens/sec.
 *
 * Spins up a real http.Server that serves a mock provider stream of N
 * tokens at a configurable inter-token delay, and a real http.Server
 * that consumes those tokens through the shared SSE writer. We measure:
 *
 *   - TTFB (time-to-first-byte): elapsed wall time from request send to
 *     first non-comment SSE frame received by the client.
 *   - tokens/sec: total tokens streamed divided by total stream wall time.
 *
 * Runnable as:
 *   node backend/tests/streaming/bench.js
 *   node --test backend/tests/streaming/bench.js   # asserts thresholds
 *
 * Thresholds are lenient — this is a regression sentinel, not a flake
 * generator. If TTFB on a no-network mock stream exceeds 50 ms or
 * throughput falls below ~1k tokens/sec on a developer laptop, the SSE
 * path almost certainly regressed (the previous values are ~5 ms TTFB
 * and 50k+ tok/s in-process).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { performance } = require('node:perf_hooks');

const { createSSEWriter } = require('../../src/utils/sse-writer');

function startMockProvider({ tokenCount, gapMs }) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let i = 0;
    const tick = () => {
      if (i >= tokenCount) {
        res.write('event: done\ndata: {}\n\n');
        return res.end();
      }
      res.write(`data: ${JSON.stringify({ token: `t${i}` })}\n\n`);
      i += 1;
      if (gapMs > 0) setTimeout(tick, gapMs);
      else setImmediate(tick);
    };
    tick();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/**
 * Bridge mock-provider tokens to the SSE writer (the unit under test).
 */
function startBridge(providerPort) {
  const server = http.createServer(async (_req, res) => {
    const sse = createSSEWriter(res, { heartbeatMs: 60_000 });
    const provider = await fetch(`http://127.0.0.1:${providerPort}/`);
    const reader = provider.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop();
      for (const f of frames) {
        if (!f.startsWith('data:')) continue;
        const json = f.slice(5).trim();
        if (!json) continue;
        await sse.raw(`data: ${json}\n\n`);
      }
    }
    await sse.done();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function consumeStream(port) {
  const start = performance.now();
  const res = await fetch(`http://127.0.0.1:${port}/`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let firstByteAt = null;
  let firstTokenAt = null;
  let tokens = 0;
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (firstByteAt === null) firstByteAt = performance.now();
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop();
    for (const f of frames) {
      if (f.startsWith(':')) continue;            // heartbeat / preamble
      if (!f.startsWith('data:')) continue;
      if (f.includes('[DONE]')) continue;
      if (firstTokenAt === null) firstTokenAt = performance.now();
      tokens += 1;
    }
  }
  const end = performance.now();
  return {
    ttfbMs: firstByteAt - start,
    ttftMs: firstTokenAt - start,
    totalMs: end - start,
    tokens,
  };
}

async function runBench({ tokenCount = 200, gapMs = 0 } = {}) {
  const provider = await startMockProvider({ tokenCount, gapMs });
  const bridge = await startBridge(provider.address().port);
  try {
    const stats = await consumeStream(bridge.address().port);
    return {
      ...stats,
      tokensPerSec: stats.tokens > 0 ? stats.tokens / (stats.totalMs / 1000) : 0,
    };
  } finally {
    bridge.close();
    provider.close();
  }
}

if (require.main === module) {
  // Direct-run mode: print results and exit. Useful for ad-hoc profiling.
  runBench({ tokenCount: 1000, gapMs: 0 }).then((r) => {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    process.exit(0);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

test('bench: SSE writer TTFB stays under 100 ms on a localhost mock', async () => {
  const r = await runBench({ tokenCount: 50, gapMs: 0 });
  assert.ok(r.tokens === 50, `expected 50 tokens, got ${r.tokens}`);
  assert.ok(r.ttfbMs < 100, `TTFB regression: ${r.ttfbMs.toFixed(2)} ms`);
  assert.ok(r.ttftMs < 200, `TTFT regression: ${r.ttftMs.toFixed(2)} ms`);
});

test('bench: SSE writer sustains > 1k tokens/sec on a localhost mock', async () => {
  const r = await runBench({ tokenCount: 500, gapMs: 0 });
  assert.ok(r.tokensPerSec > 1000, `throughput regression: ${r.tokensPerSec.toFixed(0)} tok/s`);
});

module.exports = { runBench };
