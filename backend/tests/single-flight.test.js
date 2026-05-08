'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

const {
  SingleFlight,
  SingleFlightError,
  SingleFlightTimeoutError,
  getSingleFlight,
  resetSingleFlightForTests,
} = require('../src/cache/single-flight');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('SingleFlight — input validation', () => {
  it('rejects empty key', async () => {
    const sf = new SingleFlight();
    await assert.rejects(sf.do('', async () => 1), SingleFlightError);
    await assert.rejects(sf.do(null, async () => 1), SingleFlightError);
  });

  it('rejects non-function work', async () => {
    const sf = new SingleFlight();
    await assert.rejects(sf.do('k', null), SingleFlightError);
    await assert.rejects(sf.do('k', 'not-a-fn'), SingleFlightError);
  });
});

describe('SingleFlight — coalescing', () => {
  let sf;
  beforeEach(() => { sf = new SingleFlight(); });

  it('runs work() exactly once for concurrent callers with the same key', async () => {
    let calls = 0;
    const d = deferred();
    const work = async () => { calls += 1; return d.promise; };

    const p1 = sf.do('k', work);
    const p2 = sf.do('k', work);
    const p3 = sf.do('k', work);

    assert.strictEqual(sf.size(), 1);
    d.resolve('value');

    const results = await Promise.all([p1, p2, p3]);
    assert.deepStrictEqual(results, ['value', 'value', 'value']);
    assert.strictEqual(calls, 1);

    const m = sf.getMetrics();
    assert.strictEqual(m.leaders, 1);
    assert.strictEqual(m.shared, 2);
  });

  it('keys are independent', async () => {
    let aCalls = 0, bCalls = 0;
    const da = deferred(), db = deferred();
    const pa = sf.do('a', async () => { aCalls += 1; return da.promise; });
    const pb = sf.do('b', async () => { bCalls += 1; return db.promise; });
    assert.strictEqual(sf.size(), 2);
    da.resolve('A');
    db.resolve('B');
    assert.deepStrictEqual(await Promise.all([pa, pb]), ['A', 'B']);
    assert.strictEqual(aCalls, 1);
    assert.strictEqual(bCalls, 1);
  });

  it('a sequential call after settlement runs the work again', async () => {
    let calls = 0;
    const work = async () => { calls += 1; return calls; };
    const r1 = await sf.do('k', work);
    const r2 = await sf.do('k', work);
    assert.strictEqual(r1, 1);
    assert.strictEqual(r2, 2);
    assert.strictEqual(sf.getMetrics().leaders, 2);
  });
});

describe('SingleFlight — error propagation', () => {
  let sf;
  beforeEach(() => { sf = new SingleFlight(); });

  it('rejects every waiter with the same error', async () => {
    const d = deferred();
    const work = () => d.promise;
    const p1 = sf.do('k', work);
    const p2 = sf.do('k', work);
    d.reject(new Error('boom'));
    await assert.rejects(p1, /boom/);
    await assert.rejects(p2, /boom/);
    assert.strictEqual(sf.getMetrics().errors, 1);
  });

  it('does not poison the key — next call gets a fresh attempt', async () => {
    let calls = 0;
    const trial = async () => {
      calls += 1;
      if (calls === 1) throw new Error('first fail');
      return 'ok';
    };
    await assert.rejects(sf.do('k', trial), /first fail/);
    const r = await sf.do('k', trial);
    assert.strictEqual(r, 'ok');
    assert.strictEqual(calls, 2);
  });

  it('synchronously-thrown errors become rejected promises', async () => {
    await assert.rejects(sf.do('k', () => { throw new Error('sync'); }), /sync/);
    assert.strictEqual(sf.size(), 0);
  });
});

describe('SingleFlight — forget / clear', () => {
  let sf;
  beforeEach(() => { sf = new SingleFlight(); });

  it('forget() clears an in-flight entry; new calls re-execute', async () => {
    let calls = 0;
    const d1 = deferred();
    const p1 = sf.do('k', () => { calls += 1; return d1.promise; });
    assert.strictEqual(sf.size(), 1);
    assert.strictEqual(sf.forget('k'), true);
    assert.strictEqual(sf.size(), 0);

    // The original waiter still settles when d1 resolves.
    const d2 = deferred();
    const p2 = sf.do('k', () => { calls += 1; return d2.promise; });
    assert.strictEqual(calls, 2);
    d1.resolve('first');
    d2.resolve('second');
    assert.strictEqual(await p1, 'first');
    assert.strictEqual(await p2, 'second');
    assert.strictEqual(sf.getMetrics().forgotten, 1);
  });

  it('forget() returns false for unknown keys', () => {
    assert.strictEqual(sf.forget('nope'), false);
  });

  it('clear() drops every in-flight entry', async () => {
    const d = deferred();
    const ps = [
      sf.do('a', () => d.promise),
      sf.do('b', () => d.promise),
      sf.do('c', () => d.promise),
    ];
    assert.strictEqual(sf.size(), 3);
    assert.strictEqual(sf.clear(), 3);
    assert.strictEqual(sf.size(), 0);
    d.resolve('x');
    await Promise.all(ps);
  });
});

describe('SingleFlight — timeout', () => {
  // Work functions that hang forever use `new Promise(() => {})`. Nothing
  // outside the SingleFlight references that promise; once the timeout
  // fires and the entry is forgotten, the promise is unreachable and gets
  // collected. Using a deferred() here would leave a settle-able promise
  // dangling at test end, which node:test flags as a pending resolution.
  const hangForever = () => new Promise(() => {});

  it('rejects waiters with SingleFlightTimeoutError after timeoutMs', async () => {
    const sf = new SingleFlight();
    const p = sf.do('k', hangForever, { timeoutMs: 30 });
    await assert.rejects(p, err => err instanceof SingleFlightTimeoutError && err.key === 'k');
    assert.strictEqual(sf.getMetrics().timeouts, 1);
    // Entry is detached so future calls retry the work.
    assert.strictEqual(sf.size(), 0);
  });

  it('default timeout via constructor applies when no per-call override', async () => {
    const sf = new SingleFlight({ defaultTimeoutMs: 30 });
    await assert.rejects(sf.do('k', hangForever), SingleFlightTimeoutError);
  });

  it('per-call timeoutMs=0 disables timeout even when default is set', async () => {
    const sf = new SingleFlight({ defaultTimeoutMs: 5 });
    const d = deferred();
    const p = sf.do('k', () => d.promise, { timeoutMs: 0 });
    setTimeout(() => d.resolve('ok'), 30);
    assert.strictEqual(await p, 'ok');
  });
});

describe('SingleFlight — singleton', () => {
  it('returns the same instance from getSingleFlight()', () => {
    resetSingleFlightForTests();
    const a = getSingleFlight();
    const b = getSingleFlight();
    assert.strictEqual(a, b);
    resetSingleFlightForTests();
    const c = getSingleFlight();
    assert.notStrictEqual(a, c);
  });
});

describe('SingleFlight — observability', () => {
  it('keys() returns the in-flight key list', async () => {
    const sf = new SingleFlight();
    const d = deferred();
    const ps = [
      sf.do('alpha', () => d.promise),
      sf.do('beta', () => d.promise),
    ];
    assert.deepStrictEqual(sf.keys().sort(), ['alpha', 'beta']);
    d.resolve('x');
    await Promise.all(ps);
    assert.strictEqual(sf.size(), 0);
  });
});
