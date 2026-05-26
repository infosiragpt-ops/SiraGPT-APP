'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-kafka-refs');
const { extractKafkaRefs, buildKafkaRefsForFiles, renderKafkaRefsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractKafkaRefs('').total, 0);
  assert.equal(extractKafkaRefs(null).total, 0);
});

test('detects topic name', () => {
  const r = extractKafkaRefs('Topic: orders.created');
  assert.ok(r.entries.some((e) => e.kind === 'topic'));
});

test('detects consumer group', () => {
  const r = extractKafkaRefs('group.id: my-consumer-group');
  assert.ok(r.entries.some((e) => e.kind === 'consumerGroup'));
});

test('detects partition number', () => {
  const r = extractKafkaRefs('partition: 5');
  assert.ok(r.entries.some((e) => e.kind === 'partition' && e.value === '5'));
});

test('detects offset', () => {
  const r = extractKafkaRefs('offset: 123456');
  assert.ok(r.entries.some((e) => e.kind === 'offset'));
});

test('detects "committed offset"', () => {
  const r = extractKafkaRefs('committed offset 999999');
  assert.ok(r.entries.some((e) => e.kind === 'offset' && e.value === '999999'));
});

test('detects kafka-topics command', () => {
  const r = extractKafkaRefs('Run kafka-topics.sh --list');
  assert.ok(r.entries.some((e) => e.kind === 'command'));
});

test('detects kafka-console-consumer', () => {
  const r = extractKafkaRefs('kafka-console-consumer --topic foo');
  assert.ok(r.entries.some((e) => e.kind === 'command'));
});

test('detects bootstrap servers', () => {
  const r = extractKafkaRefs('bootstrap.servers: kafka1:9092,kafka2:9092');
  assert.ok(r.entries.some((e) => e.kind === 'bootstrap'));
});

test('dedupes identical entries', () => {
  const r = extractKafkaRefs('topic: foo and topic: foo');
  assert.equal(r.entries.filter((e) => e.kind === 'topic' && e.value === 'foo').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `topic: name-${i}.suffix `;
  const r = extractKafkaRefs(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by kind', () => {
  const r = extractKafkaRefs(
    'topic: foo and group.id: bar and partition 0 and offset 1234'
  );
  assert.ok(r.totals.topic >= 1);
  assert.ok(r.totals.consumerGroup >= 1);
  assert.ok(r.totals.partition >= 1);
  assert.ok(r.totals.offset >= 1);
});

test('buildKafkaRefsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.log', extractedText: 'topic: foo' },
    { name: 'b.log', extractedText: 'group.id: bar' },
  ];
  const r = buildKafkaRefsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderKafkaRefsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'runbook', extractedText: 'topic: foo' }];
  const r = buildKafkaRefsForFiles(files);
  const md = renderKafkaRefsBlock(r);
  assert.match(md, /^## KAFKA/);
});

test('renderKafkaRefsBlock empty when nothing surfaces', () => {
  assert.equal(renderKafkaRefsBlock({ perFile: [] }), '');
  assert.equal(renderKafkaRefsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildKafkaRefsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'topic: foo' },
  ]);
  assert.equal(r.perFile.length, 1);
});
