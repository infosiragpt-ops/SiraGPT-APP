/**
 * Tests for services/agent-runtime/runnable.js — LangChain-style
 * Runnable composition primitives (invoke / stream / batch / pipe /
 * withConfig / withRetry / withFallbacks + sequence + parallel).
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  Runnable,
  runnable,
  sequence,
  parallel,
  asRunnable,
  ensureTrace,
} = require('../src/services/agent-runtime/runnable');

// ── construction guards ────────────────────────────────────────────

describe('Runnable · construction', () => {
  it('throws on missing/non-string name', () => {
    assert.throws(() => new Runnable({ invoke: async () => 1 }), /requires a stable name/);
    assert.throws(() => new Runnable({ name: '', invoke: async () => 1 }), /requires a stable name/);
    assert.throws(() => new Runnable({ name: 42, invoke: async () => 1 }), /requires a stable name/);
  });

  it('throws when invoke is not a function', () => {
    assert.throws(() => new Runnable({ name: 'r' }), /requires invoke/);
    assert.throws(() => new Runnable({ name: 'r', invoke: 'nope' }), /requires invoke/);
  });

  it('config is frozen', () => {
    const r = new Runnable({ name: 'r', invoke: async () => 1, config: { foo: 'bar' } });
    assert.throws(() => { r.config.foo = 'hack'; }, TypeError);
  });
});

// ── invoke + trace emission ───────────────────────────────────────

describe('Runnable · invoke + trace events', () => {
  it('emits runnable.start and runnable.end on success', async () => {
    const r = runnable('hello', async () => 'hi');
    const trace = ensureTrace({});
    await r.invoke('input', { trace });
    const types = trace.trace.events.map((e) => e.type);
    assert.ok(types.includes('runnable.start'));
    assert.ok(types.includes('runnable.end'));
  });

  it('emits runnable.error on throw and rethrows', async () => {
    const r = runnable('boom', async () => { throw new Error('xx'); });
    const trace = ensureTrace({});
    await assert.rejects(() => r.invoke('x', { trace }), /xx/);
    const types = trace.trace.events.map((e) => e.type);
    assert.ok(types.includes('runnable.error'));
  });

  it('error event includes message + code (defaults to runnable_error)', async () => {
    const r = runnable('boom', async () => {
      const e = new Error('m');
      e.code = 'my_code';
      throw e;
    });
    const trace = ensureTrace({});
    await assert.rejects(() => r.invoke('x', { trace }));
    const err = trace.trace.events.find((e) => e.type === 'runnable.error');
    assert.equal(err.payload.message, 'm');
    assert.equal(err.payload.code, 'my_code');
  });

  it('lazily creates a trace when context has none', async () => {
    const r = runnable('hello', async () => 'hi');
    // Pass an empty context — invoke should not throw and should still work.
    const ctx = {};
    await r.invoke('x', ctx);
    assert.ok(ctx.trace, 'a trace must be attached to context');
  });
});

// ── stream ────────────────────────────────────────────────────────

describe('Runnable · stream', () => {
  it('yields the invoke result when stream impl absent', async () => {
    const r = runnable('one-shot', async (x) => x + '!');
    const out = [];
    for await (const v of r.stream('hi')) out.push(v);
    assert.deepEqual(out, ['hi!']);
  });

  it('delegates to custom stream impl when provided', async () => {
    const r = new Runnable({
      name: 'streamy',
      invoke: async () => 'ignored',
      stream: async function* () {
        yield 'a';
        yield 'b';
      },
    });
    const out = [];
    for await (const v of r.stream('x')) out.push(v);
    assert.deepEqual(out, ['a', 'b']);
  });
});

// ── batch ─────────────────────────────────────────────────────────

describe('Runnable · batch', () => {
  it('throws on non-array input', async () => {
    const r = runnable('r', async (x) => x);
    await assert.rejects(() => r.batch('not-array'), /expects an array/);
  });

  it('preserves index alignment in the output', async () => {
    const r = runnable('id', async (x) => x * 10);
    const out = await r.batch([1, 2, 3, 4, 5]);
    assert.deepEqual(out, [10, 20, 30, 40, 50]);
  });

  it('respects concurrency from context', async () => {
    let active = 0;
    let peak = 0;
    const r = runnable('counter', async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return 1;
    });
    await r.batch([1, 1, 1, 1, 1, 1, 1, 1], { concurrency: 2 });
    assert.ok(peak <= 2, `expected concurrency ≤ 2, peaked at ${peak}`);
  });

  it('default concurrency = 4 when none provided', async () => {
    let active = 0;
    let peak = 0;
    const r = runnable('counter', async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return 1;
    });
    await r.batch([1, 1, 1, 1, 1, 1, 1, 1]);
    assert.ok(peak <= 4);
  });
});

// ── pipe ──────────────────────────────────────────────────────────

describe('Runnable · pipe', () => {
  it('composes left then right', async () => {
    const left = runnable('left', async (x) => x + 1);
    const right = runnable('right', async (x) => x * 10);
    const composed = left.pipe(right);
    assert.equal(await composed.invoke(2), 30);
    assert.equal(composed.name, 'left|right');
  });

  it('accepts a plain function as the right side via asRunnable', async () => {
    const left = runnable('left', async (x) => x + 1);
    const composed = left.pipe(async (x) => x * 10);
    assert.equal(await composed.invoke(2), 30);
  });
});

// ── withConfig ────────────────────────────────────────────────────

describe('Runnable · withConfig', () => {
  it('returns a new Runnable with merged config', () => {
    const r = runnable('r', async () => 1, { config: { a: 1 } });
    const r2 = r.withConfig({ b: 2 });
    assert.deepEqual(r2.config, { a: 1, b: 2 });
    // Original untouched.
    assert.deepEqual(r.config, { a: 1 });
  });
});

// ── withRetry ─────────────────────────────────────────────────────

describe('Runnable · withRetry', () => {
  it('retries up to maxRetries on failure', async () => {
    let calls = 0;
    const flaky = runnable('flaky', async () => {
      calls += 1;
      if (calls < 3) throw new Error('flake');
      return 'ok';
    });
    const retried = flaky.withRetry({ maxRetries: 5, backoffMs: 1 });
    assert.equal(await retried.invoke(null), 'ok');
    assert.equal(calls, 3);
  });

  it('throws the last error when retries are exhausted', async () => {
    let calls = 0;
    const always = runnable('always-fail', async () => {
      calls += 1;
      throw new Error(`attempt-${calls}`);
    });
    const retried = always.withRetry({ maxRetries: 2, backoffMs: 1 });
    await assert.rejects(() => retried.invoke(null), /attempt-3/);
    assert.equal(calls, 3); // 1 initial + 2 retries
  });

  it('honours retryOn predicate (false = abort early)', async () => {
    let calls = 0;
    const guarded = runnable('guarded', async () => {
      calls += 1;
      const e = new Error('fatal');
      e.code = 'fatal';
      throw e;
    });
    const retried = guarded.withRetry({
      maxRetries: 5,
      backoffMs: 1,
      retryOn: (err) => err.code !== 'fatal',
    });
    await assert.rejects(() => retried.invoke(null), /fatal/);
    assert.equal(calls, 1, 'must not retry when retryOn returns false');
  });
});

// ── withFallbacks ────────────────────────────────────────────────

describe('Runnable · withFallbacks', () => {
  it('uses primary when it succeeds', async () => {
    const primary = runnable('p', async () => 'primary-ok');
    const fallback = runnable('f', async () => 'fallback');
    const chained = primary.withFallbacks([fallback]);
    assert.equal(await chained.invoke(null), 'primary-ok');
  });

  it('falls through to next candidate on error', async () => {
    let calls = [];
    const primary = runnable('p', async () => {
      calls.push('p');
      throw new Error('p-bad');
    });
    const fallback = runnable('f', async () => {
      calls.push('f');
      return 'fallback-ok';
    });
    const chained = primary.withFallbacks([fallback]);
    assert.equal(await chained.invoke(null), 'fallback-ok');
    assert.deepEqual(calls, ['p', 'f']);
  });

  it('throws the last error when every candidate fails', async () => {
    const primary = runnable('p', async () => { throw new Error('p'); });
    const fb1 = runnable('f1', async () => { throw new Error('f1'); });
    const fb2 = runnable('f2', async () => { throw new Error('f2'); });
    await assert.rejects(
      () => primary.withFallbacks([fb1, fb2]).invoke(null),
      /f2/,
    );
  });
});

// ── getGraph ──────────────────────────────────────────────────────

describe('Runnable · getGraph', () => {
  it('returns the node description', () => {
    const r = runnable('r', async () => 1, {
      inputSchema: { type: 'string' },
      outputSchema: { type: 'number' },
      config: { c: 1 },
    });
    const g = r.getGraph();
    assert.equal(g.type, 'runnable');
    assert.equal(g.name, 'r');
    assert.deepEqual(g.input_schema, { type: 'string' });
    assert.deepEqual(g.output_schema, { type: 'number' });
    assert.equal(g.config.c, 1);
  });
});

// ── sequence + parallel ──────────────────────────────────────────

describe('sequence', () => {
  it('chains steps left-to-right', async () => {
    const s = sequence('chain', [
      async (x) => x + 1,
      async (x) => x * 2,
      async (x) => x - 3,
    ]);
    // ((5+1)*2)-3 = 9
    assert.equal(await s.invoke(5), 9);
  });

  it('exposes the graph chain in config', () => {
    const s = sequence('chain', [async (x) => x + 1, async (x) => x * 2]);
    assert.equal(s.config.graph.length, 2);
  });
});

describe('parallel', () => {
  it('runs every branch in parallel and returns a keyed map', async () => {
    const p = parallel('fork', {
      double: async (x) => x * 2,
      triple: async (x) => x * 3,
    });
    assert.deepEqual(await p.invoke(5), { double: 10, triple: 15 });
  });

  it('exposes branch graphs in config', () => {
    const p = parallel('fork', {
      double: async (x) => x * 2,
      triple: async (x) => x * 3,
    });
    assert.equal(p.config.graph.length, 2);
    assert.ok(p.config.graph.find((b) => b.key === 'double'));
    assert.ok(p.config.graph.find((b) => b.key === 'triple'));
  });
});

// ── asRunnable ────────────────────────────────────────────────────

describe('asRunnable', () => {
  it('returns Runnable unchanged', () => {
    const r = runnable('r', async (x) => x);
    assert.strictEqual(asRunnable(r), r);
  });

  it('wraps a plain function', async () => {
    async function add5(x) { return x + 5; }
    const r = asRunnable(add5);
    assert.ok(r instanceof Runnable);
    assert.equal(await r.invoke(2), 7);
    assert.equal(r.name, 'add5');
  });

  it('falls back to "anonymous" for unnamed function', async () => {
    const r = asRunnable(async (x) => x);
    assert.equal(r.name, 'anonymous');
  });

  it('throws on non-Runnable non-function', () => {
    assert.throws(() => asRunnable({}), /Expected Runnable or function/);
    assert.throws(() => asRunnable(42), /Expected Runnable or function/);
  });
});
