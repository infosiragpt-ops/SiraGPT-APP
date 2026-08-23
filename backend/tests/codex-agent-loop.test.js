'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  closeBuild,
  ensureAppsVitePreviewable,
  runAgentLoop,
  verifyWorkspace,
} = require('../src/services/codex/agent-loop');
const buildTools = require('../src/services/codex/build-tools');
const { buildPlanMessages } = require('../src/services/codex/plan-mode');

// Scripted llmTurn: shift the next response off a queue.
function scriptedLlm(turns) {
  const q = turns.slice();
  return async () => (q.length ? q.shift() : { text: 'fin', toolCalls: [] });
}

function fakeDeps(overrides = {}) {
  const events = [];
  const actions = [];
  const writes = [];
  const runner = {
    exec: async (_p, cmd) => {
      // Default: a CLEAN tree for `git status --porcelain` so the build close
      // creates no checkpoint (keeps these tests focused on the loop itself).
      if (cmd[0] === 'git' && cmd[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: `ran ${cmd.join(' ')}`, stderr: '' };
    },
    readFile: async (_p, path) => {
      if (path === '.sira/settings.json' || path === '.sira/hooks.json' || path === '.sira/notes.md' || path === 'SIRA.md') {
        throw new Error('file_not_found');
      }
      return { content: 'a\nb\nc' };
    },
    writeFiles: async (_p, files) => { writes.push(...files); return { ok: true }; },
  };
  let t = 0;
  const clock = () => new Date(1_000_000 + (t += 10));
  const eventStore = { appendEvent: async (runId, type, data) => { events.push({ type, data }); }, listEvents: async () => [] };
  const actionStore = { recordAction: async (a) => { actions.push(a); } };
  // CODEX_AUTO_VERIFY off by default: the verify-loop has its own suite
  // (codex-verify-loop.test.js); these tests stay focused on the loop itself.
  return { events, actions, writes, deps: { eventStore, actionStore, runner, clock, fileTree: '', env: { NODE_ENV: 'test', CODEX_AUTO_VERIFY: '0' }, plan: { architecture: 'x', pages: [], components: [], tasks: [] }, ...overrides } };
}

test('plan mode delegates and ends waiting_approval with plan_proposed', async () => {
  const f = fakeDeps({ llmTurn: scriptedLlm([{ text: JSON.stringify({ architecture: 'Vite', pages: ['/'], components: ['Nav'], tasks: [{ id: 't1', title: 'x' }] }) }]) });
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'plan', prompt: 'landing' }, project: { id: 'p1', name: 'X' }, deps: f.deps });
  assert.equal(res.status, 'waiting_approval');
  assert.equal(f.events[0].type, 'plan_proposed');
  assert.equal(f.writes.length, 0); // plan mode never mutates
});

test('plan mode forwards the selected model and normalized reasoning effort to the LLM', async () => {
  let captured = null;
  const f = fakeDeps({
    llmTurn: async (args) => {
      captured = args;
      return {
        text: JSON.stringify({
          architecture: 'Vite',
          pages: ['/'],
          components: ['Nav'],
          tasks: [{ id: 't1', title: 'x' }],
        }),
      };
    },
  });

  const res = await runAgentLoop({
    run: {
      id: 'r-plan-depth',
      mode: 'plan',
      prompt: 'landing',
      tier: 'power',
      model: 'claude-sonnet-4-5',
      reasoningEffort: 'max',
    },
    project: { id: 'p1', name: 'X' },
    deps: f.deps,
  });

  assert.equal(res.status, 'waiting_approval');
  assert.equal(captured.tier, 'power');
  assert.equal(captured.model, 'claude-sonnet-4-5');
  assert.equal(captured.effort, 'high');
  assert.deepEqual(captured.tools, []);
});

test('build loop runs grouped tool calls with one groupId, narrative, then done', async () => {
  const f = fakeDeps({
    llmTurn: scriptedLlm([
      { text: 'Voy a crear el index y revisar git.', toolCalls: [
        { name: 'read_file', args: { path: 'index.html' } },
        { name: 'write_file', args: { path: 'index.html', content: '<h1>hi</h1>' } },
        { name: 'run_command', args: { cmd: ['git', 'status'] } },
      ] },
      { text: 'Listo, el proyecto quedó construido.', toolCalls: [] },
    ]),
  });
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build', prompt: 'haz algo' }, project: { id: 'p1', name: 'X' }, deps: f.deps });
  assert.equal(res.status, 'done');
  assert.deepEqual(f.writes, [{ path: 'index.html', content: '<h1>hi</h1>' }]);

  const starts = f.events.filter((e) => e.type === 'action_start');
  assert.equal(starts.length, 3);
  assert.equal(starts[0].data.groupId, starts[1].data.groupId); // same burst → one group
  assert.equal(starts[0].data.kind, 'file_read');
  assert.equal(starts[1].data.kind, 'file_write');
  assert.equal(starts[2].data.kind, 'terminal');
  assert.equal(f.events.filter((e) => e.type === 'action_end').length, 3);
  assert.ok(f.events.some((e) => e.type === 'narrative_delta'));
  assert.equal(f.actions.length, 3); // all persisted as CodexAction
});

test('build prompt tells the model to edit the starter instead of scaffolding', async () => {
  let systemPrompt = '';
  const f = fakeDeps({
    llmTurn: async ({ messages }) => {
      systemPrompt = messages.find((m) => m.role === 'system')?.content || '';
      return { text: 'Listo.', toolCalls: [] };
    },
  });
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build', prompt: 'crea una landing' }, project: { id: 'p1', name: 'X' }, deps: f.deps });
  assert.equal(res.status, 'done');
  assert.match(systemPrompt, /starter REACT 18 \+ VITE 7/i);
  assert.match(systemPrompt, /NO inicialices frameworks/i);
  assert.match(systemPrompt, /write_file\/edit_file/i);
  assert.match(systemPrompt, /Nunca dependas de prompts interactivos/i);
});

test('apps build prompt overrides a non-explicit Next.js plan back to Vite', async () => {
  let systemPrompt = '';
  const f = fakeDeps({
    plan: { architecture: 'Next.js 14 + TypeScript', pages: ['/'], components: ['Hero'], tasks: [] },
    llmTurn: async ({ messages }) => {
      systemPrompt = messages.find((m) => m.role === 'system')?.content || '';
      return { text: 'Listo.', toolCalls: [] };
    },
  });
  const prompt = [
    'MODO APPS TIPO CODEX:',
    '- Construye y entrega preview.',
    '',
    'SOLICITUD DEL USUARIO:',
    'crea una web de venta de autos',
  ].join('\n');
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build', prompt }, project: { id: 'p1', name: 'Autos' }, deps: f.deps });
  assert.equal(res.status, 'done');
  assert.match(systemPrompt, /Stack OBLIGATORIO: React 18 \+ Vite 7/i);
  assert.match(systemPrompt, /PROHIBIDO Next\.js/i);
  assert.match(systemPrompt, /script dev="vite"/i);
  assert.match(systemPrompt, /sin backend propio/i);
  assert.doesNotMatch(systemPrompt, /starter FULL-STACK/i);
});

test('apps full-stack prompt preserves the Express SQLite concurrently contract', async () => {
  let systemPrompt = '';
  const f = fakeDeps({
    fileTree: 'index.html\npackage.json\nsrc/App.tsx\nvite.config.ts\n',
    plan: { architecture: 'React + Vite + Express + SQLite', pages: ['/'], components: ['Clientes'], tasks: [] },
    llmTurn: async ({ messages }) => {
      systemPrompt = messages.find((m) => m.role === 'system')?.content || '';
      return { text: 'Listo.', toolCalls: [] };
    },
  });
  const prompt = [
    'MODO APPS TIPO CODEX:',
    '- Construye y entrega preview.',
    '',
    'SOLICITUD DEL USUARIO:',
    'crea una app con backend, API y base de datos para gestionar clientes',
  ].join('\n');
  const res = await runAgentLoop({
    run: { id: 'r1', mode: 'build', prompt },
    project: { id: 'p1', name: 'Clientes' },
    deps: f.deps,
  });
  assert.equal(res.status, 'done');
  assert.match(systemPrompt, /starter FULL-STACK/i);
  assert.match(systemPrompt, /Express/i);
  assert.match(systemPrompt, /SQLite/i);
  assert.match(systemPrompt, /concurrently/i);
  assert.match(systemPrompt, /NO lo reduzcas a dev="vite"/i);
  assert.match(systemPrompt, /PLAYBOOK APLICABLE \(backend-real\)/i);
  assert.doesNotMatch(systemPrompt, /sin backend propio/i);
});

test('apps prompt recognizes server/app.js as an existing custom backend, not the Express starter', async () => {
  let systemPrompt = '';
  const f = fakeDeps({
    fileTree: 'index.html\npackage.json\nsrc/App.tsx\nserver/app.js\nvite.config.ts\n',
    llmTurn: async ({ messages }) => {
      systemPrompt = messages.find((message) => message.role === 'system')?.content || '';
      return { text: 'Listo.', toolCalls: [] };
    },
  });
  const prompt = [
    'MODO APPS TIPO CODEX:',
    '- Construye y entrega preview.',
    '',
    'SOLICITUD DEL USUARIO:',
    'cambia el texto del encabezado',
  ].join('\n');
  const res = await runAgentLoop({
    run: { id: 'r1', mode: 'build', prompt },
    project: { id: 'p1', name: 'Backend existente' },
    deps: f.deps,
  });
  assert.equal(res.status, 'done');
  assert.match(systemPrompt, /conserva exactamente el framework actual/i);
  assert.match(systemPrompt, /CJS\/ESM/i);
  assert.doesNotMatch(systemPrompt, /starter FULL-STACK/i);
  assert.doesNotMatch(systemPrompt, /PLAYBOOK APLICABLE \(backend-real\)/i);
});

test('apps build close repairs an incomplete Next.js workspace into a Vite preview', async () => {
  const writes = [];
  const files = new Map([
    ['package.json', JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '^16.0.0' } })],
    ['index.html', '<h1><span class="dot"></span>Workspace listo</h1><script type="module" src="/src/main.js"></script>'],
    ['src/main.js', 'console.log("codex workspace ready");\n'],
  ]);
  const f = fakeDeps({
    runner: {
      exec: async (_p, cmd) => {
        if (cmd[0] === 'git' && cmd[1] === 'status') return { exitCode: 0, stdout: ' M package.json\n M index.html\n M src/main.js\n', stderr: '' };
        if (cmd[0] === 'git' && cmd[1] === 'add') return { exitCode: 0, stdout: '', stderr: '' };
        if (cmd[0] === 'git' && cmd.includes('commit')) return { exitCode: 0, stdout: '[main abc] ok\n', stderr: '' };
        if (cmd[0] === 'git' && cmd[1] === 'rev-parse') return { exitCode: 0, stdout: 'abcdef1234567890\n', stderr: '' };
        if (cmd[0] === 'git' && cmd[1] === 'diff') return { exitCode: 0, stdout: '', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      readFile: async (_p, path) => ({ content: files.get(path) || '' }),
      writeFiles: async (_p, nextFiles) => {
        writes.push(...nextFiles);
        for (const file of nextFiles) files.set(file.path, file.content);
        return { ok: true };
      },
    },
    llmTurn: scriptedLlm([
      { text: 'Ya esta listo.', toolCalls: [] },
    ]),
    prisma: {
      codexRun: { findUnique: async ({ where }) => (where.id === 'plan1' ? { prompt } : null) },
      user: { findUnique: async () => ({ plan: 'PRO' }) },
      codexCheckpoint: { create: async () => ({ id: 'cp1', commitSha: 'abcdef1234567890', createdAt: new Date() }) },
      codexRunMetric: { upsert: async () => ({}) },
    },
  });
  const prompt = [
    'MODO APPS TIPO CODEX:',
    '- Construye y entrega preview.',
    '',
    'SOLICITUD DEL USUARIO:',
    'crea una web de venta de autos',
  ].join('\n');
  const res = await runAgentLoop({
    run: { id: 'r1', userId: 'u1', mode: 'build', prompt: null, planRunId: 'plan1' },
    project: { id: 'p1', name: 'Autos' },
    deps: f.deps,
  });
  assert.equal(res.status, 'done');
  const packageWrite = writes.find((w) => w.path === 'package.json');
  assert.ok(packageWrite);
  assert.match(packageWrite.content, /"vite"/);
  assert.doesNotMatch(packageWrite.content, /"next"/);
  const indexWrite = writes.find((w) => w.path === 'index.html');
  assert.match(indexWrite.content, /venta de autos/i);
  assert.ok(f.events.some((e) => e.type === 'narrative_delta' && /Normalicé el workspace de APPS/.test(e.data.text)));
});

test('apps build close detects an existing full-stack workspace and preserves API and SQLite schema', async () => {
  const writes = [];
  const customServer = `import express from 'express'\nconst app = express()\napp.get('/api/customers', (_req, res) => res.json([{ id: 7 }]))\napp.listen(3001)\n`;
  const customDb = `import { DatabaseSync } from 'node:sqlite'\nexport const db = new DatabaseSync('server/customers.db')\ndb.exec('CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')\n`;
  const customApp = `export default function App() { return <main>Clientes reales</main> }\n`;
  const files = new Map([
    ['package.json', JSON.stringify({
      name: 'customers-app',
      scripts: { dev: 'next dev', seed: 'node server/seed.js' },
      dependencies: { next: '^16.0.0', express: '^4.21.0', zod: '^3.24.0' },
    })],
    ['index.html', '<div id="root"></div>'],
    ['src/App.tsx', customApp],
    ['vite.config.ts', 'export default {}\n'],
    ['server/index.js', customServer],
    ['server/db.js', customDb],
  ]);
  const prompt = [
    'MODO APPS TIPO CODEX:',
    '- Construye y entrega preview.',
    '',
    'SOLICITUD DEL USUARIO:',
    'cambia el color del botón principal y deja el preview funcionando',
  ].join('\n');
  const f = fakeDeps({
    runner: {
      exec: async (_p, cmd) => {
        if (cmd[0] === 'git' && cmd[1] === 'status') return { exitCode: 0, stdout: ' M package.json\n M index.html\n', stderr: '' };
        if (cmd[0] === 'git' && cmd[1] === 'add') return { exitCode: 0, stdout: '', stderr: '' };
        if (cmd[0] === 'git' && cmd.includes('commit')) return { exitCode: 0, stdout: '[main abc] ok\n', stderr: '' };
        if (cmd[0] === 'git' && cmd[1] === 'rev-parse') return { exitCode: 0, stdout: 'abcdef1234567890\n', stderr: '' };
        if (cmd[0] === 'git' && cmd[1] === 'diff') return { exitCode: 0, stdout: '', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      readFile: async (_p, path) => ({ content: files.get(path) || '' }),
      writeFiles: async (_p, nextFiles) => {
        writes.push(...nextFiles);
        for (const file of nextFiles) files.set(file.path, file.content);
        return { ok: true };
      },
    },
    llmTurn: scriptedLlm([{ text: 'Ya está listo.', toolCalls: [] }]),
    prisma: {
      user: { findUnique: async () => ({ plan: 'PRO' }) },
      codexCheckpoint: { create: async () => ({ id: 'cp1', commitSha: 'abcdef1234567890', createdAt: new Date() }) },
      codexRunMetric: { upsert: async () => ({}) },
    },
  });
  const res = await runAgentLoop({
    run: { id: 'r1', userId: 'u1', mode: 'build', prompt },
    project: { id: 'p1', name: 'Clientes' },
    deps: f.deps,
  });
  assert.equal(res.status, 'done');

  const packageWrite = writes.find((file) => file.path === 'package.json');
  assert.ok(packageWrite);
  const repairedPackage = JSON.parse(packageWrite.content);
  assert.match(repairedPackage.scripts.dev, /concurrently/i);
  assert.match(repairedPackage.scripts['dev:api'], /server\/index\.js/i);
  assert.match(repairedPackage.scripts['dev:web'], /vite/i);
  assert.ok(repairedPackage.dependencies.express);
  assert.ok(repairedPackage.dependencies.zod, 'custom dependencies are preserved');
  assert.equal(repairedPackage.dependencies.next, undefined);

  assert.equal(writes.some((file) => file.path === 'server/index.js'), false);
  assert.equal(writes.some((file) => file.path === 'server/db.js'), false);
  assert.equal(writes.some((file) => file.path === 'src/App.tsx'), false);
  assert.equal(files.get('server/index.js'), customServer);
  assert.equal(files.get('server/db.js'), customDb);
  assert.equal(files.get('src/App.tsx'), customApp);
  assert.match(files.get('vite.config.ts'), /proxy/i);
  assert.ok(f.events.some((event) => event.type === 'narrative_delta' && /full-stack/i.test(event.data.text)));
});

test('apps repair preserves an imported CommonJS Express server/app.js contract', async () => {
  const writes = [];
  const originalServer = [
    "const express = require('express')",
    'const app = express()',
    "app.get('/api/health', (_req, res) => res.json({ ok: true }))",
    'app.listen(3001)',
    '',
  ].join('\n');
  const originalPackage = `${JSON.stringify({
    name: 'express-commonjs-app',
    private: true,
    type: 'commonjs',
    scripts: {
      dev: 'vite',
      start: 'node server/app.js',
      test: 'node --test',
    },
    dependencies: {
      express: '^4.21.0',
      react: '^18.3.1',
      'react-dom': '^18.3.1',
    },
    devDependencies: { vite: '^7.0.0', '@vitejs/plugin-react': '^4.5.2' },
  }, null, 2)}\n`;
  const files = new Map([
    ['package.json', originalPackage],
    ['index.html', '<div id="root"></div><script type="module" src="/src/main.tsx"></script>'],
    ['src/App.tsx', 'export default function App() { return <main>Express CJS</main> }\n'],
    ['vite.config.ts', "export default { server: { proxy: { '/api': 'http://localhost:3001' } } }\n"],
    ['server/app.js', originalServer],
  ]);
  const runner = {
    readFile: async (_projectId, path) => ({ content: files.get(path) || '' }),
    writeFiles: async (_projectId, nextFiles) => {
      writes.push(...nextFiles);
      for (const file of nextFiles) files.set(file.path, file.content);
      return { ok: true };
    },
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  };
  const events = [];
  const prompt = [
    'MODO APPS TIPO CODEX:',
    '- Construye y entrega preview.',
    '',
    'SOLICITUD DEL USUARIO:',
    'ajusta la pantalla principal y conserva la API existente',
  ].join('\n');

  const result = await ensureAppsVitePreviewable({
    run: { id: 'run-express-cjs', projectId: 'p1', prompt },
    project: { id: 'p1', name: 'Express CJS' },
    runner,
    eventStore: { appendEvent: async (_runId, type, data) => events.push({ type, data }) },
    prisma: null,
  });

  assert.equal(result.repaired, true);
  assert.equal(result.fullStack, true);
  const packageWrite = writes.find((file) => file.path === 'package.json');
  assert.ok(packageWrite);
  const repairedPackage = JSON.parse(packageWrite.content);
  assert.equal(repairedPackage.type, 'commonjs');
  assert.equal(repairedPackage.scripts.start, 'node server/app.js');
  assert.equal(repairedPackage.scripts.test, 'node --test');
  assert.match(repairedPackage.scripts.dev, /concurrently/i);
  assert.equal(repairedPackage.scripts['dev:api'], 'node server/app.js');
  assert.equal(repairedPackage.scripts['dev:web'], 'vite');
  assert.equal(writes.some((file) => file.path.startsWith('server/')), false);
  assert.equal(files.get('server/app.js'), originalServer);
  assert.ok(events.some((event) => /backend express/i.test(event.data.text)));
});

for (const fixture of [
  {
    name: 'Koa',
    dependency: 'koa',
    version: '^2.15.0',
    server: "const Koa = require('koa')\nconst app = new Koa()\napp.use((ctx) => { ctx.body = { ok: true } })\napp.listen(3001)\n",
  },
  {
    name: 'Fastify',
    dependency: 'fastify',
    version: '^5.2.0',
    server: "const fastify = require('fastify')()\nfastify.get('/api/health', async () => ({ ok: true }))\nfastify.listen({ port: 3001 })\n",
  },
]) {
  test(`apps repair preserves a valid CommonJS ${fixture.name} server/app.js contract`, async () => {
    const writes = [];
    const scripts = {
      dev: 'concurrently "npm run dev:api" "npm run dev:web"',
      'dev:api': 'node server/app.js',
      'dev:web': 'vite',
      build: 'vite build',
      start: 'node server/app.js',
    };
    const originalPackage = `${JSON.stringify({
      name: `${fixture.name.toLowerCase()}-app`,
      private: true,
      type: 'commonjs',
      scripts,
      dependencies: {
        [fixture.dependency]: fixture.version,
        react: '^18.3.1',
        'react-dom': '^18.3.1',
        concurrently: '^9.1.0',
      },
      devDependencies: { vite: '^7.0.0', '@vitejs/plugin-react': '^4.5.2' },
    }, null, 2)}\n`;
    const files = new Map([
      ['package.json', originalPackage],
      ['index.html', '<div id="root"></div>'],
      ['src/App.tsx', `export default function App() { return <main>${fixture.name}</main> }\n`],
      ['vite.config.ts', "export default { server: { proxy: { '/api': 'http://localhost:3001' } } }\n"],
      ['server/app.js', fixture.server],
    ]);
    const runner = {
      readFile: async (_projectId, path) => ({ content: files.get(path) || '' }),
      writeFiles: async (_projectId, nextFiles) => {
        writes.push(...nextFiles);
        for (const file of nextFiles) files.set(file.path, file.content);
        return { ok: true };
      },
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const events = [];
    const prompt = [
      'MODO APPS TIPO CODEX:',
      '- Construye y entrega preview.',
      '',
      'SOLICITUD DEL USUARIO:',
      'ajusta el texto de la pantalla principal',
    ].join('\n');
    const result = await ensureAppsVitePreviewable({
      run: { id: `run-${fixture.name}`, projectId: 'p1', prompt },
      project: { id: 'p1', name: fixture.name },
      runner,
      eventStore: { appendEvent: async (_runId, type, data) => events.push({ type, data }) },
      prisma: null,
    });

    assert.equal(result.repaired, true);
    assert.equal(result.fullStack, true);
    assert.ok(writes.some((file) => file.path === 'index.html'));
    assert.ok(writes.some((file) => file.path === 'src/main.tsx'));
    assert.equal(writes.some((file) => file.path === 'package.json'), false);
    assert.equal(writes.some((file) => file.path.startsWith('server/')), false);
    assert.equal(writes.some((file) => file.path === 'vite.config.ts'), false);
    assert.equal(files.get('package.json'), originalPackage);
    const preserved = JSON.parse(files.get('package.json'));
    assert.equal(preserved.type, 'commonjs');
    assert.deepEqual(preserved.scripts, scripts);
    assert.ok(preserved.dependencies[fixture.dependency]);
    assert.equal(preserved.dependencies.express, undefined);
    assert.equal(files.get('server/app.js'), fixture.server);
    assert.ok(events.some((event) => new RegExp(`backend ${fixture.name}`, 'i').test(event.data.text)));
  });
}

test('apps planning prompt defaults simple apps to Vite index.html', () => {
  const prompt = [
    'MODO APPS TIPO CODEX:',
    '- Construye y entrega preview.',
    '',
    'SOLICITUD DEL USUARIO:',
    'crea una web de venta de autos',
  ].join('\n');
  const { system } = buildPlanMessages({ project: { name: 'Autos' }, prompt });
  assert.match(system, /React 18 \+ Vite 7/i);
  assert.match(system, /src\/main\.tsx/i);
  assert.match(system, /PROHIBIDO Next\.js/i);
});

test('update_plan emits a plan_updated event (not an action) and feeds progress back to the model', async () => {
  const f = fakeDeps({
    plan: { architecture: 'Vite', pages: ['/'], components: ['Nav'], tasks: [{ id: 't1', title: 'Estructura', status: 'pending' }, { id: 't2', title: 'Estilos', status: 'pending' }] },
    llmTurn: scriptedLlm([
      { text: 'Marco la primera tarea en curso.', toolCalls: [
        { name: 'update_plan', args: { tasks: [{ id: 't1', title: 'Estructura', status: 'in_progress' }, { id: 't2', title: 'Estilos', status: 'pending' }] } },
      ] },
      { text: 'Ya la terminé, marco completed.', toolCalls: [
        { name: 'update_plan', args: { tasks: [{ id: 't1', title: 'Estructura', status: 'completed' }, { id: 't2', title: 'Estilos', status: 'pending' }] } },
      ] },
      { text: 'Listo.', toolCalls: [] },
    ]),
  });
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build', prompt: 'haz algo' }, project: { id: 'p1', name: 'X' }, deps: f.deps });
  assert.equal(res.status, 'done');

  const planUpdates = f.events.filter((e) => e.type === 'plan_updated');
  assert.equal(planUpdates.length, 2);
  assert.equal(planUpdates[0].data.tasks[0].status, 'in_progress');
  assert.equal(planUpdates[1].data.tasks[0].status, 'completed');
  // update_plan is plan progress, not a workspace action: it must NOT create
  // action_start/action_end (or a CodexAction row).
  assert.equal(f.events.some((e) => e.type === 'action_start' && e.data.command === 'update plan'), false);
  assert.equal(f.actions.length, 0);
});

test('the system prompt instructs the agent to keep the plan up to date with update_plan', async () => {
  let systemPrompt = '';
  const f = fakeDeps({
    plan: { architecture: 'Vite', pages: ['/'], components: [], tasks: [{ id: 't1', title: 'X', status: 'pending' }] },
    llmTurn: async ({ messages }) => {
      systemPrompt = messages.find((m) => m.role === 'system')?.content || '';
      return { text: 'Listo.', toolCalls: [] };
    },
  });
  await runAgentLoop({ run: { id: 'r1', mode: 'build', prompt: 'algo' }, project: { id: 'p1', name: 'X' }, deps: f.deps });
  assert.match(systemPrompt, /update_plan/i);
  assert.match(systemPrompt, /in_progress/);
  assert.match(systemPrompt, /completed/);
});

test('a tool error does NOT abort the loop; the error is fed back to the model', async () => {
  const f = fakeDeps({
    runner: {
      exec: async () => ({ exitCode: 1, stdout: '', stderr: 'fatal: not a git repo' }),
      readFile: async () => ({ content: '' }),
      writeFiles: async () => ({}),
    },
    llmTurn: scriptedLlm([
      { text: 'Reviso el estado.', toolCalls: [{ name: 'run_command', args: { cmd: ['git', 'status'] } }] },
      { text: 'Entiendo, continúo.', toolCalls: [] },
    ]),
  });
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build' }, project: { id: 'p1' }, deps: f.deps });
  assert.equal(res.status, 'done');
  const end = f.events.find((e) => e.type === 'action_end');
  assert.equal(end.data.status, 'error'); // recorded as error, loop kept going
});

test('cancellation between steps returns cancelled', async () => {
  const f = fakeDeps({ llmTurn: scriptedLlm([{ text: 'paso 1', toolCalls: [{ name: 'run_command', args: { cmd: ['ls'] } }] }]) });
  let calls = 0;
  const isCancelled = async () => (++calls >= 2); // cancelled before the 2nd step
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build' }, project: { id: 'p1' }, isCancelled, deps: f.deps });
  assert.equal(res.status, 'cancelled');
});

test('step budget exhaustion closes as done with an honest closing narrative', async () => {
  // Always returns a tool call → never naturally stops → hits CODEX_MAX_STEPS.
  const f = fakeDeps({
    llmTurn: async () => ({ text: 'sigo', toolCalls: [{ name: 'run_command', args: { cmd: ['ls'] } }] }),
    env: { NODE_ENV: 'test', CODEX_MAX_STEPS: '3', CODEX_AUTO_VERIFY: '0' },
  });
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build' }, project: { id: 'p1' }, deps: f.deps });
  assert.equal(res.status, 'done');
  const lastNarr = f.events.filter((e) => e.type === 'narrative_delta').at(-1);
  assert.match(lastNarr.data.text, /límite de pasos/i);
});

test('a truncated turn (cut-off write) nudges a retry instead of closing the build', async () => {
  // First turn: model overran its budget mid-write → zero parsed calls but
  // truncated:true. The loop must NOT treat that as "done"; it feeds back a
  // split-the-write nudge and the model then writes the file successfully.
  let sawNudge = false;
  const f = fakeDeps({
    llmTurn: scriptedLlm([
      { text: 'Escribo el componente.', toolCalls: [], truncated: true },
      { text: 'Lo divido en partes.', toolCalls: [
        { name: 'read_file', args: { path: 'src/App.tsx' } },
        { name: 'write_file', args: { path: 'src/App.tsx', content: '<App/>' } },
      ] },
      { text: 'Listo.', toolCalls: [] },
    ]),
  });
  // Wrap the scripted llmTurn to observe the nudge that reaches the model.
  const inner = f.deps.llmTurn;
  f.deps.llmTurn = async (a) => {
    if ((a.messages || []).some((m) => typeof m.content === 'string' && m.content.includes('[TRUNCADO]'))) sawNudge = true;
    return inner(a);
  };
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build' }, project: { id: 'p1', name: 'X' }, deps: f.deps });
  assert.equal(res.status, 'done');
  assert.equal(sawNudge, true);
  assert.deepEqual(f.writes, [{ path: 'src/App.tsx', content: '<App/>' }]); // the file DID get written
});

test('a chronically truncating model still terminates (bounded truncation retries)', async () => {
  // Every turn truncates → without a bound this would spin until the step
  // budget. The retry cap kicks in and the build closes as done (honest).
  const f = fakeDeps({
    llmTurn: async () => ({ text: 'sigo', toolCalls: [], truncated: true }),
    env: { NODE_ENV: 'test', CODEX_MAX_STEPS: '12', CODEX_AUTO_VERIFY: '0' },
  });
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build' }, project: { id: 'p1' }, deps: f.deps });
  assert.equal(res.status, 'done');
  // At most MAX_TRUNCATION_RETRIES (3) nudges were emitted to the model.
  const nudges = f.events.filter((e) => e.type === 'narrative_delta'); // closing narrative present
  assert.ok(nudges.length >= 1);
});

test('LLM transport error in build → run error', async () => {
  const f = fakeDeps({ llmTurn: async () => { throw new Error('402 Insufficient credits'); } });
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build' }, project: { id: 'p1' }, deps: f.deps });
  assert.equal(res.status, 'error');
  assert.match(res.error, /402/);
});

test('runtime daily budget stops after the LLM response and before its tool calls execute', async () => {
  let llmCalls = 0;
  let aggregateCalls = 0;
  const prisma = {
    codexRunMetric: {
      aggregate: async () => {
        aggregateCalls += 1;
        return { _sum: { costAppliedUsd: 0.6 } };
      },
    },
    codexUsageEntry: {
      findMany: async () => [],
    },
  };
  const f = fakeDeps({
    prisma,
    env: {
      NODE_ENV: 'production',
      CODEX_AUTO_VERIFY: '0',
      CODEX_AUTO_MEMORY: '0',
      CODEX_CONTEXT_SUMMARY: '0',
      CODEX_RUN_BRANCHES: '0',
    },
    llmTurn: async () => {
      llmCalls += 1;
      const first = llmCalls === 1;
      return {
        text: first ? 'Primero inspecciono.' : 'Ahora voy a escribir.',
        usage: {
          provider: 'openai',
          model: 'gpt-test',
          tokensIn: 100,
          tokensOut: 50,
          costUsd: first ? 0.2 : 0.25,
        },
        toolCalls: first
          ? [{ name: 'read_file', args: { path: 'src/App.tsx' } }]
          : [{ name: 'write_file', args: { path: 'src/App.tsx', content: '<App />' } }],
      };
    },
  });

  const res = await runAgentLoop({
    run: { id: 'r-budget', userId: 'u-free', mode: 'build', prompt: 'crea una app' },
    project: {
      id: 'p1',
      name: 'X',
      brief: { settings: { budget: { dailyUsd: 1 } } },
    },
    deps: f.deps,
  });

  assert.equal(res.status, 'error');
  assert.match(res.error, /daily budget exceeded during run/i);
  assert.equal(llmCalls, 2);
  assert.equal(aggregateCalls, 5, 'proyecto y empresa se validan antes y durante la corrida');
  assert.deepEqual(f.writes, [], 'la segunda respuesta, que cruza el límite acumulado, no puede escribir');
  const runtimeStatuses = f.events.filter((event) => (
    event.type === 'budget_status' && event.data.scope !== 'company'
  ));
  assert.equal(runtimeStatuses.at(-2).data.allowed, true);
  assert.equal(runtimeStatuses.at(-2).data.inRunCostUsd, 0.2);
  const runtimeStatus = runtimeStatuses.at(-1);
  assert.equal(runtimeStatus.data.allowed, false);
  assert.equal(runtimeStatus.data.inRunCostUsd, 0.45);
  assert.equal(runtimeStatus.data.costTodayUsd, 1.05);
});

test('runtime company budget stops before tools even when the project budget remains available', async () => {
  const prisma = {
    codexRunMetric: {
      aggregate: async () => ({ _sum: { costAppliedUsd: 0.6 } }),
    },
    codexUsageEntry: {
      findMany: async () => [],
    },
  };
  const f = fakeDeps({
    prisma,
    env: {
      NODE_ENV: 'production',
      CODEX_AUTO_VERIFY: '0',
      CODEX_AUTO_MEMORY: '0',
      CODEX_CONTEXT_SUMMARY: '0',
      CODEX_RUN_BRANCHES: '0',
    },
    llmTurn: async () => ({
      text: 'Voy a escribir.',
      usage: {
        provider: 'openai',
        model: 'gpt-test',
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.45,
      },
      toolCalls: [{ name: 'write_file', args: { path: 'src/App.tsx', content: '<App />' } }],
    }),
  });

  const res = await runAgentLoop({
    run: { id: 'r-company-budget', userId: 'u-free', mode: 'build', prompt: 'crea una app' },
    project: {
      id: 'p1',
      name: 'X',
      brief: {
        settings: { budget: { dailyUsd: 10 } },
        proactive: { configuredDailyBudgetUsd: 1 },
      },
    },
    deps: f.deps,
  });

  assert.equal(res.status, 'error');
  assert.match(res.error, /company daily budget exceeded during run/i);
  assert.deepEqual(f.writes, []);
  const companyStatuses = f.events.filter((event) => (
    event.type === 'budget_status' && event.data.scope === 'company'
  ));
  assert.equal(companyStatuses.at(-1).data.allowed, false);
  assert.equal(companyStatuses.at(-1).data.inRunCostUsd, 0.45);
  assert.equal(companyStatuses.at(-1).data.costTodayUsd, 1.05);
});

test('a pooled run stops at its own reservation before executing proposed tools', async () => {
  const metricQueries = [];
  const prisma = {
    codexRunMetric: {
      findMany: async (query) => {
        metricQueries.push(query);
        return [];
      },
    },
    codexDepartmentPool: {
      findUnique: async () => ({
        id: 'pool-trust',
        projectId: 'p1',
        enabled: true,
        dailyBudgetUsd: 5,
      }),
    },
    codexSwarmTask: {
      findUnique: async () => ({
        id: 'task-qa',
        input: {
          departmentPoolId: 'pool-trust',
          poolBudgetReservationUsd: 0.5,
        },
      }),
      findMany: async () => [],
    },
    codexUsageEntry: {
      findMany: async () => [],
    },
  };
  const f = fakeDeps({
    prisma,
    llmTurn: async () => ({
      text: 'Voy a escribir.',
      usage: {
        provider: 'openai',
        model: 'gpt-test',
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.6,
      },
      toolCalls: [{ name: 'write_file', args: { path: 'src/App.tsx', content: '<App />' } }],
    }),
  });
  const res = await runAgentLoop({
    run: {
      id: 'r-pooled',
      userId: 'u1',
      mode: 'build',
      prompt: 'revisa la aplicación',
      departmentPoolId: 'pool-trust',
      swarmTaskId: 'task-qa',
    },
    project: { id: 'p1', name: 'X' },
    deps: f.deps,
  });

  assert.equal(res.status, 'error');
  assert.match(res.error, /department pool budget runtime check failed/i);
  assert.deepEqual(f.writes, []);
  assert.ok(metricQueries.every((query) => query.where.run.departmentPoolId === 'pool-trust'));
  const poolStatuses = f.events.filter((event) => (
    event.type === 'budget_status' && event.data.scope === 'department_pool'
  ));
  assert.equal(poolStatuses.at(-1).data.reason, 'department_pool_run_reservation_exceeded');
});

test('a blocking LLM error (402) emits action_required before the run errors', async () => {
  const f = fakeDeps({ llmTurn: async () => { throw new Error('OpenRouter 402 Insufficient credits'); } });
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build' }, project: { id: 'p1' }, deps: f.deps });
  assert.equal(res.status, 'error');
  const ar = f.events.find((e) => e.type === 'action_required');
  assert.ok(ar);
  assert.equal(ar.data.patternId, 'openrouter_402');
  assert.equal(ar.data.remediationUrl, 'https://openrouter.ai/credits');
});

test('a blocking tool error (runner down) ends the run with action_required', async () => {
  const f = fakeDeps({
    runner: {
      exec: async (_p, cmd) => {
        if (cmd[0] === 'git' && cmd[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
        throw new Error('runner unreachable: ECONNREFUSED 127.0.0.1:4097');
      },
      readFile: async () => ({ content: '' }),
      writeFiles: async () => ({}),
    },
    llmTurn: scriptedLlm([{ text: 'Compilo.', toolCalls: [{ name: 'run_command', args: { cmd: ['bun', 'run', 'build'] } }] }]),
  });
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build' }, project: { id: 'p1' }, deps: f.deps });
  assert.equal(res.status, 'error');
  assert.equal(f.events.find((e) => e.type === 'action_required').data.patternId, 'provision_failed');
});

test('a benign tool error is annotated as a diagnostic and the loop continues', async () => {
  const f = fakeDeps({
    runner: {
      exec: async (_p, cmd) => {
        if (cmd[0] === 'git' && cmd[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
        return { exitCode: 1, stdout: 'npm WARN deprecated foo@1.0.0: upgrade', stderr: '' };
      },
      readFile: async () => ({ content: '' }),
      writeFiles: async () => ({}),
    },
    llmTurn: scriptedLlm([
      { text: 'Instalo.', toolCalls: [{ name: 'run_command', args: { cmd: ['bun', 'install'] } }] },
      { text: 'Listo.', toolCalls: [] },
    ]),
  });
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build' }, project: { id: 'p1' }, deps: f.deps });
  assert.equal(res.status, 'done'); // benign → loop continued
  assert.equal(f.events.some((e) => e.type === 'action_required'), false);
  const end = f.events.find((e) => e.type === 'action_end' && e.data.status === 'error');
  assert.match(end.data.outputSummary, /\[diagnóstico\]/);
});

test('build close creates a checkpoint when the workspace has changes', async () => {
  const checkpoints = [];
  const f = fakeDeps({
    // git status reports a change → checkpoint is committed at close.
    runner: {
      exec: async (_p, cmd) => {
        if (cmd[0] === 'git' && cmd[1] === 'status') return { exitCode: 0, stdout: ' M index.html', stderr: '' };
        if (cmd[0] === 'git' && cmd[1] === 'rev-parse') return { exitCode: 0, stdout: 'abc1234\n', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      readFile: async () => ({ content: '' }),
      writeFiles: async () => ({}),
    },
    prisma: { codexCheckpoint: { create: async ({ data }) => { const r = { id: 'cp-1', createdAt: new Date(), ...data }; checkpoints.push(r); return r; } } },
    llmTurn: scriptedLlm([{ text: 'Construido.', toolCalls: [] }]),
  });
  const res = await runAgentLoop({ run: { id: 'run-1', mode: 'build' }, project: { id: 'p1', name: 'X' }, deps: f.deps });
  assert.equal(res.status, 'done');
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].commitSha, 'abc1234');
  assert.ok(f.events.some((e) => e.type === 'checkpoint_created'));
});

test('strict proactive gate fails closed when runtime evidence is unavailable', async () => {
  const events = [];
  const result = await verifyWorkspace({
    runner: {
      readFile: async (_project, path) => ({
        content: path === 'tsconfig.json'
          ? '{"compilerOptions":{"jsx":"react-jsx"}}'
          : '{"scripts":{}}',
      }),
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    },
    projectId: 'p1',
    run: { id: 'run-strict' },
    eventStore: { appendEvent: async (_runId, type, data) => { events.push({ type, data }); } },
    prisma: null,
    clock: () => new Date(),
    env: { NODE_ENV: 'test' },
    actionId: 'quality-1',
    groupId: 'quality',
    strict: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'infra');
  assert.equal(result.gates.typeCheck.ok, true);
  assert.equal(result.gates.devServer.ok, false);
});

test('QA gate requires an executable smoke-test contract', async () => {
  const result = await verifyWorkspace({
    runner: {
      readFile: async (_project, path) => ({
        content: path === 'tsconfig.json'
          ? '{"compilerOptions":{"jsx":"react-jsx"}}'
          : '{"scripts":{}}',
      }),
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    },
    projectId: 'p1',
    run: { id: 'run-qa' },
    eventStore: { appendEvent: async () => {} },
    prisma: null,
    clock: () => new Date(),
    env: { NODE_ENV: 'test' },
    actionId: 'quality-1',
    groupId: 'quality',
    strict: true,
    requireSmoke: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'smoke');
  assert.match(result.errors, /exige smoke tests/i);
});

test('failed proactive gate records the ledger and refuses to checkpoint', async () => {
  const commands = [];
  const events = [];
  const projectState = {
    id: 'p1',
    userId: 'u1',
    brief: { proactive: { enabled: true } },
  };
  const prompt = [
    '[PROACTIVO · Producto] Gate estricto: corrige la app',
    '[SIRA_PROACTIVE_META]{"department":"Producto","departmentId":"product-engineering","title":"Gate estricto","acceptanceCriteria":["La app abre"],"objectiveIds":[],"qaCycle":false}',
  ].join('\n');
  const result = await closeBuild({
    run: { id: 'run-gate', projectId: 'p1', userId: 'u1', prompt },
    project: projectState,
    runner: {
      readFile: async (_project, path) => {
        if (path === 'tsconfig.json') return { content: '{"compilerOptions":{"jsx":"react-jsx"}}' };
        if (path === 'package.json') return { content: '{"scripts":{}}' };
        throw new Error('not found');
      },
      exec: async (_project, cmd) => {
        commands.push(cmd);
        if (cmd[0] === 'git' && cmd[1] === 'status') return { exitCode: 0, stdout: ' M src/App.tsx\n', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      writeFiles: async () => {},
    },
    eventStore: { appendEvent: async (_runId, type, data) => { events.push({ type, data }); } },
    prisma: {
      codexProject: {
        findUnique: async () => projectState,
        update: async ({ data }) => {
          Object.assign(projectState, data);
          return projectState;
        },
      },
      user: { findUnique: async () => ({ plan: 'FREE' }) },
    },
    llmTurn: async () => ({ text: 'No pude reparar.', toolCalls: [] }),
    clock: () => new Date('2026-07-26T12:00:00.000Z'),
    env: { NODE_ENV: 'test', CODEX_AUTO_VERIFY: '0', CODEX_PROACTIVE_REPAIR_ROUNDS: '1' },
    metrics: { recordAction: () => {}, recordLlmUsage: () => {}, finalize: async () => ({ costAppliedUsd: 0.02 }) },
    sourcePrompt: prompt,
  });
  assert.equal(result.ok, false);
  assert.equal(result.checkpoint, null);
  assert.equal(projectState.brief.ledger[0].outcome, 'failed');
  assert.equal(commands.some((cmd) => cmd[0] === 'git' && cmd.includes('commit')), false);
  assert.ok(events.some((event) => event.type === 'narrative_delta' && /No cerré ni promoví/.test(event.data.text)));
});

test('the authoritative runtime gate runs after the last proactive debugger repair', async () => {
  const events = [];
  let repaired = false;
  let checkpointCalls = 0;
  const projectState = {
    id: 'p1',
    userId: 'u1',
    brief: { proactive: { enabled: true } },
  };
  const prompt = [
    '[PROACTIVO · Producto] Repara el runtime',
    '[SIRA_PROACTIVE_META]{"department":"Producto","departmentId":"product-engineering","title":"Repara runtime","acceptanceCriteria":["La app abre"],"objectiveIds":[],"qaCycle":false}',
  ].join('\n');
  const files = new Map([
    ['package.json', '{"scripts":{}}'],
    ['tsconfig.json', '{"compilerOptions":{"jsx":"react-jsx"}}'],
    ['src/App.tsx', 'export default function App(){ return <main>Lista</main> }\n'],
  ]);
  const runner = {
    readFile: async (_project, path) => {
      if (!files.has(path)) throw new Error(`no existe ${path}`);
      return { content: files.get(path) };
    },
    writeFiles: async (_project, writes) => {
      for (const file of writes) files.set(file.path, file.content);
      return { ok: true };
    },
    exec: async (_project, command) => {
      if (command[0] === 'git' && command[1] === 'status') {
        return { exitCode: 0, stdout: ' M src/App.tsx\n', stderr: '' };
      }
      if (command[0] === 'git' && command[1] === 'diff') {
        return { exitCode: 0, stdout: ' 1 file changed, 1 insertion(+), 1 deletion(-)\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    devStatus: async () => (repaired
      ? { running: true, ready: true, project: 'p1', port: 5173, tail: ['VITE ready'] }
      : {
        running: true,
        ready: false,
        project: 'p1',
        error: 'Failed to resolve import "./broken"',
        tail: ['[vite] Internal server error', 'Cannot find module ./broken'],
      }),
    startDev: async () => ({ port: 5173 }),
    stopDev: async () => ({ ok: true }),
  };
  const browserCheck = {
    devUrlFor: () => 'http://runner:5173',
    checkApp: async () => ({ unavailable: false, ok: true, rendered: true, rootChars: 12, errors: [] }),
    formatReport: () => 'browser failure',
  };
  const originalGetTool = buildTools.getTool;
  buildTools.getTool = (name) => (name === 'run_subagent'
    ? {
      execute: async () => {
        repaired = true;
        return { isError: false, summary: 'runtime reparado' };
      },
    }
    : originalGetTool(name));

  try {
    const result = await closeBuild({
      run: { id: 'run-proactive-runtime', projectId: 'p1', userId: 'u1', prompt },
      project: projectState,
      runner,
      eventStore: {
        appendEvent: async (_runId, type, data) => { events.push({ type, data }); },
      },
      prisma: {
        codexProject: {
          findUnique: async () => projectState,
          update: async ({ data }) => {
            Object.assign(projectState, data);
            return projectState;
          },
        },
        user: { findUnique: async () => ({ plan: 'PRO' }) },
      },
      llmTurn: async () => ({ text: 'sin cambios', toolCalls: [] }),
      clock: (() => { let now = 0; return () => new Date(1_000_000 + (now += 10)); })(),
      env: {
        NODE_ENV: 'test',
        CODEX_AUTO_VERIFY: '1',
        CODEX_VERIFY_DEV_SERVER: '1',
        CODEX_VERIFY_BROWSER: '1',
        CODEX_VERIFY_DEV_TIMEOUT_MS: '3000',
        CODEX_PROACTIVE_REPAIR_ROUNDS: '1',
        CODEX_VERIFY_ROUNDS: '1',
        CODEX_RUN_BRANCHES: '0',
        CODEX_AUTO_MEMORY: '0',
      },
      metrics: { recordAction: () => {}, recordLlmUsage: () => {}, finalize: async () => ({ costAppliedUsd: 0 }) },
      sourcePrompt: prompt,
      browserCheck,
      backgroundTaskService: { quiesce: async () => ({ ok: true, stopped: 0 }) },
      checkpointService: {
        createCheckpoint: async () => {
          checkpointCalls += 1;
          return { id: 'cp1', commitSha: 'abcdef1234567890', createdAt: new Date() };
        },
      },
    });

    assert.equal(result.ok, true, 'la reparación verde puede cerrar y crear checkpoint');
    assert.equal(repaired, true);
    assert.equal(checkpointCalls, 1);
    const debuggerIndex = events.findIndex((event) => event.type === 'action_start' && event.data.actionId === 'quality-debug-1');
    const repairedProbeIndex = events.findIndex((event) => event.type === 'action_start' && event.data.actionId === 'quality-2-runtime');
    const finalProbeIndex = events.findIndex((event) => event.type === 'action_start' && event.data.actionId === 'quality-runtime-final');
    assert.ok(debuggerIndex >= 0, 'ejecutó el debugger proactivo');
    assert.ok(repairedProbeIndex > debuggerIndex, 'reverificó después de reparar');
    assert.ok(finalProbeIndex > repairedProbeIndex, 'el gate autoritativo observa el workspace ya reparado');
  } finally {
    buildTools.getTool = originalGetTool;
  }
});

test('project verification unavailable fails closed and never checkpoints', async () => {
  const commands = [];
  const events = [];
  const result = await closeBuild({
    run: { id: 'run-unavailable-gate', projectId: 'p1', userId: 'u1', prompt: 'corrige la app' },
    project: { id: 'p1', userId: 'u1', brief: {} },
    runner: {
      readFile: async () => {
        const error = new Error('workspace unavailable');
        error.code = 'EIO';
        throw error;
      },
      exec: async (_project, command) => {
        commands.push(command);
        if (command[0] === 'git' && command[1] === 'status') {
          return { exitCode: 0, stdout: ' M src/App.tsx\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      writeFiles: async () => ({ ok: true }),
    },
    eventStore: {
      appendEvent: async (_runId, type, data) => {
        events.push({ type, data });
      },
    },
    prisma: null,
    llmTurn: async () => ({ text: 'sin cambios', toolCalls: [] }),
    clock: () => new Date('2026-07-26T12:00:00.000Z'),
    env: {
      NODE_ENV: 'test',
      CODEX_AUTO_VERIFY: '1',
      CODEX_RUN_BRANCHES: '1',
    },
    metrics: null,
    sourcePrompt: 'corrige la app',
    backgroundTaskService: {
      quiesce: async () => ({ ok: true, stopped: 0 }),
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.checkpoint, null);
  assert.equal(result.projectGateVerification.clean, null);
  assert.equal(commands.some((command) => command[0] === 'git' && command.includes('commit')), false);
  assert.ok(events.some((event) => (
    event.type === 'narrative_delta'
    && /fallaron los gates obligatorios/i.test(event.data.text)
  )));
});

test('metrics hooks receive usage, actions and lines read', async () => {
  const rec = { usage: [], actions: [], lines: 0 };
  const metrics = {
    recordLlmUsage: (u) => rec.usage.push(u),
    recordAction: (k) => rec.actions.push(k),
    recordLinesRead: (n) => { rec.lines += n; },
  };
  const f = fakeDeps({
    metrics,
    llmTurn: scriptedLlm([
      { text: 'leo', toolCalls: [{ name: 'read_file', args: { path: 'a.js' } }], usage: { tokensIn: 5, tokensOut: 7, provider: 'Cerebras', model: 'm' } },
      { text: 'fin', toolCalls: [] },
    ]),
  });
  await runAgentLoop({ run: { id: 'r1', mode: 'build' }, project: { id: 'p1' }, deps: f.deps });
  assert.equal(rec.usage.length, 1);
  assert.deepEqual(rec.actions, ['file_read']);
  assert.equal(rec.lines, 3);
});

test('an unknown tool call still emits action_end AND counts toward actionsCount (honest counting)', async () => {
  const rec = { actions: [] };
  const metrics = { recordAction: (k) => rec.actions.push(k) };
  const f = fakeDeps({
    metrics,
    llmTurn: scriptedLlm([
      { text: 'pruebo', toolCalls: [{ name: 'no_such_tool', args: {} }] },
      { text: 'fin', toolCalls: [] },
    ]),
  });
  await runAgentLoop({ run: { id: 'r1', mode: 'build' }, project: { id: 'p1' }, deps: f.deps });
  const ends = f.events.filter((e) => e.type === 'action_end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].data.status, 'error');
  // The action_end means the action counts (spec req. 4: any status).
  assert.deepEqual(rec.actions, ['terminal']);
});

test('a turn of ONLY run_subagent calls runs the delegations in parallel', async () => {
  let mainCalls = 0;
  let inFlight = 0;
  let release;
  const bothStarted = new Promise((r) => { release = r; });
  const llmTurn = async ({ messages }) => {
    const sys = messages[0].content;
    if (/agente de software senior/.test(sys)) {
      if (mainCalls++ === 0) {
        return {
          text: 'Delego UI y revisión en paralelo.',
          toolCalls: [
            { name: 'run_subagent', args: { agent: 'planner', task: 'planea la UI' } },
            { name: 'run_subagent', args: { agent: 'qa_reviewer', task: 'revisa el estado' } },
          ],
        };
      }
      return { text: 'fin', toolCalls: [] };
    }
    // Specialist turn: block until BOTH delegations are in flight. If the loop
    // ran them sequentially, the first would wait forever → timeout → failure.
    inFlight += 1;
    if (inFlight >= 2) release();
    await Promise.race([
      bothStarted,
      new Promise((_, rej) => { setTimeout(() => rej(new Error('subagents did not run in parallel')), 2000); }),
    ]);
    return { text: `informe de ${/PLANNER/.test(sys) ? 'planner' : 'qa'}`, toolCalls: [] };
  };

  const f = fakeDeps({
    llmTurn,
    env: { NODE_ENV: 'test', CODEX_AUTO_VERIFY: '0', CODEX_PARALLEL_WRITE_SUBAGENTS: '1' },
  });
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build', prompt: 'haz una app' }, project: { id: 'p1' }, deps: f.deps });
  assert.equal(res.status, 'done');

  const starts = f.events.filter((e) => e.type === 'action_start' && e.data.kind === 'agent');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].data.groupId, starts[1].data.groupId); // one burst, one group
  const ends = f.events.filter((e) => e.type === 'action_end');
  assert.ok(ends.every((e) => e.data.status === 'done'), JSON.stringify(ends.map((e) => e.data.outputSummary)));
  assert.ok(ends.some((e) => /planner: completado/.test(e.data.outputSummary || '')));
});

test('subagent delegations are serialized by default on a shared checkout', async () => {
  let mainCalls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const llmTurn = async ({ messages }) => {
    const sys = messages[0].content;
    if (/agente de software senior/.test(sys)) {
      if (mainCalls++ === 0) {
        return {
          text: 'Delego dos revisiones.',
          toolCalls: [
            { name: 'run_subagent', args: { agent: 'planner', task: 'planea la UI' } },
            { name: 'run_subagent', args: { agent: 'qa_reviewer', task: 'revisa el estado' } },
          ],
        };
      }
      return { text: 'fin', toolCalls: [] };
    }
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    return { text: 'informe', toolCalls: [] };
  };

  const f = fakeDeps({ llmTurn });
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build', prompt: 'haz una app' }, project: { id: 'p1' }, deps: f.deps });
  assert.equal(res.status, 'done');
  assert.equal(maxInFlight, 1);
});

// ── Generic anti-loop guards (identical actions / identical observations) ────

function capturingLlm(makeResponse) {
  const seen = [];
  const lastSeen = [];
  let calls = 0;
  const fn = async ({ messages }) => {
    calls += 1;
    seen.push(messages.map((m) => String(m.content)).join('\n'));
    // Cumulative snapshots double-count nudges when substring-matched; the
    // newest message alone is what the loop appended this turn.
    lastSeen.push(String(messages[messages.length - 1]?.content || ''));
    return makeResponse(calls);
  };
  fn.seen = seen;
  fn.lastSeen = lastSeen;
  fn.count = () => calls;
  return fn;
}

test('loop cut: repeated identical action → [LOOP_CUT] nudge, then graceful close keeping the work', async () => {
  let reads = 0;
  const llm = capturingLlm(() => ({ text: '', toolCalls: [{ name: 'read_file', args: { path: 'src/App.tsx' } }] }));
  const f = fakeDeps({ llmTurn: llm, env: { NODE_ENV: 'test', CODEX_AUTO_VERIFY: '0', CODEX_MAX_STEPS: '50' } });
  // Count only the target read: the harness runner.readFile also serves the
  // framework's settings/notes/SIRA.md lookups, which must not pollute the count.
  const innerReadFile = f.deps.runner.readFile;
  f.deps.runner.readFile = async (...a) => { if (a[1] === 'src/App.tsx') reads += 1; return innerReadFile(...a); };

  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build', prompt: 'crea algo' }, project: { id: 'p1', name: 'X' }, deps: f.deps });

  assert.equal(res.status, 'done', 'second breach closes gracefully instead of crashing');
  assert.equal(reads, 2, 'only the first two identical reads really executed');
  const cutEnds = f.events.filter((e) => e.type === 'action_end' && /loop_cut/.test(e.data.outputSummary || ''));
  assert.equal(cutEnds.length, 1, 'the third identical call is refused exactly once');
  assert.equal(llm.count(), 4);
  assert.ok(llm.seen[3].includes('[LOOP_CUT]'), 'the refusal feeds a hard course-correction nudge');
  assert.ok(f.events.some((e) => e.type === 'narrative_delta' && /Corté la corrida/.test(e.data.text || '')), 'the close explains itself');
});

test('loop cut: varying arguments resets the streak — diverse work never trips the guard', async () => {
  const llm = capturingLlm((calls) => ({
    text: '',
    toolCalls: [{ name: 'read_file', args: { path: calls % 2 ? 'src/A.tsx' : 'src/B.tsx' } }],
  }));
  const f = fakeDeps({ llmTurn: llm, env: { NODE_ENV: 'test', CODEX_AUTO_VERIFY: '0', CODEX_MAX_STEPS: '6' } });

  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build', prompt: 'crea algo' }, project: { id: 'p1', name: 'X' }, deps: f.deps });

  assert.equal(res.status, 'done');
  assert.equal(llm.count(), 6, 'the full budget is available to diverse work');
  assert.ok(!f.events.some((e) => e.type === 'action_end' && /loop_cut/.test(e.data.outputSummary || '')));
  assert.ok(!llm.seen.join('\n').includes('[LOOP_CUT]'));
});

test('identical observations produce exactly one [LOOP] course-correction nudge and the run continues', async () => {
  const llm = capturingLlm((calls) => {
    if (calls > 5) return { text: 'termino con lo revisado', toolCalls: [] };
    return { text: '', toolCalls: [{ name: 'read_file', args: { path: 'src/App.tsx' } }] };
  });
  const f = fakeDeps({
    llmTurn: llm,
    env: { NODE_ENV: 'test', CODEX_AUTO_VERIFY: '0', CODEX_MAX_STEPS: '10', CODEX_MAX_IDENTICAL_ACTIONS: '999' },
  });

  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build', prompt: 'crea algo' }, project: { id: 'p1', name: 'X' }, deps: f.deps });

  assert.equal(res.status, 'done');
  const loopNudges = llm.lastSeen.filter((m) => m.includes('[LOOP]'));
  assert.equal(loopNudges.length, 1, 'one nudge per identical-output streak, never a spam');
  assert.ok(llm.lastSeen[4].includes('[LOOP]'), 'the nudge lands after the 4th byte-identical observation');
});

test('CODEX_MAX_IDENTICAL_ACTIONS=2 tightens the cut via env', async () => {
  let reads = 0;
  const llm = capturingLlm(() => ({ text: '', toolCalls: [{ name: 'read_file', args: { path: 'src/App.tsx' } }] }));
  const f = fakeDeps({
    llmTurn: llm,
    env: { NODE_ENV: 'test', CODEX_AUTO_VERIFY: '0', CODEX_MAX_STEPS: '20', CODEX_MAX_IDENTICAL_ACTIONS: '2' },
  });
  const innerReadFile = f.deps.runner.readFile;
  f.deps.runner.readFile = async (...a) => { if (a[1] === 'src/App.tsx') reads += 1; return innerReadFile(...a); };

  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build', prompt: 'crea algo' }, project: { id: 'p1', name: 'X' }, deps: f.deps });

  assert.equal(res.status, 'done');
  assert.equal(reads, 1, 'with limit 2 the second identical call is already refused');
  assert.equal(llm.count(), 3, 'nudge turn, then the breaching turn closes the run');
});

// ── Plan-aware budget extension (auto-continue) ──────────────────────────────

function endlessToolLlm() {
  let calls = 0;
  const fn = async () => { calls += 1; return { text: '', toolCalls: [{ name: 'read_file', args: { path: 'src/App.tsx' } }] }; };
  fn.count = () => calls;
  return fn;
}

test('build loop extends the step budget when the plan still has pending tasks', async () => {
  const llm = endlessToolLlm();
  const f = fakeDeps({
    llmTurn: llm,
    // These tests intentionally repeat read_file with frozen args; disable the
    // identical-action loop cut so the budget-extension arithmetic stays isolated.
    env: { NODE_ENV: 'test', CODEX_AUTO_VERIFY: '0', CODEX_MAX_STEPS: '2', CODEX_PLAN_EXTENSIONS: '1', CODEX_MAX_IDENTICAL_ACTIONS: '999' },
    plan: { architecture: 'x', pages: [], components: [], tasks: [{ id: 't1', title: 'Construir el dashboard' }] },
  });
  // Neutral prompt: 'crm'/'tienda' would trigger the big-playbook doubled
  // budget (CODEX_MAX_STEPS_LARGE) and change the arithmetic under test.
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build', prompt: 'crea una landing simple' }, project: { id: 'p1', name: 'X' }, deps: f.deps });
  assert.equal(res.status, 'done');
  // base 2 steps + one extension of max(4, ceil(2/2)) = 4 → 6 turns total.
  assert.equal(llm.count(), 6, 'the loop must keep working through the extension');
  const ext = f.events.find((e) => e.type === 'narrative_delta' && /extensión 1\/1/.test(e.data.text || ''));
  assert.ok(ext, 'an extension narrative must be emitted');
  const close = f.events.filter((e) => e.type === 'narrative_delta').map((e) => e.data.text).join('\n');
  assert.match(close, /pendiente/, 'the final close mentions the still-pending plan');
});

test('CODEX_PLAN_EXTENSIONS=0 disables the extension (explicit falsy-0 respected)', async () => {
  const llm = endlessToolLlm();
  const f = fakeDeps({
    llmTurn: llm,
    env: { NODE_ENV: 'test', CODEX_AUTO_VERIFY: '0', CODEX_MAX_STEPS: '2', CODEX_PLAN_EXTENSIONS: '0' },
    plan: { architecture: 'x', pages: [], components: [], tasks: [{ id: 't1', title: 'algo' }] },
  });
  await runAgentLoop({ run: { id: 'r1', mode: 'build', prompt: 'crea algo' }, project: { id: 'p1', name: 'X' }, deps: f.deps });
  assert.equal(llm.count(), 2, 'no extension: exactly the base budget');
  assert.ok(!f.events.some((e) => e.type === 'narrative_delta' && /extensión/.test(e.data.text || '')));
});

test('no extension when the plan is fully completed (update_plan marks all done)', async () => {
  let calls = 0;
  const llm = async () => {
    calls += 1;
    if (calls === 1) {
      return { text: '', toolCalls: [{ name: 'update_plan', args: { tasks: [{ id: 't1', title: 'algo', status: 'completed' }] } }] };
    }
    return { text: '', toolCalls: [{ name: 'read_file', args: { path: 'src/App.tsx' } }] };
  };
  const f = fakeDeps({
    llmTurn: llm,
    env: { NODE_ENV: 'test', CODEX_AUTO_VERIFY: '0', CODEX_MAX_STEPS: '2', CODEX_PLAN_EXTENSIONS: '2' },
    plan: { architecture: 'x', pages: [], components: [], tasks: [{ id: 't1', title: 'algo' }] },
  });
  await runAgentLoop({ run: { id: 'r1', mode: 'build', prompt: 'crea algo' }, project: { id: 'p1', name: 'X' }, deps: f.deps });
  assert.equal(calls, 2, 'completed plan → no extension');
  assert.ok(!f.events.some((e) => e.type === 'narrative_delta' && /extensión/.test(e.data.text || '')));
});
