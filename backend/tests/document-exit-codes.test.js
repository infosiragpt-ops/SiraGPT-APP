'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-exit-codes');
const { extractExitCodes, buildExitCodesForFiles, renderExitCodesBlock, _internal } = engine;
const { describeCode } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractExitCodes('').total, 0);
  assert.equal(extractExitCodes(null).total, 0);
});

test('describeCode standards', () => {
  assert.equal(describeCode(0), 'success');
  assert.equal(describeCode(127), 'command-not-found');
  assert.equal(describeCode(130), 'SIGINT (Ctrl-C)');
});

test('detects "exit 0"', () => {
  const r = extractExitCodes('Script ended with exit 0');
  assert.ok(r.entries.some((e) => e.code === 0));
});

test('detects "exit 1"', () => {
  const r = extractExitCodes('Failed: exit 1');
  assert.ok(r.entries.some((e) => e.code === 1 && e.description === 'general-error'));
});

test('detects "exit 130" Ctrl-C', () => {
  const r = extractExitCodes('User pressed Ctrl-C, exit 130');
  assert.ok(r.entries.some((e) => e.code === 130 && /SIGINT/.test(e.description)));
});

test('detects "exit code: 137" SIGKILL', () => {
  const r = extractExitCodes('Process killed, exit code: 137');
  assert.ok(r.entries.some((e) => e.code === 137));
});

test('detects rc=N', () => {
  const r = extractExitCodes('Return code rc=2 indicates misuse');
  assert.ok(r.entries.some((e) => e.code === 2));
});

test('detects $?', () => {
  const r = extractExitCodes('echo $?=127');
  assert.ok(r.entries.some((e) => e.code === 127));
});

test('detects "exited with code N"', () => {
  const r = extractExitCodes('process exited with code 143');
  assert.ok(r.entries.some((e) => e.code === 143));
});

test('dedupes identical entries', () => {
  const r = extractExitCodes('exit 1 and exit 1 again');
  assert.equal(r.entries.filter((e) => e.code === 1 && e.source === 'exit-keyword').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `exit ${i} `;
  const r = extractExitCodes(text);
  assert.ok(r.entries.length <= 14);
});

test('counts totals by bucket', () => {
  const r = extractExitCodes('exit 0 then exit 1 then exit 137');
  assert.ok(r.totals.success >= 1);
  assert.ok(r.totals.error >= 1);
  assert.ok(r.totals.signal >= 1);
});

test('buildExitCodesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'exit 0' },
    { name: 'b', extractedText: 'exit 1' },
  ];
  const r = buildExitCodesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderExitCodesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'run.log', extractedText: 'exit 0' }];
  const r = buildExitCodesForFiles(files);
  const md = renderExitCodesBlock(r);
  assert.match(md, /^## SHELL EXIT/);
});

test('renderExitCodesBlock empty when nothing surfaces', () => {
  assert.equal(renderExitCodesBlock({ perFile: [] }), '');
  assert.equal(renderExitCodesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildExitCodesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'exit 0' },
  ]);
  assert.equal(r.perFile.length, 1);
});
