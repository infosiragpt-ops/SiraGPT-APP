'use strict';

// ensureAppsVitePreviewable — when an APPS-mode build leaves a broken Next+Vite
// hybrid, the repair must (a) write the Vite fallback AND (b) purge the Next
// scaffold (app/, next.config.mjs, …) so the workspace is PURE Vite and the
// host-runner preview opens without an error overlay.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ensureAppsVitePreviewable } = require('../src/services/codex/agent-loop');

const APPS_PROMPT = 'MODO APPS TIPO CODEX:\n- ...\nSOLICITUD DEL USUARIO:\ncrea una landing de un gimnasio';

function fakeRunner(files) {
  const calls = { writeFiles: [], exec: [] };
  return {
    calls,
    readFile: async (_project, path) => ({ content: files[path] || '' }),
    writeFiles: async (_project, written) => { calls.writeFiles.push(written); },
    exec: async (_project, cmd) => { calls.exec.push(cmd); return { ok: true, output: '' }; },
  };
}

const eventStore = { appendEvent: async () => {} };
const prisma = {};

test('Next hybrid → repairs: writes Vite fallback AND purges the Next scaffold', async () => {
  const runner = fakeRunner({
    'package.json': JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '15.0.0', react: '18' } }),
    'index.html': '',
    'src/main.js': '',
  });
  const res = await ensureAppsVitePreviewable({
    run: { id: 'r1', projectId: 'p1', prompt: APPS_PROMPT },
    project: { id: 'p1', name: 'Gimnasio' },
    runner, eventStore, prisma,
  });
  assert.equal(res.repaired, true);
  assert.equal(runner.calls.writeFiles.length, 1, 'should write the Vite fallback');
  assert.equal(runner.calls.exec.length, 1, 'should purge the Next scaffold');
  const rm = runner.calls.exec[0];
  assert.match(rm, /rm -rf/);
  assert.match(rm, /\bapp\b/);
  assert.match(rm, /next\.config\.mjs/);
});

test('already-clean React+Vite+TS → no repair, no purge', async () => {
  const runner = fakeRunner({
    'package.json': JSON.stringify({ scripts: { dev: 'vite' }, dependencies: { react: '^18' }, devDependencies: { vite: '^7.0.0', '@vitejs/plugin-react': '^4' } }),
    'index.html': '<!doctype html><div id="root"></div><script type="module" src="/src/main.tsx"></script>',
    'src/App.tsx': 'export default function App(){ return <main>Cafetería real generada</main> }',
  });
  const res = await ensureAppsVitePreviewable({
    run: { id: 'r2', projectId: 'p2', prompt: APPS_PROMPT },
    project: { id: 'p2', name: 'Clean' },
    runner, eventStore, prisma,
  });
  assert.equal(res.repaired, false);
  assert.equal(runner.calls.writeFiles.length, 0);
  assert.equal(runner.calls.exec.length, 0);
});

test('non-APPS prompt → never touches the workspace', async () => {
  const runner = fakeRunner({ 'package.json': JSON.stringify({ scripts: { dev: 'next dev' } }) });
  const res = await ensureAppsVitePreviewable({
    run: { id: 'r3', projectId: 'p3', prompt: 'crea una landing' }, // no APPS marker
    project: { id: 'p3', name: 'X' },
    runner, eventStore, prisma,
  });
  assert.equal(res.repaired, false);
  assert.equal(runner.calls.writeFiles.length, 0);
  assert.equal(runner.calls.exec.length, 0);
});

test('explicit Next request → respected (no forced Vite normalization)', async () => {
  const runner = fakeRunner({
    'package.json': JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '15' } }),
  });
  const res = await ensureAppsVitePreviewable({
    run: { id: 'r4', projectId: 'p4', prompt: 'MODO APPS TIPO CODEX:\nSOLICITUD DEL USUARIO:\nhazme una app con Next.js' },
    project: { id: 'p4', name: 'NextApp' },
    runner, eventStore, prisma,
  });
  assert.equal(res.repaired, false);
  assert.equal(runner.calls.exec.length, 0);
});
