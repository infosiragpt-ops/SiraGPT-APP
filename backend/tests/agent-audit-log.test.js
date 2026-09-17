'use strict';

/**
 * Tests for services/agent-audit-log.js — append-only, tamper-evident
 * audit log for external agent actions (G32).
 *
 * Covers: hash-chain construction + verifyChain tamper detection,
 * query filtering/ordering, secret redaction + detail cap, JSONL
 * rotation with real fs in os.tmpdir(), and best-effort disk errors.
 */

const assert = require('node:assert');
const { describe, it } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const {
  createAuditLog,
  createMemoryStore,
  createJsonlStore,
  MAX_DETAIL_CHARS,
  REDACTED,
} = require('../src/services/agent-audit-log');

function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-audit-log-'));
}

describe('agent-audit-log — hash chain', () => {
  it('builds a valid per-user chain and verifyChain reports ok', () => {
    const log = createAuditLog({ store: createMemoryStore() });
    log.append({ userId: 'u1', action: 'email.send', target: 'client@acme.com' });
    log.append({ userId: 'u1', action: 'http.post', target: 'https://api.acme.com' });
    log.append({ userId: 'u2', action: 'file.write', target: '/tmp/report.pdf' });
    log.append({ userId: 'u1', action: 'email.send', target: 'boss@acme.com' });

    assert.deepStrictEqual(log.verifyChain(), { ok: true });
    assert.deepStrictEqual(log.verifyChain({ userId: 'u1' }), { ok: true });
    assert.deepStrictEqual(log.verifyChain({ userId: 'u2' }), { ok: true });
  });

  it('prevHash is sha256(previous prevHash + canonical JSON of the payload)', () => {
    const store = createMemoryStore();
    const log = createAuditLog({ store });
    const first = log.append({ userId: 'u1', action: 'a', target: 't', ts: 1000 });
    const second = log.append({ userId: 'u1', action: 'b', target: 't2', ts: 2000 });

    const firstPayload = {
      seq: 1, userId: 'u1', action: 'a', target: 't', detail: undefined, ts: 1000,
    };
    assert.strictEqual(first.prevHash, sha256Hex('' + JSON.stringify(firstPayload)));

    const secondPayload = {
      seq: 2, userId: 'u1', action: 'b', target: 't2', detail: undefined, ts: 2000,
    };
    assert.strictEqual(
      second.prevHash,
      sha256Hex(first.prevHash + JSON.stringify(secondPayload)),
    );
  });

  it('verifyChain detects a tampered payload field with brokenAt', () => {
    const store = createMemoryStore();
    const log = createAuditLog({ store });
    log.append({ userId: 'u1', action: 'email.send', target: 'a@x.com' });
    const middle = log.append({ userId: 'u1', action: 'email.send', target: 'b@x.com' });
    log.append({ userId: 'u1', action: 'email.send', target: 'c@x.com' });

    // Tamper the persisted middle entry (objects in the store are live).
    const persisted = store.list().find((entry) => entry.seq === middle.seq);
    persisted.target = 'evil@attacker.com';

    const verdict = log.verifyChain();
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.brokenAt, middle.seq);
    // The scoped check catches it too.
    assert.strictEqual(log.verifyChain({ userId: 'u1' }).ok, false);
  });

  it('verifyChain detects a tampered prevHash', () => {
    const store = createMemoryStore();
    const log = createAuditLog({ store });
    log.append({ userId: 'u1', action: 'a', target: 't1' });
    const last = log.append({ userId: 'u1', action: 'a', target: 't2' });

    store.list().find((entry) => entry.seq === last.seq).prevHash = 'f'.repeat(64);

    const verdict = log.verifyChain();
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.brokenAt, last.seq);
  });

  it('tampering one user does not break another user chain scope', () => {
    const store = createMemoryStore();
    const log = createAuditLog({ store });
    const bad = log.append({ userId: 'u1', action: 'a', target: 't1' });
    log.append({ userId: 'u2', action: 'a', target: 't2' });

    store.list().find((entry) => entry.seq === bad.seq).action = 'x';

    assert.strictEqual(log.verifyChain({ userId: 'u1' }).ok, false);
    assert.deepStrictEqual(log.verifyChain({ userId: 'u2' }), { ok: true });
  });
});

describe('agent-audit-log — query', () => {
  it('filters by action and returns most recent first', () => {
    const log = createAuditLog({ store: createMemoryStore() });
    log.append({ userId: 'u1', action: 'email.send', target: 'a', ts: 1 });
    log.append({ userId: 'u1', action: 'http.post', target: 'b', ts: 2 });
    log.append({ userId: 'u1', action: 'email.send', target: 'c', ts: 3 });
    log.append({ userId: 'u2', action: 'email.send', target: 'd', ts: 4 });

    const emails = log.query({ userId: 'u1', action: 'email.send' });
    assert.strictEqual(emails.length, 2);
    assert.deepStrictEqual(emails.map((entry) => entry.target), ['c', 'a']);

    const all = log.query({ userId: 'u1' });
    assert.deepStrictEqual(all.map((entry) => entry.target), ['c', 'b', 'a']);
  });

  it('honours the limit and defaults to 50', () => {
    const log = createAuditLog({ store: createMemoryStore() });
    for (let i = 0; i < 60; i += 1) {
      log.append({ userId: 'u1', action: 'a', target: `t${i}` });
    }
    assert.strictEqual(log.query({ userId: 'u1' }).length, 50);
    const two = log.query({ userId: 'u1', limit: 2 });
    assert.deepStrictEqual(two.map((entry) => entry.target), ['t59', 't58']);
  });
});

describe('agent-audit-log — detail redaction and cap', () => {
  it('strips obvious secrets from detail', () => {
    const log = createAuditLog({ store: createMemoryStore() });
    const entry = log.append({
      userId: 'u1',
      action: 'http.post',
      target: 'https://api.example.com',
      detail:
        'used key sk-abc123SECRETXYZ and header "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig" plus password=hunter2 in the body',
    });

    assert.ok(!entry.detail.includes('sk-abc123SECRETXYZ'));
    assert.ok(!entry.detail.includes('eyJhbGciOiJIUzI1NiJ9'));
    assert.ok(!entry.detail.includes('hunter2'));
    assert.ok(entry.detail.includes(REDACTED));
    // Non-secret context survives.
    assert.ok(entry.detail.includes('in the body'));
    // Redaction happens BEFORE hashing: chain still verifies.
    assert.deepStrictEqual(log.verifyChain(), { ok: true });
  });

  it('caps detail at 2000 chars and accepts non-string detail', () => {
    const log = createAuditLog({ store: createMemoryStore() });
    const long = log.append({
      userId: 'u1', action: 'a', target: 't', detail: 'x'.repeat(5000),
    });
    assert.strictEqual(long.detail.length, MAX_DETAIL_CHARS);

    const objectDetail = log.append({
      userId: 'u1', action: 'a', target: 't', detail: { note: 'ok', password: 'plain' },
    });
    assert.strictEqual(typeof objectDetail.detail, 'string');

    const omitted = log.append({ userId: 'u1', action: 'a', target: 't' });
    assert.strictEqual(omitted.detail, undefined);
    assert.deepStrictEqual(log.verifyChain(), { ok: true });
  });
});

describe('agent-audit-log — JSONL store (real fs)', () => {
  it('appends JSONL, rotates to .1 past maxBytes keeping ONE generation', () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, 'audit.jsonl');
    try {
      const store = createJsonlStore({ filePath, maxBytes: 700 });
      const log = createAuditLog({ store });

      const appended = [];
      for (let i = 0; i < 6; i += 1) {
        appended.push(
          log.append({ userId: 'u1', action: 'email.send', target: `t${i}`, ts: i }),
        );
      }

      // Rotation happened: .1 exists and the active file is bounded.
      assert.ok(fs.existsSync(`${filePath}.1`), 'expected rotated .1 file');
      assert.ok(fs.statSync(filePath).size <= 700);

      // list() spans both generations → nothing lost, chain still valid.
      assert.strictEqual(store.list().length, 6);
      assert.deepStrictEqual(log.verifyChain(), { ok: true });
      assert.deepStrictEqual(
        log.query({ userId: 'u1', limit: 3 }).map((entry) => entry.target),
        ['t5', 't4', 't3'],
      );

      // Force more rotations: still exactly ONE rotated generation.
      for (let i = 6; i < 30; i += 1) {
        log.append({ userId: 'u1', action: 'email.send', target: `t${i}`, ts: i });
      }
      assert.ok(fs.existsSync(`${filePath}.1`));
      assert.ok(!fs.existsSync(`${filePath}.2`), 'must keep only one generation');
      const generations = fs.readdirSync(dir).filter((name) => name.startsWith('audit.jsonl.'));
      assert.deepStrictEqual(generations, ['audit.jsonl.1']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a fresh log over the same file continues the chain (restart)', () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, 'audit.jsonl');
    try {
      const first = createAuditLog({ store: createJsonlStore({ filePath }) });
      first.append({ userId: 'u1', action: 'a', target: 't1' });
      first.append({ userId: 'u1', action: 'a', target: 't2' });

      const second = createAuditLog({ store: createJsonlStore({ filePath }) });
      second.append({ userId: 'u1', action: 'a', target: 't3' });

      assert.deepStrictEqual(second.verifyChain(), { ok: true });
      assert.strictEqual(second.query({ userId: 'u1' }).length, 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disk errors do not throw — they increment stats().errors', () => {
    const dir = makeTmpDir();
    try {
      // Parent of filePath is a FILE → appendFileSync fails with ENOTDIR.
      const blocker = path.join(dir, 'blocker');
      fs.writeFileSync(blocker, 'not a directory');
      const store = createJsonlStore({ filePath: path.join(blocker, 'sub', 'audit.jsonl') });
      const log = createAuditLog({ store });

      let entry;
      assert.doesNotThrow(() => {
        entry = log.append({ userId: 'u1', action: 'a', target: 't' });
      });
      assert.strictEqual(entry.persisted, false);
      assert.strictEqual(log.stats().errors, 1);
      assert.strictEqual(log.stats().appended, 0);
      assert.ok(log.stats().lastError);

      // Still not throwing on repeat, still counting.
      log.append({ userId: 'u1', action: 'a', target: 't2' });
      assert.strictEqual(log.stats().errors, 2);
      // Nothing persisted → query is empty, verify is trivially ok.
      assert.deepStrictEqual(log.query({ userId: 'u1' }), []);
      assert.deepStrictEqual(log.verifyChain(), { ok: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('createJsonlStore requires a filePath', () => {
    assert.throws(() => createJsonlStore({}), TypeError);
  });
});

describe('agent-audit-log — stats and validation', () => {
  it('stats reports appended count, seq and store kind', () => {
    const log = createAuditLog({ store: createMemoryStore() });
    log.append({ userId: 'u1', action: 'a', target: 't' });
    log.append({ userId: 'u2', action: 'a', target: 't' });
    const snapshot = log.stats();
    assert.strictEqual(snapshot.appended, 2);
    assert.strictEqual(snapshot.errors, 0);
    assert.strictEqual(snapshot.seq, 2);
    assert.strictEqual(snapshot.users, 2);
    assert.strictEqual(snapshot.store, 'memory');
  });

  it('append validates required fields (caller bugs DO throw)', () => {
    const log = createAuditLog({ store: createMemoryStore() });
    assert.throws(() => log.append({ action: 'a', target: 't' }), TypeError);
    assert.throws(() => log.append({ userId: 'u', target: 't' }), TypeError);
    assert.throws(() => log.append({ userId: 'u', action: 'a' }), TypeError);
  });
});
