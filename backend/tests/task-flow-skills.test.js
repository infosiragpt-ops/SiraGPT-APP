'use strict';

const { afterEach, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/services/agents/task-flow-store');
const createSkill = require('../src/skills/task_flow_create/handler');
const getSkill = require('../src/skills/task_flow_get/handler');
const listSkill = require('../src/skills/task_flow_list/handler');
const updateSkill = require('../src/skills/task_flow_update/handler');
const skillRunner = require('../src/services/agents/skill-runner');
const { buildTaskTools } = require('../src/services/agents/task-tools');

let previousDir;
let tmpDir;

beforeEach(() => {
  previousDir = process.env.SIRAGPT_TASK_FLOW_STORE_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-task-flow-skills-'));
  process.env.SIRAGPT_TASK_FLOW_STORE_DIR = tmpDir;
});

afterEach(() => {
  if (previousDir == null) delete process.env.SIRAGPT_TASK_FLOW_STORE_DIR;
  else process.env.SIRAGPT_TASK_FLOW_STORE_DIR = previousDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('task flow skills create, list, inspect, and revision-check updates', async () => {
  const ctx = { userId: 'user-a', chatId: 'chat-a', taskFlowStore: store };
  const created = await createSkill.execute({ goal: 'Prepare a report', currentStep: 'collect' }, ctx);
  assert.equal(created.ok, true);
  assert.equal(created.flow.status, 'running');

  const listed = await listSkill.execute({}, ctx);
  assert.equal(listed.count, 1);
  assert.equal(listed.flows[0].flowId, created.flow.flowId);

  const waiting = await updateSkill.execute({
    flowId: created.flow.flowId,
    expectedRevision: created.flow.revision,
    action: 'set_waiting',
    currentStep: 'await_source',
    waitJson: { kind: 'document' },
  }, ctx);
  assert.equal(waiting.ok, true);
  assert.equal(waiting.flow.status, 'waiting');

  const conflict = await updateSkill.execute({
    flowId: created.flow.flowId,
    expectedRevision: created.flow.revision,
    action: 'resume',
  }, ctx);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, 'revision_conflict');
  assert.equal(conflict.currentRevision, waiting.flow.revision);

  const inspected = await getSkill.execute({ flowId: created.flow.flowId }, ctx);
  assert.equal(inspected.ok, true);
  assert.deepEqual(inspected.waitJson, { kind: 'document' });
});

test('task flow skills do not reveal another owner flow', async () => {
  const created = await createSkill.execute({ goal: 'Private task' }, { userId: 'user-a', taskFlowStore: store });
  const inspected = await getSkill.execute({ flowId: created.flow.flowId }, { userId: 'user-b', taskFlowStore: store });
  assert.deepEqual(inspected, { ok: false, error: 'flow_not_found' });
});

test('link_task verifies ownership through the task store', async () => {
  const ctx = {
    userId: 'user-a',
    taskFlowStore: store,
    taskStore: {
      getTaskSnapshotForUser(taskId, userId) {
        return taskId === 'task-owned' && userId === 'user-a'
          ? { taskId, status: 'running', chatId: 'chat-a', updatedAt: new Date().toISOString() }
          : null;
      },
    },
  };
  const created = await createSkill.execute({ goal: 'Parent task' }, ctx);
  const denied = await updateSkill.execute({
    flowId: created.flow.flowId,
    expectedRevision: 1,
    action: 'link_task',
    childTask: { taskId: 'task-other' },
  }, ctx);
  assert.equal(denied.error, 'child_task_not_found');

  const linked = await updateSkill.execute({
    flowId: created.flow.flowId,
    expectedRevision: 1,
    action: 'link_task',
    childTask: { taskId: 'task-owned' },
  }, ctx);
  assert.equal(linked.ok, true);
  assert.equal(linked.childTasks[0].taskId, 'task-owned');
});

test('chat skill policy separates flow reads from flow mutations', async () => {
  const sandboxIds = new Set(skillRunner.listSkillDescriptors({ clearance: 'free' }).map((skill) => skill.id));
  assert.equal(sandboxIds.has('task_flow_list'), true);
  assert.equal(sandboxIds.has('task_flow_get'), true);
  assert.equal(sandboxIds.has('task_flow_create'), false);
  assert.equal(sandboxIds.has('task_flow_update'), false);

  const denied = await skillRunner.runSkill('task_flow_create', { goal: 'Denied mutation' }, {
    clearance: 'free',
    userId: 'user-a',
    taskFlowStore: store,
  });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /^skill_denied:/);

  const allowed = await skillRunner.runSkill('task_flow_create', { goal: 'Allowed mutation' }, {
    clearance: 'paid',
    userId: 'user-a',
    taskFlowStore: store,
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.result.flow.status, 'running');
});

test('background task tools expose policy-scoped native skills and execute them', async () => {
  const authenticatedTools = buildTaskTools({
    skillContext: { clearance: 'authenticated', userId: 'user-a', chatId: 'chat-a' },
  });
  const authenticatedRunSkill = authenticatedTools.find((tool) => tool.name === 'run_skill');
  const authenticatedPipeline = authenticatedTools.find((tool) => tool.name === 'run_skill_pipeline');
  assert.ok(authenticatedRunSkill);
  assert.ok(authenticatedPipeline);
  const authenticatedIds = new Set(authenticatedRunSkill.parameters.properties.skillId.enum);
  assert.equal(authenticatedIds.has('task_flow_list'), true);
  assert.equal(authenticatedIds.has('task_flow_get'), true);
  assert.equal(authenticatedIds.has('task_flow_create'), false);
  assert.equal(authenticatedIds.has('weather'), false);

  const paidTools = buildTaskTools({
    skillContext: { clearance: 'paid', userId: 'user-a', chatId: 'chat-a' },
  });
  const paidRunSkill = paidTools.find((tool) => tool.name === 'run_skill');
  const paidIds = new Set(paidRunSkill.parameters.properties.skillId.enum);
  assert.equal(paidIds.has('task_flow_create'), true);
  assert.equal(paidIds.has('task_flow_update'), true);
  assert.equal(paidIds.has('summarize'), true);
  assert.equal(paidIds.has('weather'), true);

  const created = await paidRunSkill.execute({
    skillId: 'task_flow_create',
    args: { goal: 'Run a durable background task', currentStep: 'plan' },
  }, {});
  assert.equal(created.ok, true);
  assert.equal(created.result.flow.status, 'running');
  assert.equal(store.getTaskFlowForUser(created.result.flow.flowId, 'user-a').userId, 'user-a');
  assert.equal(store.getTaskFlowForUser(created.result.flow.flowId, 'user-b'), null);
});
