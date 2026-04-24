const test = require('node:test');
const assert = require('node:assert/strict');

const agentTaskRouter = require('../src/routes/agent-task');
const { INTERNAL } = agentTaskRouter;

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

test('agent task route: stores intent alignment profile in meta state', () => {
  const state = INTERNAL.reduceAgentState(INTERNAL.initialAgentState(), {
    type: 'meta',
    taskId: 'task-intent',
    goal: 'Dame 5 articulos en el chat',
    model: 'gpt-4o',
    tools: ['web_search'],
    intentAlignmentProfile: { outputMode: 'inline', groundingMode: 'source_verification_required' },
  });

  assert.equal(state.meta.intentAlignmentProfile.outputMode, 'inline');
  assert.equal(state.meta.intentAlignmentProfile.groundingMode, 'source_verification_required');
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
  assert.equal(state.steps[0].toolCalls[0].output.preview, '10 sources');
});

test('agent task route: active task lookup is scoped to the owner', () => {
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

  const prompt = INTERNAL.buildAgentSystemPrompt('', [], null, intentAlignmentProfile);

  assert.match(prompt, /User intent alignment/);
  assert.match(prompt, /requested_count:5 articulos/);
  assert.doesNotMatch(prompt, /Dame 5 articulos/);
});
