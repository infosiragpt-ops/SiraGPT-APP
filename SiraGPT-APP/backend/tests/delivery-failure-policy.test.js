'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

const {
  DeliveryFailurePolicy,
  InMemoryDLQStore,
  DeliveryError,
  classifyError,
  serializeError,
  TRANSIENT_HTTP,
  TRANSIENT_NET_CODES,
} = require('../src/utils/delivery-failure-policy');

describe('classifyError', () => {
  it('returns permanent for null/undefined', () => {
    assert.strictEqual(classifyError(null), 'permanent');
    assert.strictEqual(classifyError(undefined), 'permanent');
  });

  it('honors explicit poison flag (highest priority)', () => {
    assert.strictEqual(classifyError({ poison: true, transient: true }), 'poison');
  });

  it('honors explicit transient flag', () => {
    assert.strictEqual(classifyError({ transient: true }), 'transient');
    assert.strictEqual(classifyError({ transient: false }), 'permanent');
  });

  it('classifies transient HTTP statuses correctly', () => {
    for (const s of TRANSIENT_HTTP) {
      assert.strictEqual(classifyError({ status: s }), 'transient', `HTTP ${s}`);
    }
  });

  it('classifies 4xx (non-transient) as permanent', () => {
    assert.strictEqual(classifyError({ status: 400 }), 'permanent');
    assert.strictEqual(classifyError({ status: 401 }), 'permanent');
    assert.strictEqual(classifyError({ status: 404 }), 'permanent');
  });

  it('classifies non-listed 5xx as transient', () => {
    assert.strictEqual(classifyError({ status: 599 }), 'transient');
  });

  it('classifies known network error codes as transient', () => {
    for (const c of TRANSIENT_NET_CODES) {
      assert.strictEqual(classifyError({ code: c }), 'transient', `code ${c}`);
    }
  });

  it('treats AbortError as transient', () => {
    assert.strictEqual(classifyError({ name: 'AbortError' }), 'transient');
  });

  it('treats unknown errors as transient (let retry budget gate)', () => {
    assert.strictEqual(classifyError(new Error('mystery')), 'transient');
  });
});

describe('InMemoryDLQStore', () => {
  it('enforces capacity by FIFO eviction', () => {
    const store = new InMemoryDLQStore({ capacity: 3 });
    for (let i = 0; i < 5; i++) {
      store.enqueue({ id: `e${i}`, type: 't' });
    }
    assert.strictEqual(store.size(), 3);
    const ids = store.list().map(e => e.id).sort();
    assert.deepStrictEqual(ids, ['e2', 'e3', 'e4']);
  });

  it('rejects entries without an id', () => {
    const store = new InMemoryDLQStore();
    assert.throws(() => store.enqueue({}), DeliveryError);
  });

  it('remove() returns false for unknown ids', () => {
    const store = new InMemoryDLQStore();
    assert.strictEqual(store.remove('nope'), false);
  });

  it('clear() empties the store', () => {
    const store = new InMemoryDLQStore();
    store.enqueue({ id: 'a', type: 't' });
    store.enqueue({ id: 'b', type: 't' });
    store.clear();
    assert.strictEqual(store.size(), 0);
    assert.deepStrictEqual(store.list(), []);
  });
});

describe('DeliveryFailurePolicy — markExhausted', () => {
  let p;
  beforeEach(() => { p = new DeliveryFailurePolicy(); });

  it('rejects an envelope without a type', () => {
    assert.throws(() => p.markExhausted({}, new Error('x')), DeliveryError);
  });

  it('upgrades transient → permanent on exhaustion (force=true default)', () => {
    const entry = p.markExhausted({ type: 'webhook', payload: { a: 1 } }, { code: 'ECONNRESET' });
    assert.ok(entry);
    assert.strictEqual(entry.classification, 'permanent');
    assert.strictEqual(entry.type, 'webhook');
    assert.deepStrictEqual(entry.payload, { a: 1 });
    assert.strictEqual(p.size(), 1);
    assert.strictEqual(p.getMetrics().dlqEnqueued, 1);
  });

  it('with force=false, keeps a transient classification and skips DLQ', () => {
    const r = p.markExhausted({ type: 'webhook' }, { code: 'ECONNRESET' }, { force: false });
    assert.strictEqual(r, null);
    assert.strictEqual(p.size(), 0);
  });

  it('classifies a permanent-on-arrival error correctly', () => {
    const entry = p.markExhausted({ type: 'webhook' }, { status: 404 });
    assert.strictEqual(entry.classification, 'permanent');
  });

  it('enqueues poison after threshold permanent failures with the same dedupeKey', () => {
    const policy = new DeliveryFailurePolicy({ poisonThreshold: 3 });
    const env = { type: 'webhook', payload: 'x' };
    let last = null;
    for (let i = 0; i < 3; i++) {
      last = policy.markExhausted(env, { status: 404 }, { dedupeKey: 'wb-1' });
    }
    assert.ok(last);
    assert.strictEqual(last.classification, 'poison');
    assert.strictEqual(policy.list({ classification: 'poison' }).length, 1);
  });

  it('serialized error includes status, code and truncated message', () => {
    const longMsg = 'x'.repeat(800);
    const entry = p.markExhausted({ type: 'webhook' }, {
      name: 'HttpError',
      message: longMsg,
      code: 'EBADRESP',
      status: 502,
    });
    assert.strictEqual(entry.lastError.name, 'HttpError');
    assert.strictEqual(entry.lastError.code, 'EBADRESP');
    assert.strictEqual(entry.lastError.status, 502);
    assert.strictEqual(entry.lastError.message.length, 500);
  });
});

describe('DeliveryFailurePolicy — replay', () => {
  let p;
  beforeEach(() => { p = new DeliveryFailurePolicy(); });

  it('removes the entry on success and reports ok=true', async () => {
    const entry = p.markExhausted(
      { type: 'webhook', payload: { url: '/x' }, meta: { tries: 3 } },
      { code: 'ECONNRESET' },
    );
    let dispatched = null;
    const r = await p.replay(entry.id, async (payload, meta) => {
      dispatched = { payload, meta };
    });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(dispatched.payload, { url: '/x' });
    assert.deepStrictEqual(dispatched.meta, { tries: 3 });
    assert.strictEqual(p.size(), 0);
    const m = p.getMetrics();
    assert.strictEqual(m.dlqReplaySucceeded, 1);
    assert.strictEqual(m.dlqRemoved, 1);
  });

  it('keeps the entry on failure and updates lastError', async () => {
    const entry = p.markExhausted({ type: 'webhook' }, { status: 503 });
    const r = await p.replay(entry.id, async () => {
      const e = new Error('still failing');
      e.status = 502;
      throw e;
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.classification, 'transient');
    assert.strictEqual(p.size(), 1);
    const stored = p.list()[0];
    assert.strictEqual(stored.lastError.status, 502);
    assert.strictEqual(stored.replayCount, 1);
    assert.strictEqual(p.getMetrics().dlqReplayFailed, 1);
  });

  it('rejects unknown ids', async () => {
    await assert.rejects(p.replay('nope', async () => {}), err => err instanceof DeliveryError && err.code === 'dlq_not_found');
  });

  it('rejects when dispatcher is not a function', async () => {
    const entry = p.markExhausted({ type: 'webhook' }, { status: 500 });
    await assert.rejects(p.replay(entry.id, null), DeliveryError);
  });

  it('does not downgrade a poison classification to transient on replay', async () => {
    const policy = new DeliveryFailurePolicy({ poisonThreshold: 1 });
    const entry = policy.markExhausted({ type: 'wh' }, { status: 404 }, { dedupeKey: 'k' });
    assert.strictEqual(entry.classification, 'poison');
    await policy.replay(entry.id, async () => { throw { transient: true, message: 'ok-now-no' }; });
    const stored = policy.list()[0];
    assert.strictEqual(stored.classification, 'poison');
  });
});

describe('DeliveryFailurePolicy — list / remove / clear / metrics', () => {
  it('list filters by classification and type', () => {
    const p = new DeliveryFailurePolicy({ poisonThreshold: 2 });
    p.markExhausted({ type: 'a' }, { status: 404 });                       // permanent
    p.markExhausted({ type: 'b' }, { status: 503 });                       // permanent (force=true)
    p.markExhausted({ type: 'a' }, { status: 404 }, { dedupeKey: 'k' });   // permanent (poison count=1)
    p.markExhausted({ type: 'a' }, { status: 404 }, { dedupeKey: 'k' });   // poison (count=2)

    assert.strictEqual(p.list({ classification: 'permanent' }).length, 3);
    assert.strictEqual(p.list({ classification: 'poison' }).length, 1);
    assert.strictEqual(p.list({ type: 'a' }).length, 3);
    assert.strictEqual(p.list({ classification: 'permanent', type: 'a' }).length, 2);
    assert.strictEqual(p.list({ classification: 'permanent', type: 'b' }).length, 1);
  });

  it('remove() decrements size and updates metrics', () => {
    const p = new DeliveryFailurePolicy();
    const e = p.markExhausted({ type: 't' }, { status: 500 });
    assert.strictEqual(p.size(), 1);
    assert.strictEqual(p.remove(e.id), true);
    assert.strictEqual(p.size(), 0);
    assert.strictEqual(p.getMetrics().dlqRemoved, 1);
  });

  it('clear() drops every entry and resets poison history', () => {
    const p = new DeliveryFailurePolicy({ poisonThreshold: 2 });
    p.markExhausted({ type: 't' }, { status: 404 }, { dedupeKey: 'p' });
    p.markExhausted({ type: 't' }, { status: 404 }, { dedupeKey: 'p' });
    assert.strictEqual(p.list({ classification: 'poison' }).length, 1);
    p.clear();
    assert.strictEqual(p.size(), 0);
    // After clear, dedupe count restarts.
    p.markExhausted({ type: 't' }, { status: 404 }, { dedupeKey: 'p' });
    assert.strictEqual(p.list({ classification: 'poison' }).length, 0);
    assert.strictEqual(p.list({ classification: 'permanent' }).length, 1);
  });

  it('getMetrics returns a defensive copy', () => {
    const p = new DeliveryFailurePolicy();
    p.markExhausted({ type: 't' }, { status: 503 });
    const m1 = p.getMetrics();
    m1.dlqEnqueued = 999;
    const m2 = p.getMetrics();
    assert.notStrictEqual(m2.dlqEnqueued, 999);
  });
});

describe('serializeError', () => {
  it('returns null for null input', () => {
    assert.strictEqual(serializeError(null), null);
  });

  it('truncates long messages to 500 chars', () => {
    const r = serializeError({ message: 'a'.repeat(1000) });
    assert.strictEqual(r.message.length, 500);
  });

  it('coerces non-string messages', () => {
    const r = serializeError({ message: 123 });
    assert.strictEqual(r.message, '123');
  });

  it('falls back to String(err) when message is missing', () => {
    const r = serializeError({});
    assert.strictEqual(typeof r.message, 'string');
    assert.strictEqual(r.name, 'Error');
  });
});
