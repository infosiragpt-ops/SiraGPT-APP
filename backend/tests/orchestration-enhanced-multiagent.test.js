'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { WORKFLOWS, createMultiAgentOrchestrator } = require('../src/orchestration/multi-agent/enhanced-orchestrator');
const { getOrchestrationWireup, resetOrchestrationWireup } = require('../src/orchestration/orchestration-wireup');

function stubGateway(outputs) {
  let call = 0;
  return {
    calls: 0,
    async complete() {
      this.calls += 1;
      const content = outputs[Math.min(call++, outputs.length - 1)] ?? '';
      return { response: { choices: [{ message: { content } }] } };
    },
  };
}

test('run(mode) does not mutate the shared WORKFLOWS registry', async () => {
  assert.equal(WORKFLOWS.code.mode, 'chain');
  const orch = createMultiAgentOrchestrator({ gateway: stubGateway(['a']) });
  await orch.run({ intent: 'debug repo', prompt: 'x', mode: 'vote' });
  assert.equal(WORKFLOWS.code.mode, 'chain');
});

test('mode override does not leak across instances or requests', async () => {
  const first = createMultiAgentOrchestrator({ gateway: stubGateway(['x']) });
  const voteResult = await first.run({ intent: 'debug repo', prompt: 'x', mode: 'vote' });
  assert.equal(voteResult.mode, 'vote');

  const second = createMultiAgentOrchestrator({ gateway: stubGateway(['y']) });
  const plainResult = await second.run({ intent: 'debug repo', prompt: 'y' });
  assert.equal(plainResult.mode, 'chain');
});

test('executeChain feeds each agent the previous output and collects errors', async () => {
  const gateway = stubGateway(['plan output']);
  gateway.complete = async (...args) => {
    gateway.calls += 1;
    if (gateway.calls === 1) throw new Error('boom');
    gateway.lastMessages = args[0].messages;
    return { response: { choices: [{ message: { content: 'plan output' } }] } };
  };
  const orch = createMultiAgentOrchestrator({ gateway });
  const result = await orch.run({ intent: 'plan then code', prompt: 'build it', context: { a: 1 } });

  assert.equal(result.results.length, 3);
  assert.equal(result.results[0].error, 'boom');
  assert.equal(result.results[1].output, 'plan output');
  const userPayload = JSON.parse(gateway.lastMessages.find((m) => m.role === 'user').content);
  assert.deepEqual(userPayload.previousResults.map((r) => r.output ?? null), [null, 'plan output']);
  assert.deepEqual(userPayload.context, { a: 1 });
});

test('orchestration-wireup exposes getMultiAgentOrchestrator wired to its gateway', () => {
  resetOrchestrationWireup();
  const wireup = getOrchestrationWireup({});
  try {
    const orch = wireup.getMultiAgentOrchestrator();
    assert.equal(typeof orch.run, 'function');
    assert.equal(wireup.getMultiAgentOrchestrator(), orch, 'must be a lazy singleton');
  } finally {
    resetOrchestrationWireup();
  }
});
