'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-env-vars');
const { extractEnvVars, buildEnvVarsForFiles, renderEnvVarsBlock, _internal } = engine;
const { isLikelyEnvName } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractEnvVars('').total, 0);
  assert.equal(extractEnvVars(null).total, 0);
});

test('isLikelyEnvName: requires underscore', () => {
  assert.equal(isLikelyEnvName('FOO_BAR'), true);
  assert.equal(isLikelyEnvName('FOO'), false);
  assert.equal(isLikelyEnvName('AB_CD'), true);
});

test('isLikelyEnvName: rejects stopwords', () => {
  assert.equal(isLikelyEnvName('HTTP'), false);
  assert.equal(isLikelyEnvName('JSON'), false);
  assert.equal(isLikelyEnvName('CVE'), false);
});

test('isLikelyEnvName: rejects lowercase', () => {
  assert.equal(isLikelyEnvName('foo_bar'), false);
  assert.equal(isLikelyEnvName('foo_BAR'), false);
});

test('detects bare DATABASE_URL', () => {
  const r = extractEnvVars('Set DATABASE_URL to your DSN.');
  assert.ok(r.vars.some((v) => v.name === 'DATABASE_URL'));
});

test('detects $FOO_BAR prefixed', () => {
  const r = extractEnvVars('Run with $STRIPE_API_KEY exported.');
  assert.ok(r.vars.some((v) => v.name === 'STRIPE_API_KEY'));
});

test('detects process.env.FOO', () => {
  const r = extractEnvVars('const x = process.env.NEXT_PUBLIC_URL;');
  assert.ok(r.vars.some((v) => v.name === 'NEXT_PUBLIC_URL'));
});

test('detects ${FOO} interpolation', () => {
  const r = extractEnvVars('Path: ${HOME_DIR}/data');
  assert.ok(r.vars.some((v) => v.name === 'HOME_DIR'));
});

test('detects .env declaration with value', () => {
  const r = extractEnvVars('DATABASE_URL=postgres://localhost/foo');
  const v = r.vars.find((x) => x.name === 'DATABASE_URL');
  assert.ok(v);
  assert.ok(v.defaultValue && /postgres/.test(v.defaultValue));
});

test('detects export FOO=', () => {
  const r = extractEnvVars('export NODE_ENV=production');
  assert.ok(r.vars.some((v) => v.name === 'NODE_ENV'));
});

test('dedupes references to same var', () => {
  const r = extractEnvVars('Use $DATABASE_URL and DATABASE_URL again.');
  assert.equal(r.vars.filter((v) => v.name === 'DATABASE_URL').length, 1);
});

test('skips common acronyms like HTTP / JSON', () => {
  const r = extractEnvVars('Send HTTP requests in JSON format.');
  // No underscores so they wouldn't match anyway; but if they did, stopword filter blocks them
  assert.equal(r.vars.length, 0);
});

test('skips single-token without underscore', () => {
  const r = extractEnvVars('Configure NODE for production.');
  assert.equal(r.vars.length, 0);
});

test('captures default value when present', () => {
  const r = extractEnvVars('TIMEOUT_MS=5000');
  assert.ok(r.vars.some((v) => v.name === 'TIMEOUT_MS' && v.defaultValue === '5000'));
});

test('caps vars per file', () => {
  let text = '';
  for (let i = 0; i < 50; i++) text += `Set VAR_${i}_FLAG=1\n`;
  const r = extractEnvVars(text);
  assert.ok(r.vars.length <= 32);
});

test('totals reports withDefault vs withoutDefault', () => {
  const text = `DATABASE_URL=postgres://localhost\nNEXT_PUBLIC_API mentioned bare`;
  const r = extractEnvVars(text);
  assert.ok(r.totals.withDefault >= 1);
  assert.ok(r.totals.withoutDefault >= 1);
});

test('buildEnvVarsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'DATABASE_URL=postgres' },
    { name: 'b.md', extractedText: '$STRIPE_API_KEY required' },
  ];
  const r = buildEnvVarsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderEnvVarsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'DATABASE_URL=postgres' }];
  const r = buildEnvVarsForFiles(files);
  const md = renderEnvVarsBlock(r);
  assert.match(md, /^## ENVIRONMENT VARIABLES \/ CONFIG FLAGS/);
  assert.match(md, /DATABASE_URL/);
});

test('renderEnvVarsBlock empty when nothing surfaces', () => {
  assert.equal(renderEnvVarsBlock({ perFile: [] }), '');
  assert.equal(renderEnvVarsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildEnvVarsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'DATABASE_URL' },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('merges sources when same var seen multiple ways', () => {
  const r = extractEnvVars('DATABASE_URL=foo\nprocess.env.DATABASE_URL elsewhere.');
  const v = r.vars.find((x) => x.name === 'DATABASE_URL');
  assert.ok(v);
  assert.ok(v.sources.length >= 1);
});
