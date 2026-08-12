'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

function mockResolvedModule(resolvedPath, exports) {
  const original = require.cache[resolvedPath];
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports,
  };
  return () => {
    if (original) require.cache[resolvedPath] = original;
    else delete require.cache[resolvedPath];
  };
}

let project;
let createFleetImpl;
let enqueueImpl;
let hasActiveRunImpl;
let cancelFamilyImpl;
let resumeRecoveryImpl;
let createdSwarm;
let linkedTasks;
let linkedRuns;
let activeProjectRuns;
const calls = [];

const fakeDb = {
  codexProject: {
    findFirst: async ({ where }) => (
      where.id === project.id && where.userId === project.userId ? { ...project } : null
    ),
    update: async ({ data }) => {
      project = { ...project, ...data };
      return { ...project };
    },
  },
  codexSwarm: {
    findFirst: async ({ where }) => (
      where.id === 'swarm-1' && where.projectId === project.id && where.userId === project.userId
        ? { id: 'swarm-1', projectId: project.id, userId: project.userId, status: 'running' }
        : null
    ),
  },
  codexSwarmTask: {
    findMany: async (args) => {
      calls.push(['findSwarmTasks', args]);
      return linkedTasks;
    },
  },
  codexRun: {
    findMany: async (args) => {
      if (args.where?.swarmTaskId) {
        calls.push(['findLinkedRuns', args]);
        return linkedRuns;
      }
      calls.push(['findActiveProjectRuns', args]);
      return activeProjectRuns;
    },
  },
};

const restores = [];
restores.push(mockResolvedModule(require.resolve('../src/config/database'), fakeDb));
restores.push(mockResolvedModule(require.resolve('../src/middleware/auth'), {
  authenticateToken(req, _res, next) {
    req.user = { id: 'user-1', isAdmin: true, isSuperAdmin: false };
    next();
  },
}));
restores.push(mockResolvedModule(require.resolve('../src/services/codex/flags'), {
  isCodexV2Enabled: () => true,
}));
restores.push(mockResolvedModule(require.resolve('../src/services/codex/access-control'), {
  canUseCodexAgent: () => true,
  publicAccess: () => ({ canRun: true, allowlistConfigured: true }),
}));
restores.push(mockResolvedModule(require.resolve('../src/services/codex/project-service'), {
  createProject: async () => ({}),
  listProjects: async () => [],
  getProject: async () => null,
}));
restores.push(mockResolvedModule(require.resolve('../src/services/codex/sandbox-provider'), {
  createSandboxClient: () => ({}),
}));
restores.push(mockResolvedModule(require.resolve('../src/services/codex/runner-client'), {
  runnerDevUrl: () => 'http://localhost:5173',
  codexExportHostPath: () => '/tmp/export',
}));
restores.push(mockResolvedModule(require.resolve('../src/services/codex/event-store'), {
  createSeqGate: () => ({ shouldEmit: () => true }),
  listEvents: async () => [],
}));
restores.push(mockResolvedModule(require.resolve('../src/services/codex/run-access'), {
  findOwnedRun: async () => null,
  isTerminalStatus: () => true,
}));
restores.push(mockResolvedModule(require.resolve('../src/services/codex/redis-pubsub'), {
  createRunSubscriber: async () => null,
  publishEvent: async () => false,
}));
restores.push(mockResolvedModule(require.resolve('../src/services/codex/run-service'), {
  ACTIVE_STATUSES: ['queued', 'running', 'waiting_approval'],
  hasActiveRun: async (args) => {
    calls.push(['hasActiveRun', args]);
    return hasActiveRunImpl(args);
  },
  cancelRunFamily: async (args) => {
    calls.push(['cancelRunFamily', args]);
    return cancelFamilyImpl(args);
  },
}));
restores.push(mockResolvedModule(require.resolve('../src/services/codex/enterprise-command-center-service'), {
  loadEnterpriseCommandCenter: async () => ({
    company: { profile: { mission: 'Construir la plataforma' } },
    plan: { workstreams: [] },
    commandCenter: { swarm: createdSwarm },
  }),
}));
restores.push(mockResolvedModule(require.resolve('../src/services/codex/fleet-orchestrator'), {
  createFleetSwarm: async (args) => {
    calls.push(['createFleetSwarm', args]);
    const fleet = await createFleetImpl(args);
    createdSwarm = fleet?.swarm || null;
    return fleet;
  },
}));
restores.push(mockResolvedModule(require.resolve('../src/services/codex/swarm-runner'), {
  enqueueSwarm: async (args) => {
    calls.push(['enqueueSwarm', args]);
    return enqueueImpl(args);
  },
}));
restores.push(mockResolvedModule(require.resolve('../src/services/codex/boot-recovery'), {
  resumeDeferredSwarmRunsReliably: async (args) => {
    calls.push(['resumeDeferredSwarmRunsReliably', args]);
    return resumeRecoveryImpl(args);
  },
}));

class MockSwarmOrchestrator {
  async resumeSwarm(args) {
    calls.push(['resumeSwarm', args]);
    return {
      swarm: { id: args.swarmId, status: 'running' },
      progress: { counts: { queued: 1, running: 0 } },
    };
  }

  async cancelSwarm(args) {
    calls.push(['cancelSwarm', args]);
    return {
      swarm: { id: args.swarmId, status: 'cancelled' },
      progress: { counts: { cancelled: 2 } },
    };
  }
}
restores.push(mockResolvedModule(require.resolve('../src/services/codex/swarm-orchestrator'), {
  CodexSwarmOrchestrator: MockSwarmOrchestrator,
}));

const routePath = require.resolve('../src/routes/codex');
delete require.cache[routePath];
const codexRoutes = require(routePath);

after(() => {
  delete require.cache[routePath];
  while (restores.length) restores.pop()();
});

beforeEach(() => {
  project = {
    id: 'project-1',
    userId: 'user-1',
    name: 'SiraGPT',
    deletedAt: null,
    brief: {
      objective: 'Construir la plataforma',
      proactive: {
        enabled: true,
        runsToday: 12,
        opaque: { preserved: true },
        fleetMode: 'all-departments',
        continuity: 'permanent-until-paused',
      },
    },
  };
  createdSwarm = null;
  calls.length = 0;
  createFleetImpl = async () => ({ swarm: { id: 'swarm-1', status: 'queued' } });
  enqueueImpl = async () => ({ id: 'swarm-job-1' });
  hasActiveRunImpl = async () => false;
  resumeRecoveryImpl = async () => ({
    complete: true,
    attemptCount: 1,
    scanned: 1,
    reenqueued: 1,
    live: 0,
    leaseLost: 0,
    skipped: 0,
    failed: 0,
    attempts: [],
  });
  cancelFamilyImpl = async ({ runId }) => ({
    cancelledRunIds: [runId],
    runs: [{ id: runId, projectId: project.id, status: 'cancelled' }],
  });
  linkedTasks = [
    { id: 'task-ok', result: { planRunId: 'plan-ok' } },
    { id: 'task-stuck', result: { planRunId: 'plan-stuck' } },
    { id: 'task-duplicate', result: { planRunId: 'plan-ok' } },
  ];
  linkedRuns = [];
  activeProjectRuns = [];
});

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/codex', codexRoutes);
  return instance;
}

test('swarm route accepts the durable launch before leaving legacy PROACTIVO off', async () => {
  const response = await request(app())
    .post('/api/codex/projects/project-1/swarms')
    .send({ objective: 'Construir una plataforma compleja', logicalAgents: 48 });

  assert.equal(response.status, 202);
  assert.equal(response.body.swarm.id, 'swarm-1');
  assert.equal(project.brief.proactive.enabled, false);
  assert.equal(project.brief.proactive.runsToday, 12);
  assert.deepEqual(project.brief.proactive.opaque, { preserved: true });
  assert.equal(calls.filter(([name]) => name === 'hasActiveRun').length, 2);
  assert.deepEqual(calls.find(([name]) => name === 'enqueueSwarm')[1], { swarmId: 'swarm-1' });
});

test('swarm resume reports complete only after deferred runs are recoverable', async () => {
  const response = await request(app())
    .post('/api/codex/projects/project-1/swarms/swarm-1/resume')
    .send();

  assert.equal(response.status, 200);
  assert.equal(response.body.complete, true);
  assert.equal(response.body.swarm.status, 'running');
  assert.equal(response.body.runRecovery.reenqueued, 1);
  assert.deepEqual(
    calls
      .filter(([name]) => [
        'resumeSwarm',
        'resumeDeferredSwarmRunsReliably',
        'enqueueSwarm',
      ].includes(name))
      .map(([name]) => name),
    ['resumeSwarm', 'resumeDeferredSwarmRunsReliably', 'enqueueSwarm'],
  );
});

test('swarm resume returns 207 after bounded recovery retries but still starts its worker', async () => {
  resumeRecoveryImpl = async () => ({
    complete: false,
    attemptCount: 2,
    scanned: 1,
    reenqueued: 0,
    live: 0,
    leaseLost: 0,
    skipped: 0,
    failed: 1,
    attempts: [{ failed: 1 }, { failed: 1 }],
  });
  const response = await request(app())
    .post('/api/codex/projects/project-1/swarms/swarm-1/resume')
    .send();

  assert.equal(response.status, 207);
  assert.equal(response.body.complete, false);
  assert.equal(response.body.swarm.status, 'running');
  assert.equal(response.body.runRecovery.failed, 1);
  assert.ok(calls.some(([name]) => name === 'enqueueSwarm'));
});

test('swarm route restores exact PROACTIVO state when durable enqueue fails', async () => {
  const previous = JSON.parse(JSON.stringify(project.brief.proactive));
  enqueueImpl = async () => {
    const error = new Error('queue unavailable');
    error.code = 'swarm_queue_unavailable';
    error.status = 503;
    throw error;
  };
  const response = await request(app())
    .post('/api/codex/projects/project-1/swarms')
    .send({ objective: 'Construir una plataforma compleja' });

  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'swarm_queue_unavailable');
  assert.deepEqual(project.brief.proactive, previous);
  assert.ok(calls.some(([name, args]) => (
    name === 'cancelSwarm'
    && args.swarmId === 'swarm-1'
    && args.reason === 'swarm_launch_not_accepted'
  )));
});

test('swarm cancel route returns an observable 503 after partial family cancellation retries', async () => {
  cancelFamilyImpl = async ({ runId }) => {
    if (runId === 'plan-stuck') {
      const error = new Error('worker did not acknowledge cancellation');
      error.code = 'codex_cancel_timeout';
      throw error;
    }
    return { cancelledRunIds: [runId] };
  };
  const response = await request(app())
    .post('/api/codex/projects/project-1/swarms/swarm-1/cancel')
    .send({ reason: 'operator requested stop' });

  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'codex_swarm_cancel_incomplete');
  assert.equal(response.body.swarm.status, 'cancelled');
  assert.equal(response.body.runFamilyCancellation.complete, false);
  assert.equal(response.body.runFamilyCancellation.cancelled, 1);
  assert.equal(response.body.runFamilyCancellation.failed, 1);
  assert.equal(
    calls.filter(([name, args]) => name === 'cancelRunFamily' && args.runId === 'plan-stuck').length,
    2,
  );
});

test('swarm cancel route finds an active run through swarmTaskId before task result is published', async () => {
  linkedTasks = [{ id: 'task-racing', result: null }];
  linkedRuns = [{ id: 'build-racing', planRunId: 'plan-racing' }];
  const response = await request(app())
    .post('/api/codex/projects/project-1/swarms/swarm-1/cancel')
    .send({ reason: 'stop racing writer' });

  assert.equal(response.status, 200);
  assert.equal(response.body.runFamilyCancellation.complete, true);
  assert.equal(response.body.runFamilyCancellation.requested, 1);
  assert.equal(response.body.runFamilyCancellation.cancelled, 1);
  assert.ok(calls.some(([name, args]) => (
    name === 'findLinkedRuns'
    && args.where.swarmTaskId.in.length === 1
    && args.where.swarmTaskId.in[0] === 'task-racing'
  )));
  assert.equal(
    calls.filter(([name, args]) => name === 'cancelRunFamily' && args.runId === 'plan-racing').length,
    1,
  );
});

test('cancel-active discovers and stops an old active family outside the paginated 50-run history', async () => {
  activeProjectRuns = [
    { id: 'build-old-active', planRunId: 'plan-old-active', createdAt: new Date('2026-01-01') },
    { id: 'plan-second-active', planRunId: null, createdAt: new Date('2026-01-02') },
    // Same family must be requested once even if both plan and build are active.
    { id: 'plan-old-active', planRunId: null, createdAt: new Date('2026-01-01') },
  ];
  cancelFamilyImpl = async ({ runId }) => ({
    cancelledRunIds: [runId, `${runId}-build`],
    runs: [
      { id: runId, projectId: project.id, status: 'cancelled' },
      { id: `${runId}-build`, projectId: project.id, planRunId: runId, status: 'cancelled' },
    ],
  });
  const response = await request(app())
    .post('/api/codex/projects/project-1/runs/cancel-active')
    .send();

  assert.equal(response.status, 200);
  assert.equal(response.body.complete, true);
  assert.deepEqual(response.body.requestedRunIds, ['plan-old-active', 'plan-second-active']);
  assert.deepEqual(response.body.cancelledRunIds, ['plan-old-active', 'plan-second-active']);
  assert.deepEqual(response.body.failedRunIds, []);
  assert.equal(response.body.runs.length, 4);
  const query = calls.find(([name]) => name === 'findActiveProjectRuns')[1];
  assert.equal(query.take, undefined, 'authoritative stop-all query must never inherit listRuns pagination');
  assert.deepEqual(query.where, {
    projectId: 'project-1',
    userId: 'user-1',
    status: { in: ['queued', 'running', 'waiting_approval'] },
  });
});

test('cancel-active returns 207 and explicit failed roots after bounded retries', async () => {
  activeProjectRuns = [
    { id: 'plan-ok', planRunId: null },
    { id: 'build-stuck', planRunId: 'plan-stuck' },
  ];
  cancelFamilyImpl = async ({ runId }) => {
    if (runId === 'plan-stuck') {
      const error = new Error('cancellation not acknowledged');
      error.code = 'codex_cancel_timeout';
      throw error;
    }
    return {
      cancelledRunIds: [runId],
      runs: [{ id: runId, projectId: project.id, status: 'cancelled' }],
    };
  };
  const response = await request(app())
    .post('/api/codex/projects/project-1/runs/cancel-active')
    .send();

  assert.equal(response.status, 207);
  assert.equal(response.body.complete, false);
  assert.deepEqual(response.body.requestedRunIds, ['plan-ok', 'plan-stuck']);
  assert.deepEqual(response.body.cancelledRunIds, ['plan-ok']);
  assert.deepEqual(response.body.failedRunIds, ['plan-stuck']);
  assert.equal(
    calls.filter(([name, args]) => name === 'cancelRunFamily' && args.runId === 'plan-stuck').length,
    2,
  );
});

test('cancel-active is idempotent when the owned project has no active runs', async () => {
  const response = await request(app())
    .post('/api/codex/projects/project-1/runs/cancel-active')
    .send();

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    complete: true,
    requestedRunIds: [],
    cancelledRunIds: [],
    failedRunIds: [],
    runs: [],
  });
  assert.equal(calls.some(([name]) => name === 'cancelRunFamily'), false);
});
