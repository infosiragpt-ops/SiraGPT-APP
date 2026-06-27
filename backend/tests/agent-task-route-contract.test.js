const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.AGENT_TASK_PRISMA_SYNC = '0';

const agentTaskRouter = require('../src/routes/agent-task');
const { INTERNAL } = agentTaskRouter;
const taskStore = require('../src/services/agents/task-store');
const chatTaskScope = require('../src/services/agents/chat-task-scope');
const {
  buildCognitiveImprovementBundle,
} = require('../src/services/agents/cognitive-improvements');

test('agent task route: strips internal execution contracts from visible goals', () => {
  const raw = [
    'Creame en un word un chiste',
    '',
    '---',
    'siraGPT professional execution contract for agent_task:',
    'Operate as a long-running autonomous agent.',
    '---',
  ].join('\n');

  assert.equal(INTERNAL.normalizeDisplayGoal(raw), 'Creame en un word un chiste');
  assert.match(INTERNAL.extractProfessionalContract(raw), /long-running autonomous agent/);
});

test('agent task route: stores taskId in meta state for reload/resume', () => {
  const state = INTERNAL.reduceAgentState(INTERNAL.initialAgentState(), {
    type: 'meta',
    taskId: 'task-123',
    goal: 'Investiga fuentes',
    model: 'gpt-4o',
    tools: ['web_search'],
  });

  assert.equal(state.meta.taskId, 'task-123');
  assert.equal(state.meta.goal, 'Investiga fuentes');
});

test('agent task route: safeJsonStringify keeps oversized SSE events parseable', () => {
  const serialized = INTERNAL.safeJsonStringify({
    type: 'framework_status',
    taskId: 'task-large-json',
    seq: 7,
    active: {
      prompt: 'x'.repeat(80_000),
      nested: Array.from({ length: 200 }, (_, index) => ({
        index,
        body: 'payload '.repeat(1200),
      })),
    },
  });

  assert.ok(serialized.length <= 32_768);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.type, 'framework_status');
  assert.equal(parsed.taskId, 'task-large-json');
  assert.equal(parsed.seq, 7);
});

test('agent task route: safeJsonStringify preserves cognitive meta summary under a hard SSE budget', () => {
  const cognitive = buildCognitiveImprovementBundle({
    goal: 'Implementa 100 mejoras en el backend y mejora el cerebro del software',
  });
  const serialized = INTERNAL.safeJsonStringify({
    type: 'meta',
    taskId: 'task-cognitive-meta',
    goal: 'x'.repeat(80_000),
    model: 'gpt-4o',
    executionProfile: {
      version: 'test-profile',
      capabilities: { needsAgentRuntimeHardening: true },
      requiredTools: ['run_tests', ...Array.from({ length: 120 }, (_, index) => `tool_${index}`)],
      cognitiveImprovements: cognitive,
    },
    enterpriseRuntimeProfile: {
      agenticOperatingCore: {
        cognitiveImprovementCount: 100,
        activeCognitiveImprovementCount: cognitive.summary.activeControlCount,
      },
      toolRuntime: { authorizedTools: Array.from({ length: 120 }, (_, index) => `tool_${index}`) },
      qaPreflight: { decision: 'allow' },
      durableExecution: { status: 'running' },
      noisy: 'y'.repeat(120_000),
    },
    agenticOperatingCore: {
      version: 'test-core',
      core_id: 'core-cognitive-meta',
      trace_id: 'trace-cognitive-meta',
      summary: {
        cognitiveImprovementCount: 100,
        activeCognitiveImprovementCount: cognitive.summary.activeControlCount,
        cognitiveCategoryCount: 10,
      },
      cognitive_improvements: cognitive,
      validation: {
        reports_required: Array.from({ length: 80 }, (_, index) => `report_${index}`),
        deterministic_checks: [
          ...cognitive.validation_checks,
          ...Array.from({ length: 120 }, (_, index) => `extra_check_${index}`),
        ],
        qa_board_decision: 'allow',
      },
      observability: {
        trace_id: 'trace-cognitive-meta',
        events: [...cognitive.observability_events, ...Array.from({ length: 120 }, (_, index) => `event_${index}`)],
        metrics: [...cognitive.metrics, ...Array.from({ length: 120 }, (_, index) => `metric_${index}`)],
      },
    },
  }, 8192);

  assert.ok(serialized.length <= 8192);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.type, 'meta');
  assert.equal(parsed._compaction, 'meta_control_plane_summary');
  assert.equal(parsed.agenticOperatingCore.cognitive_improvements.summary.totalControlCount, 100);
  assert.equal(parsed.agenticOperatingCore.cognitive_improvements.summary.activeControlCount, 100);
  assert.ok(parsed.agenticOperatingCore.validation.deterministic_checks.includes('cognitive.e2e-user-journey-probe'));
});

test('agent task route: detects weak attachment tool-unavailable final answers', () => {
  assert.equal(
    INTERNAL.looksLikeAttachmentRecoveryNeeded('No pude usar docintel_retrieve en esta tarea (falló de forma repetida). Vuelve a intentarlo.'),
    true,
  );
  assert.equal(
    INTERNAL.looksLikeAttachmentRecoveryNeeded('Nota sobre verificación: docintel_analyze no está disponible por missing_scopes. La respuesta usa rag_retrieve.'),
    true,
  );
  assert.equal(
    INTERNAL.looksLikeAttachmentRecoveryNeeded('El total real combinado es 283000 USD y la fuente primaria es el DOCX.'),
    false,
  );
});

test('agent task route: meta state exposes compact OpenClaw runtime summary', () => {
  const state = INTERNAL.reduceAgentState(INTERNAL.initialAgentState(), {
    type: 'meta',
    taskId: 'task-openclaw',
    goal: 'Fusiona OpenClaw como agente autonomo',
    model: 'gpt-4o',
    tools: ['host_bash', 'run_tests'],
    openclawRuntimeProfile: {
      version: 'openclaw-capability-kernel-2026-05',
      trustBoundary: 'user_chat_context',
      signals: {
        externalRepoAdaptation: true,
        wantsAutonomousAgent: true,
        nativeRewriteRequired: false,
        likelyLongRunning: true,
      },
      capabilities: {
        nativeRepoAdaptation: true,
        autonomousExecution: true,
        taskPlanning: true,
        safeExternalActions: true,
        evidenceLedger: true,
      },
      routing: { reason: 'test' },
      executionDossier: {
        operatingMode: { primary: 'software_agent' },
        qualityGates: ['autonomous_plan_execute_verify_loop'],
        workPackets: [{ id: 'autonomous_runtime', label: 'Autonomous runtime', required: true }],
        riskControls: [{ risk: 'premature_autonomy_claim' }],
      },
    },
  });
  const serializable = INTERNAL.toSerializableAgentState(state);

  assert.equal(serializable.meta.openclawRuntime.signals.externalRepoAdaptation, true);
  assert.equal(serializable.meta.openclawRuntime.signals.wantsAutonomousAgent, true);
  assert.equal(serializable.meta.openclawRuntime.operatingMode, 'software_agent');
  assert.ok(serializable.meta.openclawRuntime.qualityGates.includes('autonomous_plan_execute_verify_loop'));
});

test('agent task route: keeps internal planning profiles out of visible meta state', () => {
  const state = INTERNAL.reduceAgentState(INTERNAL.initialAgentState(), {
    type: 'meta',
    taskId: 'task-intent',
    goal: 'Dame 5 articulos en el chat',
    model: 'gpt-4o',
    tools: ['web_search'],
    intentAlignmentProfile: { outputMode: 'inline', groundingMode: 'source_verification_required' },
    taskPlan: { phases: [{ id: 'source_research' }] },
  });

  assert.equal(state.meta.taskId, 'task-intent');
  assert.equal(state.meta.intentAlignmentProfile, undefined);
  assert.equal(state.meta.taskPlan, undefined);
});

test('agent task route: keeps UniversalTaskContract out of visible meta state', () => {
  const state = INTERNAL.reduceAgentState(INTERNAL.initialAgentState(), {
    type: 'meta',
    taskId: 'task-contract',
    goal: 'Creame un SVG de una casa',
    model: 'gpt-4o',
    tools: ['create_document', 'verify_artifact'],
    universalTaskContract: {
      pipeline: 'VisualArtifactPipeline',
      required_extension: '.svg',
      mime_type: 'image/svg+xml',
      artifact_type: 'svg',
    },
  });

  assert.equal(state.meta.taskId, 'task-contract');
  assert.equal(state.meta.universalTaskContract, undefined);
});

test('agent task route: keeps enterprise ExecutionGraph out of visible meta state', () => {
  const state = INTERNAL.reduceAgentState(INTERNAL.initialAgentState(), {
    type: 'meta',
    taskId: 'task-enterprise',
    goal: 'Crea una web SaaS',
    model: 'gpt-4o',
    tools: ['run_tests'],
    enterpriseExecutionGraph: {
      graph_id: 'eg_1234567890abcdef',
      architecture_layers: ['AgenticOperatingCore', 'WorkflowOrchestrator', 'SoftwareEngineeringPipeline'],
      durable_execution: { enabled: true },
      nodes: [{ id: 'release_controller' }],
    },
    enterpriseRuntimeProfile: {
      capabilities: ['SoftwareEngineeringPipeline', 'FullStackWebBuilder'],
    },
  });

  assert.equal(state.meta.taskId, 'task-enterprise');
  assert.equal(state.meta.enterpriseExecutionGraph, undefined);
  assert.equal(state.meta.enterpriseRuntimeProfile, undefined);
});

test('agent task route: system prompt includes UniversalTaskContract sovereignty rules', () => {
  const prompt = INTERNAL.buildAgentSystemPrompt('', [], null, null, null, null, {
    version: 'universal-task-contract-2026-04',
    primary_intent: 'visual_artifact',
    secondary_intents: [],
    pipeline: 'VisualArtifactPipeline',
    artifact_required: true,
    artifact_type: 'svg',
    required_extension: '.svg',
    mime_type: 'image/svg+xml',
    delivery_mode: 'downloadable-file',
    required_tools: ['create_document', 'verify_artifact', 'finalize'],
    source_requirements: { required: false, providers: [], verification_policy: 'none', recency_range: null, exclusions: [] },
    grounding_required: false,
    citations_required: false,
    user_constraints: ['required_extension:.svg'],
    implicit_constraints: ['format_sovereignty:.svg'],
    ambiguity_score: 0.1,
    risk_level: 'medium',
    validation_plan: [{ id: 'svg_parseable', stage: 'format_validation', check: 'parses_as_svg', expected: 'pass' }],
    final_delivery_rules: ['The final deliverable must be exactly .svg; no substitute format is allowed.'],
    multi_intent_dag: { enabled: false, nodes: [], edges: [] },
  });

  assert.match(prompt, /UNIVERSAL TASK CONTRACT/);
  assert.match(prompt, /required_extension/);
  assert.match(prompt, /\.svg/);
  assert.match(prompt, /Never substitute formats/);
});

test('agent task route: system prompt includes enterprise ExecutionGraph rules', () => {
  const enterpriseExecutionGraph = {
    graph_id: 'eg_1234567890abcdef',
    idempotency_key: 'idem_1234567890abcdef1234',
    pipeline: 'CodePipeline',
    durable_execution: { enabled: true, state_store: 'task-store' },
    human_in_the_loop: { required: false },
    gates: { validation_gate: ['tests_or_build_executed'], release_gate: ['ReleaseController approved'] },
    qa_board: { reports_required: ['ValidationReport'], reviewers: ['ReleaseController'] },
    nodes: [
      {
        id: 'validation_fabric',
        layer: 'ValidationFabric',
        agent_role: 'QA',
        tools: [],
        dependencies: [],
      },
      {
        id: 'release_controller',
        layer: 'HumanInTheLoopControlCenter',
        agent_role: 'ReleaseController',
        tools: [],
        dependencies: ['validation_fabric'],
      },
    ],
  };
  const prompt = INTERNAL.buildAgentSystemPrompt('', [], null, null, null, null, null, enterpriseExecutionGraph, {
    capabilities: ['SoftwareEngineeringPipeline'],
  });

  assert.match(prompt, /ENTERPRISE EXECUTION GRAPH/);
  assert.match(prompt, /validation_fabric/);
  assert.match(prompt, /ReleaseController/);
});

test('agent task route: system prompt includes OpenClaw autonomous runtime block when provided', () => {
  const openclawProfile = {
    version: 'openclaw-capability-kernel-2026-05',
    trustBoundary: 'user_chat_context',
    signals: {
      externalRepoAdaptation: true,
      wantsAutonomousAgent: true,
      nativeRewriteRequired: false,
      likelyLongRunning: true,
    },
    tools: ['memory_recall', 'host_bash', 'host_file', 'run_tests'],
    routing: { reason: 'test' },
    executionDossier: {
      operatingMode: { primary: 'software_agent', confidence: 0.9 },
      evidenceChannels: [{ name: 'current_user_message', present: true, trust: 'medium' }],
      workPackets: [{ label: 'Preserve autonomous loop', doneWhen: 'verified' }],
      toolPlan: { selected: ['host_bash', 'run_tests'], missingFamilies: [] },
      qualityGates: ['autonomous_plan_execute_verify_loop'],
      riskControls: [{ risk: 'premature_autonomy_claim', mitigation: 'verify first' }],
    },
  };
  const prompt = INTERNAL.buildAgentSystemPrompt(
    '',
    [],
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    '',
    openclawProfile
  );

  assert.match(prompt, /OpenClaw-Level Runtime Policy/);
  assert.match(prompt, /autonomous-agent software requests/);
  assert.match(prompt, /autonomous_plan_execute_verify_loop/);
});


test('agent task route: does not drop tool events emitted without a current step', () => {
  let state = INTERNAL.initialAgentState();
  state = INTERNAL.reduceAgentState(state, {
    type: 'tool_call',
    stepId: null,
    tool: 'web_search',
    preview: 'OpenAlex query',
  });
  state = INTERNAL.reduceAgentState(state, {
    type: 'tool_output',
    stepId: state.steps[0].id,
    tool: 'web_search',
    ok: true,
    preview: '10 sources',
  });

  assert.equal(state.steps.length, 1);
  assert.equal(state.steps[0].toolCalls.length, 1);
  assert.equal(state.steps[0].toolCalls[0].output.ok, true);
  assert.equal(state.steps[0].toolCalls[0].preview, undefined);
});

test('agent task route: active task lookup is scoped to the owner', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-agent-route-store-'));
  const controller = new AbortController();
  const task = INTERNAL.createTaskRecord({
    taskId: 'task-owned',
    userId: 'user-a',
    chatId: 'chat-a',
    displayGoal: 'Genera un Excel',
    model: 'gpt-4o',
    controller,
    maxSteps: 10,
    maxRuntimeMs: 60000,
    streamState: INTERNAL.initialAgentState(),
  });

  assert.equal(INTERNAL.getTaskForUser(task.taskId, 'user-a').taskId, task.taskId);
  assert.equal(INTERNAL.getTaskForUser(task.taskId, 'user-b'), null);
  assert.equal(taskStore.getTaskSnapshotForUser(task.taskId, 'user-a').taskId, task.taskId);
  assert.equal(taskStore.getTaskSnapshotForUser(task.taskId, 'user-b'), null);
  INTERNAL.ACTIVE_AGENT_TASKS.delete(task.taskId);
});

test('agent task route: appendTaskEvent persists reloadable checkpoints', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-agent-route-store-'));
  const task = INTERNAL.createTaskRecord({
    taskId: 'task-reloadable',
    userId: 'user-a',
    chatId: 'chat-a',
    displayGoal: 'Trabaja 5 horas',
    model: 'gpt-4o',
    controller: new AbortController(),
    maxSteps: 20,
    maxRuntimeMs: 7200000,
    streamState: INTERNAL.initialAgentState(),
  });
  const state = INTERNAL.reduceAgentState(task.streamState, {
    type: 'step_start',
    id: 's1',
    label: 'Plan estructurado',
    icon: 'thought',
  });

  INTERNAL.appendTaskEvent(task, { type: 'step_start', id: 's1', label: 'Plan estructurado', icon: 'thought' }, state);

  const payload = INTERNAL.formatTaskPayload(taskStore.getTaskSnapshotForUser('task-reloadable', 'user-a'));
  assert.equal(payload.taskId, 'task-reloadable');
  assert.equal(payload.streamState.steps.length, 1);
  assert.equal(payload.checkpoints.length, 1);
  INTERNAL.ACTIVE_AGENT_TASKS.delete(task.taskId);
});

test('agent task route: createTaskRecord persists OpenClaw runtime profile for retry', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-agent-route-store-'));
  const openclawRuntimeProfile = {
    version: 'openclaw-capability-kernel-2026-05',
    signals: { externalRepoAdaptation: true, wantsAutonomousAgent: true },
    capabilities: { autonomousExecution: true, nativeRepoAdaptation: true },
  };
  const task = INTERNAL.createTaskRecord({
    taskId: 'task-openclaw-retry',
    userId: 'user-a',
    chatId: 'chat-a',
    displayGoal: 'Fusiona OpenClaw como agente autonomo',
    model: 'gpt-4o',
    controller: new AbortController(),
    maxSteps: 20,
    maxRuntimeMs: 7200000,
    streamState: INTERNAL.initialAgentState(),
    openclawRuntimeProfile,
  });

  const payload = INTERNAL.formatTaskPayload(taskStore.getTaskSnapshotForUser('task-openclaw-retry', 'user-a'));
  assert.equal(payload.openclawRuntimeProfile.version, 'openclaw-capability-kernel-2026-05');
  assert.equal(payload.openclawRuntimeProfile.signals.wantsAutonomousAgent, true);
  INTERNAL.ACTIVE_AGENT_TASKS.delete(task.taskId);
});

test('agent task route: system prompt keeps hidden contract separate from user goal', () => {
  const prompt = INTERNAL.buildAgentSystemPrompt('Verify every document before finalizing.', ['file_1']);

  assert.match(prompt, /Additional execution contract/);
  assert.match(prompt, /Verify every document/);
  assert.match(prompt, /file_1/);
  assert.doesNotMatch(INTERNAL.normalizeDisplayGoal('Haz un resumen'), /execution contract/i);
});

test('agent task route: system prompt includes deep document analysis contract for document summaries', () => {
  const prompt = INTERNAL.buildAgentSystemPrompt(
    '',
    ['TESIS 2 - JESSICA PATINO - 15JUN2026.docx'],
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    '',
    null,
    'dame un resumen en un solo parrafo',
  );

  assert.match(prompt, /CONTRATO DE ANALISIS DOCUMENTAL PROFUNDO/);
  assert.match(prompt, /cubra el documento completo/);
  assert.match(prompt, /resultados, conclusiones/);
});

test('agent task route: chat-only attached document/image tasks bypass queued runtime by default', () => {
  assert.equal(
    INTERNAL.shouldRunAttachmentTaskLocally({
      fileIds: ['file-docx-1'],
      goal: 'dame un resumen en dos parrafos',
      documentPolicy: { mode: 'chat_only', autoGenerate: false },
      env: {},
    }),
    true,
  );
  assert.equal(
    INTERNAL.shouldRunAttachmentTaskLocally({
      fileIds: [],
      goal: 'transcribe esta imagen',
      documentPolicy: { mode: 'chat_only', autoGenerate: false },
      env: {},
    }),
    true,
  );
  assert.equal(
    INTERNAL.shouldRunAttachmentTaskLocally({
      fileIds: ['file-docx-1'],
      goal: 'dame un resumen en dos parrafos',
      documentPolicy: { mode: 'chat_only', autoGenerate: false },
      env: { AGENT_TASK_QUEUE_ATTACHMENTS: '1' },
    }),
    false,
  );
  assert.equal(
    INTERNAL.shouldRunAttachmentTaskLocally({
      fileIds: [],
      goal: 'investiga el tema sin adjuntos',
      documentPolicy: { mode: 'chat_only', autoGenerate: false },
      env: {},
    }),
    false,
  );
});

test('agent task route: document deliverables with attachments stay on the background worker', () => {
  assert.equal(
    INTERNAL.shouldRunAttachmentTaskLocally({
      fileIds: ['file-docx-1'],
      goal: 'corrige la redacción y devuélveme el documento completo',
      documentPolicy: { mode: 'doc_required', autoGenerate: true },
      env: {},
    }),
    false,
  );
  assert.equal(
    INTERNAL.shouldRunAttachmentTaskLocally({
      fileIds: ['file-xlsx-1'],
      goal: 'agrega esta hoja y devuelve el Excel actualizado',
      documentPolicy: { mode: 'doc_required', autoGenerate: true },
      env: {},
    }),
    false,
  );
});

test('agent task route: queued stream timeout is longer for heavy document runs', () => {
  const taskId = 'task-document-timeout';
  const userId = 'user-document-timeout';
  const task = INTERNAL.createTaskRecord({
    taskId,
    userId,
    chatId: 'chat-document-timeout',
    displayGoal: 'edita el documento completo',
    model: 'gpt-4o',
    controller: new AbortController(),
    maxSteps: 60,
    maxRuntimeMs: 7200000,
    streamState: INTERNAL.initialAgentState(),
    documentPolicy: { mode: 'doc_required', autoGenerate: true },
    status: 'queued',
  });
  try {
    assert.equal(
      INTERNAL.resolveQueuedStreamTimeoutMs({ taskId, userId, env: {} }),
      3 * 60 * 60 * 1000,
    );
    assert.equal(
      INTERNAL.resolveQueuedStreamTimeoutMs({ taskId, userId, env: { AGENT_RESPONSE_TIMEOUT_MS: '90000' } }),
      90000,
    );
  } finally {
    INTERNAL.ACTIVE_AGENT_TASKS.delete(task.taskId);
  }
});

test('agent task route: system prompt includes intent alignment without echoing the user prompt', () => {
  const intentAlignmentProfile = {
    version: 'test-profile',
    taxonomy: 'generation',
    outputMode: 'inline',
    requestedFormat: null,
    groundingMode: 'source_verification_required',
    hardConstraints: ['requested_count:5 articulos'],
    responsePolicy: ['answer_the_actual_request_first', 'do_not_create_file_unless_user_asked'],
  };

  const prompt = INTERNAL.buildAgentSystemPrompt('', [], null, intentAlignmentProfile, {
    version: 'test-plan',
    objective: 'generation:inline',
    outputMode: 'inline',
    groundingMode: 'source_verification_required',
    phases: [{ id: 'source_research', role: 'research', objective: 'Collect verified sources.', checkpoint: 'Enough evidence.' }],
    successCriteria: ['No fabricated citations.'],
    risks: ['Premature finalization.'],
  });

  assert.match(prompt, /User intent alignment/);
  assert.match(prompt, /Internal task plan/);
  assert.match(prompt, /source_research/);
  assert.match(prompt, /requested_count:5 articulos/);
  assert.doesNotMatch(prompt, /Dame 5 articulos/);
});

test('agent task stream: normal request close does not cut off later task events', async () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-agent-stream-store-'));
  const task = INTERNAL.createTaskRecord({
    taskId: 'task-stream-close',
    userId: 'user-a',
    chatId: 'chat-a',
    displayGoal: 'transcribir imagen',
    model: 'gpt-4o',
    controller: new AbortController(),
    maxSteps: 10,
    maxRuntimeMs: 60000,
    streamState: INTERNAL.initialAgentState(),
  });
  const firstEvent = { type: 'queue_status', taskId: task.taskId, status: 'running', queue: 'local-agent-task' };
  let state = INTERNAL.reduceAgentState(task.streamState, firstEvent);
  INTERNAL.appendTaskEvent(task, firstEvent, state);

  const req = new EventEmitter();
  const chunks = [];
  const res = new EventEmitter();
  res.writableEnded = false;
  res.destroyed = false;
  res.setHeader = () => {};
  res.flushHeaders = () => {};
  res.setTimeout = () => {};
  res.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  res.end = () => {
    res.writableEnded = true;
    res.emit('finish');
  };

  assert.equal(typeof INTERNAL.streamTaskEvents, 'function');
  INTERNAL.streamTaskEvents(req, res, task.taskId, 'user-a');

  // In a browser POST+SSE request the request side can emit `close`
  // once the upload body is consumed while the response stream remains
  // alive. This must not close the SSE response before worker events land.
  req.emit('close');

  const doneEvent = { type: 'done', stoppedReason: 'transcription_finalize', stats: { steps: 1, artifacts: 0 } };
  state = INTERNAL.reduceAgentState(state, doneEvent);
  INTERNAL.appendTaskEvent(task, doneEvent, state);
  task.status = 'completed';
  taskStore.markTaskStatus(task, 'completed', { streamState: state });

  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.match(chunks.join(''), /"type":"done"/);
  assert.equal(res.writableEnded, true);
  INTERNAL.ACTIVE_AGENT_TASKS.delete(task.taskId);
});

test('chat-task-scope: prisma validates chat ownership', async () => {
  const prismaMock = {
    chat: {
      findFirst: async ({ where }) => (where.id === 'owned' ? { id: 'owned' } : null),
    },
  };
  const ok = await chatTaskScope.assertChatScopeForAgentTask({
    prisma: prismaMock,
    userId: 'user-1',
    body: { chatId: 'owned' },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.chatId, 'owned');

  const denied = await chatTaskScope.assertChatScopeForAgentTask({
    prisma: prismaMock,
    userId: 'user-1',
    body: { chatId: 'foreign' },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 404);
});
