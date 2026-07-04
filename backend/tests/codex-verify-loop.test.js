'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const verifyLoop = require('../src/services/codex/verify-loop');
const { TOOLS } = require('../src/services/codex/build-tools');

function fakeEventStore() {
  const events = [];
  return {
    events,
    appendEvent: async (runId, type, data) => { events.push({ runId, type, data }); return { seq: events.length }; },
  };
}

function baseRunner({ execResults, files = {} } = {}) {
  let execIdx = 0;
  const written = [];
  return {
    written,
    exec: async (_p, cmd) => {
      if (Array.isArray(cmd) && cmd[0] === 'bunx') {
        const r = execResults[Math.min(execIdx, execResults.length - 1)];
        execIdx += 1;
        return r;
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    readFile: async (_p, path) => {
      if (path in files) return { content: files[path] };
      throw new Error('not found');
    },
    writeFiles: async (_p, fs) => { written.push(...fs); return { ok: true }; },
  };
}

const TS_FILES = { 'package.json': '{"name":"x"}', 'tsconfig.json': '{"compilerOptions":{}}' };
const run = { id: 'r1' };

test('skips when disabled via CODEX_AUTO_VERIFY=0', async () => {
  const es = fakeEventStore();
  const out = await verifyLoop.autoVerifyAndHeal({
    run, projectId: 'p1', runner: baseRunner({ execResults: [], files: TS_FILES }), eventStore: es, llmTurn: async () => ({}), env: { NODE_ENV: 'test', CODEX_AUTO_VERIFY: '0' },
  });
  assert.deepEqual(out, { ran: false, clean: null, rounds: 0, fixes: 0 });
  assert.equal(es.events.length, 0);
});

test('skips non-TS workspaces (no tsconfig)', async () => {
  const out = await verifyLoop.autoVerifyAndHeal({
    run, projectId: 'p1', runner: baseRunner({ execResults: [], files: { 'package.json': '{}' } }), eventStore: fakeEventStore(), llmTurn: async () => ({}), env: { NODE_ENV: 'test' },
  });
  assert.equal(out.ran, false);
});

test('clean first pass: one check action + narrative, no fixes', async () => {
  const es = fakeEventStore();
  const out = await verifyLoop.autoVerifyAndHeal({
    run,
    projectId: 'p1',
    runner: baseRunner({ execResults: [{ exitCode: 0, stdout: '', stderr: '' }], files: TS_FILES }),
    eventStore: es,
    llmTurn: async () => { throw new Error('must not be called'); },
    env: { NODE_ENV: 'test' },
  });
  assert.deepEqual(out, { ran: true, clean: true, rounds: 1, fixes: 0 });
  const types = es.events.map((e) => e.type);
  assert.deepEqual(types, ['action_start', 'action_end', 'narrative_delta']);
  assert.equal(es.events[1].data.status, 'done');
});

test('dirty → fix → clean: model edits land before the re-check and are counted', async () => {
  const es = fakeEventStore();
  const runner = baseRunner({
    execResults: [
      { exitCode: 2, stdout: "src/App.tsx(3,5): error TS2304: Cannot find name 'Boton'.", stderr: '' },
      { exitCode: 0, stdout: '', stderr: '' },
    ],
    files: { ...TS_FILES, 'src/App.tsx': 'x' },
  });
  let llmCalls = 0;
  const llmTurn = async ({ messages }) => {
    llmCalls += 1;
    if (llmCalls === 1) {
      assert.match(messages[1].content, /TS2304/);
      return { text: 'Corrijo el import.', toolCalls: [{ id: 't1', name: 'write_file', args: { path: 'src/App.tsx', content: 'fixed' } }] };
    }
    return { text: 'Listo.', toolCalls: [] };
  };
  const out = await verifyLoop.autoVerifyAndHeal({ run, projectId: 'p1', runner, eventStore: es, llmTurn, env: { NODE_ENV: 'test' } });
  assert.deepEqual(out, { ran: true, clean: true, rounds: 2, fixes: 1 });
  assert.equal(runner.written.length, 1);
  const ends = es.events.filter((e) => e.type === 'action_end');
  assert.equal(ends[0].data.status, 'error'); // first tsc
  assert.equal(ends[ends.length - 1].data.status, 'done'); // final tsc
});

test('still dirty after all rounds: reports clean=false honestly', async () => {
  const es = fakeEventStore();
  const runner = baseRunner({
    execResults: [{ exitCode: 2, stdout: 'error TS1005', stderr: '' }],
    files: TS_FILES,
  });
  const out = await verifyLoop.autoVerifyAndHeal({
    run, projectId: 'p1', runner, eventStore: es, llmTurn: async () => ({ text: '', toolCalls: [] }), env: { NODE_ENV: 'test' },
  });
  assert.equal(out.clean, false);
  assert.equal(out.rounds, 2);
  const lastNarrative = es.events.filter((e) => e.type === 'narrative_delta').pop();
  assert.match(lastNarrative.data.text, /aún tiene errores/i);
});

test('fixer only gets the whitelisted repair tools', async () => {
  const seenTools = [];
  const runner = baseRunner({ execResults: [{ exitCode: 2, stdout: 'error', stderr: '' }, { exitCode: 0, stdout: '', stderr: '' }], files: TS_FILES });
  await verifyLoop.autoVerifyAndHeal({
    run,
    projectId: 'p1',
    runner,
    eventStore: fakeEventStore(),
    llmTurn: async ({ tools }) => { seenTools.push(tools.map((t) => t.name).sort()); return { text: 'ok', toolCalls: [] }; },
    env: { NODE_ENV: 'test' },
  });
  assert.deepEqual(seenTools[0], ['edit_file', 'install_dependencies', 'list_files', 'read_file', 'write_file']);
  for (const name of verifyLoop.FIX_TOOLS) assert.ok(TOOLS[name], name);
});

test('an llmTurn crash degrades to the honest re-check (never throws)', async () => {
  const runner = baseRunner({ execResults: [{ exitCode: 2, stdout: 'error', stderr: '' }], files: TS_FILES });
  const out = await verifyLoop.autoVerifyAndHeal({
    run, projectId: 'p1', runner, eventStore: fakeEventStore(), llmTurn: async () => { throw new Error('down'); }, env: { NODE_ENV: 'test' },
  });
  assert.equal(out.ran, true);
  assert.equal(out.clean, false);
});

test('a tsc runner crash is informational (clean=null), not a failure', async () => {
  const runner = baseRunner({ execResults: [], files: TS_FILES });
  runner.exec = async () => { throw new Error('runner unreachable'); };
  const out = await verifyLoop.autoVerifyAndHeal({
    run, projectId: 'p1', runner, eventStore: fakeEventStore(), llmTurn: async () => ({}), env: { NODE_ENV: 'test' },
  });
  assert.equal(out.ran, true);
  assert.equal(out.clean, null);
});

test('normalizeTsconfig strips bogus react types entries, keeps the rest', async () => {
  const { normalizeTsconfig } = require('../src/services/codex/verify-loop');
  let written = null;
  const runner = {
    readFile: async () => ({ content: JSON.stringify({ compilerOptions: { jsx: 'react-jsx', types: ['react', 'react-dom', 'vite/client'] } }) }),
    writeFiles: async (_p, files) => { written = files[0]; },
  };
  assert.equal(await normalizeTsconfig(runner, 'p1'), true);
  const cfg = JSON.parse(written.content);
  assert.deepEqual(cfg.compilerOptions.types, ['vite/client']);

  // Sin entradas bogus → no toca nada.
  let touched = false;
  const clean = {
    readFile: async () => ({ content: JSON.stringify({ compilerOptions: { types: ['vite/client'] } }) }),
    writeFiles: async () => { touched = true; },
  };
  assert.equal(await normalizeTsconfig(clean, 'p1'), false);
  assert.equal(touched, false);

  // types queda vacío → se elimina la clave.
  let written2 = null;
  const onlyBogus = {
    readFile: async () => ({ content: JSON.stringify({ compilerOptions: { types: ['react'] } }) }),
    writeFiles: async (_p, files) => { written2 = files[0]; },
  };
  assert.equal(await normalizeTsconfig(onlyBogus, 'p1'), true);
  assert.ok(!('types' in JSON.parse(written2.content).compilerOptions));

  // tsconfig roto → best-effort false, nunca lanza.
  const broken = { readFile: async () => ({ content: '{invalid json' }), writeFiles: async () => {} };
  assert.equal(await normalizeTsconfig(broken, 'p1'), false);
});
