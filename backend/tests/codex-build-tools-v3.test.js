'use strict';

// New Claude Code-style workspace tools: list_files, type_check,
// dev_server_check (the "see the real errors" loop).

const test = require('node:test');
const assert = require('node:assert/strict');

const { TOOLS } = require('../src/services/codex/build-tools');

function fakeRunner(overrides = {}) {
  return {
    exec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    readFile: async () => ({ content: 'x' }),
    writeFiles: async () => ({ ok: true }),
    devStatus: async () => ({ running: true, ready: true, project: 'p1', tail: ['vite ready in 300ms'] }),
    startDev: async () => ({ ok: true }),
    ...overrides,
  };
}

test('list_files returns the tracked+untracked listing', async () => {
  const runner = fakeRunner({ exec: async (_p, cmd) => {
    assert.deepEqual(cmd, ['git', 'ls-files', '--cached', '--others', '--exclude-standard']);
    return { exitCode: 0, stdout: 'package.json\nsrc/App.tsx', stderr: '' };
  } });
  const r = await TOOLS.list_files.execute({}, { runner, project: 'p1' });
  assert.equal(r.isError, false);
  assert.match(r.observation, /src\/App\.tsx/);
});

test('list_files surfaces git failures as tool errors', async () => {
  const runner = fakeRunner({ exec: async () => ({ exitCode: 128, stdout: '', stderr: 'not a git repo' }) });
  const r = await TOOLS.list_files.execute({}, { runner, project: 'p1' });
  assert.equal(r.isError, true);
  assert.match(r.observation, /not a git repo/);
});

test('type_check clean pass', async () => {
  const calls = [];
  const runner = fakeRunner({ exec: async (_p, cmd) => {
    calls.push(cmd);
    return { exitCode: 0, stdout: '', stderr: '' };
  } });
  const r = await TOOLS.type_check.execute({}, { runner, project: 'p1' });
  assert.equal(r.isError, false);
  assert.deepEqual(calls, [
    ['bun', 'install'],
    ['bunx', 'tsc', '--noEmit', '--pretty', 'false'],
  ]);
  assert.match(r.observation, /compila sin errores/);
});

test('type_check failure feeds the REAL diagnostics back to the model', async () => {
  let n = 0;
  const runner = fakeRunner({
    exec: async () => {
      n += 1;
      if (n === 1) return { exitCode: 0, stdout: '', stderr: '' };
      return { exitCode: 2, stdout: "src/App.tsx(1,1): error TS2304: Cannot find name 'x'.", stderr: '' };
    },
  });
  const r = await TOOLS.type_check.execute({}, { runner, project: 'p1' });
  assert.equal(r.isError, true);
  assert.match(r.observation, /TS2304/);
  assert.match(r.observation, /Corrige estos errores/);
});

test('type_check failure reports install errors before tsc', async () => {
  const runner = fakeRunner({ exec: async () => ({ exitCode: 1, stdout: '', stderr: 'No matching version for no-such-package' }) });
  const r = await TOOLS.type_check.execute({}, { runner, project: 'p1' });
  assert.equal(r.isError, true);
  assert.match(r.observation, /No pude instalar/);
});

test('type_check runner crash is informational, not a build error', async () => {
  const runner = fakeRunner({ exec: async () => { throw new Error('runner unreachable'); } });
  const r = await TOOLS.type_check.execute({}, { runner, project: 'p1' });
  assert.equal(r.isError, false);
  assert.match(r.observation, /No pude ejecutar/);
});

test('dev_server_check: already-ready server with clean logs', async () => {
  const r = await TOOLS.dev_server_check.execute({ waitMs: 2000 }, { runner: fakeRunner(), project: 'p1' });
  assert.equal(r.isError, false);
  assert.match(r.observation, /corriendo y responde/);
});

test('dev_server_check: starts the dev server when idle or on another project', async () => {
  let started = 0;
  let calls = 0;
  const runner = fakeRunner({
    startDev: async () => { started += 1; return { ok: true }; },
    devStatus: async () => {
      calls += 1;
      if (calls === 1) return { running: false, ready: false, tail: [] };
      return { running: true, ready: true, project: 'p1', tail: ['ready'] };
    },
  });
  const r = await TOOLS.dev_server_check.execute({ waitMs: 2000 }, { runner, project: 'p1' });
  assert.equal(started, 1);
  assert.equal(r.isError, false);
});

test('dev_server_check: a failing server returns the live error logs', async () => {
  const runner = fakeRunner({
    devStatus: async () => ({ running: true, ready: false, project: 'p1', error: 'exited', tail: ['[vite] Internal server error: Failed to resolve import "./Boton"'] }),
  });
  const r = await TOOLS.dev_server_check.execute({ waitMs: 2000 }, { runner, project: 'p1' });
  assert.equal(r.isError, true);
  assert.match(r.observation, /Failed to resolve import/);
  assert.match(r.observation, /Diagnostica y corrige/);
});

test('dev_server_check: ready but noisy logs → warning, not error', async () => {
  const runner = fakeRunner({
    devStatus: async () => ({ running: true, ready: true, project: 'p1', tail: ['warning: Cannot find module type', 'ready in 200ms'] }),
  });
  const r = await TOOLS.dev_server_check.execute({ waitMs: 2000 }, { runner, project: 'p1' });
  assert.equal(r.isError, false);
  assert.match(r.observation, /posibles problemas/);
});

test('dev_server_check: runner unreachable is a tool error', async () => {
  const runner = fakeRunner({ devStatus: async () => { throw new Error('ECONNREFUSED'); } });
  const r = await TOOLS.dev_server_check.execute({}, { runner, project: 'p1' });
  assert.equal(r.isError, true);
  assert.match(r.observation, /ECONNREFUSED/);
});

test('new tools carry timeline metadata (kind/commandFor/pathFor)', () => {
  assert.equal(TOOLS.list_files.kind, 'file_read');
  assert.equal(TOOLS.type_check.kind, 'terminal');
  assert.equal(TOOLS.dev_server_check.kind, 'terminal');
  assert.equal(TOOLS.run_subagent.kind, 'agent');
  assert.equal(TOOLS.install_dependencies.kind, 'terminal');
  assert.equal(TOOLS.type_check.commandFor({}), 'bun install && bunx tsc --noEmit');
  assert.equal(TOOLS.install_dependencies.commandFor({ packages: ['zod'], dev: true }), 'bun add -d zod');
  assert.match(TOOLS.run_subagent.commandFor({ agent: 'planner', task: 'plan the CRM' }), /subagent planner/);
});
