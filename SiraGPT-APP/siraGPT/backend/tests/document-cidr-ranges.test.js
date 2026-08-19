'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-cidr-ranges');
const { extractCidrRanges, buildCidrRangesForFiles, renderCidrRangesBlock, _internal } = engine;
const { isValidIPv4, classifyIPv4, classifyIPv6, looksLikeIPv6 } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractCidrRanges('').total, 0);
  assert.equal(extractCidrRanges(null).total, 0);
});

test('isValidIPv4: rejects bad octets', () => {
  assert.equal(isValidIPv4('1.2.3.4'), true);
  assert.equal(isValidIPv4('256.1.1.1'), false);
  assert.equal(isValidIPv4('1.2.3'), false);
});

test('classifyIPv4: RFC 1918 private ranges', () => {
  assert.equal(classifyIPv4('10.0.0.0', '8'), 'private');
  assert.equal(classifyIPv4('172.16.0.0', '12'), 'private');
  assert.equal(classifyIPv4('192.168.1.0', '24'), 'private');
});

test('classifyIPv4: public / loopback / link-local / multicast', () => {
  assert.equal(classifyIPv4('8.8.8.8', '32'), 'public');
  assert.equal(classifyIPv4('127.0.0.1', '32'), 'loopback');
  assert.equal(classifyIPv4('169.254.0.0', '16'), 'link-local');
  assert.equal(classifyIPv4('224.0.0.1', '32'), 'multicast');
});

test('classifyIPv6: ULA / link-local / multicast', () => {
  assert.equal(classifyIPv6('fc00::', '7'), 'ula');
  assert.equal(classifyIPv6('fe80::', '10'), 'link-local');
  assert.equal(classifyIPv6('ff00::', '8'), 'multicast');
});

test('looksLikeIPv6 detects v6 patterns', () => {
  assert.equal(looksLikeIPv6('2001:db8::'), true);
  assert.equal(looksLikeIPv6('not-ip'), false);
});

test('detects 10.0.0.0/8', () => {
  const r = extractCidrRanges('VPC: 10.0.0.0/8');
  assert.ok(r.entries.some((e) => e.cidr === '10.0.0.0/8' && e.kind === 'private'));
});

test('detects 192.168.1.0/24', () => {
  const r = extractCidrRanges('Subnet 192.168.1.0/24');
  assert.ok(r.entries.some((e) => e.kind === 'private'));
});

test('detects 8.8.8.8/32 as public', () => {
  const r = extractCidrRanges('Allow 8.8.8.8/32 for DNS');
  assert.ok(r.entries.some((e) => e.kind === 'public'));
});

test('detects fe80::/10 link-local', () => {
  const r = extractCidrRanges('IPv6 link-local: fe80::/10');
  assert.ok(r.entries.some((e) => e.kind === 'link-local'));
});

test('rejects invalid CIDR (octet 256)', () => {
  const r = extractCidrRanges('Not a CIDR: 256.1.1.1/24');
  assert.equal(r.entries.length, 0);
});

test('dedupes identical CIDRs', () => {
  const r = extractCidrRanges('10.0.0.0/8 here and 10.0.0.0/8 again');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `10.${i}.0.0/16 `;
  const r = extractCidrRanges(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by kind', () => {
  const r = extractCidrRanges('10.0.0.0/8 and 8.8.8.8/32 and 127.0.0.1/32');
  assert.ok(r.totals.private >= 1);
  assert.ok(r.totals.public >= 1);
  assert.ok(r.totals.loopback >= 1);
});

test('buildCidrRangesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: '10.0.0.0/8' },
    { name: 'b', extractedText: '192.168.1.0/24' },
  ];
  const r = buildCidrRangesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCidrRangesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'iac', extractedText: '10.0.0.0/8' }];
  const r = buildCidrRangesForFiles(files);
  const md = renderCidrRangesBlock(r);
  assert.match(md, /^## CIDR/);
});

test('renderCidrRangesBlock empty when nothing surfaces', () => {
  assert.equal(renderCidrRangesBlock({ perFile: [] }), '');
  assert.equal(renderCidrRangesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCidrRangesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '10.0.0.0/8' },
  ]);
  assert.equal(r.perFile.length, 1);
});
