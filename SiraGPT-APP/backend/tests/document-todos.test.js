'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-todos');
const { extractTodos, buildTodosForFiles, renderTodosBlock, _internal } = engine;
const { normaliseMarker } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractTodos('').total, 0);
  assert.equal(extractTodos(null).total, 0);
});

test('normaliseMarker: tbd/tba/tbc → wip', () => {
  assert.equal(normaliseMarker('TBD'), 'wip');
  assert.equal(normaliseMarker('TBA'), 'wip');
  assert.equal(normaliseMarker('TBC'), 'wip');
});

test('normaliseMarker: Spanish nota/ojo → note', () => {
  assert.equal(normaliseMarker('NOTA'), 'note');
  assert.equal(normaliseMarker('OJO'), 'note');
});

test('detects TODO with description', () => {
  const r = extractTodos('TODO: implement caching layer');
  assert.ok(r.entries.some((e) => e.kind === 'todo' && /caching/.test(e.text)));
});

test('detects FIXME', () => {
  const r = extractTodos('FIXME: race condition in upload handler');
  assert.ok(r.entries.some((e) => e.kind === 'fixme'));
});

test('detects NOTE', () => {
  const r = extractTodos('NOTE: max retries set conservatively');
  assert.ok(r.entries.some((e) => e.kind === 'note'));
});

test('detects HACK', () => {
  const r = extractTodos('HACK: hardcoded value for now');
  assert.ok(r.entries.some((e) => e.kind === 'hack'));
});

test('detects XXX', () => {
  const r = extractTodos('XXX: needs review before ship');
  assert.ok(r.entries.some((e) => e.kind === 'xxx'));
});

test('detects bare WIP', () => {
  const r = extractTodos('Feature status: WIP');
  assert.ok(r.entries.some((e) => e.kind === 'wip'));
});

test('detects BUG marker', () => {
  const r = extractTodos('BUG: returns wrong status code on timeout');
  assert.ok(r.entries.some((e) => e.kind === 'bug'));
});

test('detects Spanish PENDIENTE', () => {
  const r = extractTodos('PENDIENTE: revisar políticas de seguridad');
  assert.ok(r.entries.some((e) => e.kind === 'pendiente'));
});

test('detects NOTA / OJO normalized to note', () => {
  const r = extractTodos('NOTA: revisar antes de release\nOJO: cambia el orden');
  assert.equal(r.byKind.note >= 2, true);
});

test('dedupes identical entries', () => {
  const r = extractTodos('TODO: same task\nTODO: same task');
  assert.equal(r.entries.filter((e) => e.kind === 'todo').length, 1);
});

test('caps per kind', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `TODO: task ${i}\n`;
  const r = extractTodos(text);
  assert.ok(r.byKind.todo <= 10);
});

test('counts byKind', () => {
  const r = extractTodos('TODO: a\nFIXME: b\nNOTE: c');
  assert.equal(r.byKind.todo, 1);
  assert.equal(r.byKind.fixme, 1);
  assert.equal(r.byKind.note, 1);
});

test('buildTodosForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'TODO: x' },
    { name: 'b.md', extractedText: 'FIXME: y' },
  ];
  const r = buildTodosForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderTodosBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'TODO: refactor' }];
  const r = buildTodosForFiles(files);
  const md = renderTodosBlock(r);
  assert.match(md, /^## TODO/);
});

test('renderTodosBlock empty when nothing surfaces', () => {
  assert.equal(renderTodosBlock({ perFile: [] }), '');
  assert.equal(renderTodosBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildTodosForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'TODO: x' },
  ]);
  assert.equal(r.perFile.length, 1);
});
