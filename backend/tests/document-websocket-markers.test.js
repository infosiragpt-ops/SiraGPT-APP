'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-websocket-markers');
const { extractWebsocketMarkers, buildWebsocketMarkersForFiles, renderWebsocketMarkersBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractWebsocketMarkers('').total, 0);
  assert.equal(extractWebsocketMarkers(null).total, 0);
});

test('detects ws:// URL', () => {
  const r = extractWebsocketMarkers('Connect to ws://localhost:8080/socket');
  assert.ok(r.entries.some((e) => e.kind === 'url' && /ws:\/\//.test(e.value)));
});

test('detects wss:// secure URL', () => {
  const r = extractWebsocketMarkers('wss://api.example.com/ws');
  assert.ok(r.entries.some((e) => e.kind === 'url' && /wss:\/\//.test(e.value)));
});

test('detects Sec-WebSocket-Key', () => {
  const r = extractWebsocketMarkers('Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==');
  assert.ok(r.entries.some((e) => e.kind === 'header'));
});

test('detects Sec-WebSocket-Protocol', () => {
  const r = extractWebsocketMarkers('Sec-WebSocket-Protocol: graphql-ws');
  assert.ok(r.entries.some((e) => e.kind === 'header'));
});

test('detects PING frame', () => {
  const r = extractWebsocketMarkers('Send PING frame to keep alive');
  assert.ok(r.entries.some((e) => e.kind === 'opcode' && e.value === 'PING'));
});

test('detects CLOSE opcode', () => {
  const r = extractWebsocketMarkers('Got CLOSE frame, closing connection');
  assert.ok(r.entries.some((e) => e.value === 'CLOSE'));
});

test('detects graphql-ws subprotocol', () => {
  const r = extractWebsocketMarkers('Using graphql-ws subprotocol');
  assert.ok(r.entries.some((e) => e.kind === 'subproto'));
});

test('detects mqtt subprotocol', () => {
  const r = extractWebsocketMarkers('via mqtt over websockets');
  assert.ok(r.entries.some((e) => e.value === 'mqtt'));
});

test('detects ping interval', () => {
  const r = extractWebsocketMarkers('ping-interval: 30000');
  assert.ok(r.entries.some((e) => e.kind === 'interval'));
});

test('dedupes identical entries', () => {
  const r = extractWebsocketMarkers('ws://localhost/ and ws://localhost/');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `wss://host${i}.example.com/ws `;
  const r = extractWebsocketMarkers(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by kind', () => {
  const r = extractWebsocketMarkers(
    'wss://x.com/ws and Sec-WebSocket-Key: x and PING frame and graphql-ws'
  );
  assert.ok(r.totals.url >= 1);
  assert.ok(r.totals.header >= 1);
  assert.ok(r.totals.opcode >= 1);
  assert.ok(r.totals.subproto >= 1);
});

test('buildWebsocketMarkersForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'ws://localhost/' },
    { name: 'b', extractedText: 'wss://api.example.com/ws' },
  ];
  const r = buildWebsocketMarkersForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderWebsocketMarkersBlock returns markdown when entries exist', () => {
  const files = [{ name: 'spec', extractedText: 'ws://localhost/' }];
  const r = buildWebsocketMarkersForFiles(files);
  const md = renderWebsocketMarkersBlock(r);
  assert.match(md, /^## WEBSOCKET/);
});

test('renderWebsocketMarkersBlock empty when nothing surfaces', () => {
  assert.equal(renderWebsocketMarkersBlock({ perFile: [] }), '');
  assert.equal(renderWebsocketMarkersBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildWebsocketMarkersForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'ws://localhost/' },
  ]);
  assert.equal(r.perFile.length, 1);
});
