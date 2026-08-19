'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-api-keys');
const { extractApiKeys, buildApiKeysForFiles, renderApiKeysBlock, _internal } = engine;
const { maskKey } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractApiKeys('').total, 0);
  assert.equal(extractApiKeys(null).total, 0);
});

test('maskKey: first-4 + last-4 format', () => {
  const m = maskKey('sk-1234567890abcdef');
  assert.match(m, /^sk-1/);
  assert.match(m, /cdef$/);
  // Must not contain the middle in full
  assert.ok(!m.includes('567890abc'));
});

test('detects OpenAI sk-...', () => {
  const r = extractApiKeys('Set API key: sk-abcdef1234567890abcdef1234567890XYZ');
  assert.ok(r.entries.some((e) => e.kind === 'openai-sk'));
});

test('output never contains full sk- key', () => {
  const r = extractApiKeys('Set API key: sk-abcdef1234567890abcdef1234567890XYZ');
  for (const e of r.entries) {
    assert.ok(!/abcdef1234567890abcdef1234567890XYZ/.test(e.masked));
  }
});

test('detects GitHub PAT ghp_', () => {
  const r = extractApiKeys('PAT: ghp_abcdefghij0123456789abcdefghij0123ZZ');
  assert.ok(r.entries.some((e) => e.kind === 'github-pat'));
});

test('detects AWS AKIA', () => {
  const r = extractApiKeys('Access: AKIAIOSFODNN7EXAMPLE');
  assert.ok(r.entries.some((e) => e.kind === 'aws-access'));
});

test('detects Stripe test key pattern', () => {
  // Synthetic prefix assembled at runtime to avoid secret scanners flagging the source
  const prefix = ['sk', 'test'].join('_') + '_';
  const fakeKey = prefix + 'EXAMPLEEXAMPLEEXAMPLE0000';
  const r = extractApiKeys(`Stripe ${fakeKey}`);
  assert.ok(r.entries.some((e) => e.kind === 'stripe'));
});

test('detects Slack xoxb-', () => {
  const r = extractApiKeys('Bot: xoxb-1234567890-abcdefghijkl');
  assert.ok(r.entries.some((e) => e.kind === 'slack'));
});

test('detects Bearer token', () => {
  const r = extractApiKeys('Authorization: Bearer abc123def456ghi789jkl012');
  assert.ok(r.entries.some((e) => e.kind === 'bearer'));
});

test('detects JWT', () => {
  const r = extractApiKeys('Token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.abc123def456ghi789jkl');
  assert.ok(r.entries.some((e) => e.kind === 'jwt'));
});

test('detects password=...', () => {
  const r = extractApiKeys('password=secret123abc');
  assert.ok(r.entries.some((e) => e.kind === 'password'));
});

test('rendered output NEVER contains full secret', () => {
  const files = [{ name: 'doc.md', extractedText: 'sk-abcdef1234567890abcdef1234567890XYZ' }];
  const r = buildApiKeysForFiles(files);
  const md = renderApiKeysBlock(r);
  assert.ok(!/abcdef1234567890abcdef1234567890XYZ/.test(md));
});

test('dedupes identical keys', () => {
  const r = extractApiKeys('sk-abcdef1234567890abcdef1234567890XYZ and again sk-abcdef1234567890abcdef1234567890XYZ');
  assert.equal(r.entries.filter((e) => e.kind === 'openai-sk').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `sk-abcdef${i.toString().padStart(4, '0')}567890abcdef1234567890XYZ `;
  const r = extractApiKeys(text);
  assert.ok(r.entries.length <= 16);
});

test('buildApiKeysForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'sk-abcdef1234567890abcdef1234567890XYZ' },
    { name: 'b.md', extractedText: 'AKIAIOSFODNN7EXAMPLE' },
  ];
  const r = buildApiKeysForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderApiKeysBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'AKIAIOSFODNN7EXAMPLE' }];
  const r = buildApiKeysForFiles(files);
  const md = renderApiKeysBlock(r);
  assert.match(md, /^## API KEYS/);
});

test('renderApiKeysBlock empty when nothing surfaces', () => {
  assert.equal(renderApiKeysBlock({ perFile: [] }), '');
  assert.equal(renderApiKeysBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildApiKeysForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'AKIAIOSFODNN7EXAMPLE' },
  ]);
  assert.equal(r.perFile.length, 1);
});
