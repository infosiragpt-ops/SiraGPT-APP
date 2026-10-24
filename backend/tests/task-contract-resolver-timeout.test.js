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


// Exercise the real SDK request options rather than a stub that ignores
// automatic retries and AbortSignal propagation.
const OpenAI = require('openai');
const billing = require('../src/services/ai/billing-failover');
const keyHealth = require('../src/utils/provider-key-health');
const { __resetResolverForTests } = require('../src/services/agents/task-contract-resolver');
const TRANSPORT_ENV = { OPENAI_API_KEY: 'resolver-transport-fixture' };

function resetTransportHealth() {
  billing.__resetForTests();
  keyHealth.clear();
  __resetResolverForTests();
}

function sdkResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'retry-after-ms': '1' },
  });
}

function validSdkResponse() {
  return sdkResponse(200, { choices: [{ message: { content: JSON.stringify(FEW_SHOT_EXAMPLES[2].contract) } }] });
}

test('resolver transport: an unfunded 429 is sent once even when the caller SDK enables retries', async () => {
  resetTransportHealth();
  const payloads = [];
  const client = new OpenAI({
    apiKey: TRANSPORT_ENV.OPENAI_API_KEY,
    maxRetries: 2,
    fetch: async (_url, init) => {
      payloads.push(JSON.parse(init.body));
      return sdkResponse(429, { error: { message: 'You have no credits remaining.', code: 'insufficient_quota' } });
    },
  });
  try {
    const result = await resolveTaskContract({
      goal: 'explica una fórmula', openai: client, env: TRANSPORT_ENV,
      fallback: () => ({ fromHeuristic: true }), timeoutMs: 1000,
    });
    assert.equal(result.source, 'fallback');
    assert.equal(result.contract.fromHeuristic, true);
    assert.equal(payloads.length, 1, 'the SDK must not retry an unfunded account before the resolver records it');
    assert.equal(payloads[0].model, 'gpt-4o-mini', 'the requested model stays unchanged');
    assert.equal(billing.isOutOfCredit('OpenAI', TRANSPORT_ENV), true);
  } finally { resetTransportHealth(); }
});

test('resolver transport: deadline aborts the SDK fetch before returning the heuristic contract', async () => {
  resetTransportHealth();
  let calls = 0;
  let aborted = false;
  let release = () => {};
  const client = new OpenAI({
    apiKey: TRANSPORT_ENV.OPENAI_API_KEY,
    maxRetries: 2,
    timeout: 2000,
    fetch: (_url, init) => new Promise((resolve, reject) => {
      calls += 1;
      release = () => resolve(validSdkResponse());
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('Request aborted', 'AbortError'));
      }, { once: true });
    }),
  });
  try {
    const result = await resolveTaskContract({
      goal: 'explica una fórmula', openai: client, env: TRANSPORT_ENV,
      fallback: () => ({ fromHeuristic: true }), timeoutMs: 40,
    });
    assert.equal(result.source, 'fallback');
    assert.equal(aborted, true, 'returning a fallback must not leave the provider request running');
    assert.equal(calls, 1, 'abortion must not trigger SDK retries');
    assert.equal(billing.isOutOfCredit('OpenAI', TRANSPORT_ENV), false, 'timeouts are not billing failures');
  } finally { release(); resetTransportHealth(); }
});

test('resolver transport: JSON adaptation shares the original deadline rather than starting a new budget', async () => {
  resetTransportHealth();
  let calls = 0;
  let secondAborted = false;
  const payloads = [];
  const client = new OpenAI({
    apiKey: TRANSPORT_ENV.OPENAI_API_KEY,
    maxRetries: 2,
    fetch: (_url, init) => new Promise((resolve, reject) => {
      const current = ++calls;
      payloads.push(JSON.parse(init.body));
      const timer = setTimeout(() => {
        init.signal.removeEventListener('abort', abort);
        resolve(current === 1
          ? sdkResponse(400, { error: { message: 'response_format json_schema is unsupported' } })
          : validSdkResponse());
      }, current === 1 ? 60 : 80);
      const abort = () => {
        clearTimeout(timer);
        if (current === 2) secondAborted = true;
        reject(new DOMException('Request aborted', 'AbortError'));
      };
      init.signal.addEventListener('abort', abort, { once: true });
    }),
  });
  try {
    const result = await resolveTaskContract({
      goal: 'explica una fórmula', openai: client, env: TRANSPORT_ENV,
      fallback: () => ({ fromHeuristic: true }), timeoutMs: 110,
    });
    assert.equal(calls, 2, 'the supported JSON adaptation is still attempted');
    assert.deepEqual(payloads.map(p => p.response_format.type), ['json_schema', 'json_object']);
    assert.equal(result.source, 'fallback', 'the second format does not receive another full timeout');
    assert.equal(secondAborted, true);
    assert.equal(billing.isOutOfCredit('OpenAI', TRANSPORT_ENV), false);
  } finally { resetTransportHealth(); }
});

test('resolver transport: a successful request clears the deadline without aborting the completed transport', async () => {
  resetTransportHealth();
  let signal;
  const client = new OpenAI({
    apiKey: TRANSPORT_ENV.OPENAI_API_KEY,
    fetch: async (_url, init) => { signal = init.signal; return validSdkResponse(); },
  });
  try {
    const result = await resolveTaskContract({
      goal: 'explica una fórmula', openai: client, env: TRANSPORT_ENV, timeoutMs: 40,
    });
    assert.equal(result.source, 'llm');
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(signal.aborted, false, 'successful requests must not retain a live deadline timer');
  } finally { resetTransportHealth(); }
});
