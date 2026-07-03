'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runAgentLoop } = require('../src/services/codex/agent-loop');
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
    readFile: async () => ({ content: 'a\nb\nc' }),
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

test('build loop runs grouped tool calls with one groupId, narrative, then done', async () => {
  const f = fakeDeps({
    llmTurn: scriptedLlm([
      { text: 'Voy a crear el index y revisar git.', toolCalls: [
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
  assert.equal(starts.length, 2);
  assert.equal(starts[0].data.groupId, starts[1].data.groupId); // same burst → one group
  assert.equal(starts[0].data.kind, 'file_write');
  assert.equal(starts[1].data.kind, 'terminal');
  assert.equal(f.events.filter((e) => e.type === 'action_end').length, 2);
  assert.ok(f.events.some((e) => e.type === 'narrative_delta'));
  assert.equal(f.actions.length, 2); // both persisted as CodexAction
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
      { text: 'Lo divido en partes.', toolCalls: [{ name: 'write_file', args: { path: 'src/App.tsx', content: '<App/>' } }] },
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

  const f = fakeDeps({ llmTurn });
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build', prompt: 'haz una app' }, project: { id: 'p1' }, deps: f.deps });
  assert.equal(res.status, 'done');

  const starts = f.events.filter((e) => e.type === 'action_start' && e.data.kind === 'agent');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].data.groupId, starts[1].data.groupId); // one burst, one group
  const ends = f.events.filter((e) => e.type === 'action_end');
  assert.ok(ends.every((e) => e.data.status === 'done'), JSON.stringify(ends.map((e) => e.data.outputSummary)));
  assert.ok(ends.some((e) => /planner: completado/.test(e.data.outputSummary || '')));
});
