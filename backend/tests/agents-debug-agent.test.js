/**
 * Tests for services/agents/debug-agent.js — debugging specialist.
 *
 * Heavy debug() calls agentCore; we test parseStacktrace (pure),
 * normalizeDebug (pure), ROLE prompt, and the error guard.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  debug,
  normalizeDebug,
  parseStacktrace,
  ROLE,
} = require('../src/services/agents/debug-agent');

// ── ROLE constant ────────────────────────────────────────────────

describe('ROLE constant', () => {
  it('emphasizes reading code before proposing fixes', () => {
    assert.match(ROLE, /ALWAYS read the actual code/);
  });

  it('demands root-cause fixes over symptom-silencing', () => {
    assert.match(ROLE, /ROOT CAUSE/);
    assert.match(ROLE, /Wrapping in try\/catch.*last resort/);
  });

  it('requires per-patch confidence scores', () => {
    assert.match(ROLE, /confidence score per patch/);
  });
});

// ── parseStacktrace ─────────────────────────────────────────────

describe('parseStacktrace', () => {
  it('returns [] for null / non-string / empty input', () => {
    assert.deepEqual(parseStacktrace(null), []);
    assert.deepEqual(parseStacktrace(undefined), []);
    assert.deepEqual(parseStacktrace(''), []);
    assert.deepEqual(parseStacktrace(42), []);
  });

  it('parses V8 stacks with "at fn (file:line:col)"', () => {
    const stack = `Error: boom
    at Object.foo (src/utils/bar.js:12:5)
    at Object.runner (src/runner.js:42:10)`;
    const hints = parseStacktrace(stack);
    assert.deepEqual(hints, [
      { file: 'src/utils/bar.js', line: 12 },
      { file: 'src/runner.js', line: 42 },
    ]);
  });

  it('parses V8 stacks with "at file:line:col" (no fn name)', () => {
    const stack = `at /app/lib/x.ts:7:3`;
    const hints = parseStacktrace(stack);
    assert.deepEqual(hints, [{ file: '/app/lib/x.ts', line: 7 }]);
  });

  it('parses Python tracebacks', () => {
    const stack = `Traceback (most recent call last):
  File "/app/main.py", line 23, in <module>
    raise ValueError("bad")`;
    const hints = parseStacktrace(stack);
    assert.deepEqual(hints, [{ file: '/app/main.py', line: 23 }]);
  });

  it('parses Go stacks', () => {
    const stack = `goroutine 1 [running]:
\tsrc/main.go:42 +0x1ab`;
    const hints = parseStacktrace(stack);
    assert.deepEqual(hints, [{ file: 'src/main.go', line: 42 }]);
  });

  it('falls back to generic "file:line" when no language match', () => {
    const stack = 'Error somewhere in lib/foo.rb:99 the bug';
    const hints = parseStacktrace(stack);
    assert.deepEqual(hints, [{ file: 'lib/foo.rb', line: 99 }]);
  });

  it('deduplicates identical file:line entries', () => {
    const stack = `at src/x.js:10:1
    at src/x.js:10:5
    at src/x.js:10:9`;
    const hints = parseStacktrace(stack);
    assert.equal(hints.length, 1);
  });

  it('caps at 8 hints', () => {
    const lines = [];
    for (let i = 0; i < 20; i++) lines.push(`    at src/x.js:${i + 1}:1`);
    const stack = lines.join('\n');
    const hints = parseStacktrace(stack);
    assert.equal(hints.length, 8);
  });
});

// ── normalizeDebug · happy path ────────────────────────────────

describe('normalizeDebug · happy path', () => {
  it('maps every documented field through', () => {
    const out = normalizeDebug({
      final: {
        hypothesis: 'null deref in handler',
        root_cause_file: 'src/handler.js',
        root_cause_lines: [12, 15],
        patches: [{
          source: 'src/handler.js',
          start_line: 12,
          end_line: 15,
          replacement: 'if (!user) return null;',
          rationale: 'guard before dereferencing user',
          confidence: 0.85,
        }],
        tests_to_add: ['null-user request'],
        confidence: 0.8,
      },
      iterations: 4,
      terminatedBy: 'final',
    }, [{ file: 'src/handler.js', line: 12 }]);

    assert.equal(out.hypothesis, 'null deref in handler');
    assert.equal(out.root_cause_file, 'src/handler.js');
    assert.deepEqual(out.root_cause_lines, [12, 15]);
    assert.equal(out.patches.length, 1);
    assert.equal(out.patches[0].source, 'src/handler.js');
    assert.equal(out.patches[0].confidence, 0.85);
    assert.equal(out.tests_to_add.length, 1);
    assert.equal(out.confidence, 0.8);
    assert.deepEqual(out.stacktrace_hints, [{ file: 'src/handler.js', line: 12 }]);
    assert.equal(out.iterations, 4);
    assert.equal(out.terminatedBy, 'final');
  });
});

// ── normalizeDebug · defaults ───────────────────────────────────

describe('normalizeDebug · defaults', () => {
  it('hypothesis defaults to ""', () => {
    const out = normalizeDebug({ final: {} }, []);
    assert.equal(out.hypothesis, '');
  });

  it('root_cause_file defaults to null', () => {
    const out = normalizeDebug({ final: {} }, []);
    assert.equal(out.root_cause_file, null);
  });

  it('root_cause_lines defaults to [null, null]', () => {
    const out = normalizeDebug({ final: {} }, []);
    assert.deepEqual(out.root_cause_lines, [null, null]);
  });

  it('patches / tests_to_add default to []', () => {
    const out = normalizeDebug({ final: {} }, []);
    assert.deepEqual(out.patches, []);
    assert.deepEqual(out.tests_to_add, []);
  });

  it('confidence defaults to 0.5', () => {
    const out = normalizeDebug({ final: {} }, []);
    assert.equal(out.confidence, 0.5);
  });

  it('handles missing final entirely', () => {
    const out = normalizeDebug({}, []);
    assert.equal(out.hypothesis, '');
  });
});

// ── normalizeDebug · coercion ──────────────────────────────────

describe('normalizeDebug · coercion', () => {
  it('non-integer start_line/end_line on patch → null', () => {
    const out = normalizeDebug({
      final: { patches: [{
        source: 'a.js', start_line: 'not-int', end_line: 12.5,
        replacement: 'fix code', rationale: 'r',
      }]},
    }, []);
    assert.equal(out.patches[0].start_line, null);
    assert.equal(out.patches[0].end_line, null);
  });

  it('rationale truncated to 400 chars', () => {
    const out = normalizeDebug({
      final: { patches: [{
        source: 'a.js', replacement: 'fix code', rationale: 'r'.repeat(800),
      }]},
    }, []);
    assert.equal(out.patches[0].rationale.length, 400);
  });

  it('confidence clamped to [0, 1] per patch', () => {
    const out = normalizeDebug({
      final: { patches: [
        { source: 'a.js', replacement: 'x', confidence: -0.5 },
        { source: 'b.js', replacement: 'y', confidence: 1.5 },
        { source: 'c.js', replacement: 'z', confidence: 0.3 },
      ]},
    }, []);
    assert.equal(out.patches[0].confidence, 0);
    assert.equal(out.patches[1].confidence, 1);
    assert.equal(out.patches[2].confidence, 0.3);
  });

  it('non-numeric confidence on patch defaults to 0.5', () => {
    const out = normalizeDebug({
      final: { patches: [{ source: 'a.js', replacement: 'x', confidence: 'high' }] },
    }, []);
    assert.equal(out.patches[0].confidence, 0.5);
  });

  it('drops patches missing source OR replacement', () => {
    const out = normalizeDebug({
      final: { patches: [
        { source: 'a.js', replacement: 'fix code' },
        { source: 'b.js' },             // no replacement
        { replacement: 'orphan' },       // no source
        null,
      ]},
    }, []);
    assert.equal(out.patches.length, 1);
    assert.equal(out.patches[0].source, 'a.js');
  });

  it('non-array patches → []', () => {
    const out = normalizeDebug({ final: { patches: 'not-array' } }, []);
    assert.deepEqual(out.patches, []);
  });

  it('tests_to_add entries coerced to string + truncated to 300', () => {
    const out = normalizeDebug({
      final: { tests_to_add: ['short', 42, 'x'.repeat(500), null, ''] },
    }, []);
    // String(null) = "null" (truthy), '' filtered out.
    assert.ok(out.tests_to_add.length >= 3);
    for (const t of out.tests_to_add) {
      assert.equal(typeof t, 'string');
      assert.ok(t.length <= 300);
    }
  });

  it('non-array tests_to_add → []', () => {
    const out = normalizeDebug({ final: { tests_to_add: 'not-array' } }, []);
    assert.deepEqual(out.tests_to_add, []);
  });

  it('top-level confidence clamped to [0, 1]', () => {
    const out1 = normalizeDebug({ final: { confidence: -0.5 } }, []);
    const out2 = normalizeDebug({ final: { confidence: 1.5 } }, []);
    assert.equal(out1.confidence, 0);
    assert.equal(out2.confidence, 1);
  });

  it('root_cause_lines coerces invalid entries to null', () => {
    const out = normalizeDebug({ final: { root_cause_lines: ['notnum', 12] } }, []);
    assert.deepEqual(out.root_cause_lines, [null, 12]);
  });

  it('root_cause_lines < 2 entries falls back to [null, null]', () => {
    const out = normalizeDebug({ final: { root_cause_lines: [12] } }, []);
    assert.deepEqual(out.root_cause_lines, [null, null]);
  });

  it('non-string root_cause_file → null', () => {
    const out = normalizeDebug({ final: { root_cause_file: 42 } }, []);
    assert.equal(out.root_cause_file, null);
  });
});

// ── debug · validation ────────────────────────────────────────

describe('debug · validation', () => {
  it('throws when error is missing', async () => {
    await assert.rejects(
      () => debug({ openai: {}, userId: 'u' }),
      /"error" is required/,
    );
  });

  it('throws when error is empty string', async () => {
    await assert.rejects(
      () => debug({ openai: {}, error: '' }),
      /"error" is required/,
    );
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/agents/debug-agent');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['ROLE', 'debug', 'normalizeDebug', 'parseStacktrace']);
  });
});
