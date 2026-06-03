'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildWorkspaceWorkflowJob,
  MAX_RUNTIME_MS,
} = require('../src/services/agents/workspace-workflow-orchestrator');

describe('workspace-workflow-orchestrator', () => {
  it('builds queued payload with plan phases and chain sub-tasks', () => {
    const built = buildWorkspaceWorkflowJob({
      goal: 'Implement auth module with tests and deploy to staging',
      user: { id: 'user-1', email: 'a@test.com' },
      maxRuntimeMs: MAX_RUNTIME_MS,
      model: 'claude-opus-4-20250514',
    });
    assert.equal(built.ok, true);
    assert.ok(built.taskId);
    assert.ok(built.payload?.systemContract?.includes('WORKSPACE ORCHESTRATOR CONTRACT'));
    assert.ok(Array.isArray(built.plan?.phases));
    assert.ok(built.subTasks.length >= 1);
    assert.equal(built.payload.maxRuntimeMs, MAX_RUNTIME_MS);
    assert.equal(built.payload.workflow.pattern, 'chain');
  });

  it('uses fork_join for explicit agent-runtime hardening workflows', () => {
    const built = buildWorkspaceWorkflowJob({
      goal: 'Sigamos mejorando los agentes del sofware para que trabajen de manera autonoma',
      user: { id: 'user-1', email: 'a@test.com' },
      model: 'claude-opus-4-20250514',
    });

    assert.equal(built.ok, true);
    assert.equal(built.payload.workflow.pattern, 'fork_join');
    assert.ok(built.plan.phases.some((phase) => phase.id === 'agent_runtime_diagnostics'));
    assert.equal(built.plan.agentRuntimeHardening.active, true);
  });

  it('rejects empty goal', () => {
    const built = buildWorkspaceWorkflowJob({ goal: '  ', user: { id: 'u' } });
    assert.equal(built.ok, false);
  });
});
