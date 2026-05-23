const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agentTaskRouter = require('../src/routes/agent-task');
const { INTERNAL } = agentTaskRouter;
const taskStore = require('../src/services/agents/task-store');

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

test('agent task route: system prompt keeps hidden contract separate from user goal', () => {
  const prompt = INTERNAL.buildAgentSystemPrompt('Verify every document before finalizing.', ['file_1']);

  assert.match(prompt, /Additional execution contract/);
  assert.match(prompt, /Verify every document/);
  assert.match(prompt, /file_1/);
  assert.doesNotMatch(INTERNAL.normalizeDisplayGoal('Haz un resumen'), /execution contract/i);
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
