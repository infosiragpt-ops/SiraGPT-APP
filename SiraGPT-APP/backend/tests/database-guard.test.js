'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  attachDatabaseGuard,
  inspectSql,
  guardRawSql,
  extractSql,
  resolveMode,
} = require('../src/services/db/database-guard');

// ── inspectSql classification ──────────────────────────────────

test('inspectSql: benign reads/writes are not destructive', () => {
  for (const sql of [
    'SELECT * FROM users WHERE id = $1',
    'INSERT INTO logs (msg) VALUES ($1)',
    'UPDATE users SET name = $1 WHERE id = $2',
    'DELETE FROM sessions WHERE expires_at < now()',
    'WITH t AS (SELECT 1) SELECT * FROM t',
  ]) {
    assert.equal(inspectSql(sql).destructive, false, `should be safe: ${sql}`);
  }
});

test('inspectSql: DROP / TRUNCATE are destructive', () => {
  assert.deepEqual(inspectSql('DROP TABLE users').reasons, ['drop']);
  assert.equal(inspectSql('truncate table audit_log').destructive, true);
  assert.equal(inspectSql('DROP DATABASE siragpt').destructive, true);
});

test('inspectSql: DELETE/UPDATE without WHERE are destructive', () => {
  assert.ok(inspectSql('DELETE FROM users').reasons.includes('delete_without_where'));
  assert.ok(inspectSql('UPDATE users SET active = false').reasons.includes('update_without_where'));
  // with WHERE → safe
  assert.equal(inspectSql('DELETE FROM users WHERE id = 1').destructive, false);
  assert.equal(inspectSql('UPDATE users SET active = false WHERE id = 1').destructive, false);
});

test('inspectSql: lossy ALTER (DROP COLUMN/CONSTRAINT) is destructive', () => {
  assert.ok(inspectSql('ALTER TABLE users DROP COLUMN email').reasons.includes('alter_drop'));
  assert.ok(inspectSql('alter table orders drop constraint fk_x').reasons.includes('alter_drop'));
  // additive ALTER → safe
  assert.equal(inspectSql('ALTER TABLE users ADD COLUMN nickname text').destructive, false);
});

test('inspectSql: keywords inside string literals / comments are NOT destructive', () => {
  // string-literal false positives (would block safe queries in enforce mode)
  assert.equal(inspectSql("SELECT * FROM t WHERE note = 'truncate everything'").destructive, false);
  assert.equal(inspectSql("INSERT INTO logs (action) VALUES ('drop table users')").destructive, false);
  assert.equal(inspectSql("UPDATE config SET val = 'truncate' WHERE k = 'x'").destructive, false);
  // a column literally named "deleted"
  assert.equal(inspectSql('CREATE TABLE t (id int, deleted boolean)').destructive, false);
  // WHERE hidden in a comment must NOT mask a destructive DELETE
  assert.ok(inspectSql('DELETE FROM users -- WHERE never runs').reasons.includes('delete_without_where'));
});

test('inspectSql: catches a destructive statement trailing in a multi-statement payload', () => {
  assert.ok(inspectSql('SELECT 1; DROP TABLE x').reasons.includes('drop'));
  assert.ok(inspectSql('SELECT 1; DELETE FROM users').reasons.includes('delete_without_where'));
  // a WHERE on one statement must not mask a sibling without one
  const r = inspectSql('DELETE FROM a WHERE id = 1; DELETE FROM b');
  assert.ok(r.reasons.includes('delete_without_where'));
});

test('inspectSql: never throws on junk input', () => {
  for (const bad of [null, undefined, 42, {}, [], '']) {
    assert.doesNotThrow(() => inspectSql(bad));
  }
});

// ── extractSql ─────────────────────────────────────────────────

test('extractSql: handles Unsafe strings and tagged templates', () => {
  assert.equal(extractSql('$executeRawUnsafe', ['DROP TABLE x']), 'DROP TABLE x');
  // TemplateStringsArray form
  const tsa = Object.assign(['DELETE FROM x WHERE id = ', ''], { raw: [] });
  assert.match(extractSql('$queryRaw', [tsa, 1]), /DELETE FROM x/);
  // Prisma.Sql-like object
  assert.equal(extractSql('$executeRaw', [{ sql: 'TRUNCATE y' }]), 'TRUNCATE y');
  assert.equal(extractSql('$queryRawUnsafe', [null]), '');
});

// ── resolveMode ────────────────────────────────────────────────

test('resolveMode: defaults to monitor, validates input', () => {
  assert.equal(resolveMode(), 'monitor');
  assert.equal(resolveMode('enforce'), 'enforce');
  assert.equal(resolveMode('OFF'), 'off');
  assert.equal(resolveMode('garbage'), 'monitor');
});

// ── attachDatabaseGuard: a fake prisma client ──────────────────

function makePrisma() {
  const calls = [];
  return {
    calls,
    $executeRawUnsafe(sql) { calls.push(sql); return Promise.resolve(1); },
    $queryRawUnsafe(sql) { calls.push(sql); return Promise.resolve([]); },
    $executeRaw(strings) { calls.push(Array.isArray(strings) ? strings.join('?') : String(strings)); return Promise.resolve(1); },
    $queryRaw(strings) { calls.push(Array.isArray(strings) ? strings.join('?') : String(strings)); return Promise.resolve([]); },
  };
}

test('monitor mode: audits destructive SQL but DOES NOT block', async () => {
  const seen = [];
  const p = makePrisma();
  attachDatabaseGuard(p, { mode: 'monitor', onDestructive: (info) => seen.push(info) });

  const res = await p.$executeRawUnsafe('DROP TABLE users');
  assert.equal(res, 1, 'original query still ran');
  assert.equal(p.calls.length, 1, 'original method was called');
  assert.equal(seen.length, 1, 'destructive op was reported');
  assert.deepEqual(seen[0].verdict.reasons, ['drop']);
});

test('monitor mode: safe SQL is not reported and runs normally', async () => {
  const seen = [];
  const p = makePrisma();
  attachDatabaseGuard(p, { mode: 'monitor', onDestructive: (info) => seen.push(info) });

  await p.$queryRawUnsafe('SELECT * FROM users WHERE id = $1');
  assert.equal(seen.length, 0);
  assert.equal(p.calls.length, 1);
});

test('enforce mode: blocks destructive SQL (throws, original NOT called)', async () => {
  const seen = [];
  const p = makePrisma();
  attachDatabaseGuard(p, { mode: 'enforce', onDestructive: (info) => seen.push(info) });

  await assert.rejects(
    () => p.$executeRawUnsafe('DELETE FROM users'),
    (err) => err.code === 'DB_GUARD_BLOCKED' && err.reasons.includes('delete_without_where'),
  );
  assert.equal(p.calls.length, 0, 'destructive query was blocked before execution');
  assert.equal(seen.length, 1, 'block was audited');
});

test('enforce mode: safe SQL still passes through', async () => {
  const p = makePrisma();
  attachDatabaseGuard(p, { mode: 'enforce' });
  const res = await p.$executeRawUnsafe('UPDATE users SET x = 1 WHERE id = 2');
  assert.equal(res, 1);
  assert.equal(p.calls.length, 1);
});

test('fail-open: a throwing onDestructive sink never breaks the query (monitor)', async () => {
  const p = makePrisma();
  attachDatabaseGuard(p, {
    mode: 'monitor',
    onDestructive: () => { throw new Error('sink exploded'); },
  });
  const res = await p.$executeRawUnsafe('TRUNCATE audit_log');
  assert.equal(res, 1, 'query proceeded despite a broken sink');
});

test('off mode: methods are left untouched', async () => {
  const p = makePrisma();
  const before = p.$executeRawUnsafe;
  attachDatabaseGuard(p, { mode: 'off' });
  assert.equal(p.$executeRawUnsafe, before, 'method not wrapped when off');
  assert.equal(p.__dbGuardMode, 'off');
});

test('attach is idempotent (no double-wrap)', async () => {
  const seen = [];
  const p = makePrisma();
  attachDatabaseGuard(p, { mode: 'monitor', onDestructive: (info) => seen.push(info) });
  const wrapped = p.$executeRawUnsafe;
  attachDatabaseGuard(p, { mode: 'monitor', onDestructive: (info) => seen.push(info) });
  assert.equal(p.$executeRawUnsafe, wrapped, 'second attach did not re-wrap');

  await p.$executeRawUnsafe('DROP TABLE x');
  assert.equal(seen.length, 1, 'destructive reported exactly once');
});

test('guardRawSql: pure verdict helper', () => {
  assert.equal(guardRawSql('SELECT 1', { mode: 'enforce' }).allowed, true);
  const v = guardRawSql('DROP TABLE x', { mode: 'enforce' });
  assert.equal(v.allowed, false);
  assert.deepEqual(v.reasons, ['drop']);
  // monitor never disallows
  assert.equal(guardRawSql('DROP TABLE x', { mode: 'monitor' }).allowed, true);
});
