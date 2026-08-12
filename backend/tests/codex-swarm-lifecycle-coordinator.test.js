'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  cancelRunFamiliesReliably,
  launchFleetSafely,
} = require('../src/services/codex/swarm-lifecycle-coordinator');

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function launchHarness(initialBrief) {
  let brief = copy(initialBrief);
  const calls = [];
  const project = { id: 'project-1', userId: 'user-1', brief: copy(initialBrief) };
  const briefStore = {
    async mutateProjectBrief({ mutate }) {
      calls.push('mutateBrief');
      brief = copy(await mutate(copy(brief), { ...project, brief: copy(brief) }));
      return { project, brief: copy(brief) };
    },
  };
  const proactiveLease = {
    async acquireProactiveLease() {
      calls.push('acquireLease');
      return { projectId: project.id, token: 'lease-1', local: true };
    },
    async releaseProactiveLease() {
      calls.push('releaseLease');
    },
  };
  return {
    briefStore,
    calls,
    getBrief: () => copy(brief),
    prisma: {},
    proactiveLease,
    project,
  };
}

for (const enabled of [true, false]) {
  test(`fleet launch keeps PROACTIVO intact through creation and only suspends it after acceptance (previous=${enabled})`, async () => {
    const initialBrief = {
      objective: 'ship safely',
      proactive: {
        enabled,
        enabledAt: '2026-08-11T10:00:00.000Z',
        runsToday: 17,
        customFutureField: { keep: true },
        fleetMode: enabled ? 'all-departments' : null,
        continuity: enabled ? 'permanent-until-paused' : null,
      },
    };
    const h = launchHarness(initialBrief);
    const result = await launchFleetSafely({
      prisma: h.prisma,
      project: h.project,
      userId: h.project.userId,
      proactiveLease: h.proactiveLease,
      briefStore: h.briefStore,
      createFleet: async () => {
        h.calls.push('createFleet');
        assert.deepEqual(h.getBrief(), initialBrief, 'planner/create must see the exact prior state');
        return { swarm: { id: 'swarm-1' } };
      },
      hasActiveRun: async () => {
        h.calls.push('hasActiveRun');
        return false;
      },
      enqueueSwarm: async () => {
        h.calls.push('enqueueSwarm');
        assert.equal(h.getBrief().proactive.enabled, false);
      },
      cancelSwarm: async () => {
        assert.fail('accepted launch must not be compensated');
      },
    });

    assert.equal(result.fleet.swarm.id, 'swarm-1');
    assert.equal(result.proactiveWasEnabled, enabled);
    if (enabled) {
      assert.deepEqual(h.getBrief(), {
        ...initialBrief,
        proactive: {
          ...initialBrief.proactive,
          enabled: false,
          fleetMode: null,
          continuity: null,
        },
      });
    } else {
      assert.deepEqual(h.getBrief(), initialBrief);
    }
    assert.deepEqual(h.calls, [
      'acquireLease',
      'createFleet',
      'mutateBrief',
      'hasActiveRun',
      'enqueueSwarm',
      'releaseLease',
    ]);
  });
}

for (const enabled of [true, false]) {
  for (const phase of ['planner', 'create']) {
    test(`${phase} failure preserves exact PROACTIVO state (previous=${enabled})`, async () => {
      const initialBrief = {
        proactive: {
          enabled,
          runsToday: 9,
          opaque: ['must', 'survive'],
        },
      };
      const h = launchHarness(initialBrief);
      const failure = Object.assign(new Error(`${phase} failed`), {
        code: `fleet_${phase}_failed`,
        status: 422,
      });
      await assert.rejects(
        launchFleetSafely({
          prisma: h.prisma,
          project: h.project,
          userId: h.project.userId,
          proactiveLease: h.proactiveLease,
          briefStore: h.briefStore,
          createFleet: async () => { throw failure; },
          enqueueSwarm: async () => assert.fail('enqueue must not run'),
          cancelSwarm: async () => assert.fail('no durable swarm exists to cancel'),
        }),
        (error) => error === failure,
      );
      assert.deepEqual(h.getBrief(), initialBrief);
      assert.deepEqual(h.calls, ['acquireLease', 'releaseLease']);
    });
  }
}

for (const initialBrief of [
  {
    proactive: {
      enabled: true,
      runsToday: 23,
      nested: { exact: 'yes' },
      fleetMode: 'all-departments',
      continuity: 'permanent-until-paused',
    },
  },
  { objective: 'PROACTIVO was never configured' },
]) {
  const label = Object.prototype.hasOwnProperty.call(initialBrief, 'proactive') ? 'on' : 'absent/off';
  test(`enqueue failure cancels the new swarm and restores PROACTIVO exactly (${label})`, async () => {
    const h = launchHarness(initialBrief);
    const cancelled = [];
    const queueError = Object.assign(new Error('redis unavailable'), { code: 'swarm_queue_unavailable' });
    await assert.rejects(
      launchFleetSafely({
        prisma: h.prisma,
        project: h.project,
        userId: h.project.userId,
        proactiveLease: h.proactiveLease,
        briefStore: h.briefStore,
        createFleet: async () => ({ swarm: { id: 'swarm-new' } }),
        hasActiveRun: async () => false,
        enqueueSwarm: async () => { throw queueError; },
        cancelSwarm: async (args) => { cancelled.push(args); },
      }),
      (error) => error === queueError,
    );
    assert.deepEqual(cancelled, [{ swarmId: 'swarm-new', reason: 'swarm_launch_not_accepted' }]);
    assert.deepEqual(h.getBrief(), initialBrief);
    assert.equal(h.calls.at(-1), 'releaseLease');
  });
}

test('a run that appears during planning aborts launch under the lease and restores PROACTIVO', async () => {
  const initialBrief = { proactive: { enabled: true, runsToday: 3 } };
  const h = launchHarness(initialBrief);
  let enqueued = false;
  let cancelled = false;
  await assert.rejects(
    launchFleetSafely({
      prisma: h.prisma,
      project: h.project,
      userId: h.project.userId,
      proactiveLease: h.proactiveLease,
      briefStore: h.briefStore,
      createFleet: async () => ({ swarm: { id: 'swarm-raced' } }),
      hasActiveRun: async () => true,
      enqueueSwarm: async () => { enqueued = true; },
      cancelSwarm: async () => { cancelled = true; },
    }),
    (error) => error.code === 'run_in_progress' && error.status === 409,
  );
  assert.equal(enqueued, false);
  assert.equal(cancelled, true);
  assert.deepEqual(h.getBrief(), initialBrief);
});

test('launch fails closed while a PROACTIVO cycle owns the project lease', async () => {
  const h = launchHarness({ proactive: { enabled: true } });
  h.proactiveLease.acquireProactiveLease = async () => null;
  await assert.rejects(
    launchFleetSafely({
      prisma: h.prisma,
      project: h.project,
      userId: h.project.userId,
      proactiveLease: h.proactiveLease,
      briefStore: h.briefStore,
      createFleet: async () => assert.fail('planner must wait for the active cycle'),
      enqueueSwarm: async () => assert.fail('enqueue must wait for the active cycle'),
    }),
    (error) => error.code === 'codex_proactive_cycle_in_progress' && error.status === 409,
  );
});

test('run family cancellation retries transient failures and reports success', async () => {
  const attempts = new Map();
  const summary = await cancelRunFamiliesReliably({
    runIds: ['plan-1', 'plan-1', 'plan-2'],
    cancelRunFamily: async (runId) => {
      const attempt = (attempts.get(runId) || 0) + 1;
      attempts.set(runId, attempt);
      if (runId === 'plan-2' && attempt === 1) throw new Error('temporary database timeout');
      return { cancelledRunIds: [runId, `${runId}-build`] };
    },
  });
  assert.equal(summary.complete, true);
  assert.equal(summary.requested, 2);
  assert.equal(summary.cancelled, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.results.find((row) => row.runId === 'plan-2').attempts, 2);
});

test('run family cancellation exposes permanent partial failures after bounded retries', async () => {
  const summary = await cancelRunFamiliesReliably({
    runIds: ['plan-ok', 'plan-stuck'],
    maxAttempts: 2,
    cancelRunFamily: async (runId) => {
      if (runId === 'plan-stuck') {
        const error = new Error('worker did not acknowledge cancellation');
        error.code = 'codex_cancel_timeout';
        throw error;
      }
      return { cancelledRunIds: [runId] };
    },
  });
  assert.equal(summary.complete, false);
  assert.equal(summary.cancelled, 1);
  assert.equal(summary.failed, 1);
  const failed = summary.results.find((row) => row.runId === 'plan-stuck');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 2);
  assert.deepEqual(failed.errors.map((row) => row.code), [
    'codex_cancel_timeout',
    'codex_cancel_timeout',
  ]);
});

test('run family cancellation keeps fan-out within the configured worker bound', async () => {
  let active = 0;
  let peak = 0;
  const summary = await cancelRunFamiliesReliably({
    runIds: Array.from({ length: 40 }, (_, index) => `plan-${index + 1}`),
    concurrency: 5,
    cancelRunFamily: async (runId) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return { cancelledRunIds: [runId] };
    },
  });
  assert.equal(summary.complete, true);
  assert.equal(summary.requested, 40);
  assert.equal(peak, 5);
});
