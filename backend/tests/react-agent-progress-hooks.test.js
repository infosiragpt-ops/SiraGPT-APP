'use strict';

/**
 * react-agent live-progress hooks: onModelCall / onModelResponse around every
 * model call, onGuard around the finalize-guard judge. Advisory only — a
 * throwing hook never changes the run, and without hooks the run is
 * identical.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const reactAgent = require('../src/services/react-agent');

function toolCall(name, args, id) {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  };
}

function scriptedClient(responses) {
  let i = 0;
  return {
    calls: () => i,
    chat: {
      completions: {
        create: async () => responses[Math.min(i++, responses.length - 1)],
      },
    },
  };
}

const SEARCH = {
  name: 'web_search',
  description: 'Search the web.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
  execute: async (args) => ({ results: [`hit for ${args.query}`] }),
};

function script() {
  return [
    toolCall('web_search', { query: 'cobre 2026' }, 'call_s1'),
    toolCall('finalize', { answer: 'El cobre cotiza alto según las fuentes.' }, 'call_f1'),
  ];
}

function stable(result) {
  return {
    finalAnswer: result.finalAnswer,
    stoppedReason: result.stoppedReason,
    steps: result.steps.map((s) => ({ step: s.step, actions: s.actions.map((a) => a.tool) })),
  };
}

test('onModelCall / onModelResponse fire once per model call with step, maxSteps and finalize', async () => {
  const calls = [];
  const responses = [];
  const client = scriptedClient(script());
  const result = await reactAgent.run(client, {
    query: 'precio del cobre',
    tools: [SEARCH],
    model: 'deepseek-v4-pro',
    maxSteps: 5,
    onModelCall: (info) => calls.push(info),
    onModelResponse: (info) => responses.push(info),
  });
  assert.equal(result.stoppedReason, 'finalized');
  assert.equal(client.calls(), 2);
  assert.equal(calls.length, 2);
  assert.equal(responses.length, 2);
  assert.deepEqual(calls.map((c) => c.step), [0, 1]);
  assert.ok(calls.every((c) => c.maxSteps === 5));
  assert.ok(calls.every((c) => c.finalize === false), 'no forced finalize before the last step');
  assert.ok(calls.every((c) => c.model === 'deepseek-v4-pro'));
  assert.ok(calls.every((c) => Number.isFinite(c.toolCount) && c.toolCount >= 2), 'the registry includes finalize');
  assert.ok(calls.every((c) => Number.isFinite(c.stepTimeoutMs) && c.stepTimeoutMs > 0));
  assert.deepEqual(responses.map((r) => r.toolNames), [['web_search'], ['finalize']]);
  assert.deepEqual(responses.map((r) => r.finalize), [false, true]);
  assert.ok(responses.every((r) => r.failed === false && Number.isFinite(r.durationMs) && r.durationMs >= 0));
});

test('the last step is announced as a forced finalize', async () => {
  const calls = [];
  const client = scriptedClient([
    toolCall('finalize', { answer: 'Respuesta directa.' }, 'call_f'),
  ]);
  await reactAgent.run(client, {
    query: 'hola, ¿qué tal?',
    tools: [SEARCH],
    maxSteps: 1,
    onModelCall: (info) => calls.push(info),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].finalize, true);
});

test('a failing model call reports failed:true on onModelResponse', async () => {
  const responses = [];
  const client = {
    chat: { completions: { create: async () => { throw Object.assign(new Error('boom'), { status: 500 }); } } },
  };
  const result = await reactAgent.run(client, {
    query: 'algo',
    tools: [SEARCH],
    maxSteps: 3,
    onModelResponse: (info) => responses.push(info),
    recordProviderFailures: false,
  });
  assert.match(result.stoppedReason, /^model_error/);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].failed, true);
  assert.equal(responses[0].timedOut, false);
  assert.deepEqual(responses[0].toolNames, []);
});

test('onGuard brackets a real check: start → repair (with category) → start → pass', async () => {
  const guards = [];
  let verdicts = 0;
  const client = scriptedClient([
    toolCall('finalize', { answer: 'Borrador flojo.' }, 'call_f1'),
    toolCall('finalize', { answer: 'Respuesta corregida y completa.' }, 'call_f2'),
  ]);
  const result = await reactAgent.run(client, {
    query: 'explica el cobre',
    tools: [SEARCH],
    maxSteps: 5,
    // A reviewing guard announces its check before running it.
    finalizeGuard: async ({ onCheckStart }) => {
      onCheckStart();
      verdicts += 1;
      return verdicts === 1
        ? { ok: false, code: 'E_VERIFICATION_REJECTED', message: 'Quality check failed' }
        : { ok: true };
    },
    onGuard: (info) => guards.push(info),
  });
  assert.equal(result.stoppedReason, 'finalized');
  assert.deepEqual(guards.map((g) => g.phase), ['start', 'repair', 'start', 'pass']);
  assert.equal(guards[1].category, 'E_VERIFICATION_REJECTED');
  assert.equal(guards[3].category, undefined);
});

test('onGuard: a guard that passes without checking leaves no row; a rejection is always announced', async () => {
  const guards = [];
  let verdicts = 0;
  const client = scriptedClient([
    toolCall('finalize', { answer: 'Borrador sin la búsqueda.' }, 'call_f1'),
    toolCall('finalize', { answer: 'Respuesta completa.' }, 'call_f2'),
  ]);
  const result = await reactAgent.run(client, {
    query: 'explica el cobre',
    tools: [SEARCH],
    maxSteps: 5,
    // A deterministic guard: rejects once (never calls onCheckStart), then
    // passes without reviewing anything (a short draft, verification off…).
    finalizeGuard: async () => {
      verdicts += 1;
      return verdicts === 1 ? { ok: false, missingTools: ['web_search'] } : { ok: true };
    },
    onGuard: (info) => guards.push(info),
  });
  assert.equal(result.stoppedReason, 'finalized');
  assert.deepEqual(guards.map((g) => g.phase), ['start', 'repair'], 'no «Verificación superada» for a pass that checked nothing');
  assert.equal(guards[1].category, 'missing_tools');
});

test('the answer verifier announces a check only when its review really runs', async () => {
  const { createAnswerVerifier } = require('../src/services/agents/agent-plan-verify');
  const saved = process.env.SIRAGPT_AGENT_VERIFY;
  process.env.SIRAGPT_AGENT_VERIFY = '1';
  try {
    let reviews = 0;
    const openai = { chat: { completions: { create: async () => { reviews += 1; return { choices: [{ message: { content: '{"pass": true}' } }] }; } } } };
    const verifier = createAnswerVerifier({ openai, model: 'm', userQuery: 'Explícame con detalle cómo funciona la fotosíntesis en las plantas' });
    let announced = 0;
    const short = await verifier({ answer: 'Corta.', steps: [], ctx: {}, onCheckStart: () => { announced += 1; } });
    assert.equal(short.ok, true);
    assert.equal(announced, 0, 'a short draft is not reviewed: nothing announced');
    assert.equal(reviews, 0);
    const long = await verifier({ answer: 'La fotosíntesis convierte la luz en energía química. '.repeat(12), steps: [], ctx: {}, onCheckStart: () => { announced += 1; } });
    assert.equal(long.ok, true);
    assert.equal(reviews, 1, 'the long draft is really reviewed');
    assert.equal(announced, 1, 'a real review is announced once');
    // Verification off: no review, nothing announced.
    process.env.SIRAGPT_AGENT_VERIFY = '0';
    const off = await createAnswerVerifier({ openai, model: 'm', userQuery: 'Explícame con detalle cómo funciona la fotosíntesis en las plantas' })({
      answer: 'La fotosíntesis convierte la luz en energía química. '.repeat(12), steps: [], ctx: {}, onCheckStart: () => { announced += 1; },
    });
    assert.equal(off.ok, true);
    assert.equal(reviews, 1);
    assert.equal(announced, 1);
  } finally {
    if (saved === undefined) delete process.env.SIRAGPT_AGENT_VERIFY; else process.env.SIRAGPT_AGENT_VERIFY = saved;
  }
});

test('a failed model call carries its cause by category (never the provider text) and the model', async () => {
  const responses = [];
  const client = {
    chat: { completions: { create: async () => { throw Object.assign(new Error('Insufficient Balance org_secret_9'), { status: 402 }); } } },
  };
  await reactAgent.run(client, {
    query: 'algo',
    tools: [SEARCH],
    model: 'deepseek-v4-pro',
    maxSteps: 3,
    onModelResponse: (info) => responses.push(info),
    recordProviderFailures: false,
  });
  assert.equal(responses.length, 1);
  assert.equal(responses[0].failed, true);
  assert.equal(responses[0].category, 'billing');
  assert.equal(responses[0].model, 'deepseek-v4-pro');
  assert.doesNotMatch(JSON.stringify(responses), /org_secret_9|Insufficient/);
});

test('throwing hooks never change the run; without hooks the run is identical', async () => {
  const baseline = await reactAgent.run(scriptedClient(script()), {
    query: 'precio del cobre',
    tools: [SEARCH],
    model: 'deepseek-v4-pro',
    maxSteps: 5,
  });
  const noisy = await reactAgent.run(scriptedClient(script()), {
    query: 'precio del cobre',
    tools: [SEARCH],
    model: 'deepseek-v4-pro',
    maxSteps: 5,
    onModelCall: () => { throw new Error('hook exploded'); },
    onModelResponse: async () => { throw new Error('async hook exploded'); },
    onGuard: () => { throw new Error('guard hook exploded'); },
    finalizeGuard: async () => ({ ok: true }),
  });
  assert.deepEqual(stable(noisy), stable(baseline));
  assert.equal(baseline.stoppedReason, 'finalized');
});
