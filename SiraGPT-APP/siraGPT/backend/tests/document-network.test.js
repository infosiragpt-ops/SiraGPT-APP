'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-network');
const { extractNetwork, buildNetworkForFiles, renderNetworkBlock, _internal } = engine;
const { isValidPort, isLikelyIPv4 } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractNetwork('').total, 0);
  assert.equal(extractNetwork(null).total, 0);
});

test('isValidPort: range 1-65535', () => {
  assert.equal(isValidPort(80), true);
  assert.equal(isValidPort(0), false);
  assert.equal(isValidPort(99999), false);
});

test('isLikelyIPv4: validates octet ranges', () => {
  assert.equal(isLikelyIPv4('192.168.1.1'), true);
  assert.equal(isLikelyIPv4('256.0.0.1'), false);
  assert.equal(isLikelyIPv4('1.2.3'), false);
});

test('detects IPv4', () => {
  const r = extractNetwork('Server at 192.168.1.1');
  assert.ok(r.entries.some((e) => e.kind === 'ipv4' && e.value === '192.168.1.1'));
});

test('detects IPv4 CIDR', () => {
  const r = extractNetwork('Subnet 10.0.0.0/16 is reserved.');
  assert.ok(r.entries.some((e) => e.kind === 'ipv4' && /\/16/.test(e.value)));
});

test('rejects 256.0.0.1', () => {
  const r = extractNetwork('Invalid IP 256.0.0.1 here.');
  assert.equal(r.entries.filter((e) => e.kind === 'ipv4').length, 0);
});

test('detects IPv6', () => {
  const r = extractNetwork('Address 2001:db8::1 is in scope.');
  assert.ok(r.entries.some((e) => e.kind === 'ipv6'));
});

test('detects MAC address', () => {
  const r = extractNetwork('NIC MAC: 00:1A:2B:3C:4D:5E reported.');
  assert.ok(r.entries.some((e) => e.kind === 'mac'));
});

test('detects MAC with hyphens', () => {
  const r = extractNetwork('Adapter 00-AA-BB-CC-DD-EE');
  assert.ok(r.entries.some((e) => e.kind === 'mac'));
});

test('detects labeled port', () => {
  const r = extractNetwork('Service on port 8080 here.');
  assert.ok(r.entries.some((e) => e.kind === 'port' && e.value === '8080'));
});

test('detects Spanish "puerto"', () => {
  const r = extractNetwork('Escuchando en puerto: 443');
  assert.ok(r.entries.some((e) => e.kind === 'port'));
});

test('detects inline :8080 port', () => {
  const r = extractNetwork('listening on :8080 now.');
  assert.ok(r.entries.some((e) => e.kind === 'port'));
});

test('dedupes identical entries', () => {
  const r = extractNetwork('192.168.1.1 and 192.168.1.1 again');
  assert.equal(r.entries.filter((e) => e.kind === 'ipv4' && e.value === '192.168.1.1').length, 1);
});

test('caps per kind', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `192.168.${i}.1 `;
  const r = extractNetwork(text);
  assert.ok(r.totals.ipv4 <= 12);
});

test('counts totals by kind', () => {
  const r = extractNetwork('192.168.1.1 and port 8080 and 00:1A:2B:3C:4D:5E');
  assert.ok(r.totals.ipv4 >= 1);
  assert.ok(r.totals.port >= 1);
  assert.ok(r.totals.mac >= 1);
});

test('buildNetworkForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '192.168.1.1' },
    { name: 'b.md', extractedText: 'port 8080' },
  ];
  const r = buildNetworkForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderNetworkBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: '192.168.1.1' }];
  const r = buildNetworkForFiles(files);
  const md = renderNetworkBlock(r);
  assert.match(md, /^## NETWORK IDENTIFIERS/);
});

test('renderNetworkBlock empty when nothing surfaces', () => {
  assert.equal(renderNetworkBlock({ perFile: [] }), '');
  assert.equal(renderNetworkBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildNetworkForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '10.0.0.1' },
  ]);
  assert.equal(r.perFile.length, 1);
});
