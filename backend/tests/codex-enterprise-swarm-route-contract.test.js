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
  assert.match(routeSource, /const maxConcurrentWriters = boundedSwarmInteger/);
  assert.match(routeSource, /createFleetSwarm\(\{/);
  assert.match(routeSource, /maxConcurrentWriters,/);
  assert.match(routeSource, /logicalTasks: Math\.min\(logicalAgents, 128\)/);
  assert.match(fleetSource, /const writerCap = Math\.min\(/);
  assert.match(fleetSource, /boundedInteger\(maxConcurrentWriters, runCap/);
  assert.match(fleetSource, /isolatedWriterWorktrees: true/);
  assert.match(fleetSource, /serializedBaseMerges: true/);
  assert.match(routeSource, /enqueueSwarm\(\{\s*swarmId: swarm\.id/);
  assert.match(routeSource, /swarm_queue_unavailable/);
});

test('pause, resume and cancel controls are exposed and cancellation reaches linked Codex runs', () => {
  for (const action of ['pause', 'resume', 'cancel']) {
    assert.match(
      routeSource,
      new RegExp(`'/projects/:id/swarms/:swarmId/${action}'`),
    );
  }
  assert.match(routeSource, /planRunIds/);
  assert.match(routeSource, /runService\.cancelRun\(/);
});

test('backend boot recovers swarms and shutdown closes their BullMQ runtime', () => {
  assert.match(indexSource, /startSwarmWorker\(\)/);
  assert.match(indexSource, /recoverSwarmJobs\(\)/);
  assert.match(indexSource, /closeSwarmRuntime\(\)/);
});
