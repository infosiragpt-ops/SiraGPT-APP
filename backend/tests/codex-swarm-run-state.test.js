'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  inspectSwarmRunState,
} = require('../src/services/codex/swarm-run-state');

function prismaWithSwarm(status, cancelRequestedAt = null) {
  return {
    codexSwarmTask: {
      findUnique: async () => ({
        id: 'task-1',
        swarm: {
          id: 'swarm-1',
          status,
          cancelRequestedAt,
        },
      }),
    },
  };
}

test('unlinked runs remain recoverable and executable', async () => {
  const state = await inspectSwarmRunState({ prisma: {}, run: { id: 'run-1' } });
  assert.equal(state.linked, false);
  assert.equal(state.recoverable, true);
  assert.equal(state.executable, true);
  assert.equal(state.deferred, false);
  assert.equal(state.resumable, true);
});

for (const status of ['queued', 'running']) {
  test(`${status} swarms may recover and execute linked runs`, async () => {
    const state = await inspectSwarmRunState({
      prisma: prismaWithSwarm(status),
      run: { id: 'run-1', swarmTaskId: 'task-1' },
    });
    assert.equal(state.recoverable, true);
    assert.equal(state.executable, true);
    assert.equal(state.deferred, false);
    assert.equal(state.resumable, true);
    assert.equal(state.reason, 'swarm_active');
  });
}

test('paused swarms defer restart recovery but preserve explicit resume continuity', async () => {
  const state = await inspectSwarmRunState({
    prisma: prismaWithSwarm('paused'),
    run: { id: 'run-1', swarmTaskId: 'task-1' },
  });
  assert.equal(state.recoverable, false);
  assert.equal(state.executable, true);
  assert.equal(state.deferred, true);
  assert.equal(state.resumable, true);
  assert.equal(state.reason, 'swarm_paused');
});

for (const status of ['completed', 'completed_with_errors', 'failed']) {
  test(`${status} swarms cannot recover or execute linked runs`, async () => {
    const state = await inspectSwarmRunState({
      prisma: prismaWithSwarm(status),
      run: { id: 'run-1', swarmTaskId: 'task-1' },
    });
    assert.equal(state.recoverable, false);
    assert.equal(state.executable, false);
    assert.equal(state.deferred, false);
    assert.equal(state.resumable, false);
    assert.equal(state.cancelled, false);
    assert.equal(state.reason, 'swarm_terminal');
  });
}

for (const status of ['cancelling', 'cancelled']) {
  test(`${status} swarms cancel linked runs`, async () => {
    const state = await inspectSwarmRunState({
      prisma: prismaWithSwarm(status),
      run: { id: 'run-1', swarmTaskId: 'task-1' },
    });
    assert.equal(state.recoverable, false);
    assert.equal(state.executable, false);
    assert.equal(state.deferred, false);
    assert.equal(state.resumable, false);
    assert.equal(state.cancelled, true);
    assert.equal(state.reason, 'swarm_cancelled');
  });
}

test('unknown swarm states fail closed', async () => {
  const state = await inspectSwarmRunState({
    prisma: prismaWithSwarm('mystery'),
    run: { id: 'run-1', swarmTaskId: 'task-1' },
  });
  assert.equal(state.recoverable, false);
  assert.equal(state.executable, false);
  assert.equal(state.deferred, false);
  assert.equal(state.resumable, false);
  assert.equal(state.reason, 'swarm_status_invalid');
});
