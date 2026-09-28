'use strict';

/**
 * react-agent feeds the provider memo when the model call fails (no credit →
 * «sin saldo», 401 → rejected key) and returns the error as `modelError`.
 * A step timeout or a user Stop marks nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const reactAgent = require('../src/services/react-agent');
const billing = require('../src/services/ai/billing-failover');
const keyHealth = require('../src/utils/provider-key-health');

const ENV_KEYS = ['XAI_API_KEY', 'ANTHROPIC_API_KEY', 'SIRA_ANTHROPIC_API_KEY', 'REACT_STEP_TIMEOUT_MS'];
let savedEnv = {};

test.beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  billing.__resetForTests();
});

test.afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  billing.__resetForTests();
});

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function failingClient(err, onCall = () => {}) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (params, opts) => {
          calls.push(params);
          await onCall(opts);
          throw err;
        },
      },
    },
  };
}

const baseArgs = { query: 'Resume el informe', tools: [], maxSteps: 3 };

test('a 403 «used all available credits» marks the provider «sin saldo» and comes back as modelError', async () => {
  process.env.XAI_API_KEY = 'xai-test-key';
  const long = `You have used all available credits. Please purchase more to continue. ${'x'.repeat(400)}`;
  const client = failingClient(httpError(403, long));
  const result = await reactAgent.run(client, { ...baseArgs, model: 'grok-4.7', ctx: { provider: 'xAI' } });

  assert.equal(client.calls.length, 1);
  assert.ok(String(result.stoppedReason).startsWith('model_error'), result.stoppedReason);
  assert.equal(result.modelError.status, 403);
  assert.equal(result.modelError.reason, 'billing');
  assert.ok(result.modelError.message.length <= 200);
  assert.match(result.modelError.message, /used all available credits/);
  assert.equal(billing.isOutOfCredit('xAI'), true);
  assert.equal(keyHealth.rejectionReason('xai', 'xai-test-key'), 'billing');
});

test('a 401 marks the key rejected (auth), not «sin saldo»', async () => {
  process.env.ANTHROPIC_API_KEY = 'an-test-key';
  delete process.env.SIRA_ANTHROPIC_API_KEY;
  const client = failingClient(httpError(401, 'invalid x-api-key'));
  const result = await reactAgent.run(client, { ...baseArgs, model: 'claude-fable-5-1', ctx: { provider: 'Anthropic' } });

  assert.equal(result.modelError.status, 401);
  assert.equal(result.modelError.reason, 'auth');
  assert.equal(keyHealth.rejectionReason('anthropic', 'an-test-key'), 'auth');
  assert.equal(billing.isOutOfCredit('Anthropic'), false);
});

test('without ctx.provider the provider is inferred from the model id; recordProviderFailures:false records nothing', async () => {
  process.env.XAI_API_KEY = 'xai-test-key';
  await reactAgent.run(failingClient(httpError(402, 'Insufficient Balance')), { ...baseArgs, model: 'grok-4.7' });
  assert.equal(billing.isOutOfCredit('xAI'), true);

  billing.__resetForTests();
  const result = await reactAgent.run(failingClient(httpError(402, 'Insufficient Balance')), {
    ...baseArgs, model: 'grok-4.7', ctx: { provider: 'xAI' }, recordProviderFailures: false,
  });
  assert.equal(result.modelError.reason, 'billing', 'still reported to the caller');
  assert.equal(billing.isOutOfCredit('xAI'), false);
});

test('a step timeout or a user Stop marks nothing and returns no modelError', async () => {
  process.env.XAI_API_KEY = 'xai-test-key';
  process.env.REACT_STEP_TIMEOUT_MS = '40';
  const hang = (opts) => new Promise((resolve) => {
    opts.signal.addEventListener('abort', resolve, { once: true });
  });
  const timedOut = await reactAgent.run(failingClient(httpError(402, 'Insufficient Balance'), hang), {
    ...baseArgs, model: 'grok-4.7', ctx: { provider: 'xAI' },
  });
  assert.match(timedOut.stoppedReason, /model_error: step_timeout_/);
  assert.equal(timedOut.modelError, null);
  assert.equal(billing.isOutOfCredit('xAI'), false);

  delete process.env.REACT_STEP_TIMEOUT_MS;
  const ctrl = new AbortController();
  const stopped = await reactAgent.run(failingClient(httpError(402, 'Insufficient Balance'), async () => { ctrl.abort(); }), {
    ...baseArgs, model: 'grok-4.7', ctx: { provider: 'xAI', signal: ctrl.signal },
  });
  assert.equal(stopped.modelError, null);
  assert.equal(billing.isOutOfCredit('xAI'), false);
  assert.equal(keyHealth.isRejected('xai', 'xai-test-key'), false);
});
