'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveTaskContract, FEW_SHOT_EXAMPLES } = require('../src/services/agents/task-contract-resolver');

/**
 * Planning-phase fail-fast for task-contract-resolver.
 *
 * The resolver runs BEFORE the agent emits its first step event. A hung or
 * very slow provider here is invisible to the user ("Analizando solicitud"
 * with 0 steps / 0 tools) until the client's 90s idle watchdog aborts the
 * whole run — the exact bug a stuck "búscame 2 artículos científicos" turn
 * exhibited. These tests pin the new behavior: the LLM call is raced against
 * a tight timeout and a stall drops us into the deterministic heuristic
 * fallback fast, instead of freezing the run.
 */

function rememberEnv(keys) {
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  return () => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// A client whose create() never settles — simulates a hung provider socket.
function hangingClient() {
  return {
    baseURL: 'https://api.openai.com/v1',
    chat: { completions: { create: () => new Promise(() => { /* never resolves */ }) } },
  };
}

test('resolver: a hung provider falls back fast instead of hanging forever', async () => {
  const restore = rememberEnv(['AGENT_TASK_CONTRACT_TIMEOUT_MS', 'OPENAI_API_KEY']);
  // Keep OPENAI side-channel from kicking in; the passed client is OpenAI-native.
  delete process.env.OPENAI_API_KEY;
  try {
    const t0 = Date.now();
    const out = await resolveTaskContract({
      goal: 'búscame 2 artículos científicos de la gestión administrativa',
      openai: hangingClient(),
      fileIds: [],
      fallback: ({ goal }) => ({ goal, intent: 'research', _fallback: true }),
      timeoutMs: 120, // tight cap for the test
    });
    const elapsed = Date.now() - t0;
    assert.equal(out.source, 'fallback', 'a timed-out resolve must use the heuristic fallback');
    assert.equal(out.contract._fallback, true);
    assert.ok(elapsed < 2000, `resolver should fail fast, took ${elapsed}ms`);
    assert.ok(elapsed >= 100, `resolver should honor the timeout window, took ${elapsed}ms`);
  } finally {
    restore();
  }
});

test('resolver: timeout is configurable via AGENT_TASK_CONTRACT_TIMEOUT_MS', async () => {
  const restore = rememberEnv(['AGENT_TASK_CONTRACT_TIMEOUT_MS', 'OPENAI_API_KEY']);
  delete process.env.OPENAI_API_KEY;
  process.env.AGENT_TASK_CONTRACT_TIMEOUT_MS = '150';
  try {
    const t0 = Date.now();
    const out = await resolveTaskContract({
      goal: 'genera un informe',
      openai: hangingClient(),
      fileIds: [],
      fallback: () => ({ intent: 'g', _fallback: true }),
    });
    const elapsed = Date.now() - t0;
    assert.equal(out.source, 'fallback');
    assert.ok(elapsed < 2000, `env-configured timeout should fail fast, took ${elapsed}ms`);
  } finally {
    restore();
  }
});

test('resolver: a fast, valid LLM response goes through the race unharmed (no false timeout)', async () => {
  const restore = rememberEnv(['AGENT_TASK_CONTRACT_TIMEOUT_MS', 'OPENAI_API_KEY']);
  delete process.env.OPENAI_API_KEY;
  try {
    // A canonical, schema-valid contract straight from the resolver's own
    // few-shot bank — guaranteed to validate, so source must be "llm".
    const validContract = FEW_SHOT_EXAMPLES[2].contract;
    let calls = 0;
    const fastClient = {
      baseURL: 'https://api.openai.com/v1',
      chat: {
        completions: {
          create: async () => {
            calls += 1;
            return { choices: [{ message: { content: JSON.stringify(validContract) } }] };
          },
        },
      },
    };
    const out = await resolveTaskContract({
      goal: 'explícame el teorema de Bayes',
      openai: fastClient,
      fileIds: [],
      fallback: () => ({ intent: 'g', _fallback: true }),
      timeoutMs: 5000,
    });
    assert.equal(calls, 1, 'the LLM must be invoked once — the race must not pre-empt a fast response');
    assert.equal(out.source, 'llm', 'a fast, schema-valid response must still come from the LLM');
    assert.equal(out.contract.artifact_type, 'text-answer');
  } finally {
    restore();
  }
});
