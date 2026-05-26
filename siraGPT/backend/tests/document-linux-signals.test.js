'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-linux-signals');
const { extractLinuxSignals, buildLinuxSignalsForFiles, renderLinuxSignalsBlock, _internal } = engine;
const { nameFromNumber, SIGNALS } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractLinuxSignals('').total, 0);
  assert.equal(extractLinuxSignals(null).total, 0);
});

test('nameFromNumber helper', () => {
  assert.equal(nameFromNumber(9), 'SIGKILL');
  assert.equal(nameFromNumber(15), 'SIGTERM');
});

test('detects SIGTERM by name', () => {
  const r = extractLinuxSignals('Received SIGTERM');
  assert.ok(r.entries.some((e) => e.signal === 'SIGTERM'));
});

test('detects SIGKILL by name', () => {
  const r = extractLinuxSignals('Forced SIGKILL after timeout');
  assert.ok(r.entries.some((e) => e.signal === 'SIGKILL'));
});

test('detects "kill -9 PID"', () => {
  const r = extractLinuxSignals('Ran kill -9 12345 to terminate');
  assert.ok(r.entries.some((e) => e.signal === 'SIGKILL' && e.source === 'kill'));
});

test('detects "kill -TERM PID"', () => {
  const r = extractLinuxSignals('Used kill -TERM 12345');
  assert.ok(r.entries.some((e) => e.signal === 'SIGTERM'));
});

test('detects labeled "signal: 15"', () => {
  const r = extractLinuxSignals('Process received signal: 15');
  assert.ok(r.entries.some((e) => e.signal === 'SIGTERM'));
});

test('detects SIGINT (Ctrl+C)', () => {
  const r = extractLinuxSignals('User pressed Ctrl+C, SIGINT caught');
  assert.ok(r.entries.some((e) => e.signal === 'SIGINT'));
});

test('detects SIGSEGV', () => {
  const r = extractLinuxSignals('Crashed with SIGSEGV');
  assert.ok(r.entries.some((e) => e.signal === 'SIGSEGV'));
});

test('detects SIGHUP for daemon reload', () => {
  const r = extractLinuxSignals('Send SIGHUP to reload config');
  assert.ok(r.entries.some((e) => e.signal === 'SIGHUP'));
});

test('dedupes identical signal+source', () => {
  const r = extractLinuxSignals('SIGTERM and SIGTERM again');
  assert.equal(r.entries.filter((e) => e.signal === 'SIGTERM' && e.source === 'name').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (const sig of Object.keys(SIGNALS).slice(0, 20)) text += `${sig} `;
  const r = extractLinuxSignals(text);
  assert.ok(r.entries.length <= 14);
});

test('buildLinuxSignalsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'SIGTERM caught' },
    { name: 'b', extractedText: 'kill -9 12345' },
  ];
  const r = buildLinuxSignalsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderLinuxSignalsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'runbook', extractedText: 'SIGTERM caught' }];
  const r = buildLinuxSignalsForFiles(files);
  const md = renderLinuxSignalsBlock(r);
  assert.match(md, /^## LINUX SIGNALS/);
});

test('renderLinuxSignalsBlock empty when nothing surfaces', () => {
  assert.equal(renderLinuxSignalsBlock({ perFile: [] }), '');
  assert.equal(renderLinuxSignalsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildLinuxSignalsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'SIGTERM' },
  ]);
  assert.equal(r.perFile.length, 1);
});
