/**
 * Tests for services/agents/test-gen-agent.js — unit-test generator.
 *
 * We test the pure normalizeTestGen + the validation guard on
 * generate() + the role prompt constant.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  generate,
  normalizeTestGen,
  ROLE,
} = require('../src/services/agents/test-gen-agent');

// ── ROLE constant ────────────────────────────────────────────────

describe('ROLE constant', () => {
  it('mentions scenario buckets happy_path/edge_cases/error_paths/regression', () => {
    assert.match(ROLE, /happy_path/);
    assert.match(ROLE, /edge_cases/);
    assert.match(ROLE, /error_paths/);
    assert.match(ROLE, /regression/);
  });

  it('forbids brittle timing tests', () => {
    assert.match(ROLE, /setTimeout/);
  });

  it('warns against mocking pure functions', () => {
    assert.match(ROLE, /pure functions/);
  });

  it('encourages reporting uncovered cases over brittle tests', () => {
    assert.match(ROLE, /uncovered/);
  });
});

// ── generate · validation ────────────────────────────────────────

describe('generate · validation', () => {
  it('throws when source is missing', async () => {
    await assert.rejects(
      () => generate({ openai: {}, symbol: 'foo' }),
      /"source" is required/,
    );
  });

  it('throws when source is empty', async () => {
    await assert.rejects(
      () => generate({ source: '' }),
      /"source" is required/,
    );
  });
});

// ── normalizeTestGen · happy paths ───────────────────────────────

describe('normalizeTestGen · happy paths', () => {
  it('maps every documented field through', () => {
    const out = normalizeTestGen({
      final: {
        target: 'foo.ts:add',
        framework: 'node:test',
        test_file: 'import test from "node:test"; ...',
        test_cases: [
          { name: 'adds two numbers', scenario: 'happy_path' },
          { name: 'handles 0', scenario: 'edge_case' },
        ],
        uncovered: ['arbitrary-precision case not covered'],
      },
      iterations: 4,
      terminatedBy: 'final',
    }, { source: 'foo.ts', symbol: 'add' });

    assert.equal(out.target, 'foo.ts:add');
    assert.equal(out.framework, 'node:test');
    assert.match(out.test_file, /import test/);
    assert.equal(out.test_cases.length, 2);
    assert.equal(out.test_cases[0].name, 'adds two numbers');
    assert.equal(out.test_cases[0].scenario, 'happy_path');
    assert.equal(out.uncovered.length, 1);
    assert.equal(out.iterations, 4);
    assert.equal(out.terminatedBy, 'final');
  });

  it('counts test cases by scenario bucket', () => {
    const out = normalizeTestGen({
      final: {
        test_cases: [
          { name: 't1', scenario: 'happy_path' },
          { name: 't2', scenario: 'happy_path' },
          { name: 't3', scenario: 'edge_case' },
          { name: 't4', scenario: 'edge_case' },
          { name: 't5', scenario: 'edge_case' },
          { name: 't6', scenario: 'error_path' },
          { name: 't7', scenario: 'regression' },
        ],
      },
    }, { source: 's' });
    assert.equal(out.counts.total, 7);
    assert.equal(out.counts.happy_path, 2);
    assert.equal(out.counts.edge_case, 3);
    assert.equal(out.counts.error_path, 1);
    assert.equal(out.counts.regression, 1);
  });
});

// ── normalizeTestGen · defaults / fallbacks ──────────────────────

describe('normalizeTestGen · defaults', () => {
  it('builds a default target as "source:symbol"', () => {
    const out = normalizeTestGen({ final: {} }, { source: 'foo.ts', symbol: 'add' });
    assert.equal(out.target, 'foo.ts:add');
  });

  it('builds default target as just "source" when symbol missing', () => {
    const out = normalizeTestGen({ final: {} }, { source: 'foo.ts' });
    assert.equal(out.target, 'foo.ts');
  });

  it('final.target overrides the computed default', () => {
    const out = normalizeTestGen({ final: { target: 'override:target' } }, { source: 'foo.ts', symbol: 'x' });
    assert.equal(out.target, 'override:target');
  });

  it('framework defaults to "unknown"', () => {
    const out = normalizeTestGen({ final: {} }, { source: 's' });
    assert.equal(out.framework, 'unknown');
  });

  it('test_file defaults to ""', () => {
    const out = normalizeTestGen({ final: {} }, { source: 's' });
    assert.equal(out.test_file, '');
  });

  it('test_cases / uncovered default to []', () => {
    const out = normalizeTestGen({ final: {} }, { source: 's' });
    assert.deepEqual(out.test_cases, []);
    assert.deepEqual(out.uncovered, []);
  });

  it('counts default to all zeros when no test_cases', () => {
    const out = normalizeTestGen({ final: {} }, { source: 's' });
    assert.equal(out.counts.total, 0);
    assert.equal(out.counts.happy_path, 0);
  });
});

// ── normalizeTestGen · coercion + filtering ──────────────────────

describe('normalizeTestGen · coercion + filtering', () => {
  it('non-string framework becomes "unknown"', () => {
    const out = normalizeTestGen({ final: { framework: 42 } }, { source: 's' });
    assert.equal(out.framework, 'unknown');
  });

  it('non-string test_file becomes ""', () => {
    const out = normalizeTestGen({ final: { test_file: ['array', 'not', 'string'] } }, { source: 's' });
    assert.equal(out.test_file, '');
  });

  it('non-array test_cases becomes []', () => {
    const out = normalizeTestGen({ final: { test_cases: 'not-array' } }, { source: 's' });
    assert.deepEqual(out.test_cases, []);
  });

  it('drops test cases without a name (filter)', () => {
    const out = normalizeTestGen({
      final: { test_cases: [
        { name: 'valid', scenario: 'happy_path' },
        { name: '' },
        { scenario: 'edge_case' },
      ]},
    }, { source: 's' });
    assert.equal(out.test_cases.length, 1);
    assert.equal(out.test_cases[0].name, 'valid');
  });

  it('test case name truncated at 200 chars', () => {
    const out = normalizeTestGen({
      final: { test_cases: [{ name: 'x'.repeat(500), scenario: 'happy_path' }] },
    }, { source: 's' });
    assert.equal(out.test_cases[0].name.length, 200);
  });

  it('unknown scenario falls back to "happy_path"', () => {
    const out = normalizeTestGen({
      final: { test_cases: [{ name: 'x', scenario: 'made-up' }] },
    }, { source: 's' });
    assert.equal(out.test_cases[0].scenario, 'happy_path');
  });

  it('missing scenario falls back to "happy_path"', () => {
    const out = normalizeTestGen({
      final: { test_cases: [{ name: 'x' }] },
    }, { source: 's' });
    assert.equal(out.test_cases[0].scenario, 'happy_path');
  });

  it('non-string scenario falls back to "happy_path"', () => {
    const out = normalizeTestGen({
      final: { test_cases: [{ name: 'x', scenario: 42 }] },
    }, { source: 's' });
    assert.equal(out.test_cases[0].scenario, 'happy_path');
  });

  it('uncovered entries coerced to string', () => {
    const out = normalizeTestGen({
      final: { uncovered: ['a', 42, null, { x: 1 }] },
    }, { source: 's' });
    assert.equal(out.uncovered.length, 4);
    for (const u of out.uncovered) assert.equal(typeof u, 'string');
  });

  it('uncovered entries truncated at 300 chars', () => {
    const out = normalizeTestGen({
      final: { uncovered: ['z'.repeat(500)] },
    }, { source: 's' });
    assert.equal(out.uncovered[0].length, 300);
  });

  it('non-array uncovered becomes []', () => {
    const out = normalizeTestGen({ final: { uncovered: 'not-array' } }, { source: 's' });
    assert.deepEqual(out.uncovered, []);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/agents/test-gen-agent');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['ROLE', 'generate', 'normalizeTestGen']);
  });
});
