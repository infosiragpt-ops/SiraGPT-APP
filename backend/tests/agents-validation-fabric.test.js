/**
 * Tests for services/agents/validation-fabric.js — aggregator merging
 * 6 validation report categories into a single ReleaseDecision.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  aggregate,
  normaliseReport,
  emptyReports,
  RELEASE_DECISIONS,
  SEVERITY,
} = require('../src/services/agents/validation-fabric');

// ── SEVERITY enum ──────────────────────────────────────────────

describe('SEVERITY enum', () => {
  it('pins exact severity ordering', () => {
    assert.deepEqual({ ...SEVERITY }, {
      info: 0, low: 1, medium: 2, high: 3, critical: 4,
    });
  });

  it('is frozen', () => {
    assert.throws(() => { SEVERITY.foo = 99; }, TypeError);
  });
});

// ── RELEASE_DECISIONS enum ────────────────────────────────────

describe('RELEASE_DECISIONS enum', () => {
  it('pins exact decision list', () => {
    assert.deepEqual([...RELEASE_DECISIONS], ['approve', 'hold', 'reject', 'manual-review']);
  });

  it('is frozen', () => {
    assert.throws(() => RELEASE_DECISIONS.push('extra'), TypeError);
  });
});

// ── normaliseReport ────────────────────────────────────────────

describe('normaliseReport', () => {
  it('null / non-object → { ok:true, findings:[] }', () => {
    assert.deepEqual(normaliseReport(null), { ok: true, findings: [] });
    assert.deepEqual(normaliseReport(undefined), { ok: true, findings: [] });
    assert.deepEqual(normaliseReport('not-object'), { ok: true, findings: [] });
    assert.deepEqual(normaliseReport(42), { ok: true, findings: [] });
  });

  it('preserves ok=true when explicit', () => {
    const out = normaliseReport({ ok: true, findings: [] });
    assert.equal(out.ok, true);
  });

  it('preserves ok=false when explicit', () => {
    const out = normaliseReport({ ok: false, findings: [] });
    assert.equal(out.ok, false);
  });

  it('treats missing ok as true (default optimistic)', () => {
    const out = normaliseReport({ findings: [] });
    assert.equal(out.ok, true);
  });

  it('filters out null / non-object finding entries', () => {
    const out = normaliseReport({ findings: [
      null, undefined, 'string', { severity: 'low' },
    ]});
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].severity, 'low');
  });

  it('normalises severity: unknown values → "medium"', () => {
    const out = normaliseReport({ findings: [
      { severity: 'apocalyptic', code: 'x' },
      { severity: 'high', code: 'y' },
    ]});
    assert.equal(out.findings[0].severity, 'medium');
    assert.equal(out.findings[1].severity, 'high');
  });

  it('coerces non-string code → "finding"', () => {
    const out = normaliseReport({ findings: [{ code: 42, severity: 'low' }] });
    assert.equal(out.findings[0].code, 'finding');
  });

  it('non-string detail → JSON.stringify truncated to 300', () => {
    const out = normaliseReport({ findings: [
      { severity: 'low', code: 'x', detail: { reason: 'bad-thing', deep: 'y'.repeat(500) } },
    ]});
    assert.ok(out.findings[0].detail.length <= 300);
    assert.match(out.findings[0].detail, /^{/);
  });

  it('passes through numeric score', () => {
    const out = normaliseReport({ findings: [], score: 0.85 });
    assert.equal(out.score, 0.85);
  });

  it('drops non-numeric score (undefined)', () => {
    const out = normaliseReport({ findings: [], score: 'high' });
    assert.equal(out.score, undefined);
  });

  it('captures raw payload (or self if not given)', () => {
    const raw = { custom: 'field' };
    const out = normaliseReport({ findings: [], raw });
    assert.deepEqual(out.raw, raw);
  });
});

// ── aggregate · decision matrix ────────────────────────────────

describe('aggregate · decision rules', () => {
  it('all empty reports → approve', () => {
    const out = aggregate({});
    assert.equal(out.decision, 'approve');
    assert.match(out.reason, /all reports passed/);
  });

  it('1 critical finding → reject (rule 1)', () => {
    const out = aggregate({
      security: { findings: [{ severity: 'critical', code: 'cwe-89', detail: 'sql injection' }] },
    });
    assert.equal(out.decision, 'reject');
    assert.match(out.reason, /1 critical finding/);
  });

  it('multiple critical findings: plural wording', () => {
    const out = aggregate({
      security: { findings: [
        { severity: 'critical', code: 'a' },
        { severity: 'critical', code: 'b' },
      ]},
    });
    assert.match(out.reason, /2 critical findings/);
  });

  it('3+ high findings (no critical) → reject (rule 2)', () => {
    const out = aggregate({
      codeReview: { findings: [
        { severity: 'high', code: 'a' },
        { severity: 'high', code: 'b' },
        { severity: 'high', code: 'c' },
      ]},
    });
    assert.equal(out.decision, 'reject');
    assert.match(out.reason, /3 high-severity/);
  });

  it('any report ok=false (no high/critical) → hold (rule 3)', () => {
    const out = aggregate({
      validation: { ok: false, findings: [] },
    });
    assert.equal(out.decision, 'hold');
    assert.match(out.reason, /validation/);
  });

  it('multiple reports ok=false list each name in reason', () => {
    const out = aggregate({
      validation: { ok: false, findings: [] },
      security: { ok: false, findings: [] },
    });
    assert.match(out.reason, /validation/);
    assert.match(out.reason, /security/);
  });

  it('1 high finding (no critical, no 3-high, no ok:false) → manual-review (rule 4)', () => {
    const out = aggregate({
      codeReview: { findings: [{ severity: 'high', code: 'x' }] },
    });
    assert.equal(out.decision, 'manual-review');
    assert.match(out.reason, /1 high.*human review/);
  });

  it('5+ medium findings → manual-review', () => {
    const out = aggregate({
      codeReview: { findings: Array.from({ length: 5 }, (_, i) => ({ severity: 'medium', code: `m${i}` })) },
    });
    assert.equal(out.decision, 'manual-review');
    assert.match(out.reason, /5 medium/);
  });

  it('budget breach (usd) with clean findings → hold (rule 5)', () => {
    const out = aggregate({ budgets: { usd_spent: 0.51, usd_max: 0.5 } });
    assert.equal(out.decision, 'hold');
    assert.match(out.reason, /usd/);
  });

  it('budget breach (tokens) → hold', () => {
    const out = aggregate({ budgets: { tokens_used: 100_000, tokens_max: 50_000 } });
    assert.equal(out.decision, 'hold');
    assert.match(out.reason, /tokens/);
  });

  it('budget breach (latency) → hold', () => {
    const out = aggregate({ budgets: { latency_ms: 5000, latency_ms_hard: 3000 } });
    assert.equal(out.decision, 'hold');
    assert.match(out.reason, /latency/);
  });

  it('no budget breach when usd_spent within limit', () => {
    const out = aggregate({ budgets: { usd_spent: 0.4, usd_max: 0.5 } });
    assert.equal(out.decision, 'approve');
    assert.equal(out.budgetBreach, null);
  });
});

// ── aggregate · output shape ──────────────────────────────────

describe('aggregate · output shape', () => {
  it('always includes counts: info/low/medium/high/critical', () => {
    const out = aggregate({});
    for (const k of ['info', 'low', 'medium', 'high', 'critical']) {
      assert.ok(k in out.counts);
      assert.equal(out.counts[k], 0);
    }
  });

  it('counts reflect findings tally across all reports', () => {
    const out = aggregate({
      validation: { findings: [{ severity: 'low' }, { severity: 'medium' }] },
      security: { findings: [{ severity: 'high' }] },
    });
    assert.equal(out.counts.low, 1);
    assert.equal(out.counts.medium, 1);
    assert.equal(out.counts.high, 1);
  });

  it('flattens findings with source annotation', () => {
    const out = aggregate({
      validation: { findings: [{ severity: 'low', code: 'v1' }] },
      security: { findings: [{ severity: 'high', code: 's1' }] },
    });
    const sources = out.findings.map(f => f.source).sort();
    assert.deepEqual(sources, ['security', 'validation']);
  });

  it('decidedAt is an ISO timestamp', () => {
    const out = aggregate({});
    assert.ok(!isNaN(new Date(out.decidedAt).getTime()));
  });

  it('budgetBreach is null when no budget given', () => {
    const out = aggregate({});
    assert.equal(out.budgetBreach, null);
  });

  it('reports map contains all 6 keys after normalisation', () => {
    const out = aggregate({});
    const keys = Object.keys(out.reports).sort();
    assert.deepEqual(keys, ['codeReview', 'designReview', 'factuality', 'performance', 'security', 'validation']);
  });
});

// ── emptyReports ──────────────────────────────────────────────

describe('emptyReports', () => {
  it('returns the 6 documented categories, each with ok:true + []', () => {
    const out = emptyReports();
    const keys = Object.keys(out).sort();
    assert.deepEqual(keys, ['codeReview', 'designReview', 'factuality', 'performance', 'security', 'validation']);
    for (const k of keys) {
      assert.equal(out[k].ok, true);
      assert.deepEqual(out[k].findings, []);
    }
  });

  it('returns a fresh object each call (no shared mutation)', () => {
    const a = emptyReports();
    const b = emptyReports();
    assert.notStrictEqual(a, b);
    a.validation.findings.push({ severity: 'high', code: 'x' });
    assert.equal(b.validation.findings.length, 0);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/agents/validation-fabric');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['RELEASE_DECISIONS', 'SEVERITY', 'aggregate', 'emptyReports', 'normaliseReport']);
  });
});
