const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const taskStore = require('../src/services/agents/task-store');
const agentTaskRouter = require('../src/routes/agent-task');
const { INTERNAL } = agentTaskRouter;

test('agent task store assigns resumable event sequence ids', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-agent-seq-'));

  const base = taskStore.writeTaskSnapshot({
    taskId: 'task-seq',
    userId: 'user-a',
    displayGoal: 'Genera un informe largo',
    streamState: INTERNAL.initialAgentState(),
  });

  let state = INTERNAL.reduceAgentState(base.streamState, {
    type: 'queue_status',
    status: 'queued',
    queue: 'siragpt-agent-tasks',
    jobId: 'job-1',
  });
  taskStore.appendTaskEvent(base, {
    type: 'queue_status',
    status: 'queued',
    queue: 'siragpt-agent-tasks',
    jobId: 'job-1',
  }, state);

  state = INTERNAL.reduceAgentState(state, {
    type: 'checkpoint',
    label: 'Plan guardado',
    status: 'saved',
  });
  taskStore.appendTaskEvent({ ...base, streamState: state }, {
    type: 'checkpoint',
    label: 'Plan guardado',
    status: 'saved',
  }, state);

  const loaded = taskStore.getTaskSnapshotForUser('task-seq', 'user-a');
  assert.equal(loaded.events.length, 2);
  assert.equal(loaded.events[0].seq, 1);
  assert.equal(loaded.events[1].seq, 2);
  assert.equal(loaded.events[1].id, 'task-seq:2');
});

test('agent state reducer keeps queue, document policy, gates and repairs', () => {
  let state = INTERNAL.initialAgentState();
  state = INTERNAL.reduceAgentState(state, {
    type: 'queue_status',
    status: 'running',
    queue: 'siragpt-agent-tasks',
    jobId: 'job-2',
  });
  state = INTERNAL.reduceAgentState(state, {
    type: 'document_policy',
    policy: { mode: 'doc_required', format: 'docx', template: 'business' },
  });
  state = INTERNAL.reduceAgentState(state, {
    type: 'quality_gate',
    gate: 'artifact_validation',
    passed: true,
    score: 94,
    summary: 'Validado',
  });
  state = INTERNAL.reduceAgentState(state, {
    type: 'repair_attempt',
    attempt: 1,
    status: 'resolved',
    message: 'Regenerado',
  });

  assert.equal(state.queue.status, 'running');
  assert.equal(state.documentPolicy.format, 'docx');
  assert.equal(state.qualityGates.length, 1);
  assert.equal(state.qualityGates[0].passed, true);
  assert.equal(state.repairs[0].status, 'resolved');
});
