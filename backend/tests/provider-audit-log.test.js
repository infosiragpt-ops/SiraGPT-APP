'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createProviderAuditLog,
  defaultRedactor,
} = require('../src/services/observability/provider-audit-log');

describe('defaultRedactor', () => {
  test('replaces emails', () => {
    assert.match(defaultRedactor('mail to alice@example.com'), /\[REDACTED:email\]/);
  });
  test('replaces bearer tokens', () => {
    const out = defaultRedactor('Authorization: Bearer abc.def_GHI-123');
    assert.match(out, /Bearer \[REDACTED\]/);
  });
  test('replaces sk- API keys', () => {
    const out = defaultRedactor('key=sk-abcd1234efgh5678');
    assert.match(out, /\[REDACTED:key\]/);
  });
  test('credit-card-like sequence is replaced', () => {
    const out = defaultRedactor('card 4111 1111 1111 1111');
    assert.match(out, /\[REDACTED:cc\]/);
  });
  test('non-string passthrough', () => {
    assert.equal(defaultRedactor(null), null);
    assert.equal(defaultRedactor(42), 42);
  });
  test('safe text is unchanged', () => {
    assert.equal(defaultRedactor('hello world'), 'hello world');
  });
});

describe('createProviderAuditLog — append + size', () => {
  test('append stores a row and increments size', () => {
    const log = createProviderAuditLog({ now: () => 1000 });
    const r = log.append({ model: 'gpt-5', tenantId: 't1', status: 'ok', latencyMs: 42 });
    assert.equal(r.model, 'gpt-5');
    assert.equal(r.ts, 1000);
    assert.equal(log.size(), 1);
  });

  test('rejects appends without model', () => {
    const log = createProviderAuditLog({});
    assert.equal(log.append({}), null);
    assert.equal(log.append({ model: '' }), null);
    assert.equal(log.size(), 0);
  });

  test('redacts email/keys/bearer in fields and meta (deep)', () => {
    const log = createProviderAuditLog({ now: () => 0 });
    const r = log.append({
      model: 'gpt-5',
      tenantId: 'alice@example.com',
      requestId: 'sk-abcdef1234567890',
      meta: {
        prompt: 'send to bob@example.com',
        nested: { auth: 'Bearer xyz.123' },
      },
    });
    assert.match(r.tenantId, /\[REDACTED:email\]/);
    assert.match(r.requestId, /\[REDACTED:key\]/);
    assert.match(r.meta.prompt, /\[REDACTED:email\]/);
    assert.match(r.meta.nested.auth, /Bearer \[REDACTED\]/);
  });

  test('latencyMs is sanitized (negative/NaN → 0, floored)', () => {
    const log = createProviderAuditLog({ now: () => 0 });
    assert.equal(log.append({ model: 'm', latencyMs: -5 }).latencyMs, 0);
    assert.equal(log.append({ model: 'm', latencyMs: NaN }).latencyMs, 0);
    assert.equal(log.append({ model: 'm', latencyMs: 12.7 }).latencyMs, 12);
  });
});

describe('createProviderAuditLog — capacity', () => {
  test('exceeding capacity drops oldest and counts it', () => {
    const log = createProviderAuditLog({ capacity: 3, now: () => 0 });
    log.append({ model: 'a' });
    log.append({ model: 'b' });
    log.append({ model: 'c' });
    log.append({ model: 'd' });
    assert.equal(log.size(), 3);
    assert.equal(log.snapshot().totalDroppedCapacity, 1);
    const all = log.query({});
    assert.deepEqual(all.map((e) => e.model), ['d', 'c', 'b']);
  });
});

describe('createProviderAuditLog — age window', () => {
  test('events older than maxAgeMs are pruned on append', () => {
    let t = 0;
    const log = createProviderAuditLog({ maxAgeMs: 1000, now: () => t });
    log.append({ model: 'old' });
    t = 5000;
    log.append({ model: 'new' });
    const all = log.query({});
    assert.deepEqual(all.map((e) => e.model), ['new']);
    assert.equal(log.snapshot().totalDroppedAge, 1);
  });
});

describe('createProviderAuditLog — query', () => {
  test('filter by model / tenantId / status', () => {
    const log = createProviderAuditLog({ now: () => 0 });
    log.append({ model: 'a', tenantId: 't1', status: 'ok' });
    log.append({ model: 'b', tenantId: 't1', status: 'fail' });
    log.append({ model: 'a', tenantId: 't2', status: 'ok' });
    assert.equal(log.query({ model: 'a' }).length, 2);
    assert.equal(log.query({ tenantId: 't1' }).length, 2);
    assert.equal(log.query({ status: 'fail' }).length, 1);
    assert.equal(log.query({ model: 'a', tenantId: 't2' }).length, 1);
  });

  test('filter by since/until window', () => {
    let t = 0;
    const log = createProviderAuditLog({ now: () => t, maxAgeMs: 60_000 });
    log.append({ model: 'a' }); t = 1000;
    log.append({ model: 'a' }); t = 2000;
    log.append({ model: 'a' });
    assert.equal(log.query({ since: 500, until: 1500 }).length, 1);
  });

  test('limit caps result count and respects newest-first', () => {
    const log = createProviderAuditLog({ now: () => 0 });
    for (let i = 0; i < 5; i++) log.append({ model: `m${i}` });
    const r = log.query({ limit: 2 });
    assert.equal(r.length, 2);
    assert.equal(r[0].model, 'm4');
    assert.equal(r[1].model, 'm3');
  });
});

describe('createProviderAuditLog — snapshot + clear', () => {
  test('snapshot reports counters + config', () => {
    const log = createProviderAuditLog({ capacity: 10, maxAgeMs: 1000 });
    log.append({ model: 'm' });
    const s = log.snapshot();
    assert.equal(s.size, 1);
    assert.equal(s.capacity, 10);
    assert.equal(s.totalAppended, 1);
  });

  test('clear() empties the log without resetting counters', () => {
    const log = createProviderAuditLog({});
    log.append({ model: 'm' });
    log.clear();
    assert.equal(log.size(), 0);
    assert.equal(log.snapshot().totalAppended, 1);
  });
});
