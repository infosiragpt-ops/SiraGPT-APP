'use strict';

/**
 * F1 hardening — runner-claimed turns NEVER fall back to the generic
 * 8-slide document pipeline.
 *
 * Production evidence (2026-08-13): "crea una ppt del embarazo de color
 * celeste/rosado" kept answering with the old advanced-document-pipeline
 * template ("Preparé una presentación de 8 diapositivas") because the doc
 * route fell through whenever the runner failed (OpenRouter 402 / Anthropic
 * out of credits / no LLM key). These tests pin the new contract:
 *   - claimed + no file  → honest Spanish error with the skip/fail reason;
 *   - not claimed        → null (pipeline allowed);
 *   - LLM 402            → loop stops immediately, no retry;
 *   - max_tokens capped  → a low credit balance can still finish a loop.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  runAgentLoop,
  resolveAgentRunnerMaxTokens,
  isLlmCreditError,
  MAX_TOKENS_DEFAULT,
} = require('../src/services/agent-runner/loop');
const {
  shouldRunAgentRunner,
  executeAgentRunnerTurn,
  runAgentRunnerForDocRoute,
  buildAgentRunnerFailureMessage,
} = require('../src/services/agent-runner');
const { TOOL_DEFINITIONS } = require('../src/services/agent-runner/tools');

function openRouter402Error() {
  const err = new Error(
    'This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 694.',
  );
  err.status = 402;
  return err;
}

function anthropicCreditError() {
  // Anthropic surfaces the failure as a message, not always a 402 status.
  return new Error('Your credit balance is too low to access the Anthropic API.');
}

function throwingClient(errFactory, calls) {
  return {
    chat: {
      completions: {
        create: async (opts) => {
          calls.push(opts);
          throw errFactory();
        },
      },
    },
  };
}

// ── Credit-error classification ─────────────────────────────────────────

test('isLlmCreditError detects OpenRouter 402 and Anthropic credit messages', () => {
  assert.equal(isLlmCreditError(openRouter402Error()), true);
  assert.equal(isLlmCreditError(anthropicCreditError()), true);
  assert.equal(isLlmCreditError(new Error('Insufficient credits to run this prompt')), true);
  assert.equal(isLlmCreditError(new Error('ECONNRESET')), false);
  assert.equal(isLlmCreditError(new Error('model not found')), false);
  assert.equal(isLlmCreditError(null), false);
});

// ── Loop stops immediately on 402 ───────────────────────────────────────

test('runAgentLoop stops on the FIRST 402 — no retries, reason surfaced', async () => {
  const calls = [];
  const result = await runAgentLoop({
    client: throwingClient(openRouter402Error, calls),
    model: 'test/model',
    messages: [{ role: 'user', content: 'crea una ppt del embarazo celeste' }],
    tools: TOOL_DEFINITIONS,
    executors: {},
    maxIterations: 10,
  });
  assert.equal(result.stoppedReason, 'llm_402');
  assert.equal(calls.length, 1, '402 is terminal: one attempt, zero retries');
  assert.match(String(result.errorMessage), /can only afford/);
});

test('runAgentLoop stops on Anthropic "credit balance is too low"', async () => {
  const calls = [];
  const result = await runAgentLoop({
    client: throwingClient(anthropicCreditError, calls),
    model: 'test/model',
    messages: [{ role: 'user', content: 'crea una ppt' }],
    tools: TOOL_DEFINITIONS,
    executors: {},
    maxIterations: 10,
  });
  assert.equal(result.stoppedReason, 'llm_402');
  assert.equal(calls.length, 1);
});

test('non-credit LLM errors still throw (transient failures keep old semantics)', async () => {
  const calls = [];
  await assert.rejects(
    runAgentLoop({
      client: throwingClient(() => new Error('boom'), calls),
      model: 'test/model',
      messages: [{ role: 'user', content: 'x' }],
      tools: TOOL_DEFINITIONS,
      executors: {},
      maxIterations: 3,
    }),
    /boom/,
  );
});

// ── max_tokens cap ──────────────────────────────────────────────────────

test('agent loop requests a SMALL max_tokens so low balances still work', async () => {
  const calls = [];
  const client = {
    chat: {
      completions: {
        create: async (opts) => {
          calls.push(opts);
          return { choices: [{ message: { content: 'Listo.' } }] };
        },
      },
    },
  };
  await runAgentLoop({
    client,
    model: 'test/model',
    messages: [{ role: 'user', content: 'hola' }],
    tools: TOOL_DEFINITIONS,
    executors: {},
    maxIterations: 2,
  });
  assert.ok(calls.length >= 1);
  assert.equal(calls[0].max_tokens, MAX_TOKENS_DEFAULT);
  assert.ok(calls[0].max_tokens <= 4096, 'never the 8192 reservation that 402s on low balances');
  assert.ok(calls[0].max_tokens >= 2048, 'still enough room for a tool call with code');
});

test('resolveAgentRunnerMaxTokens: env override, clamped to [256, 8192]', () => {
  assert.equal(resolveAgentRunnerMaxTokens({}), MAX_TOKENS_DEFAULT);
  assert.equal(resolveAgentRunnerMaxTokens({ SIRAGPT_AGENT_RUNNER_MAX_TOKENS: '2048' }), 2048);
  assert.equal(resolveAgentRunnerMaxTokens({ SIRAGPT_AGENT_RUNNER_MAX_TOKENS: '64' }), 256);
  assert.equal(resolveAgentRunnerMaxTokens({ SIRAGPT_AGENT_RUNNER_MAX_TOKENS: '999999' }), 8192);
  assert.equal(resolveAgentRunnerMaxTokens({ SIRAGPT_AGENT_RUNNER_MAX_TOKENS: 'nope' }), MAX_TOKENS_DEFAULT);
});

// ── Honest failure copy ─────────────────────────────────────────────────

test('buildAgentRunnerFailureMessage is Spanish, honest, and reason-specific', () => {
  const m402 = buildAgentRunnerFailureMessage('llm_402', 'You requested up to 8192 tokens…');
  assert.match(m402, /créditos/);
  assert.match(m402, /402/);
  assert.match(m402, /plantilla genérica/);
  assert.match(m402, /Detalle técnico/);

  const mNoLlm = buildAgentRunnerFailureMessage('no_llm');
  assert.match(mNoLlm, /modelo de IA/);
  assert.match(mNoLlm, /plantilla genérica/);
  assert.doesNotMatch(mNoLlm, /Detalle técnico/);

  const mUnknown = buildAgentRunnerFailureMessage('weird_reason');
  assert.match(mUnknown, /weird_reason/);
});

// ── executeAgentRunnerTurn surfaces the reason, never throws ────────────

test('executeAgentRunnerTurn: LLM 402 → ok:false with stoppedReason llm_402 (no throw, no artifacts)', async () => {
  const calls = [];
  const ran = await executeAgentRunnerTurn({
    instruction: 'crea una ppt del embarazo de color celeste la ppt',
    client: throwingClient(openRouter402Error, calls),
    driver: 'local',
    maxIterations: 6,
  });
  assert.equal(ran.ok, false);
  assert.equal(ran.stoppedReason, 'llm_402');
  assert.deepEqual(ran.artifacts, []);
  assert.equal(calls.length, 1, 'the loop must not keep retrying against an empty balance');
  assert.match(String(ran.errorMessage), /can only afford/);
});

test('executeAgentRunnerTurn: unexpected exception → ok:false with reason + message (no throw)', async () => {
  const ran = await executeAgentRunnerTurn({
    instruction: 'crea una ppt del embarazo de color celeste la ppt',
    client: throwingClient(() => new Error('sandbox exploded'), []),
    driver: 'local',
    maxIterations: 4,
  });
  assert.equal(ran.ok, false);
  assert.equal(ran.stoppedReason, 'exception');
  assert.match(String(ran.errorMessage), /sandbox exploded/);
});

// ── Doc route: claimed turns never reach the pipeline ───────────────────

test('runAgentRunnerForDocRoute: claimed + no_llm → honest failure object, NOT null (pipeline blocked)', async () => {
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'ci-dummy';
  try {
    const prompt = 'crea una ppt del embarazo de color celeste la ppt';
    assert.equal(shouldRunAgentRunner({ text: prompt }), true, 'precondition: the runner claims this turn');
    const result = await runAgentRunnerForDocRoute({
      prisma: { generatedArtifact: { findMany: async () => [] } },
      userId: 'u1',
      chatId: 'c1',
      prompt,
      fileIds: [],
    });
    assert.ok(result, 'claimed turns must NOT return null — null is what re-opens the pipeline');
    assert.equal(result.agentRunnerClaimed, true);
    assert.equal(result.failed, true);
    assert.equal(result.reason, 'no_llm');
    assert.equal(result.file, undefined, 'no fabricated file');
    assert.match(result.message, /plantilla genérica/);
  } finally {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  }
});

test('runAgentRunnerForDocRoute: claimed + LLM 402 → failure object with reason llm_402', async () => {
  const result = await runAgentRunnerForDocRoute({
    prisma: { generatedArtifact: { findMany: async () => [] } },
    userId: 'u1',
    chatId: 'c1',
    prompt: 'crea una ppt del embarazo de color celeste la ppt',
    fileIds: [],
    client: throwingClient(openRouter402Error, []),
    driver: 'local',
    maxIterations: 6,
  });
  assert.ok(result);
  assert.equal(result.agentRunnerClaimed, true);
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'llm_402');
  assert.match(result.message, /créditos/);
  assert.match(result.message, /plantilla genérica/);
});

test('runAgentRunnerForDocRoute: claimed + model that produces nothing → failure, never a stub deck', async () => {
  const emptyClient = {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: 'No pude crear la presentación.' } }] }),
      },
    },
  };
  const result = await runAgentRunnerForDocRoute({
    prisma: { generatedArtifact: { findMany: async () => [] } },
    userId: 'u1',
    chatId: 'c1',
    prompt: 'crea una ppt del embarazo de color celeste la ppt',
    fileIds: [],
    client: emptyClient,
    driver: 'local',
    maxIterations: 4,
  });
  assert.ok(result);
  assert.equal(result.failed, true);
  assert.ok(['no_output', 'verification_failed', 'max_iterations'].includes(result.reason), result.reason);
  assert.match(result.message, /plantilla genérica/);
});

test('runAgentRunnerForDocRoute: NOT claimed → null (pipeline stays available for non-runner requests)', async () => {
  const result = await runAgentRunnerForDocRoute({
    prisma: { generatedArtifact: { findMany: async () => [] } },
    userId: 'u1',
    chatId: 'c1',
    prompt: 'hola, ¿cómo estás?',
    fileIds: [],
  });
  assert.equal(result, null);
});

// ── Doc-route decision mirror (routes/doc.js branch contract) ───────────
// The route only enters the pipeline branch when the helper returned null:
//   file → deliver | claimed failure → honest error | null → pipeline.
function docRouteDecision(agentRunnerResult) {
  if (agentRunnerResult && agentRunnerResult.file) return 'agent_runner_file';
  if (agentRunnerResult && agentRunnerResult.agentRunnerClaimed) return 'agent_runner_error';
  return 'pipeline';
}

test('doc route decision: claimed failures NEVER route to streamAdvancedDocumentPipeline', () => {
  assert.equal(docRouteDecision({ agentRunnerClaimed: true, failed: true, reason: 'no_llm', message: 'x' }), 'agent_runner_error');
  assert.equal(docRouteDecision({ agentRunnerClaimed: true, failed: true, reason: 'llm_402', message: 'x' }), 'agent_runner_error');
  assert.equal(docRouteDecision({ agentRunnerClaimed: true, failed: true, reason: 'no_output', message: 'x' }), 'agent_runner_error');
  assert.equal(docRouteDecision({ content: 'Listo', file: { url: '/api/agent/artifact/a1' }, format: 'pptx' }), 'agent_runner_file');
  assert.equal(docRouteDecision(null), 'pipeline');
});
