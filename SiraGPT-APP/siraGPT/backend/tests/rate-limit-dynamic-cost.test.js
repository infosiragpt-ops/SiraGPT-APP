'use strict';

/**
 * rate-limit-dynamic-cost — exercises the cost-based limiter:
 *
 *   - Upfront charge: tryConsume rejects bursty callers before the
 *     handler runs, identical to the static bucket.
 *   - Reconciliation: when a handler reports tokens/cpuMs, the bucket
 *     debits the difference against the upfront charge.
 *   - Refunds: a cheaper-than-expected request gets tokens back, but
 *     never above capacity.
 *   - Clamping: a runaway report cannot push the bucket negative.
 *   - Manual flush vs auto flush via `finish`/`close`.
 *   - Late reports after flush are counted but ignored.
 *
 * Tests use a shared fake clock + an injected registry so refills are
 * deterministic and we can assert remaining-token math precisely.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  TokenBucketRegistry,
  TokenBucket,
} = require('../src/rate-limit/token-bucket');
const {
  createDynamicCostMiddleware,
  defaultCostFn,
} = require('../src/rate-limit/dynamic-cost');

function makeFakeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => { now += ms; },
  };
}

function makeRes() {
  const headers = {};
  const res = new EventEmitter();
  res.headersSent = false;
  res.statusCode = 200;
  res.setHeader = (k, v) => { headers[k] = v; };
  res.getHeader = (k) => headers[k];
  res.headers = headers;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.end = () => { res.ended = true; };
  return res;
}

function makeReq({ ip = '1.2.3.4' } = {}) {
  return { ip };
}

describe('TokenBucket.adjust + Registry.adjust', () => {
  test('positive delta debits, negative refunds, both clamped', () => {
    const clock = makeFakeClock();
    const b = new TokenBucket({ capacity: 10, refillRate: 1, clock: clock.now });
    let r = b.adjust(3); // 10 - 3 = 7
    assert.equal(r.remaining, 7);
    r = b.adjust(-100); // refund clamped at capacity
    assert.equal(r.remaining, 10);
    r = b.adjust(50); // debit clamped at 0
    assert.equal(r.remaining, 0);
  });

  test('non-finite delta throws', () => {
    const b = new TokenBucket({ capacity: 5, refillRate: 1 });
    assert.throws(() => b.adjust(Number.NaN), /finite/);
  });

  test('registry.adjust touches the bucket so it survives reaping', () => {
    const clock = makeFakeClock();
    const reg = new TokenBucketRegistry({
      capacity: 5,
      refillRate: 1,
      idleTtlMs: 1000,
      clock: clock.now,
    });
    reg.consume('k', 1); // creates bucket, 4 left
    clock.advance(2000); // older than idleTtlMs
    reg.adjust('k', -10); // refund — also touches lastTouched
    clock.advance(10);
    // adjust should have touched it, so a subsequent consume sees the
    // same bucket (full because refill + refund), not a fresh one
    const r = reg.consume('k', 1);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 4);
  });
});

describe('defaultCostFn', () => {
  test('combines tokens and cpuMs additively with baseCost', () => {
    const cost = defaultCostFn({
      baseCost: 1,
      report: { tokens: 2000, cpuMs: 200 },
      cpuMs: 0,
    });
    // 1 + 2000/1000 + 200/100 = 1 + 2 + 2 = 5
    assert.equal(cost, 5);
  });

  test('extraCost adds to the bill, negative is ignored', () => {
    const cost = defaultCostFn({
      baseCost: 1,
      report: { extraCost: 4 },
      cpuMs: 0,
    });
    assert.equal(cost, 5);
    const cost2 = defaultCostFn({
      baseCost: 1,
      report: { extraCost: -100 },
      cpuMs: 0,
    });
    assert.equal(cost2, 1);
  });

  test('clamps to MAX_DYNAMIC_COST', () => {
    const cost = defaultCostFn({
      baseCost: 1,
      report: { tokens: 10 ** 12 },
      cpuMs: 0,
    });
    assert.ok(cost <= 1_000_000);
  });
});

describe('createDynamicCostMiddleware', () => {
  function buildMiddleware(overrides = {}) {
    const clock = makeFakeClock();
    const registry = new TokenBucketRegistry({
      capacity: 10,
      refillRate: 1,
      clock: clock.now,
    });
    const mw = createDynamicCostMiddleware({
      route: 'test',
      capacity: 10,
      refillRate: 1,
      registry,
      clock: clock.now,
      measureCpu: false,
      ...overrides,
    });
    return { mw, registry, clock };
  }

  test('charges upfront and reconciles on auto-flush (finish)', () => {
    const { mw, registry } = buildMiddleware();
    const req = makeReq();
    const res = makeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.headers['RateLimit-Remaining'], '9'); // -1 upfront

    req.reportRateCost({ tokens: 4000 }); // +4 cost
    res.emit('finish');

    // Remaining should be 10 - (1 + 4) = 5
    assert.equal(res.headers['RateLimit-Remaining'], '5');
    // Subsequent direct registry consume confirms bucket state
    const probe = registry.consume('test|ip:1.2.3.4', 1);
    assert.equal(probe.remaining, 4);
  });

  test('manual flush via req.flushRateCost', () => {
    const { mw } = buildMiddleware();
    const req = makeReq();
    const res = makeRes();
    mw(req, res, () => {});
    req.reportRateCost({ tokens: 2000 });
    const info = req.flushRateCost();
    assert.equal(info.upfront, 1);
    assert.equal(info.finalCost, 3);
    assert.equal(info.delta, 2);
    // A second flush is a no-op
    const info2 = req.flushRateCost();
    assert.equal(info2.delta, 2); // same flushInfo returned
  });

  test('refunds when actual cost is lower than upfront', () => {
    const { mw, registry } = buildMiddleware({
      initialCost: 5,
      // costFn that ignores tokens and reports a tiny final cost
      costFn: () => 1,
    });
    const req = makeReq();
    const res = makeRes();
    mw(req, res, () => {});
    // Upfront charged 5, final cost 1 ⇒ refund 4
    res.emit('finish');
    const probe = registry.consume('test|ip:1.2.3.4', 1);
    // Capacity 10 - 5 (upfront) + 4 (refund) - 1 (probe) = 8
    assert.equal(probe.remaining, 8);
  });

  test('429 on upfront exhaustion before handler runs', () => {
    const { mw } = buildMiddleware({ initialCost: 11 });
    const req = makeReq();
    const res = makeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.error, 'rate_limited');
    assert.ok(res.headers['Retry-After']);
  });

  test('runaway report cannot push bucket negative', () => {
    const { mw, registry } = buildMiddleware();
    const req = makeReq();
    const res = makeRes();
    mw(req, res, () => {});
    req.reportRateCost({ tokens: 10 ** 9 }); // huge cost
    res.emit('finish');
    // Bucket clamped to 0; next consume must reject
    const probe = registry.consume('test|ip:1.2.3.4', 1);
    assert.equal(probe.allowed, false);
  });

  test('late reportRateCost after flush is recorded as a late counter', () => {
    const { mw } = buildMiddleware();
    const req = makeReq();
    const res = makeRes();
    mw(req, res, () => {});
    req.reportRateCost({ tokens: 1000 });
    req.flushRateCost();
    const accepted = req.reportRateCost({ tokens: 5000 });
    assert.equal(accepted, false);
    assert.equal(req._rateCostLateReport, 1);
  });

  test('skip bypasses both charge and reconciliation', () => {
    const { mw, registry } = buildMiddleware({ skip: () => true });
    const req = makeReq();
    const res = makeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.reportRateCost, undefined);
    // No bucket created
    assert.equal(registry.size(), 0);
  });

  test('keyGenerator isolates principals', () => {
    const { mw, registry } = buildMiddleware({
      initialCost: 5,
      keyGenerator: (r) => `user:${r.userId}`,
    });
    const r1 = makeReq(); r1.userId = 'a';
    const r2 = makeReq(); r2.userId = 'b';
    const res1 = makeRes();
    const res2 = makeRes();
    mw(r1, res1, () => {});
    mw(r2, res2, () => {});
    // Each principal has its own bucket — both got 5 charged from 10
    assert.equal(res1.headers['RateLimit-Remaining'], '5');
    assert.equal(res2.headers['RateLimit-Remaining'], '5');
    assert.equal(registry.size(), 2);
  });

  test('close event also triggers auto-flush (client abort)', () => {
    const { mw, registry } = buildMiddleware();
    const req = makeReq();
    const res = makeRes();
    mw(req, res, () => {});
    req.reportRateCost({ tokens: 3000 });
    res.emit('close'); // client cut the connection
    const probe = registry.consume('test|ip:1.2.3.4', 1);
    // 10 - 1 (upfront) - 3 (extra after report = 4 final - 1 upfront) - 1 = 5
    assert.equal(probe.remaining, 5);
  });

  test('throws without a route label', () => {
    assert.throws(
      () => createDynamicCostMiddleware({ capacity: 1, refillRate: 1 }),
      /route label/,
    );
  });

  test('throws on non-function costFn', () => {
    assert.throws(
      () => createDynamicCostMiddleware({
        route: 'r', capacity: 1, refillRate: 1, costFn: 'nope',
      }),
      /costFn/,
    );
  });

  test('custom costFn receives baseCost, report, cpuMs', () => {
    const seen = [];
    const { mw } = buildMiddleware({
      initialCost: 2,
      costFn: (input) => { seen.push(input); return 3; },
    });
    const req = makeReq();
    const res = makeRes();
    mw(req, res, () => {});
    req.reportRateCost({ tokens: 500, cpuMs: 50, extraCost: 0.5 });
    res.emit('finish');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].baseCost, 2);
    assert.equal(seen[0].report.tokens, 500);
    assert.equal(seen[0].report.cpuMs, 50);
    assert.equal(seen[0].report.extraCost, 0.5);
    assert.equal(typeof seen[0].cpuMs, 'number');
  });

  test('measureCpu auto-instruments handler when enabled', () => {
    // Doesn't assert exact CPU (non-deterministic) — just that the
    // value passed to costFn is a non-negative finite number.
    const observed = [];
    const reg = new TokenBucketRegistry({ capacity: 100, refillRate: 1 });
    const mw = createDynamicCostMiddleware({
      route: 'cpu',
      capacity: 100,
      refillRate: 1,
      registry: reg,
      measureCpu: true,
      costFn: ({ cpuMs }) => { observed.push(cpuMs); return 1; },
    });
    const req = makeReq();
    const res = makeRes();
    mw(req, res, () => {});
    // Burn a little CPU
    let acc = 0;
    for (let i = 0; i < 10000; i += 1) acc += Math.sqrt(i);
    res.emit('finish');
    assert.equal(observed.length, 1);
    assert.ok(Number.isFinite(observed[0]));
    assert.ok(observed[0] >= 0);
    // Reference acc to keep the JIT from eliding the loop
    assert.ok(Number.isFinite(acc));
  });

  test('multiple reportRateCost calls accumulate', () => {
    const { mw, registry } = buildMiddleware();
    const req = makeReq();
    const res = makeRes();
    mw(req, res, () => {});
    req.reportRateCost({ tokens: 1000 });
    req.reportRateCost({ tokens: 1000 });
    req.reportRateCost({ cpuMs: 100 });
    res.emit('finish');
    // final = 1 (base) + 2 (tokens) + 1 (cpu) = 4 ⇒ debited 4
    const probe = registry.consume('test|ip:1.2.3.4', 1);
    assert.equal(probe.remaining, 5); // 10 - 4 - 1
  });
});
