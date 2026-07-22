'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createImplementerRequest } = require('../src/services/codex/agent-adapters/contract');
const { nativeCodexAdapter } = require('../src/services/codex/agent-adapters/native-codex-adapter');

test('native adapter passes exact loop inputs and returns the exact loop outcome', async () => {
  const run = { id: 'run-1', mode: 'build', prompt: 'ship it' };
  const project = { id: 'project-1', name: 'Demo' };
  const request = createImplementerRequest({ run, project, timeoutMs: 90_000, maxSteps: 12 });
  const controller = new AbortController();
  const isCancelled = async () => false;
  const deps = { prisma: {}, eventStore: {}, env: {}, clock: () => new Date() };
  const outcome = { status: 'done', checkpoint: { id: 'checkpoint-1' } };
  let received;

  const returned = await nativeCodexAdapter.execute(request, {
    signal: controller.signal,
    isCancelled,
    deps,
    nativeRun: run,
    nativeProject: project,
    runAgentLoop(args) {
      received = args;
      return outcome;
    },
  });

  assert.equal(returned, outcome);
  assert.equal(received.run, run);
  assert.equal(received.project, project);
  assert.equal(received.signal, controller.signal);
  assert.equal(received.isCancelled, isCancelled);
  assert.equal(received.deps, deps);
});

test('native adapter propagates loop failures without translation', () => {
  const request = createImplementerRequest({
    run: { id: 'run-1', mode: 'plan', prompt: null },
    project: null,
    timeoutMs: 60_000,
    maxSteps: 4,
  });
  const original = new Error('native failure');
  assert.throws(
    () => nativeCodexAdapter.execute(request, {
      deps: {},
      runAgentLoop() { throw original; },
    }),
    (err) => err === original,
  );
});
