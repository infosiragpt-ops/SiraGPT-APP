'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-nats');
const { extractNats, buildNatsForFiles, renderNatsBlock, _internal } = engine;
const { isNatsLike, classifySubject } = _internal;

const NATS_FIXTURE = `import { connect, JSONCodec, AckPolicy } from '@nats-io/transport-node';

const nc = await connect({ servers: 'nats://localhost:4222' });
const jc = JSONCodec();

// Pub/Sub
nc.publish('orders.created', jc.encode({ id: 1 }));
nc.subscribe('orders.>', { callback: (err, msg) => {} });
const reply = await nc.request('users.lookup', jc.encode({ id: 1 }), { timeout: 1000 });

// JetStream
const js = nc.jetstream();
const jsm = await nc.jetstreamManager();

await jsm.streams.add({
  name: 'ORDERS',
  subjects: ['orders.*'],
  retention: 'limits',
});

await jsm.consumers.add('ORDERS', {
  durable_name: 'order-processor',
  ack_policy: 'explicit',
  deliver_policy: 'all',
});

await js.publish('orders.completed', jc.encode({ id: 1 }));
const sub = await js.pullSubscribe('orders.*', { config: { durable: 'worker-1' } });

// Headers
const h = headers();
h.set('Nats-Msg-Id', '12345');
h.set('Nats-Expected-Stream', 'ORDERS');
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractNats('').total, 0);
  assert.equal(extractNats(null).total, 0);
});

test('non-NATS text returns empty', () => {
  const r = extractNats('Just regular code without NATS markers');
  assert.equal(r.total, 0);
});

test('isNatsLike heuristic', () => {
  assert.ok(isNatsLike('nc.publish("foo", data)'));
  assert.ok(isNatsLike('@nats-io/transport-node'));
  assert.ok(!isNatsLike('plain text'));
});

test('classifySubject: literal / single-wildcard / tail-wildcard', () => {
  assert.equal(classifySubject('orders.created'), 'literal');
  assert.equal(classifySubject('orders.*.shipped'), 'single-wildcard');
  assert.equal(classifySubject('events.>'), 'tail-wildcard');
});

test('detects publish / subscribe / request methods', () => {
  const r = extractNats(NATS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'method' && e.name === 'publish'));
  assert.ok(r.entries.some((e) => e.kind === 'method' && e.name === 'subscribe'));
  assert.ok(r.entries.some((e) => e.kind === 'method' && e.name === 'request'));
});

test('detects JetStream methods', () => {
  const r = extractNats(NATS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'jsMethod'));
});

test('detects subject names', () => {
  const r = extractNats(NATS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'subject' && e.name === 'orders.created'));
  assert.ok(r.entries.some((e) => e.kind === 'subject' && e.name === 'users.lookup'));
});

test('classifies wildcard subjects', () => {
  const r = extractNats(NATS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'subject' && e.detail === 'tail-wildcard'));
  assert.ok(r.entries.some((e) => e.kind === 'subject' && e.detail === 'single-wildcard'));
});

test('detects stream names', () => {
  const r = extractNats(NATS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'stream' && e.name === 'ORDERS'));
});

test('detects durable consumer names', () => {
  const r = extractNats(NATS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'durable' && e.name === 'order-processor'));
});

test('detects ack_policy / deliver_policy / retention', () => {
  const r = extractNats(NATS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'policy' && e.name === 'ack_policy' && e.detail === 'explicit'));
  assert.ok(r.entries.some((e) => e.kind === 'policy' && e.name === 'deliver_policy' && e.detail === 'all'));
});

test('detects Nats-* headers', () => {
  const r = extractNats(NATS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'header' && e.name === 'Nats-Msg-Id'));
  assert.ok(r.entries.some((e) => e.kind === 'header' && e.name === 'Nats-Expected-Stream'));
});

test('dedupes identical subjects', () => {
  const r = extractNats('nc.publish("foo.bar", x); nc.publish("foo.bar", y);');
  assert.equal(r.entries.filter((e) => e.kind === 'subject' && e.name === 'foo.bar').length, 1);
});

test('filters out file-path-like strings', () => {
  const r = extractNats('nc.publish("foo.bar", x); const f = "src/index.ts";');
  assert.ok(!r.entries.some((e) => e.kind === 'subject' && e.name === 'src/index.ts'));
  assert.ok(!r.entries.some((e) => e.kind === 'subject' && /\.ts$/.test(e.name)));
});

test('caps entries per file', () => {
  let text = 'nc.publish("a", x); ';
  for (let i = 0; i < 30; i++) text += `nc.publish("topic.${i}.event", y); `;
  const r = extractNats(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractNats(NATS_FIXTURE);
  assert.ok(r.totals.method >= 3);
  assert.ok(r.totals.subject >= 3);
});

test('buildNatsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.ts', extractedText: 'nc.publish("a.b", x); nc.subscribe("a.>", h);' },
    { name: 'b.ts', extractedText: 'jsm.streams.add({ name: "BACKLOG", subjects: ["b.*"] });' },
  ];
  const r = buildNatsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderNatsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'pubsub.ts', extractedText: NATS_FIXTURE }];
  const r = buildNatsForFiles(files);
  const md = renderNatsBlock(r);
  assert.match(md, /^## NATS/);
});

test('renderNatsBlock empty when nothing surfaces', () => {
  assert.equal(renderNatsBlock({ perFile: [] }), '');
  assert.equal(renderNatsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildNatsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: NATS_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
