'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const routeSource = fs.readFileSync(
  path.join(__dirname, '../src/routes/codex.js'),
  'utf8',
);
const indexSource = fs.readFileSync(
  path.join(__dirname, '../index.js'),
  'utf8',
);
const fleetSource = fs.readFileSync(
  path.join(__dirname, '../src/services/codex/fleet-orchestrator.js'),
  'utf8',
);

test('enterprise command center and swarm routes require authentication and owned projects', () => {
  assert.match(
    routeSource,
    /router\.get\('\/projects\/:id\/command-center', authenticateToken/,
  );
  assert.match(
    routeSource,
    /'\/projects\/:id\/swarms',\s*authenticateToken,\s*requireCodexAgentAccess/,
  );
  assert.match(
    routeSource,
    /async function loadOwnedSwarm[\s\S]*projectId: req\.params\.id[\s\S]*userId: req\.user\.id/,
  );
  assert.match(
    routeSource,
    /const project = await loadOwnedProjectRecord\(req, res\)/,
  );
});

test('swarm start hands a bounded worktree-isolated fleet to the durable queue', () => {
  assert.match(
    routeSource,
    /runService\.hasActiveRun\(\{ projectId: project\.id, db: codexDb \}\)/,
  );
  assert.match(routeSource, /function swarmConcurrencyDefaults/);
  assert.match(routeSource, /const maxConcurrency = boundedSwarmInteger/);
  assert.match(routeSource, /createFleetSwarm\(\{/);
  // Full logical capacity (up to 10k) — no artificial min(…, 64) choke.
  assert.match(routeSource, /logicalTasks:\s*logicalAgents/);
  assert.doesNotMatch(routeSource, /logicalTasks:\s*Math\.min\(logicalAgents,\s*64\)/);
  assert.match(routeSource, /maxConcurrentWriters,/);
  assert.match(fleetSource, /const writerCap = Math\.min\(/);
  assert.match(fleetSource, /boundedInteger\(maxConcurrentWriters, runCap/);
  assert.match(fleetSource, /isolatedWriterWorktrees: true/);
  assert.match(fleetSource, /serializedBaseMerges: true/);
  assert.match(fleetSource, /MAX_PLANNER_TASKS = 10_000/);
  assert.match(routeSource, /swarmLifecycle\.launchFleetSafely\(\{/);
  assert.match(routeSource, /createFleet: \(\) => createFleetSwarm\(\{/);
  assert.match(routeSource, /enqueueSwarm: \(\{ swarmId \}\)/);
  assert.match(routeSource, /hasActiveRun: \(\) => runService\.hasActiveRun/);
});

test('pause, resume and cancel controls are exposed and cancellation reaches every task run family', () => {
  for (const action of ['pause', 'resume', 'cancel']) {
    assert.match(
      routeSource,
      new RegExp(`'/projects/:id/swarms/:swarmId/${action}'`),
    );
  }
  assert.match(routeSource, /const linkedTasks = await codexDb\.codexSwarmTask\.findMany/);
  assert.match(routeSource, /where: \{ swarmId: swarm\.id \}/);
  assert.doesNotMatch(routeSource, /where: \{ swarmId: swarm\.id, role: 'integrator' \}/);
  assert.match(routeSource, /swarmTaskId: \{ in: linkedTaskIds \}/);
  assert.match(routeSource, /status: \{ in: runService\.ACTIVE_STATUSES \}/);
  assert.match(routeSource, /planRunIds/);
  assert.match(routeSource, /runService\.cancelRunFamily\(/);
  assert.match(routeSource, /swarmLifecycle\.cancelRunFamiliesReliably\(\{/);
  assert.match(routeSource, /codex_swarm_cancel_incomplete/);
  assert.match(routeSource, /res\.status\(503\)/);
  assert.match(
    routeSource,
    /resumeSwarm\([\s\S]*resumeDeferredSwarmRunsReliably\([\s\S]*enqueueSwarm/,
    'resume must publish deferred Codex runs before restarting swarm workers',
  );
  assert.match(routeSource, /res\.status\(runRecovery\.complete \? 200 : 207\)/);
  assert.match(routeSource, /complete: runRecovery\.complete[\s\S]*runRecovery/);
});

test('backend boot recovers swarms and shutdown closes their BullMQ runtime', () => {
  assert.match(indexSource, /startSwarmWorker\(\)/);
  assert.match(indexSource, /recoverSwarmJobs\(\)/);
  assert.match(indexSource, /closeSwarmRuntime\(\)/);
});

test('project-wide stop is authoritative, owned and independent from paginated run history', () => {
  assert.match(
    routeSource,
    /'\/projects\/:id\/runs\/cancel-active',\s*authenticateToken,\s*requireCodexAgentAccess/,
  );
  assert.match(routeSource, /const project = await loadOwnedProjectRecord\(req, res\)/);
  assert.match(routeSource, /const activeRuns = await codexDb\.codexRun\.findMany\(\{/);
  assert.match(routeSource, /status: \{ in: runService\.ACTIVE_STATUSES \}/);
  assert.match(routeSource, /requestedRunIds/);
  assert.match(routeSource, /cancelledRunIds/);
  assert.match(routeSource, /failedRunIds/);
  assert.match(routeSource, /res\.status\(cancellation\.complete \? 200 : 207\)/);
});
