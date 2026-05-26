'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

const {
  PromptModule,
  RawExecutionTape,
  BootstrapFewShot,
  COPRO,
  Optimizer,
  OptimizerError,
  interpolate,
} = require('../src/services/agents/prompt-optimizer');

// ── interpolate ──────────────────────────────────────────────────────

describe('interpolate', () => {
  it('substitutes simple {{name}} placeholders', () => {
    assert.strictEqual(interpolate('Hello {{name}}', { name: 'world' }), 'Hello world');
  });

  it('renders missing keys as empty string', () => {
    assert.strictEqual(interpolate('a={{a}} b={{b}}', { a: 1 }), 'a=1 b=');
  });

  it('handles dotted paths', () => {
    assert.strictEqual(interpolate('{{user.name}}', { user: { name: 'alice' } }), 'alice');
  });

  it('coerces non-string values', () => {
    assert.strictEqual(interpolate('n={{n}}', { n: 42 }), 'n=42');
    assert.strictEqual(interpolate('b={{b}}', { b: true }), 'b=true');
  });

  it('throws on non-string template', () => {
    assert.throws(() => interpolate(null, {}), OptimizerError);
  });

  it('handles whitespace inside braces', () => {
    assert.strictEqual(interpolate('{{ name }}', { name: 'x' }), 'x');
  });
});

// ── PromptModule ─────────────────────────────────────────────────────

describe('PromptModule — construction', () => {
  it('rejects missing name', () => {
    assert.throws(() => new PromptModule({ template: 'x' }), OptimizerError);
    assert.throws(() => new PromptModule({ name: '', template: 'x' }), OptimizerError);
  });

  it('rejects missing template', () => {
    assert.throws(() => new PromptModule({ name: 'm' }), OptimizerError);
  });

  it('initializes with default empty params/examples/instructions', () => {
    const m = new PromptModule({ name: 'm', template: 'x' });
    assert.deepStrictEqual(m.params, {});
    assert.deepStrictEqual(m.examples, []);
    assert.strictEqual(m.instructions, '');
    assert.strictEqual(m.executor, null);
  });
});

describe('PromptModule — render/forward', () => {
  it('render interpolates template with params + input', () => {
    const m = new PromptModule({
      name: 'm',
      template: 'Task: {{task}}\nInput: {{input}}',
      params: { task: 'classify' },
    });
    const out = m.render('hello');
    assert.match(out, /Task: classify/);
    assert.match(out, /Input: hello/);
  });

  it('render includes instructions when set', () => {
    const m = new PromptModule({
      name: 'm',
      template: '{{input}}',
      instructions: 'You are a helpful assistant.',
    });
    assert.match(m.render('q'), /You are a helpful assistant/);
  });

  it('render formats examples when set', () => {
    const m = new PromptModule({
      name: 'm',
      template: 'Q: {{input}}',
      examples: [
        { input: 'apple', output: 'fruit' },
        { input: 'car', output: 'vehicle' },
      ],
    });
    const out = m.render('dog');
    assert.match(out, /Input: apple/);
    assert.match(out, /Output: fruit/);
    assert.match(out, /Q: dog/);
  });

  it('forward without executor returns the rendered prompt', async () => {
    const m = new PromptModule({ name: 'm', template: 'P: {{input}}' });
    assert.strictEqual(await m.forward('x'), 'P: x');
  });

  it('forward with executor invokes it and returns its result', async () => {
    const m = new PromptModule({
      name: 'm',
      template: '{{input}}',
      executor: async (prompt) => `executed[${prompt}]`,
    });
    assert.strictEqual(await m.forward('hi'), 'executed[hi]');
  });

  it('input as object is exposed under the input.* path', () => {
    const m = new PromptModule({
      name: 'm',
      template: '{{input.user}}|{{input.task}}',
    });
    const out = m.render({ user: 'alice', task: 'sort' });
    assert.strictEqual(out, 'alice|sort');
  });
});

describe('PromptModule — update/setExamples/clone', () => {
  it('update mutates a known param', () => {
    const m = new PromptModule({ name: 'm', template: 'x', params: { a: 1 } });
    m.update('a', 7);
    assert.strictEqual(m.params.a, 7);
  });

  it('update throws on unknown param', () => {
    const m = new PromptModule({ name: 'm', template: 'x', params: { a: 1 } });
    assert.throws(() => m.update('b', 2), OptimizerError);
  });

  it('setExamples replaces examples; rejects non-array', () => {
    const m = new PromptModule({ name: 'm', template: 'x' });
    m.setExamples([{ input: 'a', output: 'b' }]);
    assert.strictEqual(m.examples.length, 1);
    assert.throws(() => m.setExamples('no'), OptimizerError);
  });

  it('clone produces an independent copy', () => {
    const m = new PromptModule({ name: 'm', template: 'x', params: { a: 1 }, examples: [{ input: 'i', output: 'o' }] });
    const c = m.clone();
    c.update('a', 9);
    c.setExamples([]);
    assert.strictEqual(m.params.a, 1);
    assert.strictEqual(m.examples.length, 1);
    assert.strictEqual(c.params.a, 9);
    assert.strictEqual(c.examples.length, 0);
  });
});

// ── RawExecutionTape ─────────────────────────────────────────────────

describe('RawExecutionTape', () => {
  let tape;
  beforeEach(() => { tape = new RawExecutionTape({ capacity: 3 }); });

  it('records entries with raw input/output (no privacy filter)', () => {
    const r = tape.record({ moduleName: 'm', input: { user: 'alice', secret: 'sk-xyz' }, output: 'plaintext', score: 0.8 });
    assert.strictEqual(r.input.user, 'alice');
    assert.strictEqual(r.input.secret, 'sk-xyz', 'tape must NOT redact secrets');
    assert.strictEqual(r.output, 'plaintext');
    assert.strictEqual(r.score, 0.8);
  });

  it('rejects records without moduleName', () => {
    assert.throws(() => tape.record({ input: 'x', output: 'y', score: 1 }), OptimizerError);
  });

  it('coerces non-numeric score to null', () => {
    const r = tape.record({ moduleName: 'm', input: 'x', output: 'y', score: 'NaN' });
    assert.strictEqual(r.score, null);
  });

  it('caps at capacity (FIFO)', () => {
    for (let i = 0; i < 5; i++) tape.record({ moduleName: 'm', input: i, output: i, score: i / 10 });
    assert.strictEqual(tape.size(), 3);
    const ins = tape.getRecords().map(r => r.input);
    assert.deepStrictEqual(ins, [2, 3, 4]);
  });

  it('getRecords filters by moduleName and minScore', () => {
    tape.record({ moduleName: 'A', input: 1, output: 1, score: 0.9 });
    tape.record({ moduleName: 'B', input: 2, output: 2, score: 0.5 });
    tape.record({ moduleName: 'A', input: 3, output: 3, score: 0.3 });
    assert.strictEqual(tape.getRecords({ moduleName: 'A' }).length, 2);
    assert.strictEqual(tape.getRecords({ minScore: 0.6 }).length, 1);
    assert.strictEqual(tape.getRecords({ moduleName: 'A', minScore: 0.6 }).length, 1);
  });

  it('clear empties the tape', () => {
    tape.record({ moduleName: 'm', input: 1, output: 1, score: 1 });
    assert.strictEqual(tape.clear(), 1);
    assert.strictEqual(tape.size(), 0);
  });
});

// ── BootstrapFewShot ─────────────────────────────────────────────────

describe('BootstrapFewShot', () => {
  it('selects top-N by score and assigns them as module examples', async () => {
    const tape = new RawExecutionTape();
    tape.record({ moduleName: 'cls', input: 'A', output: 'a', score: 0.9 });
    tape.record({ moduleName: 'cls', input: 'B', output: 'b', score: 0.4 });
    tape.record({ moduleName: 'cls', input: 'C', output: 'c', score: 0.95 });
    tape.record({ moduleName: 'cls', input: 'D', output: 'd', score: 0.7 });

    const m = new PromptModule({ name: 'cls', template: '{{input}}' });
    const opt = await new BootstrapFewShot({ n: 2, minScore: 0.5 }).optimize(m, tape);
    assert.deepStrictEqual(
      opt.examples.map(e => e.input).sort(),
      ['A', 'C'],
    );
  });

  it('respects minScore (drops below-threshold records)', async () => {
    const tape = new RawExecutionTape();
    tape.record({ moduleName: 'm', input: 'a', output: 'a', score: 0.2 });
    const opt = await new BootstrapFewShot({ n: 5, minScore: 0.5 }).optimize(
      new PromptModule({ name: 'm', template: 'x' }),
      tape,
    );
    assert.strictEqual(opt.examples.length, 0);
  });

  it('handles empty tape gracefully', async () => {
    const opt = await new BootstrapFewShot().optimize(
      new PromptModule({ name: 'm', template: 'x' }),
      new RawExecutionTape(),
    );
    assert.strictEqual(opt.examples.length, 0);
  });

  it('rejects non-PromptModule', async () => {
    await assert.rejects(
      new BootstrapFewShot().optimize({}, new RawExecutionTape()),
      OptimizerError,
    );
  });

  it('rejects non-RawExecutionTape', async () => {
    await assert.rejects(
      new BootstrapFewShot().optimize(new PromptModule({ name: 'm', template: 'x' }), {}),
      OptimizerError,
    );
  });

  it('returns a clone — original module unchanged', async () => {
    const tape = new RawExecutionTape();
    tape.record({ moduleName: 'm', input: 'x', output: 'y', score: 1 });
    const m = new PromptModule({ name: 'm', template: 'x' });
    const opt = await new BootstrapFewShot({ n: 1, minScore: 0 }).optimize(m, tape);
    assert.strictEqual(m.examples.length, 0);
    assert.strictEqual(opt.examples.length, 1);
  });
});

// ── COPRO ────────────────────────────────────────────────────────────

describe('COPRO — construction', () => {
  it('rejects missing mutator', () => {
    assert.throws(() => new COPRO(), OptimizerError);
  });
});

describe('COPRO — optimization', () => {
  // Toy problem: choose `prefix` that maximizes string match with example.expected.
  // The mutator proposes specific candidates; the metric scores 1 if output starts
  // with example.expected, 0 otherwise.
  const trainset = [
    { input: 'cat', expected: 'A:cat' },
    { input: 'dog', expected: 'A:dog' },
  ];
  const metric = (input, output, example) => output.startsWith(example.expected) ? 1 : 0;

  it('improves prefix from a poor initial value', async () => {
    const m = new PromptModule({
      name: 'm',
      template: '{{prefix}}{{input}}',
      params: { prefix: 'X:' },
    });
    const candidates = ['B:', 'A:', 'C:'];
    let i = 0;
    const mutator = () => candidates[i++ % candidates.length];
    const copro = new COPRO({ candidatesPerParam: 3, rounds: 1, mutator });
    const opt = await copro.optimize(m, trainset, metric);
    assert.strictEqual(opt.params.prefix, 'A:', 'best prefix should be A:');
  });

  it('keeps the original value when no candidate is better', async () => {
    const m = new PromptModule({
      name: 'm',
      template: '{{prefix}}{{input}}',
      params: { prefix: 'A:' },
    });
    const mutator = () => 'WRONG:';
    const copro = new COPRO({ candidatesPerParam: 5, rounds: 2, mutator });
    const opt = await copro.optimize(m, trainset, metric);
    assert.strictEqual(opt.params.prefix, 'A:');
  });

  it('throws when trainset is empty', async () => {
    await assert.rejects(
      new COPRO({ mutator: () => 'x' }).optimize(new PromptModule({ name: 'm', template: 'x' }), [], () => 1),
      OptimizerError,
    );
  });

  it('mutator throwing is absorbed; optimization still runs', async () => {
    const m = new PromptModule({
      name: 'm',
      template: '{{prefix}}{{input}}',
      params: { prefix: 'X:' },
    });
    let calls = 0;
    const mutator = () => {
      calls += 1;
      if (calls % 2 === 0) throw new Error('flaky');
      return 'A:';
    };
    const copro = new COPRO({ candidatesPerParam: 4, rounds: 1, mutator });
    const opt = await copro.optimize(m, trainset, metric);
    assert.strictEqual(opt.params.prefix, 'A:');
  });

  it('metric throwing is absorbed; example skipped', async () => {
    const m = new PromptModule({
      name: 'm',
      template: '{{prefix}}{{input}}',
      params: { prefix: 'A:' },
    });
    let evals = 0;
    const flakeyMetric = (i, o, e) => {
      evals += 1;
      if (evals % 3 === 0) throw new Error('boom');
      return o.startsWith(e.expected) ? 1 : 0;
    };
    const copro = new COPRO({ candidatesPerParam: 1, rounds: 1, mutator: () => 'A:' });
    const opt = await copro.optimize(m, trainset, flakeyMetric);
    assert.ok(opt instanceof PromptModule);
  });

  it('history records every evaluated candidate', async () => {
    const m = new PromptModule({
      name: 'm',
      template: '{{prefix}}{{input}}',
      params: { prefix: 'X:' },
    });
    const copro = new COPRO({ candidatesPerParam: 2, rounds: 1, mutator: (n, c, i) => `M${i}:` });
    await copro.optimize(m, trainset, metric);
    assert.ok(copro.history.length >= 3, `history length ${copro.history.length}`);
    assert.strictEqual(copro.history[0].paramName, '<init>');
  });

  it('iterates rounds — multiple param updates compose', async () => {
    const m = new PromptModule({
      name: 'm',
      template: '{{a}}{{b}}{{input}}',
      params: { a: 'X', b: 'Y' },
    });
    const trainset2 = [{ input: 'cat' }];
    // Partial-credit metric so each independent coordinate move improves
    // the score; otherwise coordinate-wise descent stalls at a saddle.
    const metric2 = (i, o) => {
      let s = 0;
      if (o.includes('P')) s += 0.5;
      if (o.includes('Q')) s += 0.5;
      return s;
    };
    const mutator = (paramName) => (paramName === 'a' ? 'P' : 'Q');
    const copro = new COPRO({ candidatesPerParam: 1, rounds: 2, mutator });
    const opt = await copro.optimize(m, trainset2, metric2);
    assert.strictEqual(opt.params.a, 'P');
    assert.strictEqual(opt.params.b, 'Q');
  });
});

// ── Optimizer orchestrator ───────────────────────────────────────────

describe('Optimizer.compile', () => {
  it('chains bootstrap + COPRO end-to-end', async () => {
    const tape = new RawExecutionTape();
    tape.record({ moduleName: 'm', input: 'good-shot', output: 'great', score: 0.95 });
    tape.record({ moduleName: 'm', input: 'meh', output: 'ok', score: 0.4 });

    const m = new PromptModule({
      name: 'm',
      template: '{{prefix}}{{input}}',
      params: { prefix: 'X:' },
    });
    const trainset = [{ input: 'cat', expected: 'A:cat' }];
    // Use .includes since the rendered prompt also contains the few-shot
    // example block prepended by BootstrapFewShot — startsWith would test
    // the wrong substring.
    const metric = (i, o, e) => o.includes(e.expected) ? 1 : 0;
    const mutator = () => 'A:';
    const opt = await new Optimizer({
      bootstrap: new BootstrapFewShot({ n: 1, minScore: 0.5 }),
      copro: new COPRO({ candidatesPerParam: 1, rounds: 1, mutator }),
    }).compile(m, { tape, trainset, metric });

    assert.strictEqual(opt.params.prefix, 'A:');
    assert.strictEqual(opt.examples.length, 1);
    assert.strictEqual(opt.examples[0].input, 'good-shot');
  });

  it('with no algorithms configured returns a clone untouched', async () => {
    const m = new PromptModule({ name: 'm', template: 'x', params: { a: 1 } });
    const opt = await new Optimizer().compile(m, {});
    assert.strictEqual(opt.params.a, 1);
    assert.notStrictEqual(opt, m);
  });

  it('rejects non-PromptModule', async () => {
    await assert.rejects(new Optimizer().compile({}, {}), OptimizerError);
  });

  it('rejects bootstrap without a tape', async () => {
    await assert.rejects(
      new Optimizer({ bootstrap: new BootstrapFewShot() }).compile(
        new PromptModule({ name: 'm', template: 'x' }),
        {},
      ),
      OptimizerError,
    );
  });
});
