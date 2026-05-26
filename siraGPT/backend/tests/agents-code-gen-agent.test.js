/**
 * Tests for services/agents/code-gen-agent.js — code-generation agent.
 *
 * The heavy `generate()` invokes agentCore — we test the normalizer
 * (pure) + the input validation guard + the role prompt constants.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  generate,
  normalizeCodeGen,
  ROLE_SINGLE,
  ROLE_MULTI,
} = require('../src/services/agents/code-gen-agent');

// ── ROLE prompt constants ─────────────────────────────────────────

describe('ROLE constants', () => {
  it('ROLE_SINGLE is a non-empty string', () => {
    assert.equal(typeof ROLE_SINGLE, 'string');
    assert.ok(ROLE_SINGLE.length > 0);
  });

  it('ROLE_MULTI extends ROLE_SINGLE (prepended)', () => {
    // ROLE_MULTI is "ROLE_SINGLE + multi-path guidance".
    assert.ok(ROLE_MULTI.startsWith(ROLE_SINGLE));
    assert.ok(ROLE_MULTI.length > ROLE_SINGLE.length);
  });

  it('ROLE_MULTI mentions multi-path / multiple-candidates intent', () => {
    assert.match(ROLE_MULTI, /MULTIPLE candidate|multi-path/i);
  });

  it('ROLE_SINGLE mentions Single Responsibility (SRP)', () => {
    assert.match(ROLE_SINGLE, /Single Responsibility/);
  });
});

// ── generate() · input validation ─────────────────────────────────

describe('generate · validation', () => {
  it('throws when spec is missing', async () => {
    await assert.rejects(
      () => generate({ openai: {}, userId: 'u1', collection: 'c1' }),
      /"spec" is required/,
    );
  });

  it('throws when spec is empty string', async () => {
    await assert.rejects(() => generate({ spec: '' }), /"spec" is required/);
  });
});

// ── normalizeCodeGen · happy paths ────────────────────────────────

describe('normalizeCodeGen · happy paths', () => {
  it('extracts every documented field from final', () => {
    const out = normalizeCodeGen({
      final: {
        language: 'typescript',
        file_path: 'src/utils/foo.ts',
        code: 'export function foo() { return 1 }',
        rationale: 'simple and direct',
        assumptions: ['returns number', 'no async'],
        chosen_among: [
          { label: 'A', approach: 'functional', score: 0.85, reason_rejected_or_selected: 'best fit' },
          { label: 'B', approach: 'class', score: 0.55, reason_rejected_or_selected: 'overkill' },
        ],
      },
      iterations: 5,
      terminatedBy: 'final',
    }, { strategy: 'multi_path' });

    assert.equal(out.language, 'typescript');
    assert.equal(out.file_path, 'src/utils/foo.ts');
    assert.match(out.code, /export function foo/);
    assert.equal(out.rationale, 'simple and direct');
    assert.deepEqual(out.assumptions, ['returns number', 'no async']);
    assert.equal(out.chosen_among.length, 2);
    assert.equal(out.chosen_among[0].label, 'A');
    assert.equal(out.chosen_among[0].approach, 'functional');
    assert.equal(out.chosen_among[0].score, 0.85);
    assert.equal(out.chosen_among[0].reason, 'best fit');
    assert.equal(out.strategy, 'multi_path');
    assert.equal(out.iterations, 5);
    assert.equal(out.terminatedBy, 'final');
  });

  it('preserves strategy through to output', () => {
    const single = normalizeCodeGen({ final: {} }, { strategy: 'single_path' });
    const multi = normalizeCodeGen({ final: {} }, { strategy: 'multi_path' });
    assert.equal(single.strategy, 'single_path');
    assert.equal(multi.strategy, 'multi_path');
  });
});

// ── normalizeCodeGen · defaults ───────────────────────────────────

describe('normalizeCodeGen · defaults', () => {
  it('language defaults to "unknown"', () => {
    const out = normalizeCodeGen({ final: {} }, { strategy: 'single_path' });
    assert.equal(out.language, 'unknown');
  });

  it('file_path defaults to null', () => {
    const out = normalizeCodeGen({ final: {} }, { strategy: 'single_path' });
    assert.equal(out.file_path, null);
  });

  it('code defaults to empty string', () => {
    const out = normalizeCodeGen({ final: {} }, { strategy: 'single_path' });
    assert.equal(out.code, '');
  });

  it('rationale defaults to empty string', () => {
    const out = normalizeCodeGen({ final: {} }, { strategy: 'single_path' });
    assert.equal(out.rationale, '');
  });

  it('assumptions / chosen_among default to []', () => {
    const out = normalizeCodeGen({ final: {} }, { strategy: 'single_path' });
    assert.deepEqual(out.assumptions, []);
    assert.deepEqual(out.chosen_among, []);
  });

  it('handles missing final entirely', () => {
    const out = normalizeCodeGen({}, { strategy: 'single_path' });
    assert.equal(out.language, 'unknown');
    assert.equal(out.code, '');
    assert.deepEqual(out.assumptions, []);
  });
});

// ── normalizeCodeGen · type coercion ──────────────────────────────

describe('normalizeCodeGen · type coercion', () => {
  it('non-string language becomes "unknown"', () => {
    const out = normalizeCodeGen({ final: { language: 42 } }, { strategy: 'single_path' });
    assert.equal(out.language, 'unknown');
  });

  it('non-string file_path becomes null', () => {
    const out = normalizeCodeGen({ final: { file_path: 99 } }, { strategy: 'single_path' });
    assert.equal(out.file_path, null);
  });

  it('non-string code becomes ""', () => {
    const out = normalizeCodeGen({ final: { code: { not: 'string' } } }, { strategy: 'single_path' });
    assert.equal(out.code, '');
  });

  it('non-array assumptions becomes []', () => {
    const out = normalizeCodeGen({ final: { assumptions: 'not-array' } }, { strategy: 'single_path' });
    assert.deepEqual(out.assumptions, []);
  });

  it('assumptions entries coerced to string', () => {
    const out = normalizeCodeGen({
      final: { assumptions: ['valid', 42, null, { x: 1 }] },
    }, { strategy: 'single_path' });
    assert.equal(out.assumptions.length, 4);
    for (const a of out.assumptions) assert.equal(typeof a, 'string');
  });

  it('assumptions list capped at 10', () => {
    const many = Array.from({ length: 20 }, (_, i) => `a-${i}`);
    const out = normalizeCodeGen({
      final: { assumptions: many },
    }, { strategy: 'single_path' });
    assert.equal(out.assumptions.length, 10);
    assert.deepEqual(out.assumptions, many.slice(0, 10));
  });

  it('non-array chosen_among becomes []', () => {
    const out = normalizeCodeGen({ final: { chosen_among: 'not-array' } }, { strategy: 'single_path' });
    assert.deepEqual(out.chosen_among, []);
  });
});

// ── normalizeCodeGen · chosen_among shape ─────────────────────────

describe('normalizeCodeGen · chosen_among shaping', () => {
  it('approach truncated to 200 chars', () => {
    const out = normalizeCodeGen({
      final: { chosen_among: [{ label: 'A', approach: 'x'.repeat(500) }] },
    }, { strategy: 'multi_path' });
    assert.equal(out.chosen_among[0].approach.length, 200);
  });

  it('reason truncated to 300 chars', () => {
    const out = normalizeCodeGen({
      final: { chosen_among: [{ label: 'A', reason_rejected_or_selected: 'y'.repeat(500) }] },
    }, { strategy: 'multi_path' });
    assert.equal(out.chosen_among[0].reason.length, 300);
  });

  it('non-numeric score becomes null', () => {
    const out = normalizeCodeGen({
      final: { chosen_among: [
        { label: 'A', score: 'high' },
        { label: 'B', score: null },
        { label: 'C', score: 0.7 },
      ]},
    }, { strategy: 'multi_path' });
    assert.equal(out.chosen_among[0].score, null);
    assert.equal(out.chosen_among[1].score, null);
    assert.equal(out.chosen_among[2].score, 0.7);
  });

  it('missing fields in a candidate are coerced to safe defaults', () => {
    const out = normalizeCodeGen({
      final: { chosen_among: [{}] },
    }, { strategy: 'multi_path' });
    const c = out.chosen_among[0];
    assert.equal(c.label, '');
    assert.equal(c.approach, '');
    assert.equal(c.score, null);
    assert.equal(c.reason, '');
  });

  it('label coerced to string', () => {
    const out = normalizeCodeGen({
      final: { chosen_among: [{ label: 42 }] },
    }, { strategy: 'multi_path' });
    assert.equal(out.chosen_among[0].label, '42');
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/agents/code-gen-agent');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['ROLE_MULTI', 'ROLE_SINGLE', 'generate', 'normalizeCodeGen']);
  });
});
