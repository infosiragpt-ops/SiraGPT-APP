'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TOOLS, toolRegistry, getTool, lineCount } = require('../src/services/codex/build-tools');

function fakeRunner(overrides = {}) {
  return {
    exec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    readFile: async () => ({ content: 'line1\nline2\nline3' }),
    writeFiles: async () => ({ ok: true, written: 1 }),
    ...overrides,
  };
}

test('toolRegistry projects name/description/parameters for the 5 tools', () => {
  const reg = toolRegistry();
  assert.deepEqual(reg.map((t) => t.name).sort(), ['edit_file', 'read_file', 'run_command', 'web_search', 'write_file']);
  for (const t of reg) { assert.ok(t.description); assert.ok(t.parameters); }
});

test('run_command returns exit code; non-zero is a tool error (not a throw)', async () => {
  const ok = await TOOLS.run_command.execute({ cmd: ['git', 'status'] }, { runner: fakeRunner(), project: 'p1' });
  assert.equal(ok.isError, false);
  assert.match(ok.observation, /exitCode=0/);

  const bad = await TOOLS.run_command.execute({ cmd: ['bun', 'run', 'x'] }, { runner: fakeRunner({ exec: async () => ({ exitCode: 1, stdout: '', stderr: 'boom' }) }), project: 'p1' });
  assert.equal(bad.isError, true);
  assert.match(bad.summary, /exit 1/);
});

test('run_command rejects a non-array cmd', async () => {
  const r = await TOOLS.run_command.execute({ cmd: 'git status' }, { runner: fakeRunner(), project: 'p1' });
  assert.equal(r.isError, true);
});

test('read_file counts lines read', async () => {
  const r = await TOOLS.read_file.execute({ path: 'src/main.js' }, { runner: fakeRunner(), project: 'p1' });
  assert.equal(r.isError, false);
  assert.equal(r.linesRead, 3);
  assert.equal(TOOLS.read_file.pathFor({ path: 'src/main.js' }), 'src/main.js');
});

test('write_file writes content and reports bytes', async () => {
  let captured = null;
  const runner = fakeRunner({ writeFiles: async (p, files) => { captured = files; return { ok: true }; } });
  const r = await TOOLS.write_file.execute({ path: 'a.txt', content: 'hola' }, { runner, project: 'p1' });
  assert.equal(r.isError, false);
  assert.deepEqual(captured, [{ path: 'a.txt', content: 'hola' }]);
  assert.match(r.summary, /4 bytes/);
});

test('edit_file replaces an exact match and errors when not found', async () => {
  let written = null;
  const runner = fakeRunner({ readFile: async () => ({ content: 'const x = 1;' }), writeFiles: async (p, f) => { written = f; return {}; } });
  const ok = await TOOLS.edit_file.execute({ path: 'a.js', find: 'x = 1', replace: 'x = 2' }, { runner, project: 'p1' });
  assert.equal(ok.isError, false);
  assert.equal(written[0].content, 'const x = 2;');

  const miss = await TOOLS.edit_file.execute({ path: 'a.js', find: 'nope', replace: 'y' }, { runner: fakeRunner({ readFile: async () => ({ content: 'const x = 1;' }) }), project: 'p1' });
  assert.equal(miss.isError, true);
  assert.match(miss.observation, /no existe/);
});

test('web_search returns titles/snippets and degrades without an adapter', async () => {
  const withAdapter = await TOOLS.web_search.execute({ query: 'vite docs' }, { webSearch: async () => [{ title: 'Vite', snippet: 'build tool' }] });
  assert.equal(withAdapter.isError, false);
  assert.match(withAdapter.observation, /Vite/);

  const noAdapter = await TOOLS.web_search.execute({ query: 'x' }, {});
  assert.equal(noAdapter.isError, true);
});

test('getTool + lineCount helpers', () => {
  assert.equal(getTool('read_file').kind, 'file_read');
  assert.equal(getTool('nope'), null);
  assert.equal(lineCount('a\nb'), 2);
  assert.equal(lineCount(''), 0);
});
