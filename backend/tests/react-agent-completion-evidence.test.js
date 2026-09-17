'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { run } = require('../src/services/react-agent');
const { createAnswerVerifier } = require('../src/services/agents/agent-plan-verify');

const UNVERIFIED = 'UNVERIFIED_DRAFT_812: La operación está terminada y verificada.';
const VERIFIED = 'VERIFIED_827: La comprobación de prueba se completó.';

function scripted(entries) {
  let requests = 0;
  return {
    get requests() { return requests; },
    chat: { completions: { create: async () => {
      const entry = entries[Math.min(requests++, entries.length - 1)];
      if (entry instanceof Error) throw entry;
      const message = entry.prose !== undefined
        ? { role: 'assistant', content: entry.prose }
        : { role: 'assistant', content: '', tool_calls: [{
          id: `completion_${requests}`, type: 'function', function: {
            name: entry.tool || 'finalize',
            arguments: JSON.stringify(entry.args || { answer: UNVERIFIED }),
          },
        }] };
      return { choices: [{ message }] };
    } } },
  };
}

function assertNotApproved(result, forbiddenDraft = UNVERIFIED) {
  assert.notEqual(result.finalAnswer, forbiddenDraft, 'a rejected or unreviewed draft cannot become the delivered final answer');
  assert.ok(String(result.finalAnswer || '').trim(), 'the run must return an honest, non-empty incomplete/cancelled explanation');
  assert.doesNotMatch(String(result.stoppedReason), /^(?:finalized|plain_text_finalize)/,
    'termination after failed verification must not advertise successful finalization');
}

const options = { query: 'Comprueba la operación antes de afirmar que está terminada.', model: 'test-model', tools: [], maxSteps: 8 };
const reject = () => ({ ok: false, message: 'No hay evidencia de que se haya completado la operación.', missingTools: ['verify_artifact'] });

test('repeated rejected finalize calls stop without accepting the rejected draft', async () => {
  let reviews = 0;
  const client = scripted([{}]);
  const result = await run(client, { ...options, finalizeGuard: () => { reviews++; return reject(); } });
  assert.ok(reviews >= 1 && reviews <= 3, 'the rejection breaker must remain bounded');
  assertNotApproved(result);
});

test('repeated rejected prose cannot bypass the same completion evidence gate', async () => {
  const result = await run(scripted([{ prose: UNVERIFIED }]), { ...options, finalizeGuard: reject });
  assertNotApproved(result);
});

test('the last allowed step does not rescue a draft that its verifier rejected', async () => {
  const result = await run(scripted([{}]), { ...options, maxSteps: 1, finalizeGuard: reject });
  assertNotApproved(result);
});

test('a throwing finalize verifier never becomes an approval through the breaker', async () => {
  const result = await run(scripted([{}]), {
    ...options,
    finalizeGuard: () => { throw new Error('fixture_verifier_unavailable'); },
  });
  assertNotApproved(result);
});

test('a provider failure after a rejected draft preserves failure instead of rescuing the draft', async () => {
  const result = await run(scripted([{}, new Error('fixture_provider_unavailable')]), {
    ...options, finalizeGuard: reject,
  });
  assertNotApproved(result);
  assert.match(result.stoppedReason, /model_error|provider|verification|guard/i);
});

test('Stop after a rejected draft remains cancelled and never rescues that draft', async () => {
  const controller = new AbortController();
  const result = await run(scripted([{}]), {
    ...options,
    ctx: { signal: controller.signal },
    finalizeGuard: reject,
    onBeforeStep: ({ step }) => { if (step === 1) controller.abort(); return {}; },
  });
  assertNotApproved(result);
  assert.equal(result.stoppedReason, 'aborted');
});

test('a truthy non-boolean guard value is not evidence of approval', async () => {
  const result = await run(scripted([{}]), { ...options, maxSteps: 1, finalizeGuard: () => ({ ok: 'false' }) });
  assertNotApproved(result);
});

for (const prose of [false, true]) {
  test(`Stop during a ${prose ? 'prose' : 'native'} guard overrides even a late positive verdict`, async () => {
    const controller = new AbortController();
    const result = await run(scripted([prose ? { prose: UNVERIFIED } : {}]), {
      ...options, maxSteps: 1, ctx: { signal: controller.signal },
      finalizeGuard: () => { controller.abort(); return { ok: true }; },
    });
    assertNotApproved(result);
    assert.equal(result.stoppedReason, 'aborted');
  });
}

test('the real answer verifier does not approve a draft when its judge throws', async () => {
  const draft = UNVERIFIED.repeat(8);
  const verifier = createAnswerVerifier({
    openai: scripted([new Error('fixture_judge_unavailable')]),
    model: 'test-model', userQuery: options.query,
  });
  let verdict;
  try { verdict = await verifier({ answer: draft }); }
  catch (error) { assert.ok(error); return; }
  assert.notEqual(verdict?.ok, true, 'judge failure is unavailable evidence, not a positive verdict');
});

test('the real answer verifier cannot accept the identical draft immediately after rejecting it', async () => {
  const client = scripted([{ prose: JSON.stringify({ pass: false, problems: ['Synthetic missing evidence'], fix: 'Verify the operation.' }) }]);
  const verifier = createAnswerVerifier({ openai: client, model: 'test-model', userQuery: options.query });
  const draft = UNVERIFIED.repeat(8);
  const first = await verifier({ answer: draft });
  assert.equal(first.ok, false);
  const repeated = await verifier({ answer: draft });
  assert.notEqual(repeated?.ok, true, 'exhausting a review allowance cannot turn the same rejected draft into a pass');
  assert.ok(client.requests <= 2, 'review attempts must remain bounded');
});

test('a malformed judge response is not interpreted as affirmative evidence', async () => {
  const verifier = createAnswerVerifier({
    openai: scripted([{ prose: 'Not a JSON verdict.' }]), model: 'test-model', userQuery: options.query,
  });
  const verdict = await verifier({ answer: UNVERIFIED.repeat(8) });
  assert.notEqual(verdict?.ok, true);
});

test('a genuinely approved native final answer keeps its existing successful behavior', async () => {
  const result = await run(scripted([{ args: { answer: VERIFIED } }]), {
    ...options, finalizeGuard: () => ({ ok: true }),
  });
  assert.equal(result.finalAnswer, VERIFIED);
  assert.equal(result.stoppedReason, 'finalized');
});

test('a genuinely approved prose answer keeps its existing successful behavior', async () => {
  const result = await run(scripted([{ prose: VERIFIED }]), {
    ...options, finalizeGuard: () => ({ ok: true }),
  });
  assert.equal(result.finalAnswer, VERIFIED);
  assert.equal(result.stoppedReason, 'plain_text_finalize');
});

test('a rejected candidate may finish successfully after real tool evidence and explicit approval', async () => {
  let verified = false;
  const result = await run(scripted([
    {},
    { tool: 'verify_artifact', args: {} },
    { args: { answer: VERIFIED } },
  ]), {
    ...options,
    tools: [{
      name: 'verify_artifact', description: 'Synthetic local evidence only.', parameters: { type: 'object' },
      execute: async () => { verified = true; return { ok: true, checked: true }; },
    }],
    finalizeGuard: () => verified ? { ok: true } : reject(),
  });
  assert.equal(result.finalAnswer, VERIFIED);
  assert.equal(result.stoppedReason, 'finalized');
  assert.equal(verified, true);
});
