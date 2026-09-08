'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { run } = require('../src/services/react-agent');

function client(entries) {
  let index = 0;
  return { chat: { completions: { create: async () => {
    const entry = entries[Math.min(index++, entries.length - 1)];
    if (entry instanceof Error) throw entry;
    return { choices: [{ message: entry.prose !== undefined
      ? { role: 'assistant', content: entry.prose }
      : { role: 'assistant', content: '', tool_calls: [{
        id: `review_${index}`, type: 'function',
        function: { name: 'host_file', arguments: '{}' },
      }] },
    }] };
  } } } };
}

test('rejected prose checkpoints retain consumed steps and verification counters across resume', async () => {
  let checkpoint;
  let effects = 0;
  const tools = [{
    name: 'host_file', description: 'In-memory fixture only.', parameters: { type: 'object' },
    execute: async () => ({ ok: true, revision: ++effects }),
  }];
  const options = { query: 'Verify a synthetic operation.', model: 'test-model', tools, maxSteps: 10 };
  const rejection = () => ({ ok: false, message: 'Synthetic evidence is insufficient.' });
  const first = await run(client([
    {}, { prose: 'Unverified draft one.' }, { prose: 'Unverified draft two.' },
    new Error('fixture_provider_disconnected'),
  ]), {
    ...options,
    finalizeGuard: rejection,
    onCheckpoint: value => { checkpoint = JSON.parse(JSON.stringify(value)); },
  });
  assert.equal(first.steps.length, 3);
  assert.equal(checkpoint.stepsCompleted, 3, 'rejected prose still consumes a completed model step');
  assert.equal(checkpoint.finalizeRejectionsTotal, 2);
  assert.equal(checkpoint.finalizeRejectionsConsecutive, 2);

  let resumedReviews = 0;
  const result = await run(client([{ prose: 'Still unverified.' }]), {
    ...options,
    resumeCheckpoint: checkpoint,
    finalizeGuard: () => { resumedReviews++; return rejection(); },
  });
  assert.equal(resumedReviews, 1, 'resume must not grant a fresh verification allowance');
  assert.equal(effects, 1, 'the recorded operation is not repeated');
  assert.match(result.stoppedReason, /^verification_failed/);
});
