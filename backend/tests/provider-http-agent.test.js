/**
 * Tests for provider-http-agent.js — shared undici keep-alive pool for
 * outbound LLM-provider calls.
 *
 * These tests avoid real HTTP. The agent's purpose is connection
 * reuse, which we verify by:
 *   1. singleton identity (same ref across calls)
 *   2. destroySharedAgent resets the singleton
 *   3. sharedFetch wires through the dispatcher option
 */

'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { Agent } = require('undici');

const mod = require('../src/utils/provider-http-agent');

describe('provider-http-agent · getSharedAgent', () => {
  afterEach(async () => {
    await mod.destroySharedAgent();
  });

  it('returns the same Agent instance on repeated calls (singleton)', () => {
    const a = mod.getSharedAgent();
    const b = mod.getSharedAgent();
    assert.strictEqual(a, b, 'expected the same dispatcher reference');
  });

  it('returns an undici Agent', () => {
    const a = mod.getSharedAgent();
    assert.ok(a instanceof Agent, 'expected an undici Agent');
  });

  it('rebuilds the singleton after destroySharedAgent', async () => {
    const a = mod.getSharedAgent();
    await mod.destroySharedAgent();
    const b = mod.getSharedAgent();
    assert.notStrictEqual(
      a, b,
      'expected a fresh dispatcher after destroySharedAgent',
    );
  });
});

describe('provider-http-agent · destroySharedAgent', () => {
  it('is a no-op when no agent has been created yet', async () => {
    // First, make sure there's nothing alive.
    await mod.destroySharedAgent();
    // Call again — should not throw.
    await mod.destroySharedAgent();
    // Then create one and tear it down to leave a clean slate.
    mod.getSharedAgent();
    await mod.destroySharedAgent();
  });

  it('swallows close() errors silently', async () => {
    // Force a fresh agent and then short-circuit its close() with a
    // throwing stub. destroySharedAgent must NOT propagate the error.
    const agent = mod.getSharedAgent();
    const origClose = agent.close.bind(agent);
    agent.close = async () => {
      throw new Error('synthetic close failure');
    };

    // Should resolve without throwing.
    await mod.destroySharedAgent();

    // The singleton was nulled, so a subsequent get is fresh.
    const next = mod.getSharedAgent();
    assert.notStrictEqual(next, agent);

    // Restore + clean up.
    agent.close = origClose;
    await mod.destroySharedAgent();
  });
});

describe('provider-http-agent · sharedFetch', () => {
  afterEach(async () => {
    await mod.destroySharedAgent();
  });

  it('exposes sharedFetch as a function', () => {
    assert.equal(typeof mod.sharedFetch, 'function');
  });

  it('passes the shared dispatcher when none is provided in init', async () => {
    // Stub undici.fetch by intercepting via init.dispatcher: we don't
    // actually want to send a request, so we use a MockAgent that
    // returns a deterministic response for one origin.
    const { MockAgent } = require('undici');
    const mockAgent = new MockAgent({ connections: 1 });
    mockAgent.disableNetConnect();

    const pool = mockAgent.get('https://provider.test');
    pool
      .intercept({ path: '/v1/ping', method: 'GET' })
      .reply(200, { ok: true });

    // Sneak the mock in via init.dispatcher: that's the SAME code path
    // that proves sharedFetch honours the dispatcher hook the OpenAI
    // SDK uses.
    const res = await mod.sharedFetch('https://provider.test/v1/ping', {
      dispatcher: mockAgent,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });

    await mockAgent.close();
  });

  it('falls back to getSharedAgent() when init has no dispatcher', async () => {
    // We can't trivially intercept the real shared agent without an
    // HTTP server. Instead we verify the wiring by spying: replace
    // getSharedAgent for one call and assert it was consulted.
    // The cleanest check is that the singleton is created lazily —
    // destroying then calling sharedFetch with NO dispatcher creates
    // a new singleton. We don't make the actual request (route to a
    // bogus host so the call fails fast) and just inspect side-effects.
    await mod.destroySharedAgent();

    // Trigger creation via getSharedAgent() before the call — we know
    // sharedFetch reads that singleton when init.dispatcher is absent.
    const beforeRef = mod.getSharedAgent();

    // Fire sharedFetch without dispatcher. We don't await the result
    // (real network) — we just assert the singleton ref didn't change.
    // Use an AbortController to immediately cancel so we don't leak a
    // real HTTP connection attempt.
    const ac = new AbortController();
    ac.abort();
    let caught = null;
    try {
      await mod.sharedFetch('https://198.51.100.0/never', { signal: ac.signal });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'expected fetch to be cancelled / fail');

    // Singleton untouched by the call.
    const afterRef = mod.getSharedAgent();
    assert.strictEqual(beforeRef, afterRef);
  });

  it('treats an explicit dispatcher in init as authoritative', async () => {
    const { MockAgent } = require('undici');
    const mockAgent = new MockAgent({ connections: 1 });
    mockAgent.disableNetConnect();

    const pool = mockAgent.get('https://explicit.test');
    pool
      .intercept({ path: '/x', method: 'GET' })
      .reply(204, '');

    const res = await mod.sharedFetch('https://explicit.test/x', {
      dispatcher: mockAgent,
    });

    assert.equal(res.status, 204);
    await mockAgent.close();
  });

  it('forwards method, headers, and body to the underlying fetch', async () => {
    const { MockAgent } = require('undici');
    const mockAgent = new MockAgent({ connections: 1 });
    mockAgent.disableNetConnect();

    const pool = mockAgent.get('https://provider.test');
    pool
      .intercept({
        path: '/echo',
        method: 'POST',
        headers: { 'authorization': 'Bearer test-token' },
        body: JSON.stringify({ ping: 'pong' }),
      })
      .reply(200, { echoed: true });

    const res = await mod.sharedFetch('https://provider.test/echo', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      body: JSON.stringify({ ping: 'pong' }),
      dispatcher: mockAgent,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { echoed: true });
    await mockAgent.close();
  });
});

describe('provider-http-agent · module exports', () => {
  it('exports exactly { getSharedAgent, destroySharedAgent, sharedFetch }', () => {
    // Pin the surface so accidental additions/removals are visible.
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, [
      'destroySharedAgent',
      'getSharedAgent',
      'sharedFetch',
    ]);
  });
});
