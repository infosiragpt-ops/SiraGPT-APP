/**
 * Tests for services/agents/log-analysis-agent.js — log-burst
 * clustering + LLM correlation.
 *
 * Heavy analyse() calls agentCore; we test the pure clusterLines,
 * normaliseLogLine, normaliseLogResult, ROLE, and the input guard.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  analyse,
  clusterLines,
  normaliseLogLine,
  normaliseLogResult,
  ROLE,
} = require('../src/services/agents/log-analysis-agent');

// ── ROLE constant ────────────────────────────────────────────────

describe('ROLE constant', () => {
  it('positions as SRE perspective', () => {
    assert.match(ROLE, /SRE/);
  });

  it('directs to focus on highest-count clusters', () => {
    assert.match(ROLE, /highest-count clusters first/);
  });

  it('mentions cascading-error recognition', () => {
    assert.match(ROLE, /cascading errors/);
  });

  it('requires confidence scores', () => {
    assert.match(ROLE, /Confidence scores are required/);
  });
});

// ── normaliseLogLine ────────────────────────────────────────────

describe('normaliseLogLine', () => {
  it('replaces ISO timestamps with <TS>', () => {
    assert.match(normaliseLogLine('2026-01-15T12:34:56 ERROR boom'), /<TS>/);
    assert.match(normaliseLogLine('2026-01-15 12:34:56.789Z ERROR'), /<TS>/);
    assert.match(normaliseLogLine('2026-01-15T12:34:56+05:30 ERROR'), /<TS>/);
  });

  it('replaces 13+ digit ms timestamps with <TS_MS>', () => {
    assert.match(normaliseLogLine('event at 1736947200000'), /<TS_MS>/);
  });

  it('replaces UUIDs with <UUID>', () => {
    assert.match(normaliseLogLine('user 550e8400-e29b-41d4-a716-446655440000 logged in'), /<UUID>/);
  });

  it('replaces long hex (32+ chars) with <ID>', () => {
    assert.match(normaliseLogLine('hash=' + 'a'.repeat(64)), /<ID>/);
  });

  it('replaces IPv4 with <IP>', () => {
    assert.match(normaliseLogLine('client 192.168.1.42 connected'), /<IP>/);
  });

  it('replaces double-quoted strings with <STR>', () => {
    assert.match(normaliseLogLine('msg="user not found"'), /<STR>/);
  });

  it('replaces single-quoted strings with <STR>', () => {
    assert.match(normaliseLogLine("msg='bad request'"), /<STR>/);
  });

  it('replaces bare numbers with <N>', () => {
    assert.match(normaliseLogLine('count=42 retries=3'), /<N>/);
  });

  it('collapses runs of whitespace', () => {
    const out = normaliseLogLine('a    b\t\tc\n\nd');
    assert.equal(out, 'a b c d');
  });

  it('truncates result to 400 chars', () => {
    const long = 'x'.repeat(2000);
    assert.equal(normaliseLogLine(long).length, 400);
  });

  it('two similar lines reduce to the same signature', () => {
    const a = normaliseLogLine('2026-01-15T12:34:56 user 550e8400-e29b-41d4-a716-446655440000 not found');
    const b = normaliseLogLine('2026-01-15T13:00:00 user 12345678-1234-1234-1234-123456789012 not found');
    assert.equal(a, b);
  });
});

// ── clusterLines ────────────────────────────────────────────────

describe('clusterLines', () => {
  it('returns [] for empty input', () => {
    assert.deepEqual(clusterLines([]), []);
  });

  it('groups identical-after-normalisation lines into one cluster', () => {
    // Numbers must be space-bounded (\\b\\d+\\b) to normalise; "5s"
    // doesn't because digit-letter has no word boundary. Use isolated
    // digits.
    const lines = [
      'user 550e8400-e29b-41d4-a716-446655440000 timeout after 5 sec',
      'user 12345678-1234-1234-1234-123456789012 timeout after 3 sec',
      'user 87654321-4321-4321-4321-210987654321 timeout after 10 sec',
    ];
    const out = clusterLines(lines);
    assert.equal(out.length, 1);
    assert.equal(out[0].count, 3);
    assert.equal(out[0].examples.length, 3);
  });

  it('keeps separate clusters when signatures differ', () => {
    const lines = [
      'ERROR timeout',
      'ERROR timeout',
      'WARN low memory',
      'WARN low memory',
      'WARN low memory',
    ];
    const out = clusterLines(lines);
    assert.equal(out.length, 2);
    // WARN cluster has 3 (top), ERROR has 2.
    assert.equal(out[0].count, 3);
    assert.equal(out[1].count, 2);
  });

  it('sorts clusters by count descending', () => {
    const lines = [
      'a', 'a',
      'b', 'b', 'b', 'b',
      'c', 'c', 'c',
    ];
    const out = clusterLines(lines);
    assert.deepEqual(out.map(c => c.count), [4, 3, 2]);
  });

  it('caps to topK (default 10)', () => {
    // Need GENUINELY different signatures — "pattern-1" and "pattern-2"
    // normalise to the SAME signature because the trailing digit is
    // bound by space ahead and end-of-string after, both \\b. Use
    // alphabetic variations instead.
    const letters = 'abcdefghijklmnopqrstuvwxyzABCD';
    const lines = letters.split('').map(l => `error category ${l}`);
    const out = clusterLines(lines);
    assert.equal(out.length, 10);  // capped at default topK
  });

  it('honours custom topK', () => {
    const letters = 'abcdefghij';
    const lines = letters.split('').map(l => `error category ${l}`);
    const out = clusterLines(lines, { topK: 3 });
    assert.equal(out.length, 3);
  });

  it('honours minCount filter', () => {
    const lines = ['a', 'a', 'b', 'b', 'b', 'c'];
    const out = clusterLines(lines, { minCount: 2 });
    assert.equal(out.length, 2);
    assert.ok(out.every(c => c.count >= 2));
  });

  it('skips empty / whitespace-only lines', () => {
    const lines = ['ERROR boom', '', '   ', 'ERROR boom', null];
    const out = clusterLines(lines);
    assert.equal(out.length, 1);
    assert.equal(out[0].count, 2);
  });

  it('captures up to 3 example lines per cluster', () => {
    const lines = [];
    for (let i = 0; i < 10; i++) lines.push(`error at ${i} ms`);
    const out = clusterLines(lines);
    assert.equal(out[0].examples.length, 3);
  });

  it('truncates each example to 300 chars', () => {
    const long = 'x'.repeat(1000) + ' error';
    const out = clusterLines([long, long]);
    assert.ok(out[0].examples[0].length <= 300);
  });
});

// ── analyse · validation ────────────────────────────────────────

describe('analyse · validation', () => {
  it('throws when logs missing', async () => {
    await assert.rejects(
      () => analyse({ openai: {}, userId: 'u' }),
      /"logs" is required/,
    );
  });
});

describe('analyse · early-return on no clusters', () => {
  it('throws for empty-string logs (falsy check fires first)', async () => {
    // The "logs is required" guard rejects empty strings before
    // clustering. The early-return path only triggers when logs is a
    // truthy value (non-empty array or non-empty string) that
    // happens to cluster to nothing.
    await assert.rejects(
      () => analyse({ openai: {}, logs: '' }),
      /"logs" is required/,
    );
  });

  it('returns synthetic summary when string logs cluster to nothing', async () => {
    // A string of only whitespace lines passes the truthy guard but
    // produces no clusters (every line is whitespace-only).
    const out = await analyse({
      openai: {}, userId: 'u', collection: 'c',
      logs: '   \n   \n   ',
    });
    assert.match(out.summary, /No log lines matched/);
    assert.deepEqual(out.top_clusters, []);
    assert.equal(out.iterations, 0);
    assert.equal(out.terminatedBy, 'final');
  });

  it('throws when logs is an empty array (falsy on no-elements? actually [] is truthy)', async () => {
    // Empty array passes the truthy guard, then clusters to nothing.
    const out = await analyse({
      openai: {}, userId: 'u', collection: 'c',
      logs: [],
    });
    assert.match(out.summary, /No log lines matched/);
    assert.equal(out.total_lines, 0);
  });
});

// ── normaliseLogResult ─────────────────────────────────────────

describe('normaliseLogResult', () => {
  const rawClusters = [
    { signature: 'ERROR <N>', count: 7, examples: ['ERROR 1', 'ERROR 2'] },
    { signature: 'WARN low memory', count: 3, examples: ['WARN low memory'] },
  ];

  it('merges raw clusters with LLM enrichment by index', () => {
    const out = normaliseLogResult({
      final: {
        summary: 'mostly timeouts',
        top_clusters: [
          {
            likely_root_cause: 'DB timeout',
            correlated_source: 'db/conn.js',
            severity: 'high',
            confidence: 0.85,
            suggested_action: 'increase pool size',
          },
          {
            likely_root_cause: 'OOM',
            severity: 'medium',
            confidence: 0.6,
          },
        ],
      },
      iterations: 5,
      terminatedBy: 'final',
      stats: { tokens: 1234 },
    }, rawClusters, 200);

    assert.equal(out.top_clusters.length, 2);
    assert.equal(out.top_clusters[0].count, 7);
    assert.equal(out.top_clusters[0].likely_root_cause, 'DB timeout');
    assert.equal(out.top_clusters[0].severity, 'high');
    assert.equal(out.top_clusters[0].correlated_source, 'db/conn.js');
    assert.equal(out.top_clusters[1].correlated_source, null);  // default
    assert.equal(out.summary, 'mostly timeouts');
    assert.equal(out.total_lines, 200);
    assert.equal(out.iterations, 5);
    assert.deepEqual(out.stats, { tokens: 1234 });
  });

  it('auto-generates summary when LLM provides none', () => {
    const out = normaliseLogResult({ final: {} }, rawClusters, 200);
    assert.match(out.summary, /2 clusters from 200 lines/);
  });

  it('summary truncated to 600 chars', () => {
    const out = normaliseLogResult({
      final: { summary: 's'.repeat(2000) },
    }, rawClusters, 100);
    assert.equal(out.summary.length, 600);
  });

  it('preserves raw cluster fields when LLM omits enrichment for index', () => {
    const out = normaliseLogResult({
      final: { top_clusters: [] },  // no enrichment for any cluster
    }, rawClusters, 100);
    assert.equal(out.top_clusters.length, 2);
    assert.equal(out.top_clusters[0].likely_root_cause, '');
    assert.equal(out.top_clusters[0].severity, 'medium');  // default
    assert.equal(out.top_clusters[0].confidence, 0.5);     // default
    assert.equal(out.top_clusters[0].correlated_source, null);
  });

  it('likely_root_cause truncated to 1000 chars', () => {
    const out = normaliseLogResult({
      final: { top_clusters: [{ likely_root_cause: 'x'.repeat(2000) }] },
    }, [rawClusters[0]], 100);
    assert.equal(out.top_clusters[0].likely_root_cause.length, 1000);
  });

  it('suggested_action truncated to 300 chars', () => {
    const out = normaliseLogResult({
      final: { top_clusters: [{ suggested_action: 'a'.repeat(1000) }] },
    }, [rawClusters[0]], 100);
    assert.equal(out.top_clusters[0].suggested_action.length, 300);
  });

  it('unknown severity defaults to "medium"', () => {
    const out = normaliseLogResult({
      final: { top_clusters: [{ severity: 'apocalyptic' }] },
    }, [rawClusters[0]], 100);
    assert.equal(out.top_clusters[0].severity, 'medium');
  });

  it('confidence clamped to [0, 1]', () => {
    const a = normaliseLogResult({
      final: { top_clusters: [{ confidence: -0.5 }] },
    }, [rawClusters[0]], 100);
    assert.equal(a.top_clusters[0].confidence, 0);
    const b = normaliseLogResult({
      final: { top_clusters: [{ confidence: 1.5 }] },
    }, [rawClusters[0]], 100);
    assert.equal(b.top_clusters[0].confidence, 1);
  });

  it('non-numeric confidence defaults to 0.5', () => {
    const out = normaliseLogResult({
      final: { top_clusters: [{ confidence: 'high' }] },
    }, [rawClusters[0]], 100);
    assert.equal(out.top_clusters[0].confidence, 0.5);
  });

  it('non-string correlated_source → null', () => {
    const out = normaliseLogResult({
      final: { top_clusters: [{ correlated_source: 42 }] },
    }, [rawClusters[0]], 100);
    assert.equal(out.top_clusters[0].correlated_source, null);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/agents/log-analysis-agent');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['ROLE', 'analyse', 'clusterLines', 'normaliseLogLine', 'normaliseLogResult']);
  });
});
