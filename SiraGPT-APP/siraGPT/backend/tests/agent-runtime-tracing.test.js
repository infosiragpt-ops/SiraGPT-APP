/**
 * Tests for services/agent-runtime/tracing.js — agent-run tracer.
 *
 * Covers the createTrace() emit/snapshot/finish flow and the redact()
 * helper that hides secrets from logged payloads.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const { createTrace, redact } = require('../src/services/agent-runtime/tracing');

// ── redact() ───────────────────────────────────────────────────────

describe('redact', () => {
  it('returns primitives unchanged', () => {
    assert.equal(redact(42), 42);
    assert.equal(redact('hello'), 'hello');
    assert.equal(redact(true), true);
    assert.equal(redact(null), null);
    assert.equal(redact(undefined), undefined);
  });

  it('redacts the documented exact-match keys', () => {
    const out = redact({
      apiKey: 'sk-x',
      api_key: 'sk-y',
      authorization: 'Bearer z',
      Authorization: 'Bearer Z',
      password: 'hunter2',
      token: 'tk',
      secret: 'shh',
    });
    for (const key of Object.keys(out)) {
      assert.equal(out[key], '[REDACTED]', `${key} should be redacted`);
    }
  });

  it('redacts case-insensitive substring patterns (secret/password/token/api[_-]?key)', () => {
    const out = redact({
      OPENAI_SECRET: 'x',
      mySecretValue: 'x',
      USER_PASSWORD_HASH: 'x',
      session_token: 'x',
      apiKey_main: 'x',
      'api-key': 'x',
      api_key_v2: 'x',
    });
    for (const key of Object.keys(out)) {
      assert.equal(out[key], '[REDACTED]', `${key} should be redacted`);
    }
  });

  it('does NOT redact non-matching keys', () => {
    const input = {
      userId: 'u1',
      message: 'hello',
      count: 42,
    };
    assert.deepEqual(redact(input), input);
  });

  it('recurses into nested objects', () => {
    const out = redact({
      level1: {
        level2: {
          api_key: 'sk-deep',
          okField: 'visible',
        },
      },
    });
    assert.equal(out.level1.level2.api_key, '[REDACTED]');
    assert.equal(out.level1.level2.okField, 'visible');
  });

  it('recurses into arrays', () => {
    const out = redact([
      { password: 'a' },
      { name: 'public' },
    ]);
    assert.equal(out[0].password, '[REDACTED]');
    assert.equal(out[1].name, 'public');
  });

  it('handles circular references with [Circular] marker', () => {
    const obj = { a: 1 };
    obj.self = obj;
    const out = redact(obj);
    assert.equal(out.a, 1);
    assert.equal(out.self, '[Circular]');
  });

  it('produces a new object — does not mutate the input', () => {
    const input = { token: 'orig', name: 'keep' };
    redact(input);
    assert.equal(input.token, 'orig', 'input must remain unchanged');
  });
});

// ── createTrace() ──────────────────────────────────────────────────

describe('createTrace · construction', () => {
  it('returns a frozen handle with trace, emit, snapshot, finish', () => {
    const t = createTrace();
    assert.equal(typeof t.emit, 'function');
    assert.equal(typeof t.snapshot, 'function');
    assert.equal(typeof t.finish, 'function');
    assert.ok(t.trace);
    assert.throws(() => { t.x = 'hack'; }, TypeError);
  });

  it('generates run_id and correlation_id when not provided', () => {
    const t = createTrace();
    assert.match(t.trace.run_id, /^run_[0-9a-f-]+$/);
    assert.match(t.trace.correlation_id, /^corr_[0-9a-f-]+$/);
  });

  it('honours provided runId and correlationId', () => {
    const t = createTrace({ runId: 'r-custom', correlationId: 'c-custom' });
    assert.equal(t.trace.run_id, 'r-custom');
    assert.equal(t.trace.correlation_id, 'c-custom');
  });

  it('redacts metadata at construction time', () => {
    const t = createTrace({ metadata: { apiKey: 'sk-x', userId: 'u1' } });
    assert.equal(t.trace.metadata.apiKey, '[REDACTED]');
    assert.equal(t.trace.metadata.userId, 'u1');
  });

  it('starts with an empty events array', () => {
    const t = createTrace();
    assert.equal(t.trace.events.length, 0);
  });

  it('started_at is a parseable ISO timestamp', () => {
    const t = createTrace();
    assert.ok(!isNaN(new Date(t.trace.started_at).getTime()));
  });
});

describe('createTrace · emit', () => {
  it('appends an event with monotonically incrementing id', () => {
    const t = createTrace();
    const e1 = t.emit('step.start');
    const e2 = t.emit('step.end');
    assert.equal(e1.id, 'evt_1');
    assert.equal(e2.id, 'evt_2');
    assert.equal(t.trace.events.length, 2);
  });

  it('event carries the run_id and correlation_id of the trace', () => {
    const t = createTrace({ runId: 'r1', correlationId: 'c1' });
    const e = t.emit('test');
    assert.equal(e.run_id, 'r1');
    assert.equal(e.correlation_id, 'c1');
  });

  it('emitted events are frozen', () => {
    const t = createTrace();
    const e = t.emit('test');
    assert.throws(() => { e.x = 'hack'; }, TypeError);
  });

  it('redacts payload before storing', () => {
    const t = createTrace();
    const e = t.emit('test', { apiKey: 'sk-x', message: 'hi' });
    assert.equal(e.payload.apiKey, '[REDACTED]');
    assert.equal(e.payload.message, 'hi');
  });

  it('handles missing payload (default {})', () => {
    const t = createTrace();
    const e = t.emit('test');
    assert.deepEqual(e.payload, {});
  });

  it('event ts is a parseable ISO timestamp', () => {
    const t = createTrace();
    const e = t.emit('test');
    assert.ok(!isNaN(new Date(e.ts).getTime()));
  });
});

describe('createTrace · snapshot', () => {
  it('returns a frozen snapshot', () => {
    const t = createTrace();
    const s = t.snapshot();
    assert.throws(() => { s.x = 'hack'; }, TypeError);
  });

  it('snapshot.events is a copy — pushing to it does not affect later snapshots', () => {
    const t = createTrace();
    t.emit('e1');
    const s1 = t.snapshot();
    t.emit('e2');
    // s1 was taken when there was 1 event — must still be 1.
    assert.equal(s1.events.length, 1);
  });

  it('status defaults to "running" before finish', () => {
    const t = createTrace();
    assert.equal(t.snapshot().status, 'running');
  });

  it('ended_at defaults to null before finish', () => {
    const t = createTrace();
    assert.equal(t.snapshot().ended_at, null);
  });
});

describe('createTrace · finish', () => {
  it('default status is "completed"', () => {
    const t = createTrace();
    const s = t.finish();
    assert.equal(s.status, 'completed');
  });

  it('emits a run.<status> event with the provided payload', () => {
    const t = createTrace();
    t.finish('completed', { result: 'ok' });
    const last = t.trace.events[t.trace.events.length - 1];
    assert.equal(last.type, 'run.completed');
    assert.equal(last.payload.result, 'ok');
  });

  it('honours a custom status (e.g. "failed")', () => {
    const t = createTrace();
    const s = t.finish('failed', { error: 'boom' });
    assert.equal(s.status, 'failed');
    const last = t.trace.events[t.trace.events.length - 1];
    assert.equal(last.type, 'run.failed');
  });

  it('records ended_at on the returned snapshot', () => {
    const t = createTrace();
    const s = t.finish();
    assert.ok(s.ended_at);
    assert.ok(!isNaN(new Date(s.ended_at).getTime()));
  });

  it('redacts the finish payload too', () => {
    const t = createTrace();
    t.finish('completed', { apiKey: 'sk-x' });
    const last = t.trace.events[t.trace.events.length - 1];
    assert.equal(last.payload.apiKey, '[REDACTED]');
  });
});
