'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  Saga,
  SagaError,
  STATUS,
  MODE,
} = require('../src/services/agents/saga-coordinator');

describe('Saga — construction & step registration', () => {
  it('rejects unknown mode', () => {
    assert.throws(() => new Saga({ mode: 'weird' }), SagaError);
  });

  it('rejects step with missing forward', () => {
    const s = new Saga();
    assert.throws(() => s.step({ name: 'x' }), SagaError);
    assert.throws(() => s.step({ name: '', forward: () => {} }), SagaError);
  });

  it('rejects duplicate step names', () => {
    const s = new Saga();
    s.step({ name: 'a', forward: async () => 1 });
    assert.throws(() => s.step({ name: 'a', forward: async () => 2 }), SagaError);
  });

  it('rejects non-function compensate', () => {
    const s = new Saga();
    assert.throws(() => s.step({ name: 'x', forward: async () => {}, compensate: 42 }), SagaError);
  });

  it('runs to completion with zero steps', async () => {
    const s = new Saga();
    const r = await s.run({ initial: 1 });
    assert.strictEqual(r.status, 'completed');
    assert.deepStrictEqual(r.steps, []);
    assert.deepStrictEqual(r.compensations, []);
    assert.deepStrictEqual(r.context, { initial: 1 });
  });
});

describe('Saga — sequential mode happy path', () => {
  it('runs every step in order and reports completed', async () => {
    const order = [];
    const saga = new Saga({ name: 'happy' })
      .step({ name: 'a', forward: async ctx => { order.push('a'); return 'A'; } })
      .step({ name: 'b', forward: async ctx => { order.push('b'); return 'B'; } })
      .step({ name: 'c', forward: async ctx => { order.push('c'); return 'C'; } });
    const r = await saga.run();
    assert.strictEqual(r.status, 'completed');
    assert.deepStrictEqual(order, ['a', 'b', 'c']);
    assert.deepStrictEqual(r.steps.map(s => [s.name, s.status, s.value]), [
      ['a', STATUS.succeeded, 'A'],
      ['b', STATUS.succeeded, 'B'],
      ['c', STATUS.succeeded, 'C'],
    ]);
    assert.deepStrictEqual(r.compensations, []);
  });

  it('passes the shared context to every forward step', async () => {
    const seen = [];
    const saga = new Saga()
      .step({
        name: 'a',
        forward: async ctx => { seen.push({ ...ctx }); ctx.tag = 'set-by-a'; return 1; },
      })
      .step({
        name: 'b',
        forward: async ctx => { seen.push({ ...ctx }); return 2; },
      });
    const r = await saga.run({ user: 'alice' });
    assert.deepStrictEqual(seen[0], { user: 'alice' });
    assert.deepStrictEqual(seen[1], { user: 'alice', tag: 'set-by-a' });
    assert.strictEqual(r.context.tag, 'set-by-a');
  });
});

describe('Saga — sequential mode failure & compensation', () => {
  it('compensates predecessors in reverse order on failure', async () => {
    const order = [];
    const saga = new Saga()
      .step({
        name: 'create',
        forward: async () => { order.push('fwd-create'); return { id: 1 }; },
        compensate: async value => { order.push(`comp-create(${value.id})`); },
      })
      .step({
        name: 'upload',
        forward: async () => { order.push('fwd-upload'); return { url: 's3://x' }; },
        compensate: async value => { order.push(`comp-upload(${value.url})`); },
      })
      .step({
        name: 'notify',
        forward: async () => { order.push('fwd-notify'); throw new Error('webhook 502'); },
        compensate: async () => { order.push('comp-notify'); },
      });

    const r = await saga.run();
    assert.strictEqual(r.status, 'compensated');
    assert.deepStrictEqual(order, [
      'fwd-create',
      'fwd-upload',
      'fwd-notify',
      'comp-upload(s3://x)',
      'comp-create(1)',
    ]);
    const stepRecord = r.steps.find(s => s.name === 'notify');
    assert.strictEqual(stepRecord.status, STATUS.failed);
    assert.match(stepRecord.error.message, /webhook 502/);
  });

  it('marks not-yet-attempted steps as skipped', async () => {
    const saga = new Saga()
      .step({ name: 'a', forward: async () => 1, compensate: async () => {} })
      .step({ name: 'b', forward: async () => { throw new Error('nope'); } })
      .step({ name: 'c', forward: async () => 3 })
      .step({ name: 'd', forward: async () => 4 });
    const r = await saga.run();
    assert.strictEqual(r.status, 'compensated');
    assert.strictEqual(r.steps.find(s => s.name === 'c').status, STATUS.skipped);
    assert.strictEqual(r.steps.find(s => s.name === 'd').status, STATUS.skipped);
  });

  it('reports compensation-failed when a compensation throws', async () => {
    const saga = new Saga()
      .step({
        name: 'a',
        forward: async () => 'A',
        compensate: async () => { throw new Error('cleanup-fail'); },
      })
      .step({
        name: 'b',
        forward: async () => { throw new Error('boom'); },
      });
    const r = await saga.run();
    assert.strictEqual(r.status, 'compensation-failed');
    const compA = r.compensations.find(c => c.name === 'a');
    assert.strictEqual(compA.status, STATUS.failed);
    assert.match(compA.error.message, /cleanup-fail/);
  });

  it('skips compensation for steps without a registered compensate fn', async () => {
    const calls = [];
    const saga = new Saga()
      .step({ name: 'a', forward: async () => 'A' /* no compensate */ })
      .step({
        name: 'b',
        forward: async () => 'B',
        compensate: async () => { calls.push('comp-b'); },
      })
      .step({ name: 'c', forward: async () => { throw new Error('x'); } });
    const r = await saga.run();
    assert.strictEqual(r.status, 'compensated');
    const compA = r.compensations.find(c => c.name === 'a');
    assert.strictEqual(compA.status, STATUS.skipped);
    assert.deepStrictEqual(calls, ['comp-b']);
  });
});

describe('Saga — parallel mode', () => {
  it('runs all steps concurrently and completes when all succeed', async () => {
    const startedAt = Date.now();
    const saga = new Saga({ mode: MODE.parallel })
      .step({ name: 'a', forward: () => new Promise(r => setTimeout(() => r('A'), 30)) })
      .step({ name: 'b', forward: () => new Promise(r => setTimeout(() => r('B'), 30)) })
      .step({ name: 'c', forward: () => new Promise(r => setTimeout(() => r('C'), 30)) });
    const r = await saga.run();
    const elapsed = Date.now() - startedAt;
    assert.strictEqual(r.status, 'completed');
    // Sequential would take ~90ms; parallel ~30ms. Allow generous margin.
    assert.ok(elapsed < 80, `expected parallel execution; took ${elapsed}ms`);
  });

  it('compensates only the steps that succeeded when one fails', async () => {
    const compCalls = [];
    const saga = new Saga({ mode: MODE.parallel })
      .step({
        name: 'a',
        forward: async () => 'A',
        compensate: async () => { compCalls.push('a'); },
      })
      .step({
        name: 'b',
        forward: async () => { throw new Error('b-fail'); },
        compensate: async () => { compCalls.push('b'); },
      })
      .step({
        name: 'c',
        forward: async () => 'C',
        compensate: async () => { compCalls.push('c'); },
      });
    const r = await saga.run();
    assert.strictEqual(r.status, 'compensated');
    // 'b' never produced a value, so its compensation is not invoked.
    assert.deepStrictEqual(compCalls.sort(), ['a', 'c']);
  });
});

describe('Saga — journal callbacks', () => {
  it('emits onStep before/after each step and onCompensation during rollback', async () => {
    const events = [];
    const journal = {
      onStep: e => events.push({ kind: 'step', name: e.record.name, status: e.record.status }),
      onCompensation: e => events.push({ kind: 'comp', name: e.record.name, status: e.record.status }),
    };
    const saga = new Saga({ journal })
      .step({
        name: 'a',
        forward: async () => 'A',
        compensate: async () => null,
      })
      .step({ name: 'b', forward: async () => { throw new Error('bad'); } });
    await saga.run();

    // We expect a's running+succeeded, b's running+failed, then a's comp running+succeeded.
    const aStep = events.filter(e => e.kind === 'step' && e.name === 'a').map(e => e.status);
    const bStep = events.filter(e => e.kind === 'step' && e.name === 'b').map(e => e.status);
    const aComp = events.filter(e => e.kind === 'comp' && e.name === 'a').map(e => e.status);
    assert.deepStrictEqual(aStep, [STATUS.running, STATUS.succeeded]);
    assert.deepStrictEqual(bStep, [STATUS.running, STATUS.failed]);
    assert.deepStrictEqual(aComp, [STATUS.running, STATUS.succeeded]);
  });

  it('a throwing journal callback never breaks the saga', async () => {
    const journal = {
      onStep: () => { throw new Error('journal exploded'); },
      onCompensation: () => { throw new Error('journal exploded'); },
    };
    const saga = new Saga({ journal })
      .step({ name: 'a', forward: async () => 1, compensate: async () => null })
      .step({ name: 'b', forward: async () => { throw new Error('x'); } });
    const r = await saga.run();
    assert.strictEqual(r.status, 'compensated');
  });
});

describe('Saga — result shape', () => {
  it('result includes elapsedMs and a serialized firstError', async () => {
    const saga = new Saga()
      .step({ name: 'a', forward: async () => { const e = new Error('first'); e.code = 'X'; throw e; } });
    const r = await saga.run();
    assert.strictEqual(r.status, 'compensation-failed' === r.status ? 'compensation-failed' : 'compensated');
    assert.strictEqual(typeof r.elapsedMs, 'number');
    assert.ok(r.firstError);
    assert.strictEqual(r.firstError.code, 'X');
  });

  it('result.context returns the merged context including step mutations', async () => {
    const saga = new Saga()
      .step({ name: 'a', forward: async ctx => { ctx.added = 'by-a'; return 1; } });
    const r = await saga.run({ initial: 'x' });
    assert.deepStrictEqual(r.context, { initial: 'x', added: 'by-a' });
  });
});
