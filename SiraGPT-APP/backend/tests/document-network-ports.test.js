'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-network-ports');
const { extractNetworkPorts, buildNetworkPortsForFiles, renderNetworkPortsBlock, _internal } = engine;
const { classifyPort } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractNetworkPorts('').total, 0);
  assert.equal(extractNetworkPorts(null).total, 0);
});

test('classifyPort: well-known + ranges', () => {
  assert.equal(classifyPort(22), 'ssh');
  assert.equal(classifyPort(443), 'https');
  assert.equal(classifyPort(5432), 'postgres');
  assert.equal(classifyPort(8888), 'jupyter');
  assert.equal(classifyPort(60000), 'ephemeral');
});

test('detects "port 22"', () => {
  const r = extractNetworkPorts('Allow port 22 inbound');
  assert.ok(r.entries.some((e) => e.port === 22 && e.service === 'ssh'));
});

test('detects "port: 5432"', () => {
  const r = extractNetworkPorts('postgres port: 5432');
  assert.ok(r.entries.some((e) => e.port === 5432 && e.service === 'postgres'));
});

test('detects TCP/443', () => {
  const r = extractNetworkPorts('Open TCP/443 firewall rule');
  assert.ok(r.entries.some((e) => e.port === 443 && e.proto === 'TCP'));
});

test('detects UDP/53 DNS', () => {
  const r = extractNetworkPorts('DNS uses UDP/53');
  assert.ok(r.entries.some((e) => e.port === 53 && e.service === 'dns'));
});

test('detects "listening on :3000"', () => {
  const r = extractNetworkPorts('Server listening on :3000');
  assert.ok(r.entries.some((e) => e.port === 3000));
});

test('detects localhost:8080', () => {
  const r = extractNetworkPorts('Hit localhost:8080 for the API');
  assert.ok(r.entries.some((e) => e.port === 8080 && e.service === 'http-alt'));
});

test('detects 0.0.0.0:6443 K8s api', () => {
  const r = extractNetworkPorts('Bound to 0.0.0.0:6443');
  assert.ok(r.entries.some((e) => e.port === 6443 && e.service === 'k8s-api'));
});

test('dedupes identical port', () => {
  const r = extractNetworkPorts('port 22 ssh, again port 22 same service');
  assert.equal(r.entries.filter((e) => e.port === 22).length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 1; i < 25; i++) text += `port ${3000 + i} `;
  const r = extractNetworkPorts(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by service', () => {
  const r = extractNetworkPorts('port 22 ssh and port 443 https');
  assert.ok(r.totals.ssh >= 1);
  assert.ok(r.totals.https >= 1);
});

test('buildNetworkPortsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'port 22' },
    { name: 'b', extractedText: 'port 443' },
  ];
  const r = buildNetworkPortsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderNetworkPortsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'firewall', extractedText: 'port 22' }];
  const r = buildNetworkPortsForFiles(files);
  const md = renderNetworkPortsBlock(r);
  assert.match(md, /^## NETWORK PORTS/);
});

test('renderNetworkPortsBlock empty when nothing surfaces', () => {
  assert.equal(renderNetworkPortsBlock({ perFile: [] }), '');
  assert.equal(renderNetworkPortsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildNetworkPortsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'port 22' },
  ]);
  assert.equal(r.perFile.length, 1);
});
