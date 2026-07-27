'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TOOLS, toolRegistry } = require('../src/services/codex/build-tools');
const { FileStateTracker } = require('../src/services/codex/file-state');
const { normalizeGlobPatterns, runSafeGlob } = require('../src/services/codex/safe-glob');

function statefulRunner(initial = {}) {
  const files = new Map(Object.entries(initial));
  const writes = [];
  return {
    files,
    writes,
    async readFile(_project, path) {
      if (!files.has(path)) throw new Error('file_not_found');
      return { content: files.get(path) };
    },
    async writeFiles(_project, changes) {
      for (const change of changes) {
        files.set(change.path, change.content);
        writes.push(change);
      }
      return { ok: true, written: changes.length };
    },
    async exec() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

test('extended registry keeps legacy tools and exposes OT-11/9/17/5 tools', () => {
  const names = new Set(toolRegistry().map((tool) => tool.name));
  for (const legacy of ['run_command', 'read_file', 'edit_file', 'web_search']) {
    assert.equal(names.has(legacy), true);
  }
  for (const added of ['glob', 'read_media', 'resolve_conflict', 'task_logs', 'task_stop', 'web_fetch', 'mcp_list_tools', 'mcp_call']) {
    assert.equal(names.has(added), true);
  }
});

test('edit_file enforces read-before-edit and detects external changes', async () => {
  const runner = statefulRunner({ 'src/app.js': 'const value = 1;\n' });
  const tracker = new FileStateTracker();
  const ctx = { runner, project: 'project-a', fileStateTracker: tracker };

  const unread = await TOOLS.edit_file.execute({
    path: 'src/app.js',
    find: 'value = 1',
    replace: 'value = 2',
  }, ctx);
  assert.equal(unread.isError, true);
  assert.match(unread.observation, /read-before-edit/);
  assert.equal(runner.writes.length, 0);

  const read = await TOOLS.read_file.execute({ path: 'src/app.js' }, ctx);
  assert.equal(read.isError, false);

  runner.files.set('src/app.js', 'const value = 9;\n');
  const stale = await TOOLS.edit_file.execute({
    path: 'src/app.js',
    find: 'value = 1',
    replace: 'value = 2',
  }, ctx);
  assert.equal(stale.isError, true);
  assert.match(stale.observation, /cambió desde la última lectura/);
  assert.equal(runner.writes.length, 0);

  await TOOLS.read_file.execute({ path: 'src/app.js' }, ctx);
  const edited = await TOOLS.edit_file.execute({
    path: 'src/app.js',
    find: 'value = 9',
    replace: 'value = 10',
  }, ctx);
  assert.equal(edited.isError, false);
  assert.equal(runner.files.get('src/app.js'), 'const value = 10;\n');
});

test('write_file records the new state for a follow-up edit in the same run', async () => {
  const runner = statefulRunner();
  const ctx = { runner, project: 'project-b', fileStateTracker: new FileStateTracker() };
  const written = await TOOLS.write_file.execute({ path: 'new.txt', content: 'alpha' }, ctx);
  assert.equal(written.isError, false);
  const edited = await TOOLS.edit_file.execute({ path: 'new.txt', find: 'alpha', replace: 'beta' }, ctx);
  assert.equal(edited.isError, false);
  assert.equal(runner.files.get('new.txt'), 'beta');
});

test('write_file refuses a blind overwrite and detects a stale read', async () => {
  const runner = statefulRunner({ 'config.json': '{"version":1}\n' });
  const tracker = new FileStateTracker();
  const ctx = { runner, project: 'project-write-guard', fileStateTracker: tracker };

  const blind = await TOOLS.write_file.execute({ path: 'config.json', content: '{"version":2}\n' }, ctx);
  assert.equal(blind.isError, true);
  assert.match(blind.observation, /read-before-write/);

  await TOOLS.read_file.execute({ path: 'config.json' }, ctx);
  runner.files.set('config.json', '{"version":9}\n');
  const stale = await TOOLS.write_file.execute({ path: 'config.json', content: '{"version":2}\n' }, ctx);
  assert.equal(stale.isError, true);
  assert.match(stale.observation, /cambió desde la última lectura/);

  await TOOLS.read_file.execute({ path: 'config.json' }, ctx);
  const current = await TOOLS.write_file.execute({ path: 'config.json', content: '{"version":10}\n' }, ctx);
  assert.equal(current.isError, false);
  assert.equal(runner.files.get('config.json'), '{"version":10}\n');
});

test('resolve_conflict only stages a path Git reports as unresolved', async () => {
  const calls = [];
  let content = '<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\n';
  const runner = {
    async writeFiles(_project, files) {
      content = files[0].content;
      return { ok: true, written: 1 };
    },
    async exec(_project, cmd) {
      calls.push(cmd);
      if (cmd.includes('--diff-filter=U') && cmd.includes('--')) {
        return { exitCode: 0, stdout: 'src/app.ts\0', stderr: '' };
      }
      if (cmd[1] === 'add') return { exitCode: 0, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  const resolved = await TOOLS.resolve_conflict.execute({
    path: 'src/app.ts',
    content: 'const choice = "left";\n',
  }, { runner, project: 'p-conflict' });
  assert.equal(resolved.isError, false);
  assert.equal(content, 'const choice = "left";\n');
  assert.deepEqual(calls.find((cmd) => cmd[1] === 'add'), ['git', 'add', '--', 'src/app.ts']);

  const untouched = await TOOLS.resolve_conflict.execute({
    path: 'src/free.ts',
    content: 'export {};\n',
  }, {
    project: 'p-conflict',
    runner: {
      async exec() { return { exitCode: 0, stdout: '', stderr: '' }; },
      async writeFiles() { throw new Error('must not write a non-conflicted path'); },
    },
  });
  assert.equal(untouched.isError, true);
  assert.match(untouched.observation, /no marca/);

  const markers = await TOOLS.resolve_conflict.execute({
    path: 'src/app.ts',
    content: '<<<<<<< HEAD\nstill broken\n',
  }, { runner, project: 'p-conflict' });
  assert.equal(markers.isError, true);
  assert.match(markers.observation, /marcadores/);
});

test('safe glob uses top-scoped Git pathspecs and rejects traversal', async () => {
  let seen = null;
  const runner = {
    async exec(project, cmd) {
      seen = { project, cmd };
      return { exitCode: 0, stdout: 'src/a.ts\0src/nested/b.ts\0', stderr: '' };
    },
  };
  const result = await runSafeGlob({
    runner,
    project: 'project-c',
    patterns: ['src/**/*.ts'],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, ['src/a.ts', 'src/nested/b.ts']);
  assert.equal(seen.project, 'project-c');
  assert.deepEqual(seen.cmd, [
    'git',
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    ':(top,glob)src/**/*.ts',
  ]);
  assert.equal(normalizeGlobPatterns(['../secret']), null);
  assert.equal(normalizeGlobPatterns(['/etc/passwd']), null);
  assert.equal(normalizeGlobPatterns(['src/**/*.ts'])?.[0], 'src/**/*.ts');
});

test('glob tool reports results and never invokes the shell', async () => {
  const calls = [];
  const runner = {
    async exec(_project, cmd) {
      calls.push(cmd);
      return { exitCode: 0, stdout: 'a.test.js\0b.test.js\0', stderr: '' };
    },
  };
  const result = await TOOLS.glob.execute({ patterns: ['**/*.test.js'] }, { runner, project: 'p1' });
  assert.equal(result.isError, false);
  assert.match(result.summary, /2 archivos/);
  assert.equal(calls[0][0], 'git');
  assert.equal(calls[0].includes('sh'), false);
});
