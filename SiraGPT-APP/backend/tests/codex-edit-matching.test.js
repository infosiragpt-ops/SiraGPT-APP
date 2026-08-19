'use strict';

/**
 * codex/edit-matching — offline unit tests for the graduated match ladder.
 *
 * Covers: exact matches (single/multi/replaceAll), the line-trimmed recovery
 * for indentation-drifted quotes (with re-indentation of the replacement),
 * ambiguity rejection on both levels, not-found, CRLF tolerance, and the
 * edit_file tool integration (fuzzy path writes the re-indented content).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findMatch, reindentReplacement, applyEdit } = require('../src/services/codex/edit-matching');
const buildTools = require('../src/services/codex/build-tools');

const FILE = [
  'function App() {',
  '  return (',
  '    <main>',
  '      <Header title="Hola" />',
  '    </main>',
  '  )',
  '}',
].join('\n');

test('exact match: single occurrence replaces as before', () => {
  const r = applyEdit(FILE, '<Header title="Hola" />', '<Header title="Adiós" />');
  assert.equal(r.ok, true);
  assert.equal(r.strategy, 'exact');
  assert.match(r.next, /Adiós/);
});

test('exact match: multiple occurrences require replaceAll', () => {
  const text = 'a\nX\nb\nX\n';
  assert.equal(applyEdit(text, 'X', 'Y').ok, false);
  const all = applyEdit(text, 'X', 'Y', { replaceAll: true });
  assert.equal(all.ok, true);
  assert.equal(all.occurrences, 2);
  assert.equal(all.next, 'a\nY\nb\nY\n');
});

test('line-trimmed: indentation-drifted quote still lands, re-indented', () => {
  // Model quoted the fragment WITHOUT the file's leading indentation.
  const find = '<main>\n  <Header title="Hola" />\n</main>';
  const r = applyEdit(FILE, find, '<main>\n  <Nav />\n</main>');
  assert.equal(r.ok, true);
  assert.equal(r.strategy, 'line-trimmed');
  // The replacement inherits the file's 4-space indent on non-blank lines.
  assert.match(r.next, /\n    <main>\n      <Nav \/>\n    <\/main>\n/);
  // Rest of the file intact.
  assert.match(r.next, /^function App\(\) \{/);
  assert.match(r.next, /\}\s*$/);
});

test('line-trimmed: ambiguous window is rejected', () => {
  const text = '  foo()\n  bar()\n\n  foo()\n  bar()\n';
  const r = applyEdit(text, 'foo()\nbar()', 'baz()');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous');
  assert.equal(r.occurrences, 2);
});

test('not found on both levels', () => {
  const r = applyEdit(FILE, 'no existe en absoluto', 'x');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_found');
});

test('CRLF file tolerated by the trimmed window', () => {
  const crlf = 'a()\r\n  b()\r\nc()\r\n';
  const r = applyEdit(crlf, 'b()', 'B()');
  assert.equal(r.ok, true);
  assert.match(r.next, /  B\(\)/);
});

test('trailing newline in find does not break the window', () => {
  const r = findMatch(FILE, '      <Header title="Hola" />\n');
  assert.equal(r.strategy, 'exact');
});

test('reindentReplacement keeps blank lines blank', () => {
  assert.equal(reindentReplacement('a\n\nb', '  '), '  a\n\n  b');
  assert.equal(reindentReplacement('a', ''), 'a');
});

test('edit_file tool: fuzzy path writes re-indented content and says so', async () => {
  let written = null;
  const runner = {
    readFile: async () => ({ content: FILE }),
    writeFiles: async (_p, files) => { written = files[0]; },
  };
  const tool = buildTools.getTool('edit_file');
  const out = await tool.execute(
    { path: 'src/App.tsx', find: '<Header title="Hola" />', replace: '<Header title="Hola" subtitle="x" />' },
    { runner, project: 'p1' },
  );
  assert.equal(out.isError, false);
  assert.match(written.content, /subtitle="x"/);

  // Drifted quote through the tool.
  const out2 = await tool.execute(
    { path: 'src/App.tsx', find: '<main>\n  <Header title="Hola" />\n</main>', replace: '<main>\n  <Nav />\n</main>' },
    { runner, project: 'p1' },
  );
  assert.equal(out2.isError, false);
  assert.match(out2.observation, /coincidencia por líneas/);
  assert.match(written.content, /    <main>\n      <Nav \/>/);
});

test('edit_file tool: not-found message mentions both levels', async () => {
  const runner = { readFile: async () => ({ content: FILE }), writeFiles: async () => {} };
  const tool = buildTools.getTool('edit_file');
  const out = await tool.execute({ path: 'x.ts', find: 'nada', replace: 'y' }, { runner, project: 'p1' });
  assert.equal(out.isError, true);
  assert.match(out.observation, /ni exacto ni por líneas/);
});
