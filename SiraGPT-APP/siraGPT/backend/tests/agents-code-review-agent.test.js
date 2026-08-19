/**
 * Tests for services/agents/code-review-agent.js — automated code
 * review specialist.
 *
 * Heavy review() invokes agentCore; we test normalizeReview() (pure)
 * + ROLE prompt content + module surface.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  review,
  normalizeReview,
  ROLE,
} = require('../src/services/agents/code-review-agent');

// ── ROLE constant ────────────────────────────────────────────────

describe('ROLE constant', () => {
  it('is a non-empty string', () => {
    assert.equal(typeof ROLE, 'string');
    assert.ok(ROLE.length > 0);
  });

  it('mentions the 5 review categories', () => {
    for (const c of ['CORRECTNESS', 'SECURITY', 'RELIABILITY', 'MAINTAINABILITY', 'PERFORMANCE']) {
      assert.match(ROLE, new RegExp(c));
    }
  });

  it('forbids style-preference findings (a formatter should handle them)', () => {
    assert.match(ROLE, /Style preferences/);
  });

  it('mentions specific examples for each category (e.g. SSRF, race conditions)', () => {
    assert.match(ROLE, /race conditions/);
    assert.match(ROLE, /SSRF/);
    assert.match(ROLE, /path traversal/);
  });
});

// ── normalizeReview · happy path ─────────────────────────────────

describe('normalizeReview · happy path', () => {
  it('passes through a fully-valid review unchanged', () => {
    const out = normalizeReview({
      final: {
        summary: 'overall clean',
        findings: [
          {
            file: 'src/a.js',
            start_line: 12,
            end_line: 18,
            severity: 'critical',
            category: 'security',
            issue: 'SQL injection',
            suggestion: 'use parameterised queries',
            confidence: 0.9,
          },
        ],
      },
      iterations: 4,
      terminatedBy: 'final',
    });
    assert.equal(out.summary, 'overall clean');
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].severity, 'critical');
    assert.equal(out.findings[0].category, 'security');
    assert.equal(out.findings[0].confidence, 0.9);
    assert.equal(out.iterations, 4);
    assert.equal(out.terminatedBy, 'final');
  });

  it('counts findings by severity', () => {
    const out = normalizeReview({
      final: { findings: [
        { issue: 'a', severity: 'critical' },
        { issue: 'b', severity: 'critical' },
        { issue: 'c', severity: 'high' },
        { issue: 'd', severity: 'medium' },
        { issue: 'e', severity: 'low' },
        { issue: 'f', severity: 'info' },
      ]},
    });
    assert.deepEqual(out.counts, {
      critical: 2,
      high: 1,
      medium: 1,
      low: 1,
      info: 1,
    });
  });

  it('sorts findings critical first → info last', () => {
    const out = normalizeReview({
      final: { findings: [
        { issue: 'a-low', severity: 'low' },
        { issue: 'b-critical', severity: 'critical' },
        { issue: 'c-info', severity: 'info' },
        { issue: 'd-high', severity: 'high' },
        { issue: 'e-medium', severity: 'medium' },
      ]},
    });
    assert.deepEqual(
      out.findings.map(f => f.severity),
      ['critical', 'high', 'medium', 'low', 'info'],
    );
  });
});

// ── normalizeReview · defaults ───────────────────────────────────

describe('normalizeReview · defaults', () => {
  it('missing summary defaults to ""', () => {
    const out = normalizeReview({ final: {} });
    assert.equal(out.summary, '');
  });

  it('non-string summary defaults to ""', () => {
    const out = normalizeReview({ final: { summary: 42 } });
    assert.equal(out.summary, '');
  });

  it('missing findings defaults to []', () => {
    const out = normalizeReview({ final: {} });
    assert.deepEqual(out.findings, []);
    assert.deepEqual(out.counts, { critical: 0, high: 0, medium: 0, low: 0, info: 0 });
  });

  it('non-array findings defaults to []', () => {
    const out = normalizeReview({ final: { findings: 'not-array' } });
    assert.deepEqual(out.findings, []);
  });

  it('handles missing final entirely', () => {
    const out = normalizeReview({});
    assert.equal(out.summary, '');
    assert.deepEqual(out.findings, []);
  });
});

// ── normalizeReview · per-finding coercion ───────────────────────

describe('normalizeReview · finding coercion', () => {
  it('non-integer start_line / end_line become null', () => {
    const out = normalizeReview({
      final: { findings: [
        { issue: 'x', start_line: 'not-int', end_line: 12.5 },
      ]},
    });
    assert.equal(out.findings[0].start_line, null);
    assert.equal(out.findings[0].end_line, null);
  });

  it('unknown severity defaults to "info"', () => {
    const out = normalizeReview({
      final: { findings: [
        { issue: 'x', severity: 'apocalyptic' },
      ]},
    });
    assert.equal(out.findings[0].severity, 'info');
  });

  it('missing severity defaults to "info"', () => {
    const out = normalizeReview({
      final: { findings: [{ issue: 'x' }] },
    });
    assert.equal(out.findings[0].severity, 'info');
  });

  it('unknown category defaults to "maintainability"', () => {
    const out = normalizeReview({
      final: { findings: [{ issue: 'x', category: 'spaghetti' }] },
    });
    assert.equal(out.findings[0].category, 'maintainability');
  });

  it('issue truncated to 400 chars', () => {
    const out = normalizeReview({
      final: { findings: [{ issue: 'x'.repeat(800) }] },
    });
    assert.equal(out.findings[0].issue.length, 400);
  });

  it('suggestion truncated to 400 chars', () => {
    const out = normalizeReview({
      final: { findings: [{ issue: 'x', suggestion: 's'.repeat(800) }] },
    });
    assert.equal(out.findings[0].suggestion.length, 400);
  });

  it('confidence clamped to [0, 1]', () => {
    const out = normalizeReview({
      final: { findings: [
        { issue: 'a', confidence: -0.5 },
        { issue: 'b', confidence: 0.3 },
        { issue: 'c', confidence: 1.5 },
      ]},
    });
    assert.equal(out.findings[0].confidence, 0);
    assert.equal(out.findings[1].confidence, 0.3);
    assert.equal(out.findings[2].confidence, 1);
  });

  it('non-numeric confidence defaults to 0.5', () => {
    const out = normalizeReview({
      final: { findings: [
        { issue: 'a', confidence: 'high' },
        { issue: 'b' },
      ]},
    });
    assert.equal(out.findings[0].confidence, 0.5);
    assert.equal(out.findings[1].confidence, 0.5);
  });

  it('findings without "issue" are dropped (.filter)', () => {
    const out = normalizeReview({
      final: { findings: [
        { issue: 'valid' },
        { issue: '' },
        {},
        { issue: 'also valid', severity: 'high' },
      ]},
    });
    assert.equal(out.findings.length, 2);
    assert.deepEqual(out.findings.map(f => f.issue).sort(), ['also valid', 'valid']);
  });

  it('file coerced to string; missing → ""', () => {
    const out = normalizeReview({
      final: { findings: [{ issue: 'x' }, { issue: 'y', file: 42 }] },
    });
    assert.equal(out.findings[0].file, '');
    assert.equal(out.findings[1].file, '42');
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/agents/code-review-agent');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['ROLE', 'normalizeReview', 'review']);
  });
});
