'use strict';

/**
 * F4 — Hierarchical orchestrator on top of AgentRunner.
 *
 * Gate coverage:
 *   - simple create-ppt / style follow-ups NEVER orchestrate (single runner);
 *   - a multi-step goal becomes a validated DAG whose nodes run in topo
 *     order as REAL AgentRunner loops (mocked LLM, local sandbox) and pass
 *     data through the shared blackboard;
 *   - hard budgets (node + run) cut a loop that would otherwise continue;
 *   - steer(runId, message) replans the REMAINING nodes only;
 *   - the F3 AbortSignal cancels the planner and every in-flight sub-agent;
 *   - an orchestrator failure surfaces the honest Spanish error and NEVER
 *     reaches the generic pipeline / create_document.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { PassThrough } = require('node:stream');

const agentRunner = require('../src/services/agent-runner');
const { toStageEvent } = require('../src/services/agent-runner/trace');
const orchestrator = require('../src/services/agent-runner/orchestrator');
const {
  validatePlan,
  ensureVerifier,
  topoOrder,
  parsePlanJson,
  PlanValidationError,
} = require('../src/services/agent-runner/orchestrator/planner');
const { rolePrompt, KNOWN_ROLES } = require('../src/services/agent-runner/orchestrator/roles');

const {
  shouldOrchestrate,
  orchestratorEnabled,
  runOrchestrator,
  runOrchestratorForChat,
  steer,
  isOrchestratorRunActive,
} = orchestrator;

/* ── helpers ─────────────────────────────────────────────────────────────── */

function toResponse(turn) {
  if (turn.toolCalls) {
    return {
      usage: turn.usage,
      choices: [{
        message: {
          content: turn.content || null,
          tool_calls: turn.toolCalls.map((c, idx) => ({
            id: `call_${Math.random().toString(36).slice(2, 8)}_${idx}`,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
      }],
    };
  }
  return { usage: turn.usage, choices: [{ message: { content: turn.content } }] };
}

/**
 * One shared client whose script is selected per SUB-AGENT ROLE: the node
 * instruction (messages[1]) carries "TU SUBTAREA (rol: <role>)". Extra calls
 * (verification nudges vary with the sandbox environment — soffice may or
 * may not exist) fall back to the role's default final answer, so the
 * scripts stay environment-robust.
 */
function roleDispatchClient(scripts, { onCall, defaults = {} } = {}) {
  const queues = new Map(Object.entries(scripts).map(([k, v]) => [k, [...v]]));
  const client = {
    calls: [],
    chat: {
      completions: {
        create: async (req) => {
          const user = String(req?.messages?.[1]?.content || '');
          const role = Object.keys(scripts).find((k) => user.includes(`rol: ${k}`)) || 'default';
          client.calls.push({ role, messages: req.messages });
          if (typeof onCall === 'function') onCall(client.calls.length, role);
          const queue = queues.get(role) || [];
          const turn = queue.length
            ? queue.shift()
            : { content: defaults[role] || 'Listo.' };
          return toResponse(turn);
        },
      },
    },
  };
  return client;
}

/** Client that always answers the same scripted turn (budget/abort probes). */
function repeatingClient(turn, { onCall } = {}) {
  const client = {
    calls: 0,
    chat: {
      completions: {
        create: async () => {
          client.calls += 1;
          if (typeof onCall === 'function') onCall(client.calls);
          return toResponse(typeof turn === 'function' ? turn(client.calls) : turn);
        },
      },
    },
  };
  return client;
}

function budgetOf(maxIterations, maxTokens = 20_000) {
  return { maxIterations, maxTokens };
}

/* ── shouldOrchestrate: only genuinely multi-step goals ──────────────────── */

test('F4: simple create-ppt and style/color follow-ups NEVER orchestrate', () => {
  const singleRunnerPhrases = [
    'crea una ppt del embarazo de color rosado la ppt',
    'crea una ppt rosada',
    'crea una ppt del embarazo de color celeste',
    'créame una presentación de marketing digital',
    'genera un word del informe trimestral',
    'genera un excel de gastos mensuales',
    'hazme una presentación en powerpoint sobre ventas',
    'create a pptx about climate change',
    'ponlas todas rosadas',
    'ponlas todas de color celeste',
    'uniformisa el color de la ppts todas de color blanco',
    'píntalas de verde',
    'cámbialas al hex #1E3A8A',
    'cambia el fondo a #FF00AA',
    'crea una ppt sobre python para principiantes',
    'hola',
    '',
  ];
  for (const phrase of singleRunnerPhrases) {
    assert.equal(shouldOrchestrate(phrase, {}), false, `must stay single-runner: "${phrase}"`);
  }
});

test('F4: genuinely multi-step goals DO orchestrate', () => {
  const multiStepPhrases = [
    'investiga las tendencias del mercado inmobiliario y luego crea un informe word con las conclusiones',
    'analiza los datos de ventas.csv y genera un informe word con los hallazgos',
    'escribe un script python que procese ventas.csv y después documenta los resultados en un word',
    'primero investiga el estado del arte de la IA generativa y después arma una presentación ejecutiva',
  ];
  for (const phrase of multiStepPhrases) {
    assert.equal(shouldOrchestrate(phrase, {}), true, `must orchestrate: "${phrase}"`);
  }
  // Multi-step CREATE-doc goals are still claimed by the F2 routing gate, so
  // the orchestrator branch inside executeAgentRunnerTurn is reachable.
  for (const phrase of [
    'investiga las tendencias del mercado inmobiliario y luego crea un informe word con las conclusiones',
    'analiza los datos de ventas.csv y genera un informe word con los hallazgos',
    'primero investiga el estado del arte de la IA generativa y después arma una presentación ejecutiva',
  ]) {
    assert.equal(agentRunner.shouldRunAgentRunner({ text: phrase }), true, `runner must claim: "${phrase}"`);
  }
});

test('F4: kill switch — default ON in production, OFF under test, explicit values win', () => {
  assert.equal(orchestratorEnabled({}), true);
  assert.equal(orchestratorEnabled({ NODE_ENV: 'production' }), true);
  assert.equal(orchestratorEnabled({ NODE_ENV: 'test' }), false);
  assert.equal(orchestratorEnabled({ NODE_ENV: 'test', SIRAGPT_AGENT_ORCHESTRATOR: '1' }), true);
  assert.equal(orchestratorEnabled({ SIRAGPT_AGENT_ORCHESTRATOR: '0' }), false);
  assert.equal(orchestratorEnabled({ SIRAGPT_AGENT_ORCHESTRATOR: 'off' }), false);
});

/* ── Plan validation ─────────────────────────────────────────────────────── */

test('F4: validatePlan rejects cycles, unknown roles, missing budgets and broken deps', () => {
  const okNode = (id, extra = {}) => ({
    id, role: 'document_editor', goal: 'haz algo', dependsOn: [], budget: budgetOf(4), ...extra,
  });
  // valid
  const plan = validatePlan({ nodes: [okNode('a'), okNode('b', { dependsOn: ['a'] })] });
  assert.equal(plan.nodes.length, 2);
  // cycle
  assert.throws(
    () => validatePlan({ nodes: [okNode('a', { dependsOn: ['b'] }), okNode('b', { dependsOn: ['a'] })] }),
    (err) => err instanceof PlanValidationError && /ciclo/.test(err.message),
  );
  // unknown role
  assert.throws(
    () => validatePlan({ nodes: [okNode('a', { role: 'hacker' })] }),
    (err) => err.code === 'PLAN_INVALID' && /rol desconocido/.test(err.message),
  );
  // missing budget
  assert.throws(
    () => validatePlan({ nodes: [{ id: 'a', role: 'coder', goal: 'x', dependsOn: [] }] }),
    (err) => err.code === 'PLAN_INVALID' && /presupuesto/.test(err.message),
  );
  // dangling dependency
  assert.throws(
    () => validatePlan({ nodes: [okNode('a', { dependsOn: ['ghost'] })] }),
    (err) => /inexistente/.test(err.message),
  );
  // empty / non-JSON plans
  assert.throws(() => validatePlan(null), (err) => err.code === 'PLAN_INVALID');
  assert.throws(() => validatePlan({ nodes: [] }), (err) => err.code === 'PLAN_INVALID');
  // parsePlanJson tolerates fences
  assert.deepEqual(parsePlanJson('```json\n{"nodes":[]}\n```'), { nodes: [] });
  assert.equal(parsePlanJson('no json here'), null);
  // topo order respects dependencies regardless of declaration order
  const order = topoOrder(validatePlan({
    nodes: [okNode('late', { dependsOn: ['early'] }), okNode('early')],
  }).nodes);
  assert.deepEqual(order.map((n) => n.id), ['early', 'late']);
});

test('F4: ensureVerifier appends ONE critic node after high-stakes deliverables', () => {
  const base = validatePlan({
    nodes: [
      { id: 'inv', role: 'researcher', goal: 'investiga', dependsOn: [], budget: budgetOf(4) },
      { id: 'doc', role: 'document_editor', goal: 'redacta', dependsOn: ['inv'], budget: budgetOf(6) },
    ],
  });
  const withVerifier = ensureVerifier(base);
  assert.equal(withVerifier.nodes.length, 3);
  const verifier = withVerifier.nodes[2];
  assert.equal(verifier.role, 'verifier');
  assert.deepEqual(verifier.dependsOn, ['doc']);
  // Already-declared verifiers and text-only plans are left alone.
  assert.equal(ensureVerifier(withVerifier).nodes.length, 3);
  const textOnly = validatePlan({
    nodes: [{ id: 'inv', role: 'researcher', goal: 'investiga', dependsOn: [], budget: budgetOf(4) }],
  });
  assert.equal(ensureVerifier(textOnly).nodes.length, 1);
  // Every role referenced by the orchestrator has a prompt.
  for (const role of KNOWN_ROLES) assert.ok(rolePrompt(role).includes('SUB-AGENT ROLE'));
  assert.match(rolePrompt('researcher'), /NO web access/i);
});

/* ── Multi-step run: DAG in topo order + blackboard + auto verifier ──────── */

test('F4: multi-step goal runs the DAG in topo order, sub-agents ARE AgentRunner loops, blackboard passes data downstream', async () => {
  const plannerCalls = [];
  const plannerFn = async (ctx) => {
    plannerCalls.push(ctx);
    return {
      nodes: [
        // Declared out of order on purpose: topo order must fix it.
        { id: 'redactar', role: 'document_editor', goal: 'Redacta el informe con las conclusiones', dependsOn: ['investigar'], budget: budgetOf(8) },
        { id: 'investigar', role: 'researcher', goal: 'Investiga las tendencias del mercado', dependsOn: [], budget: budgetOf(8) },
      ],
    };
  };
  const client = roleDispatchClient({
    researcher: [
      { toolCalls: [{ name: 'write_file', args: { path: 'outputs/investigacion.md', content: '# Hallazgos\nHALLAZGO-42: el mercado creció 12%.' } }] },
      { toolCalls: [{ name: 'render_preview', args: { path: 'outputs/investigacion.md' } }] },
      { content: 'Hallazgos listos: HALLAZGO-42, el mercado creció 12%.' },
    ],
    document_editor: [
      { toolCalls: [{ name: 'write_file', args: { path: 'outputs/informe.md', content: '# Informe\nBasado en HALLAZGO-42.' } }] },
      { toolCalls: [{ name: 'render_preview', args: { path: 'outputs/informe.md' } }] },
      { content: 'Listo. Generé informe.md con las conclusiones.' },
    ],
    verifier: [
      { toolCalls: [{ name: 'write_file', args: { path: 'outputs/verificacion.md', content: 'OK: el informe incluye HALLAZGO-42.' } }] },
      { toolCalls: [{ name: 'render_preview', args: { path: 'outputs/verificacion.md' } }] },
      { content: 'Los entregables cumplen el objetivo del usuario.' },
    ],
  }, {
    // Environment-robust: if the sandbox lacks/has soffice the verification
    // gate may demand extra turns — the role keeps answering its final text.
    defaults: {
      researcher: 'Hallazgos listos: HALLAZGO-42, el mercado creció 12%.',
      document_editor: 'Listo. Generé informe.md con las conclusiones.',
      verifier: 'Los entregables cumplen el objetivo del usuario.',
    },
  });
  const events = [];
  const result = await runOrchestrator({
    files: [],
    instruction: 'investiga las tendencias del mercado y luego crea un informe word con las conclusiones',
    client,
    plannerFn,
    driver: 'local',
    onEvent: (ev) => events.push(ev),
  });

  assert.equal(result.ok, true);
  assert.equal(result.stoppedReason, 'final');
  assert.equal(result.orchestrated, true);
  assert.equal(plannerCalls.length, 1, 'exactly one planning call');
  assert.equal(plannerCalls[0].phase, 'initial');

  // Topo order despite the declaration order, auto-verifier appended last.
  const started = events.filter((e) => e.type === 'node_start').map((e) => e.node);
  assert.deepEqual(started, ['investigar', 'redactar', 'verificacion']);
  const doneOk = events.filter((e) => e.type === 'node_done').map((e) => [e.node, e.ok]);
  assert.deepEqual(doneOk, [['investigar', true], ['redactar', true], ['verificacion', true]]);

  // Blackboard: the document node saw the researcher's text AND its file.
  const docCall = client.calls.find((c) => c.role === 'document_editor');
  assert.ok(docCall, 'document_editor sub-agent ran');
  const docSystem = String(docCall.messages[0].content);
  const docUser = String(docCall.messages[1].content);
  assert.match(docUser, /HALLAZGO-42/, 'upstream final text flows via the blackboard');
  assert.match(docUser, /investigacion\.md/, 'upstream artifact is announced');
  assert.match(docSystem, /investigacion\.md/, 'upstream artifact is a real file of the sub-agent sandbox');
  assert.match(docSystem, /SUB-AGENT ROLE: document_editor/, 'role prompt is appended to the runner system prompt');

  // Researcher never gets web tools (F6): its role prompt forbids web access.
  const researchCall = client.calls.find((c) => c.role === 'researcher');
  assert.match(String(researchCall.messages[0].content), /NO web access/i);

  // Deliverables: outputs of working nodes; the verifier report stays internal.
  const names = result.outputs.map((o) => o.name).sort();
  assert.deepEqual(names, ['informe.md', 'investigacion.md']);
  assert.match(result.finalText, /informe\.md/);
  assert.match(result.finalText, /Verificación:/);

  // Every orchestrator event renders as a canonical Spanish stage.
  const stages = events.map(toStageEvent).filter(Boolean);
  const labels = new Set(stages.map((s) => s.label));
  assert.ok(labels.has('Planificando'), 'planning stage traced');
  assert.ok(labels.has('Plan listo'), 'plan ready stage traced');
  assert.ok(labels.has('Delegando a sub-agente'), 'delegation stage traced');
  assert.ok(labels.has('Sub-agente listo'), 'node completion stage traced');
});

test('F4: runOrchestratorForChat keeps the chat contract and persists outputs', async () => {
  const plannerFn = async () => ({
    nodes: [
      { id: 'doc', role: 'document_editor', goal: 'Redacta el resumen', dependsOn: [], budget: budgetOf(8) },
      { id: 'check', role: 'verifier', goal: 'Verifica el resumen', dependsOn: ['doc'], budget: budgetOf(4) },
    ],
  });
  const client = roleDispatchClient({
    document_editor: [
      { toolCalls: [{ name: 'write_file', args: { path: 'outputs/resumen.md', content: '# Resumen' } }] },
      { toolCalls: [{ name: 'render_preview', args: { path: 'outputs/resumen.md' } }] },
      { content: 'Listo. Generé resumen.md.' },
    ],
    verifier: [
      { content: 'El resumen cumple el objetivo.' },
    ],
  }, {
    defaults: {
      document_editor: 'Listo. Generé resumen.md.',
      verifier: 'El resumen cumple el objetivo.',
    },
  });
  const persisted = [];
  const result = await runOrchestratorForChat({
    prisma: { generatedArtifact: { findMany: async () => [] } },
    userId: 'u-f4',
    chatId: 'c-f4',
    instruction: 'analiza los datos y genera un informe word', // claimed + multi-step
    client,
    plannerFn,
    driver: 'local',
    persist: async ({ outputs }) => {
      for (const out of outputs) persisted.push(out.name);
      return outputs.map((out, i) => ({
        id: `art-${i}`,
        filename: out.name,
        mime: 'text/markdown',
        format: 'md',
        sizeBytes: out.buffer.length,
        downloadUrl: `/api/agent/artifact/art-${i}`,
      }));
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.stoppedReason, 'agent_runner', 'chat telemetry contract unchanged');
  assert.deepEqual(persisted, ['resumen.md']);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].filename, 'resumen.md');
  assert.match(result.summary, /resumen\.md/);
  assert.equal(result.orchestrated, true);
  assert.ok(result.runId, 'runId exposed for steering');
});

/* ── Hard budgets ────────────────────────────────────────────────────────── */

test('F4: a node budget cap CUTS a loop that would otherwise keep calling the LLM', async () => {
  const plannerFn = async () => ({
    nodes: [
      { id: 'solo', role: 'coder', goal: 'programa algo', dependsOn: [], budget: budgetOf(2, 50_000) },
    ],
  });
  // This client would loop forever: it always asks for another tool call.
  const client = repeatingClient({ toolCalls: [{ name: 'list_files', args: { path: '.' } }] });
  const events = [];
  const result = await runOrchestrator({
    instruction: 'analiza los datos y genera un informe',
    client,
    plannerFn,
    driver: 'local',
    onEvent: (ev) => events.push(ev),
  });
  assert.equal(result.ok, false);
  assert.equal(result.stoppedReason, 'budget_exceeded');
  assert.equal(client.calls, 2, 'no LLM call happens past the node cap');
  const budgetEvents = events.filter((e) => e.type === 'budget_exceeded');
  assert.ok(budgetEvents.length >= 1, 'budget stage traced');
  assert.equal(toStageEvent(budgetEvents[0]).label, 'Presupuesto agotado');
  // Honest Spanish failure copy exists for the reason.
  const msg = agentRunner.buildAgentRunnerFailureMessage('budget_exceeded');
  assert.match(msg, /presupuesto/);
  assert.match(msg, /plantilla genérica/);
});

test('F4: the RUN token budget stops the whole orchestration and never persists a partial run', async () => {
  const plannerFn = async () => ({
    nodes: [
      { id: 'doc', role: 'document_editor', goal: 'redacta', dependsOn: [], budget: budgetOf(10, 60_000) },
      { id: 'doc2', role: 'document_editor', goal: 'redacta más', dependsOn: ['doc'], budget: budgetOf(10, 60_000) },
      { id: 'check', role: 'verifier', goal: 'verifica', dependsOn: ['doc2'], budget: budgetOf(4) },
    ],
  });
  // Every response burns 1000 reported tokens and keeps asking for tools —
  // without the run cap this would grind through every node budget.
  const client = repeatingClient({
    usage: { total_tokens: 1000 },
    toolCalls: [{ name: 'write_file', args: { path: 'outputs/parte.md', content: 'x' } }],
  });
  let persistCalled = false;
  const result = await runOrchestratorForChat({
    instruction: 'analiza los datos y genera un informe',
    client,
    plannerFn,
    driver: 'local',
    runBudget: { maxIterations: 100, maxTokens: 3500 },
    persist: async () => { persistCalled = true; return []; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.stoppedReason, 'budget_exceeded');
  assert.ok(client.calls <= 4, `run cap respected (calls=${client.calls})`);
  assert.equal(persistCalled, false, 'a partial run is NEVER persisted as success');
  assert.deepEqual(result.artifacts, []);
});

/* ── Steering ────────────────────────────────────────────────────────────── */

test('F4: steer(runId, message) replans the REMAINING nodes only — completed nodes never restart', async () => {
  const plannerCalls = [];
  const plannerFn = async (ctx) => {
    plannerCalls.push(ctx);
    if (ctx.phase === 'initial') {
      return {
        nodes: [
          { id: 'n1', role: 'researcher', goal: 'investiga el tema', dependsOn: [], budget: budgetOf(6) },
          { id: 'n2', role: 'researcher', goal: 'amplia la investigación', dependsOn: ['n1'], budget: budgetOf(6) },
        ],
      };
    }
    // Replan: replace the pending n2 with a steered node that builds on n1.
    return {
      nodes: [
        { id: 'n2b', role: 'researcher', goal: 'reenfoca el análisis según el steering', dependsOn: ['n1'], budget: budgetOf(6) },
      ],
    };
  };
  const client = repeatingClient({ content: 'Hallazgos anotados.' });
  const events = [];
  const runId = 'run-steer-f4';
  assert.equal(steer(runId, 'antes de arrancar'), false, 'steering a non-live run is a no-op');
  const result = await runOrchestrator({
    instruction: 'investiga el tema y luego redacta las notas',
    client,
    plannerFn,
    driver: 'local',
    runId,
    onEvent: (ev) => {
      events.push(ev);
      if (ev.type === 'node_done' && ev.node === 'n1') {
        assert.equal(isOrchestratorRunActive(runId), true);
        assert.equal(steer(runId, 'mejor enfócalo solo en 2025'), true);
      }
    },
  });
  assert.equal(result.ok, true);
  assert.equal(plannerCalls.length, 2, 'one initial plan + one replan');
  assert.equal(plannerCalls[1].phase, 'replan');
  assert.deepEqual(plannerCalls[1].steering, ['mejor enfócalo solo en 2025']);
  assert.deepEqual(plannerCalls[1].completed.map((c) => c.id), ['n1'], 'completed nodes reported to the replanner');

  const started = events.filter((e) => e.type === 'node_start').map((e) => e.node);
  assert.deepEqual(started, ['n1', 'n2b'], 'n1 runs ONCE; pending n2 is replaced; n1 never restarts');
  assert.ok(events.some((e) => e.type === 'steered'), 'steering traced');
  assert.ok(events.some((e) => e.type === 'replanning'), 'replanning traced');
  assert.equal(toStageEvent(events.find((e) => e.type === 'steered')).label, 'Instrucción recibida');
  assert.equal(toStageEvent(events.find((e) => e.type === 'replanning')).label, 'Replanificando');

  // The steered node receives the user note in its instruction.
  const steered = client.calls; // repeatingClient has no transcript — use planner shape instead
  assert.ok(steered >= 2, 'both nodes ran');
  assert.equal(isOrchestratorRunActive(runId), false, 'registry cleaned after the run');
  assert.equal(steer(runId, 'tarde'), false, 'steering after the run is a no-op');
});

test('F4: the steered node sees the steering note in its instruction', async () => {
  const plannerFn = async (ctx) => (ctx.phase === 'initial'
    ? {
      nodes: [
        { id: 'a', role: 'researcher', goal: 'primera parte', dependsOn: [], budget: budgetOf(6) },
        { id: 'b', role: 'data_analyst', goal: 'segunda parte', dependsOn: ['a'], budget: budgetOf(6) },
      ],
    }
    : {
      nodes: [
        { id: 'b2', role: 'data_analyst', goal: 'segunda parte reenfocada', dependsOn: ['a'], budget: budgetOf(6) },
      ],
    });
  const client = roleDispatchClient({
    researcher: [{ content: 'Notas de la primera parte.' }],
    data_analyst: [{ content: 'Números listos.' }],
  });
  const runId = 'run-steer-note-f4';
  await runOrchestrator({
    instruction: 'analiza los datos y genera un informe',
    client,
    plannerFn,
    driver: 'local',
    runId,
    onEvent: (ev) => {
      if (ev.type === 'node_done' && ev.node === 'a') steer(runId, 'usa solo el trimestre Q4');
    },
  });
  const analystCall = client.calls.find((c) => c.role === 'data_analyst');
  assert.ok(analystCall, 'steered node ran');
  assert.match(String(analystCall.messages[1].content), /usa solo el trimestre Q4/);
  assert.match(String(analystCall.messages[1].content), /Notas de la primera parte/, 'upstream blackboard entry still flows');
});

/* ── Cancel (F3 AbortSignal) ─────────────────────────────────────────────── */

test('F4: abort mid-node cancels the in-flight sub-agent — no further LLM calls, one "Cancelado", registry cleaned', async () => {
  const controller = new AbortController();
  const plannerFn = async () => ({
    nodes: [
      { id: 'solo', role: 'coder', goal: 'programa algo largo', dependsOn: [], budget: budgetOf(10) },
      { id: 'luego', role: 'document_editor', goal: 'documenta', dependsOn: ['solo'], budget: budgetOf(10) },
    ],
  });
  const client = repeatingClient(
    { toolCalls: [{ name: 'list_files', args: { path: '.' } }] },
    { onCall: () => controller.abort() }, // Stop pressed during the first LLM call
  );
  const events = [];
  const runId = 'run-abort-f4';
  await assert.rejects(
    runOrchestrator({
      instruction: 'investiga y luego crea un informe word',
      client,
      plannerFn,
      driver: 'local',
      runId,
      signal: controller.signal,
      onEvent: (ev) => events.push(ev),
    }),
    (err) => /abort/i.test(String(err?.name)) || /abort/i.test(String(err?.message)),
  );
  assert.equal(client.calls, 1, 'no LLM call after the abort');
  assert.equal(events.filter((e) => e.type === 'cancelled').length, 1, 'exactly one Cancelado trace');
  assert.equal(events.filter((e) => e.type === 'node_start').length, 1, 'the second node never starts');
  assert.equal(isOrchestratorRunActive(runId), false, 'no leaked live-run handle');
});

test('F4: abort during PLANNING cancels before any sub-agent starts', async () => {
  const controller = new AbortController();
  const plannerFn = async () => {
    controller.abort(); // Stop pressed while the director is thinking
    return { nodes: [{ id: 'x', role: 'coder', goal: 'nunca', dependsOn: [], budget: budgetOf(4) }] };
  };
  const client = repeatingClient({ content: 'nunca' });
  const events = [];
  await assert.rejects(
    runOrchestrator({
      instruction: 'investiga y luego crea un informe word',
      client,
      plannerFn,
      driver: 'local',
      signal: controller.signal,
      onEvent: (ev) => events.push(ev),
    }),
    (err) => /abort/i.test(String(err?.name)) || /abort/i.test(String(err?.message)),
  );
  assert.equal(client.calls, 0, 'no sub-agent ever ran');
  assert.equal(events.filter((e) => e.type === 'node_start').length, 0);
  assert.equal(events.filter((e) => e.type === 'cancelled').length, 1);
});

/* ── Honest failure: never the generic pipeline / create_document ────────── */

function rememberEnv(keys) {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test('F4: executeAgentRunnerTurn routes multi-step turns through the orchestrator and surfaces honest failures', async () => {
  const restoreEnv = rememberEnv(['SIRAGPT_AGENT_ORCHESTRATOR']);
  process.env.SIRAGPT_AGENT_ORCHESTRATOR = '1';
  try {
    const client = repeatingClient({ content: 'nunca debería llamarse' });
    const result = await agentRunner.executeAgentRunnerTurn({
      instruction: 'investiga las tendencias del mercado y luego crea un informe word con las conclusiones',
      client,
      driver: 'local',
      plannerFn: async () => { throw new PlanValidationError('plan roto a propósito'); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, false);
    assert.equal(result.orchestrated, true);
    assert.equal(result.stoppedReason, 'plan_failed');
    assert.match(String(result.errorMessage), /plan roto/);
    // The honest Spanish copy exists and forbids the generic template.
    const msg = agentRunner.buildAgentRunnerFailureMessage(result.stoppedReason, result.errorMessage);
    assert.match(msg, /director del agente/);
    assert.match(msg, /plantilla genérica/);
  } finally {
    restoreEnv();
  }
});

test('F4: with the kill switch OFF the same turn stays on the single-runner path', async () => {
  const restoreEnv = rememberEnv(['SIRAGPT_AGENT_ORCHESTRATOR']);
  process.env.SIRAGPT_AGENT_ORCHESTRATOR = '0';
  try {
    let plannerCalls = 0;
    // A single-runner loop that answers text-only and produces no file.
    const client = repeatingClient({ content: 'no generé nada' });
    const result = await agentRunner.executeAgentRunnerTurn({
      instruction: 'investiga las tendencias del mercado y luego crea un informe word con las conclusiones',
      client,
      driver: 'local',
      plannerFn: async () => { plannerCalls += 1; return { nodes: [] }; },
    });
    // The orchestrator (and its planner) is never consulted; the turn runs
    // as ONE AgentRunner loop and fails honestly without a file.
    assert.equal(plannerCalls, 0, 'planner never consulted with the switch off');
    assert.equal(result.orchestrated, undefined);
    assert.equal(result.ok, false);
    assert.equal(result.stoppedReason, 'no_output');
    assert.ok(client.calls >= 1, 'the single runner loop ran instead');
  } finally {
    restoreEnv();
  }
});

test('F4: chat — an orchestrator failure ends in the honest error, create_document and the pipeline stay unreachable', async () => {
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (c) => chunks.push(c.toString('utf-8')));
  stream.flushHeaders = () => {};
  stream.setHeader = () => {};

  const failingClient = repeatingClient({ content: 'no debería usarse' });
  const originalLoad = Module._load;
  Module._load = function patched(request) {
    if (request === './agent-runner' || request.endsWith('/agent-runner')) {
      return {
        ...agentRunner,
        hasConversationArtifacts: async () => false,
        // The REAL orchestrator drives the failure shape the chat consumes.
        executeAgentRunnerTurn: async (params) => runOrchestratorForChat({
          ...params,
          client: failingClient,
          driver: 'local',
          plannerFn: async () => { throw new PlanValidationError('sin plan'); },
        }),
      };
    }
    if (request === './source-preserving-document-edit' || request.endsWith('/source-preserving-document-edit')) {
      return {
        isSourcePreservingEditRequest: () => false,
        tryGenerateSourcePreservingDocumentEdit: async () => null,
      };
    }
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../src/services/agentic-chat-stream')];
  const fresh = require('../src/services/agentic-chat-stream');
  try {
    let createDocumentCalls = 0;
    const openai = {
      chat: {
        completions: {
          create: async () => {
            throw new Error('the generic LLM loop must be unreachable for a claimed runner-only failure');
          },
        },
      },
    };
    const result = await fresh.runAgenticChat({
      openai,
      model: 'gpt-4o-mini',
      userQuery: 'investiga las tendencias del mercado y luego crea un informe word con las conclusiones',
      history: [],
      res: stream,
      toolContext: { userId: 'u1', chatId: 'c1', fileIds: [], prisma: { generatedArtifact: { findMany: async () => [] } } },
      toolsOverride: [
        {
          name: 'create_document',
          description: 'create a NEW generic document',
          parameters: { type: 'object', properties: { filename: { type: 'string' } } },
          execute: async () => { createDocumentCalls += 1; throw new Error('create_document must be unreachable'); },
        },
      ],
    });
    assert.equal(result.stoppedReason, 'agent_runner_failed', 'claimed multi-step failure ends honestly');
    assert.equal(createDocumentCalls, 0, 'create_document never invoked');
    const payload = chunks.join('');
    assert.match(payload, /plantilla genérica/, 'honest Spanish error streamed to the user');
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../src/services/agentic-chat-stream')];
  }
});

test('F4: a failed working node fails the WHOLE run honestly (llm_402 propagates, no partial success)', async () => {
  const plannerFn = async () => ({
    nodes: [
      { id: 'a', role: 'researcher', goal: 'investiga', dependsOn: [], budget: budgetOf(6) },
      { id: 'b', role: 'document_editor', goal: 'redacta', dependsOn: ['a'], budget: budgetOf(6) },
    ],
  });
  let calls = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          calls += 1;
          if (calls === 1) return toResponse({ content: 'Notas listas.' });
          const err = new Error('This request requires more credits (402)');
          err.status = 402;
          throw err;
        },
      },
    },
  };
  const result = await runOrchestrator({
    instruction: 'investiga y luego redacta un informe',
    client,
    plannerFn,
    driver: 'local',
  });
  assert.equal(result.ok, false);
  assert.equal(result.stoppedReason, 'llm_402');
  const nodeStates = Object.fromEntries(result.nodes.map((n) => [n.id, n.status]));
  assert.equal(nodeStates.a, 'completed');
  assert.equal(nodeStates.b, 'failed');
});
