'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-db-conn-strings');
const { extractDbConnStrings, buildDbConnStringsForFiles, renderDbConnStringsBlock, _internal } = engine;
const { maskPassword, normaliseScheme } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractDbConnStrings('').total, 0);
  assert.equal(extractDbConnStrings(null).total, 0);
});

test('maskPassword: first-2 last-2', () => {
  assert.equal(maskPassword('supersecret'), 'su…et');
  assert.equal(maskPassword('abc'), '****');
});

test('normaliseScheme: collapses variants', () => {
  assert.equal(normaliseScheme('postgresql'), 'postgres');
  assert.equal(normaliseScheme('mongodb+srv'), 'mongodb');
  assert.equal(normaliseScheme('rediss'), 'redis');
});

test('detects postgres URL', () => {
  const r = extractDbConnStrings('DATABASE_URL=postgres://app:supersecret@db.host:5432/mydb');
  assert.ok(r.entries.some((e) => e.scheme === 'postgres' && e.host.startsWith('db.host')));
});

test('postgres password is masked', () => {
  const r = extractDbConnStrings('postgres://app:supersecret@db.host:5432/mydb');
  for (const e of r.entries) {
    assert.ok(!/supersecret/.test(e.masked));
  }
});

test('detects mongodb+srv URL', () => {
  const r = extractDbConnStrings('mongodb+srv://user:abcdef123@cluster0.mongodb.net/myDb');
  assert.ok(r.entries.some((e) => e.scheme === 'mongodb'));
});

test('detects redis URL', () => {
  const r = extractDbConnStrings('REDIS_URL=redis://:secretpass@redis.host:6379/0');
  assert.ok(r.entries.some((e) => e.scheme === 'redis'));
});

test('detects mysql URL', () => {
  const r = extractDbConnStrings('mysql://root:rootpass@127.0.0.1:3306/app');
  assert.ok(r.entries.some((e) => e.scheme === 'mysql'));
});

test('detects URL without credentials', () => {
  const r = extractDbConnStrings('connect to postgres://db.example.com:5432/public');
  assert.ok(r.entries.length >= 1);
});

test('dedupes by host/db (not by password)', () => {
  const r = extractDbConnStrings(
    'postgres://u:p123ass@h.com/db and postgres://u:differentpw@h.com/db'
  );
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `postgres://u:pw_${i}aa@host${i}.com/db `;
  const r = extractDbConnStrings(text);
  assert.ok(r.entries.length <= 12);
});

test('buildDbConnStringsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.env', extractedText: 'postgres://u:supersecret@a.com/db' },
    { name: 'b.env', extractedText: 'redis://:redispass1@b.com:6379/0' },
  ];
  const r = buildDbConnStringsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderDbConnStringsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'env', extractedText: 'postgres://u:supersecret@a.com/db' }];
  const r = buildDbConnStringsForFiles(files);
  const md = renderDbConnStringsBlock(r);
  assert.match(md, /^## DATABASE CONNECTION/);
});

test('renderDbConnStringsBlock NEVER contains the full password', () => {
  const files = [{ name: 'env', extractedText: 'postgres://u:supersecret@a.com/db' }];
  const r = buildDbConnStringsForFiles(files);
  const md = renderDbConnStringsBlock(r);
  assert.ok(!/supersecret/.test(md));
});

test('renderDbConnStringsBlock empty when nothing surfaces', () => {
  assert.equal(renderDbConnStringsBlock({ perFile: [] }), '');
  assert.equal(renderDbConnStringsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildDbConnStringsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'postgres://u:supersecret@a.com/db' },
  ]);
  assert.equal(r.perFile.length, 1);
});
