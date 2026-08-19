'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-email-auth');
const { extractEmailAuth, buildEmailAuthForFiles, renderEmailAuthBlock, _internal } = engine;
const { parseSpf, parseDmarc, parseDkim } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractEmailAuth('').total, 0);
  assert.equal(extractEmailAuth(null).total, 0);
});

test('parseSpf detects -all policy', () => {
  const r = parseSpf(' ip4:1.2.3.4 -all');
  assert.equal(r.policy, 'fail');
});

test('parseDmarc captures p=', () => {
  const r = parseDmarc('; p=quarantine; pct=100; rua=mailto:r@x.com');
  assert.equal(r.policy, 'quarantine');
  assert.equal(r.pct, '100');
  assert.equal(r.hasRua, true);
});

test('parseDkim captures algorithm and public key presence', () => {
  const r = parseDkim('; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDExample');
  assert.equal(r.algorithm, 'rsa');
  assert.equal(r.hasPublicKey, true);
});

test('detects SPF', () => {
  const r = extractEmailAuth('"v=spf1 include:_spf.google.com ~all"');
  assert.ok(r.entries.some((e) => e.kind === 'spf'));
});

test('detects DKIM', () => {
  const r = extractEmailAuth('"v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBExample"');
  assert.ok(r.entries.some((e) => e.kind === 'dkim'));
});

test('DKIM public key is masked', () => {
  const r = extractEmailAuth('"v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBExample"');
  const entry = r.entries.find((e) => e.kind === 'dkim');
  assert.ok(!/MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBExample/.test(entry.parsed.pubkeyMasked || ''));
});

test('detects DMARC', () => {
  const r = extractEmailAuth('"v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"');
  assert.ok(r.entries.some((e) => e.kind === 'dmarc'));
});

test('detects BIMI', () => {
  const r = extractEmailAuth('"v=BIMI1; l=https://example.com/logo.svg"');
  assert.ok(r.entries.some((e) => e.kind === 'bimi'));
});

test('dedupes identical entries', () => {
  const r = extractEmailAuth('"v=spf1 ~all" then "v=spf1 ~all"');
  assert.equal(r.entries.filter((e) => e.kind === 'spf').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `"v=spf1 ip4:1.2.3.${i + 1} ~all" `;
  const r = extractEmailAuth(text);
  assert.ok(r.entries.length <= 12);
});

test('counts totals by kind', () => {
  const r = extractEmailAuth(
    '"v=spf1 ~all" and "v=DKIM1; k=rsa; p=ABC" and "v=DMARC1; p=reject"'
  );
  assert.ok(r.totals.spf >= 1);
  assert.ok(r.totals.dkim >= 1);
  assert.ok(r.totals.dmarc >= 1);
});

test('buildEmailAuthForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: '"v=spf1 ~all"' },
    { name: 'b', extractedText: '"v=DMARC1; p=reject"' },
  ];
  const r = buildEmailAuthForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderEmailAuthBlock returns markdown when entries exist', () => {
  const files = [{ name: 'dns', extractedText: '"v=spf1 ~all"' }];
  const r = buildEmailAuthForFiles(files);
  const md = renderEmailAuthBlock(r);
  assert.match(md, /^## EMAIL AUTH/);
});

test('renderEmailAuthBlock NEVER contains full DKIM key', () => {
  const files = [{ name: 'dns', extractedText: '"v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBExample"' }];
  const r = buildEmailAuthForFiles(files);
  const md = renderEmailAuthBlock(r);
  assert.ok(!/MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBExample/.test(md));
});

test('renderEmailAuthBlock empty when nothing surfaces', () => {
  assert.equal(renderEmailAuthBlock({ perFile: [] }), '');
  assert.equal(renderEmailAuthBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildEmailAuthForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '"v=spf1 ~all"' },
  ]);
  assert.equal(r.perFile.length, 1);
});
