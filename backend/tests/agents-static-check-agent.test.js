/**
 * Tests for services/agents/static-check-agent.js — static analysis
 * specialist.
 *
 * Heavy check() invokes agentCore and the static_checks tool; we test
 * the pure normalizeStaticCheck() + the validation guard + ROLE.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  check,
  normalizeStaticCheck,
  ROLE,
} = require('../src/services/agents/static-check-agent');

// ── ROLE constant ────────────────────────────────────────────────

describe('ROLE constant', () => {
  it('emphasizes trusting the linter for rule matches', () => {
    assert.match(ROLE, /TRUST the linter/);
  });

  it('cautions against inventing new issues (separation from code-review)', () => {
    assert.match(ROLE, /Do NOT invent new issues/);
  });

  it('gives nuance for TODO/FIXME, long function, console.log', () => {
    assert.match(ROLE, /TODO\/FIXME/);
    assert.match(ROLE, /long function/);
    assert.match(ROLE, /console\.log/);
  });
});

// ── check · validation ──────────────────────────────────────────

describe('check · validation', () => {
  it('throws when files is missing', async () => {
    await assert.rejects(() => check({ openai: {} }), /"files" must be a non-empty array/);
  });

  it('throws when files is empty array', async () => {
    await assert.rejects(() => check({ openai: {}, files: [] }), /"files" must be a non-empty array/);
  });

  it('throws when files is not an array', async () => {
    await assert.rejects(() => check({ openai: {}, files: 'single.js' }), /"files" must be a non-empty array/);
  });
});

// ── normalizeStaticCheck · happy path ──────────────────────────

describe('normalizeStaticCheck · happy path', () => {
  it('passes through fully-valid findings', () => {
    const out = normalizeStaticCheck({
      final: {
        summary: '2 of 4 confirmed',
        findings: [
          {
            file: 'a.js', line: 12, rule: 'no-eval',
            severity: 'high', confirmed: true,
            message: 'eval is dangerous', suggestion: 'use JSON.parse',
          },
          {
            file: 'b.js', line: 30, rule: 'todo',
            severity: 'info', confirmed: false,
            message: 'note-to-self TODO', suggestion: '(skip)',
          },
        ],
      },
      iterations: 3,
      terminatedBy: 'final',
    }, { raw: { 'a.js': {}, 'b.js': {} }, rawCount: 4 });

    assert.equal(out.summary, '2 of 4 confirmed');
    // Only confirmed findings end up in `findings`.
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].rule, 'no-eval');
    assert.equal(out.raw_count, 4);
    assert.deepEqual(out.raw, { 'a.js': {}, 'b.js': {} });
    assert.equal(out.iterations, 3);
    assert.equal(out.terminatedBy, 'final');
  });

  it('sorts findings high → warn → info', () => {
    const out = normalizeStaticCheck({
      final: { findings: [
        { file: 'a', message: 'm1', severity: 'info', confirmed: true },
        { file: 'a', message: 'm2', severity: 'high', confirmed: true },
        { file: 'a', message: 'm3', severity: 'warn', confirmed: true },
      ]},
    }, { raw: {}, rawCount: 3 });
    assert.deepEqual(
      out.findings.map(f => f.severity),
      ['high', 'warn', 'info'],
    );
  });
});

// ── normalizeStaticCheck · defaults ────────────────────────────

describe('normalizeStaticCheck · defaults', () => {
  it('auto-summary when summary missing', () => {
    const out = normalizeStaticCheck({
      final: { findings: [{ file: 'a', message: 'x', confirmed: true }] },
    }, { raw: {}, rawCount: 5 });
    assert.match(out.summary, /1 confirmed of 5 raw findings/);
  });

  it('non-string summary triggers auto-summary', () => {
    const out = normalizeStaticCheck({
      final: { summary: 42, findings: [] },
    }, { raw: {}, rawCount: 5 });
    assert.match(out.summary, /0 confirmed of 5 raw findings/);
  });

  it('missing findings → []', () => {
    const out = normalizeStaticCheck({ final: {} }, { raw: {}, rawCount: 0 });
    assert.deepEqual(out.findings, []);
  });

  it('non-array findings → []', () => {
    const out = normalizeStaticCheck({ final: { findings: 'not-array' } }, { raw: {}, rawCount: 0 });
    assert.deepEqual(out.findings, []);
  });

  it('passes raw + raw_count through verbatim', () => {
    const raw = { 'a.js': { findings: [{ rule: 'r' }] }, 'b.js': { error: 'err' } };
    const out = normalizeStaticCheck({ final: { findings: [] } }, { raw, rawCount: 7 });
    assert.deepEqual(out.raw, raw);
    assert.equal(out.raw_count, 7);
  });
});

// ── normalizeStaticCheck · per-finding coercion ────────────────

describe('normalizeStaticCheck · finding coercion', () => {
  it('non-integer line → null', () => {
    const out = normalizeStaticCheck({
      final: { findings: [
        { file: 'a', line: 'twelve', message: 'x', confirmed: true },
        { file: 'a', line: 12.5, message: 'x', confirmed: true },
      ]},
    }, { raw: {}, rawCount: 0 });
    assert.equal(out.findings[0].line, null);
    assert.equal(out.findings[1].line, null);
  });

  it('unknown severity → "info"', () => {
    const out = normalizeStaticCheck({
      final: { findings: [
        { file: 'a', message: 'x', severity: 'apocalyptic', confirmed: true },
      ]},
    }, { raw: {}, rawCount: 0 });
    assert.equal(out.findings[0].severity, 'info');
  });

  it('non-boolean confirmed defaults to true', () => {
    const out = normalizeStaticCheck({
      final: { findings: [
        { file: 'a', message: 'x' },
        { file: 'b', message: 'y', confirmed: 'maybe' },
      ]},
    }, { raw: {}, rawCount: 0 });
    // Both end up confirmed=true (default).
    assert.equal(out.findings.length, 2);
  });

  it('explicit confirmed=false drops the finding from output', () => {
    const out = normalizeStaticCheck({
      final: { findings: [
        { file: 'a', message: 'x', confirmed: true },
        { file: 'b', message: 'y', confirmed: false },
      ]},
    }, { raw: {}, rawCount: 0 });
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].file, 'a');
  });

  it('message truncated to 300 chars', () => {
    const out = normalizeStaticCheck({
      final: { findings: [
        { file: 'a', message: 'm'.repeat(800), confirmed: true },
      ]},
    }, { raw: {}, rawCount: 0 });
    assert.equal(out.findings[0].message.length, 300);
  });

  it('suggestion truncated to 300 chars', () => {
    const out = normalizeStaticCheck({
      final: { findings: [
        { file: 'a', message: 'x', confirmed: true, suggestion: 's'.repeat(800) },
      ]},
    }, { raw: {}, rawCount: 0 });
    assert.equal(out.findings[0].suggestion.length, 300);
  });

  it('findings without file are dropped', () => {
    const out = normalizeStaticCheck({
      final: { findings: [
        { message: 'no file', confirmed: true },
        { file: 'a', message: 'ok', confirmed: true },
      ]},
    }, { raw: {}, rawCount: 0 });
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].file, 'a');
  });

  it('findings without message are dropped', () => {
    const out = normalizeStaticCheck({
      final: { findings: [
        { file: 'a', message: '', confirmed: true },
        { file: 'b', message: 'ok', confirmed: true },
      ]},
    }, { raw: {}, rawCount: 0 });
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].file, 'b');
  });

  it('file and rule coerced to string', () => {
    const out = normalizeStaticCheck({
      final: { findings: [
        { file: 42, rule: 99, message: 'x', confirmed: true },
      ]},
    }, { raw: {}, rawCount: 0 });
    assert.equal(out.findings[0].file, '42');
    assert.equal(out.findings[0].rule, '99');
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/agents/static-check-agent');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['ROLE', 'check', 'normalizeStaticCheck']);
  });
});
