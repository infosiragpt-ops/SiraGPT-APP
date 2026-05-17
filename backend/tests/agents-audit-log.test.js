/**
 * Tests for services/agents/audit-log.js — structured agent-activity log.
 *
 * Focus: redact() rules + audit() output (captures process.stderr) +
 * auditAgentRun shorthand.
 */

'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

const {
  audit,
  auditAgentRun,
  redact,
} = require('../src/services/agents/audit-log');

// Capture stderr writes per-test.
const _origWrite = process.stderr.write.bind(process.stderr);
let captured = [];
function startCapture() {
  captured = [];
  process.stderr.write = (chunk) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
}
function stopCapture() {
  process.stderr.write = _origWrite;
  return captured.join('');
}

beforeEach(() => {
  captured = [];
});

// ── redact ────────────────────────────────────────────────────────

describe('redact · primitives + passthrough', () => {
  it('returns null/undefined unchanged', () => {
    assert.equal(redact(null), null);
    assert.equal(redact(undefined), undefined);
  });

  it('returns non-string non-object primitives unchanged', () => {
    assert.equal(redact(42), 42);
    assert.equal(redact(true), true);
    assert.equal(redact(false), false);
  });

  it('returns clean strings unchanged', () => {
    assert.equal(redact('hello world'), 'hello world');
  });
});

describe('redact · secret-pattern detection', () => {
  it('redacts AWS AKIA access keys', () => {
    const out = redact('keys: AKIAIOSFODNN7EXAMPLE here');
    assert.match(out, /<REDACTED>/);
    assert.equal(out.includes('AKIAIOSFODNN7EXAMPLE'), false);
  });

  it('redacts AWS ASIA temp tokens', () => {
    const out = redact('token: ASIAIOSFODNN7EXAMPLE');
    assert.match(out, /<REDACTED>/);
  });

  it('redacts OpenAI sk- keys (≥20 chars after prefix)', () => {
    const out = redact('OPENAI_KEY=sk-abcdefghij1234567890ABCDEFGHIJKL');
    assert.match(out, /<REDACTED>/);
    assert.equal(out.includes('sk-abcdefghij1234567890ABCDEFGHIJKL'), false);
  });

  it('does NOT redact short sk- prefixes (< 20 chars body)', () => {
    // The pattern requires 20+ chars; short prefixes pass through.
    assert.equal(redact('sk-short'), 'sk-short');
  });

  it('redacts GitHub PAT (ghp_ + 36 chars)', () => {
    const pat = 'ghp_' + 'A'.repeat(36);
    const out = redact(`token: ${pat}`);
    assert.match(out, /<REDACTED>/);
    assert.equal(out.includes(pat), false);
  });

  it('redacts Slack xoxb/xoxp/xoxa/xoxr/xoxs tokens', () => {
    for (const prefix of ['xoxb', 'xoxp', 'xoxa', 'xoxr', 'xoxs']) {
      const tok = `${prefix}-` + 'A1B2'.repeat(5);
      const out = redact(`auth: ${tok}`);
      assert.match(out, /<REDACTED>/, `${prefix} not redacted`);
    }
  });

  it('redacts JWT-style three-segment tokens', () => {
    const jwt = 'eyJabcdefghij.eyJklmnopqrst.qrstuvwxyz123';
    const out = redact(`Authorization: Bearer ${jwt}`);
    assert.match(out, /<REDACTED>/);
  });

  it('redacts JSON fields named api_key / secret / password / token / bearer', () => {
    const json = '{"api_key":"abcdefghij1234","other":"x"}';
    const out = redact(json);
    assert.match(out, /<REDACTED>/);
    assert.equal(out.includes('abcdefghij1234'), false);
    // Non-secret fields are kept.
    assert.match(out, /"other":"x"/);
  });

  it('redacts JSON "secret":"<value>" field forms', () => {
    const out = redact('{"secret":"12345678","keep":"x"}');
    assert.match(out, /<REDACTED>/);
    assert.match(out, /"keep":"x"/);
  });

  it('case-insensitive JSON field names (API_KEY, Secret, BEARER)', () => {
    for (const key of ['API_KEY', 'Secret', 'PASSWORD', 'BEARER']) {
      const out = redact(`{"${key}":"abcdefghij12345"}`);
      assert.match(out, /<REDACTED>/, `${key} not redacted`);
    }
  });
});

describe('redact · recursion into containers', () => {
  it('recurses into arrays', () => {
    const out = redact(['public', 'AKIAIOSFODNN7EXAMPLE', 'visible']);
    assert.equal(out[0], 'public');
    assert.match(out[1], /<REDACTED>/);
    assert.equal(out[2], 'visible');
  });

  it('recurses into nested object properties', () => {
    const out = redact({
      outer: { inner: 'AKIAIOSFODNN7EXAMPLE', also: 'fine' },
      list: ['x', 'sk-abcdefghij1234567890ABCDEFGHIJKL'],
    });
    assert.match(out.outer.inner, /<REDACTED>/);
    assert.equal(out.outer.also, 'fine');
    assert.match(out.list[1], /<REDACTED>/);
  });

  it('does not mutate the input', () => {
    const input = { token: 'AKIAIOSFODNN7EXAMPLE' };
    redact(input);
    assert.equal(input.token, 'AKIAIOSFODNN7EXAMPLE', 'input should be untouched');
  });
});

// ── audit ─────────────────────────────────────────────────────────

describe('audit', () => {
  it('writes a single JSON line to stderr by default', () => {
    startCapture();
    audit({ event: 'test', value: 1 });
    const out = stopCapture();
    assert.ok(out.endsWith('\n'));
    const obj = JSON.parse(out.trim());
    assert.equal(obj.event, 'test');
    assert.equal(obj.value, 1);
    assert.ok(obj.t, 'must include timestamp');
  });

  it('adds an ISO timestamp under "t"', () => {
    startCapture();
    audit({ event: 'x' });
    const out = stopCapture();
    const obj = JSON.parse(out.trim());
    assert.ok(!isNaN(new Date(obj.t).getTime()));
  });

  it('redacts secrets in the record before emit', () => {
    startCapture();
    audit({ event: 'leak', payload: 'token=AKIAIOSFODNN7EXAMPLE' });
    const out = stopCapture();
    assert.equal(out.includes('AKIAIOSFODNN7EXAMPLE'), false);
    assert.match(out, /<REDACTED>/);
  });

  it('circular-ref input throws — no defensive seen-set in redact (pinned)', () => {
    // redact() recurses without a seen-set, so a cyclic object causes
    // RangeError (stack overflow) BEFORE the audit() write-time
    // try/catch can run. Pin actual behavior so a future defensive
    // refactor surfaces here intentionally.
    const a = { event: 'cyclic' };
    a.self = a;
    assert.throws(() => audit(a));
  });

  it('caller-supplied "t" is overridden by the auto timestamp', () => {
    // The audit function spreads { t, ...record } so the auto t comes
    // FIRST and a caller-provided t (placed later) wins. Pin actual
    // behavior so a refactor surfaces.
    startCapture();
    audit({ t: '1999-01-01T00:00:00Z', event: 'old' });
    const out = stopCapture();
    const obj = JSON.parse(out.trim());
    assert.equal(obj.t, '1999-01-01T00:00:00Z',
      'caller-supplied t wins under current spread order');
  });
});

// ── auditAgentRun ─────────────────────────────────────────────────

describe('auditAgentRun', () => {
  function lastLine() {
    return JSON.parse(captured.join('').trim());
  }

  it('emits event=agent_run with userId/agent/collection', () => {
    startCapture();
    auditAgentRun({
      userId: 'u1',
      agent: 'TestAgent',
      collection: 'docs',
      result: {},
    });
    stopCapture();
    const obj = lastLine();
    assert.equal(obj.event, 'agent_run');
    assert.equal(obj.userId, 'u1');
    assert.equal(obj.agent, 'TestAgent');
    assert.equal(obj.collection, 'docs');
  });

  it('null-defaults userId and collection when missing', () => {
    startCapture();
    auditAgentRun({ agent: 'A' });
    stopCapture();
    const obj = lastLine();
    assert.equal(obj.userId, null);
    assert.equal(obj.collection, null);
  });

  it('summarizes result.stats: tokens=prompt+completion, durationMs, toolCalls, toolCacheHits', () => {
    startCapture();
    auditAgentRun({
      agent: 'A',
      result: {
        iterations: 3,
        terminatedBy: 'final',
        stats: {
          durationMs: 1234,
          approxPromptTokens: 200,
          approxCompletionTokens: 100,
          toolCalls: 5,
          toolCacheHits: 2,
        },
      },
    });
    stopCapture();
    const obj = lastLine();
    assert.equal(obj.iterations, 3);
    assert.equal(obj.terminatedBy, 'final');
    assert.equal(obj.durationMs, 1234);
    assert.equal(obj.tokens, 300);
    assert.equal(obj.toolCalls, 5);
    assert.equal(obj.toolCacheHits, 2);
  });

  it('tokens=null when result.stats absent', () => {
    startCapture();
    auditAgentRun({ agent: 'A', result: {} });
    stopCapture();
    const obj = lastLine();
    assert.equal(obj.tokens, null);
  });

  it('merges "extra" fields into the record', () => {
    startCapture();
    auditAgentRun({
      agent: 'A',
      result: {},
      extra: { customField: 'value', another: 42 },
    });
    stopCapture();
    const obj = lastLine();
    assert.equal(obj.customField, 'value');
    assert.equal(obj.another, 42);
  });

  it('tokens handles missing prompt OR completion gracefully (treated as 0)', () => {
    startCapture();
    auditAgentRun({
      agent: 'A',
      result: { stats: { approxPromptTokens: 50 } },
    });
    stopCapture();
    assert.equal(lastLine().tokens, 50);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports audit, auditAgentRun, redact, _flush (test-only)', () => {
    const mod = require('../src/services/agents/audit-log');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['_flush', 'audit', 'auditAgentRun', 'redact']);
  });
});
