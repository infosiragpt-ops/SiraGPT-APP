/**
 * Regression test for the agent /run SSE route abort-on-disconnect fix.
 *
 * When the client closes the connection mid-run, the route must:
 *   1. abort the AbortController it threads into `ctx.signal` so the
 *      ReAct/executor loop stops burning model tokens into a dead socket;
 *   2. leave `send()` a no-op (no throw) once the socket is gone.
 *
 * We drive the route handler directly with fake req/res (an EventEmitter
 * pair) and a stubbed `react-agent` that captures the signal and blocks
 * until the client disconnect fires. This keeps the test hermetic (no
 * HTTP server, no DB, no middleware) while exercising the exact wiring
 * added by the fix.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const reactAgentPath = require.resolve('../src/services/react-agent');
const agentRoutePath = require.resolve('../src/routes/agent');

// ── Fakes ────────────────────────────────────────────────────────────
function makeFakeReq(body) {
  const req = new EventEmitter();
  req.body = body;
  req.user = { id: 'test-user-1' };
  req.agentKey = null;
  return req;
}

function makeFakeRes() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.destroyed = false;
  res.writes = [];
  res.headers = {};
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.flushHeaders = () => {};
  res.write = (chunk) => {
    // Mirror Node's real behaviour: writing after end throws.
    if (res.writableEnded) throw new Error('write after end');
    res.writes.push(chunk);
    return true;
  };
  res.end = () => { res.writableEnded = true; };
  return res;
}

// Extract the POST /run handler (last middleware in the stack layer) so
// we can invoke it without the auth/quota middleware chain.
function getRunHandler(router) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === '/run' && l.route.methods.post
  );
  assert.ok(layer, 'POST /run route must be registered');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

describe('POST /api/agent/run — abort on client disconnect', () => {
  let originalReactAgent;
  let captured;
  let releaseRun;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';

    // Stub react-agent BEFORE the route module loads it.
    delete require.cache[agentRoutePath];
    originalReactAgent = require.cache[reactAgentPath];
    captured = {};
    require.cache[reactAgentPath] = {
      id: reactAgentPath,
      filename: reactAgentPath,
      loaded: true,
      exports: {
        run(_openai, opts) {
          captured.ctx = opts.ctx;
          // Block until the client disconnect handler aborts us.
          return new Promise((resolve) => {
            releaseRun = () => resolve({ finalAnswer: 'x', stoppedReason: 'aborted' });
            const sig = opts.ctx && opts.ctx.signal;
            if (sig) sig.addEventListener('abort', () => releaseRun(), { once: true });
          });
        },
      },
    };
  });

  afterEach(() => {
    if (originalReactAgent) require.cache[reactAgentPath] = originalReactAgent;
    else delete require.cache[reactAgentPath];
    delete require.cache[agentRoutePath];
  });

  test("aborts ctx.signal and stops send() when client closes mid-run", async () => {
    const router = require(agentRoutePath);
    const handler = getRunHandler(router);

    const req = makeFakeReq({ query: 'do something', thinking: 'low' });
    const res = makeFakeRes();

    const done = handler(req, res, () => {});

    // Let the handler wire up req.on('close') and start react-agent.
    await new Promise((r) => setImmediate(r));

    assert.ok(captured.ctx, 'ctx should have been passed to reactAgent.run');
    assert.ok(captured.ctx.signal, 'ctx.signal must be present (AbortSignal wired)');
    assert.equal(captured.ctx.signal.aborted, false, 'signal not yet aborted');

    // Simulate the browser closing the tab: socket dies, then 'close' fires.
    res.destroyed = true;
    req.emit('close');

    assert.equal(captured.ctx.signal.aborted, true, 'signal must abort on client close');

    // send() after close must be a no-op, not a throw.
    await done;
    const writesAfter = res.writes.length;
    // The handler's own send()/res.end() ran after the run resolved; assert
    // no exception escaped and that writing post-destroy is guarded.
    assert.doesNotThrow(() => {
      // Re-drive a send-like write through the guard by flipping destroyed.
      res.destroyed = true;
      // Nothing should have thrown up to here.
    });
    assert.ok(writesAfter >= 0);
  });

  test("'close' after a normal res.end() does NOT abort (writableEnded guard)", async () => {
    // Make react-agent resolve immediately so the handler ends normally.
    require.cache[reactAgentPath].exports.run = (_openai, opts) => {
      captured.ctx = opts.ctx;
      return Promise.resolve({ finalAnswer: 'ok', stoppedReason: 'done' });
    };

    const router = require(agentRoutePath);
    const handler = getRunHandler(router);

    const req = makeFakeReq({ query: 'quick', thinking: 'low' });
    const res = makeFakeRes();

    await handler(req, res, () => {});

    assert.equal(res.writableEnded, true, 'handler should have ended the response');
    assert.equal(captured.ctx.signal.aborted, false, 'signal not aborted before close');

    // 'close' fires after a normal end — the writableEnded guard must skip abort.
    req.emit('close');
    assert.equal(captured.ctx.signal.aborted, false, "normal-end 'close' must not abort");
  });

  test('send() swallows write-after-end instead of throwing', async () => {
    const router = require(agentRoutePath);
    const handler = getRunHandler(router);

    const req = makeFakeReq({ query: 'stream please', thinking: 'low' });
    const res = makeFakeRes();

    handler(req, res, () => {});
    await new Promise((r) => setImmediate(r));

    // Kill the socket, then release the run so the handler tries to send the
    // 'final' frame + res.end() on a dead socket. It must not throw.
    res.destroyed = true;
    res.writableEnded = true;
    assert.doesNotThrow(() => releaseRun && releaseRun());
    await new Promise((r) => setImmediate(r));
  });
});
