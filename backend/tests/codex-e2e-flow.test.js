'use strict';

/**
 * codex-e2e-flow — the full Codex Agent V2 flow, offline + deterministic
 * (feature 15, spec §11): create project → plan → waiting_approval → approve →
 * build with streaming (narrative + grouped actions) → checkpoint → run_summary
 * → rollback. Doubles: scripted LLM, a runner-client backed by REAL git in a
 * tmpdir, an in-memory Prisma fake, Redis absent (publish is a no-op).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { makeFakePrisma, makeGitRunner, gitAvailable } = require('./codex-test-utils');
const projectService = require('../src/services/codex/project-service');
const runService = require('../src/services/codex/run-service');
const { processCodexRunJob } = require('../src/services/codex/run-processor');
const agentLoop = require('../src/services/codex/agent-loop');
const eventStore = require('../src/services/codex/event-store');
const checkpointService = require('../src/services/codex/checkpoint-service');
const pubsub = require('../src/services/codex/redis-pubsub');

const noopQueue = { enqueueCodexRun: async () => ({ id: 'job' }), cancelQueuedCodexRun: async () => ({ cancelled: false }) };

// Scripted model: plan mode (no tools) → a valid plan; build mode → one
// write_file burst, then finish.
function scriptedLlm() {
  let buildStep = 0;
  return async ({ tools }) => {
    if (!tools || tools.length === 0) {
      return { text: JSON.stringify({ architecture: 'Landing Vite', pages: ['/'], components: ['Hero'], tasks: [{ id: 't1', title: 'hero', status: 'pending' }] }) };
    }
    buildStep += 1;
    if (buildStep === 1) {
      return { text: 'Creo la landing.', toolCalls: [{ name: 'write_file', args: { path: 'index.html', content: '<h1>Hola</h1>\n' } }], usage: { tokensIn: 100, tokensOut: 40, provider: 'Cerebras', model: 'm' } };
    }
    return { text: 'Listo, la landing quedó construida.', toolCalls: [] };
  };
}

let git;
let prisma;
let savedRedisUrl;
const USER = 'u-e2e';

before(() => {
  if (!gitAvailable) return;
  // No Redis in the harness: keep event-store.appendEvent's best-effort publish
  // a true no-op so it never opens an ioredis connection that would keep the
  // test process alive (the durable DB append is what we assert).
  savedRedisUrl = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  git = makeGitRunner();
  prisma = makeFakePrisma({ user: { id: USER, plan: 'PRO' } });
  eventStore._resetSeqCache();
});
after(() => {
  if (git) git.cleanup();
  pubsub._resetPublisher();
  if (savedRedisUrl !== undefined) process.env.REDIS_URL = savedRedisUrl;
});

test('full flow: create → plan → approve → build → checkpoint → summary → rollback', { skip: !gitAvailable }, async () => {
  // 1) Provision the project (real git init + starter + initial commit).
  const project = await projectService.createProject({ userId: USER, name: 'Mi Landing', runner: git.runner, db: prisma, env: {} });
  assert.equal(project.status, 'ready');
  assert.equal(project.workspacePath, `projects/${project.id}`);

  const loopWith = (llm) => (args) => agentLoop.runAgentLoop({ ...args, deps: { ...args.deps, llmTurn: llm, runner: git.runner } });
  const llm = scriptedLlm();

  // 2) Plan run → waiting_approval + plan_proposed.
  const planRun = await runService.createRun({ userId: USER, projectId: project.id, mode: 'plan', prompt: 'haz una landing de zapatos', db: prisma, queue: noopQueue });
  assert.equal(planRun.status, 'queued');
  const planOutcome = await processCodexRunJob({ runId: planRun.id, prisma, clock: () => new Date(), runAgentLoop: loopWith(llm) });
  assert.equal(planOutcome.status, 'waiting_approval');

  const planEvents = await eventStore.listEvents(planRun.id, { afterSeq: 0, prisma });
  const planTypes = planEvents.map((e) => e.type);
  assert.ok(planTypes.includes('plan_proposed'));
  assert.deepEqual(planTypes.filter((t) => t === 'run_status').map((_, i) => planEvents.filter((e) => e.type === 'run_status')[i].data.status), ['running', 'waiting_approval']);

  // 3) Approve → build run.
  const buildRun = await runService.createRun({ userId: USER, projectId: project.id, mode: 'build', planRunId: planRun.id, prompt: 'construye', db: prisma, queue: noopQueue });
  const buildOutcome = await processCodexRunJob({ runId: buildRun.id, prisma, clock: () => new Date(), runAgentLoop: loopWith(llm) });
  assert.equal(buildOutcome.status, 'done');

  // The file was actually written in the workspace.
  const written = await git.runner.readFile(project.id, 'index.html');
  assert.match(written.content, /Hola/);

  // 4) Build events: narrative + grouped action + checkpoint_created + run_summary + terminal done.
  const buildEvents = await eventStore.listEvents(buildRun.id, { afterSeq: 0, prisma });
  const types = buildEvents.map((e) => e.type);
  assert.ok(types.includes('narrative_delta'));
  assert.ok(types.includes('action_start') && types.includes('action_end'));
  assert.ok(types.includes('checkpoint_created'));
  assert.ok(types.includes('run_summary'));
  // run_summary is the penultimate event, before the terminal run_status done.
  const summaryIdx = types.lastIndexOf('run_summary');
  const lastStatusIdx = types.lastIndexOf('run_status');
  assert.ok(summaryIdx < lastStatusIdx);
  assert.equal(buildEvents[lastStatusIdx].data.status, 'done');

  // 5) Metrics persisted with real numbers.
  const metric = prisma.codexRunMetric.rows.find((m) => m.runId === buildRun.id);
  assert.ok(metric);
  assert.ok(metric.actionsCount >= 1);
  assert.ok(metric.additions >= 1); // index.html added
  assert.equal(metric.costSource, 'provider_exact'); // Cerebras → exact 0
  assert.equal(metric.costAppliedUsd, 0);

  // 6) Checkpoint row + rollback restores the workspace.
  const checkpoint = prisma.codexCheckpoint.rows.find((c) => c.runId === buildRun.id);
  assert.ok(checkpoint && /^[0-9a-f]{7,40}$/.test(checkpoint.commitSha));

  // Make a dirty change, then roll back to the checkpoint → it's discarded.
  await git.runner.writeFiles(project.id, [{ path: 'index.html', content: 'DIRTY\n' }]);
  await git.runner.exec(project.id, ['git', 'add', '-A']);
  await git.runner.exec(project.id, ['git', '-c', 'user.name=x', '-c', 'user.email=x@y.z', 'commit', '-m', 'dirty']);
  const rb = await checkpointService.rollbackCheckpoint({ checkpointId: checkpoint.id, userId: USER, deps: { runner: git.runner, prisma } });
  assert.equal(rb.ok, true);
  const restored = await git.runner.readFile(project.id, 'index.html');
  assert.match(restored.content, /Hola/);
  assert.doesNotMatch(restored.content, /DIRTY/);
});

test('a second run while one is active is rejected (409)', { skip: !gitAvailable }, async () => {
  const project = await projectService.createProject({ userId: USER, name: 'Otro', runner: git.runner, db: prisma, env: {} });
  await runService.createRun({ userId: USER, projectId: project.id, mode: 'plan', prompt: 'x', db: prisma, queue: noopQueue });
  await assert.rejects(
    () => runService.createRun({ userId: USER, projectId: project.id, mode: 'plan', prompt: 'y', db: prisma, queue: noopQueue }),
    (e) => e.code === 'run_in_progress',
  );
});
