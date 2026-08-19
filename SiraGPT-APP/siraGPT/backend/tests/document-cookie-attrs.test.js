'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-cookie-attrs');
const { extractCookieAttrs, buildCookieAttrsForFiles, renderCookieAttrsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractCookieAttrs('').total, 0);
  assert.equal(extractCookieAttrs(null).total, 0);
});

test('detects HttpOnly', () => {
  const r = extractCookieAttrs('Set-Cookie: sid=abc; HttpOnly; Secure');
  assert.ok(r.entries.some((e) => e.attrs.httpOnly));
});

test('detects Secure flag', () => {
  const r = extractCookieAttrs('Set-Cookie: token=xyz; Secure; SameSite=Strict');
  assert.ok(r.entries.some((e) => e.attrs.secure));
});

test('detects SameSite value', () => {
  const r = extractCookieAttrs('Set-Cookie: csrf=zzz; SameSite=Lax; HttpOnly');
  assert.ok(r.entries.some((e) => e.attrs.sameSite === 'Lax'));
});

test('detects Max-Age value', () => {
  const r = extractCookieAttrs('Set-Cookie: pref=on; Max-Age=3600; Path=/');
  assert.ok(r.entries.some((e) => e.attrs.maxAge === 3600));
});

test('detects Partitioned', () => {
  const r = extractCookieAttrs('Set-Cookie: x=y; Partitioned; Secure; SameSite=None');
  assert.ok(r.entries.some((e) => e.attrs.partitioned));
});

test('counts totals across multiple cookies', () => {
  const r = extractCookieAttrs(
    'Set-Cookie: a=1; HttpOnly; SameSite=Strict\n' +
    'Set-Cookie: b=2; HttpOnly; Secure; SameSite=Lax'
  );
  assert.ok(r.totals.httpOnly >= 2);
  assert.ok(r.totals.sameSite >= 2);
});

test('dedupes by cookie name', () => {
  const r = extractCookieAttrs(
    'Set-Cookie: sid=abc; HttpOnly; SameSite=Strict\nSet-Cookie: sid=def; HttpOnly; SameSite=Strict'
  );
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `Set-Cookie: c${i}=v; HttpOnly; SameSite=Lax\n`;
  const r = extractCookieAttrs(text);
  assert.ok(r.entries.length <= 16);
});

test('buildCookieAttrsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'Set-Cookie: sid=abc; HttpOnly; SameSite=Strict' },
    { name: 'b', extractedText: 'Set-Cookie: csrf=xyz; Secure; SameSite=Lax' },
  ];
  const r = buildCookieAttrsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCookieAttrsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc', extractedText: 'Set-Cookie: sid=abc; HttpOnly; SameSite=Strict' }];
  const r = buildCookieAttrsForFiles(files);
  const md = renderCookieAttrsBlock(r);
  assert.match(md, /^## COOKIE ATTRIBUTES/);
});

test('renderCookieAttrsBlock empty when nothing surfaces', () => {
  assert.equal(renderCookieAttrsBlock({ perFile: [] }), '');
  assert.equal(renderCookieAttrsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCookieAttrsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Set-Cookie: sid=abc; HttpOnly; SameSite=Strict' },
  ]);
  assert.equal(r.perFile.length, 1);
});
