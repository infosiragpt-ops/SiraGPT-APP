'use strict';

// Offline boundary tests: source modules run with synthetic env, dependency
// stubs, an in-memory policy filesystem, and no real transport or database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const GUARD_PATH = path.resolve(__dirname, '../src/services/ai/acceptance-spend-guard.js');
const nativeRequire = createRequire(GUARD_PATH);
const guardModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(GUARD_PATH, 'utf8'), {
  module: guardModule, exports: guardModule.exports, require: nativeRequire,
  process: { env: {} }, Buffer, URL,
}, { filename: GUARD_PATH });
const realGuard = guardModule.exports;
const IDENTITY = Object.freeze({ userId: 'acceptance-user', chatId: 'acceptance-chat' });

function makeGuard() {
  const policyPath = '/synthetic-acceptance/policy.json';
  const ledgerPath = '/synthetic-acceptance/ledger.json';
  const files = new Map([
    [policyPath, JSON.stringify({ version: 1, campaignId: 'wiring', ...IDENTITY,
      expiresAt: '2030-01-01T00:00:00.000Z', ledgerPath,
      maxTotalMicros: 5_000_000, reservationMicros: 1_000_000,
      pricing: { verified: true, inputMicrosPerMillion: 100_000, outputMicrosPerMillion: 200_000,
        inputTokenCeiling: 1_048_576, outputTokenCeiling: 16_384 } })],
    [ledgerPath, JSON.stringify({ version: 1, campaignId: 'wiring', maxTotalMicros: 5_000_000,
      reservationMicros: 1_000_000, usedMicros: 0, reservations: [] })],
  ]);
  const disk = {
    openSync(filename, flags) {
      assert.notEqual(flags, 'wx', 'denied operations must not reserve or write');
      assert.ok(files.has(filename), 'only the synthetic policy/ledger may be read');
      return filename;
    },
    fstatSync(fd) { return { isFile: () => true, nlink: 1, mode: 0o600, size: Buffer.byteLength(files.get(fd)) }; },
    readFileSync: (fd) => files.get(fd),
    closeSync() {},
    realpathSync: (filename) => filename,
    statSync: () => ({ isDirectory: () => true, mode: 0o700 }),
  };
  return { ...realGuard, ...realGuard.createAcceptanceSpendGuard({
    policyFile: policyPath, fsImpl: disk, clock: () => Date.parse('2026-09-09T12:00:00Z'),
  }) };
}

function loadSource(relativePath, { guard, mocks = {}, env = {}, fetchImpl = async () => {
  assert.fail('unexpected transport');
}, immediate = setImmediate } = {}) {
  const filename = path.resolve(__dirname, '../src', relativePath);
  const mod = { exports: {} };
  const requireStub = (name) => {
    if (name.endsWith('/acceptance-spend-guard')) return guard;
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.startsWith('node:') || ['fs', 'path', 'crypto'].includes(name)) return require(name);
    // Unrelated dependencies cannot initialize a real DB, queue or provider.
    return {};
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: mod, exports: mod.exports, require: requireStub,
    __dirname: path.dirname(filename), __filename: filename,
    process: { env: { ...env } }, fetch: fetchImpl,
    Buffer, URL, Headers, Request, Response, AbortController, AbortSignal,
    setTimeout, clearTimeout, setImmediate: immediate, clearImmediate,
    console: { warn() {}, log() {}, error() {} },
  }, { filename });
  return mod.exports;
}

function sdkStub(constructed = []) {
  return class FakeOpenAI {
    constructor(options) {
      this.options = options;
      constructed.push(this);
      const request = async (endpoint, body) => {
        assert.equal(typeof options.fetch, 'function', 'SDK must receive the guarded fetch');
        const response = await options.fetch(`${options.baseURL || 'https://api.openai.com/v1'}${endpoint}`, {
          method: 'POST', body: JSON.stringify(body),
        });
        return response.json();
      };
      this.chat = { completions: { create: (body) => request('/chat/completions', body) } };
      this.embeddings = { create: (body) => request('/embeddings', body) };
    }
  };
}

test('Cerebras and Custom constructors preserve injected fetch outside scope and deny inside', async () => {
  const guard = makeGuard();
  let sends = 0;
  const fetchImpl = async () => { sends += 1; return { json: async () => ({ ok: true }) }; };
  const Ctor = sdkStub();
  const cerebras = loadSource('services/ai/cerebras-client.js', { guard });
  const custom = loadSource('services/ai/custom-provider-client.js', { guard });
  const clients = [
    cerebras.createCerebrasClient({ env: { CEREBRAS_API_KEY: 'synthetic' }, OpenAICtor: Ctor, fetchImpl }),
    custom.createCustomProviderClient({ url: 'https://custom.invalid/v1' }, { OpenAI: Ctor, fetchImpl }),
  ];
  for (const client of clients) {
    await client.chat.completions.create({ model: 'test', messages: [] });
    const before = sends;
    await guard.withAcceptanceScope(IDENTITY, () => assert.rejects(
      client.chat.completions.create({ model: 'test', messages: [] }), guard.isAcceptanceSpendError,
    ));
    assert.equal(sends, before);
  }
  assert.equal(sends, 2);
});

test('native Custom transport preserves terminal acceptance errors with zero sends', async () => {
  const guard = makeGuard();
  let sends = 0;
  const custom = loadSource('services/ai/custom-provider-client.js', { guard });
  const client = custom.createCustomProviderClient({ url: 'http://local.invalid/v1', authType: 'None' }, {
    OpenAI: sdkStub(), fetchImpl: async () => { sends += 1; throw new Error('unexpected send'); },
  });
  await guard.withAcceptanceScope(IDENTITY, () => assert.rejects(
    client.chat.completions.create({ model: 'sira-mini', messages: [], stream: false }), guard.isAcceptanceSpendError,
  ));
  assert.equal(sends, 0);
});

test('memory scope survives background continuation without affecting concurrent ordinary work', async () => {
  const guard = makeGuard();
  let sends = 0;
  const memory = loadSource('services/user-memory-store.js', { guard });
  const opts = { provider: 'voyage', apiKey: 'synthetic', fetch: async () => {
    sends += 1;
    return { ok: true, json: async () => ({ data: [{ embedding: Array(1024).fill(0) }] }) };
  } };
  let background;
  guard.withAcceptanceScope(IDENTITY, () => {
    background = new Promise((resolve, reject) => setImmediate(() => {
      assert.rejects(memory.embedTexts(['private'], opts), guard.isAcceptanceSpendError).then(resolve, reject);
    }));
  });
  assert.equal(guard.isActive(), false);
  const ordinary = guard.withAcceptanceScope({ userId: 'other-user', chatId: 'other-chat' }, () => memory.embedTexts(['ordinary'], opts));
  await Promise.all([background, ordinary]);
  assert.equal(sends, 1, 'only the ordinary request may send');
});

test('RAG singleton uses per-call scope and never joins unscoped singleflight', async () => {
  const guard = makeGuard();
  let sends = 0;
  let flights = 0;
  const rag = loadSource('services/rag-service.js', {
    guard, env: { OPENAI_API_KEY: 'synthetic', SIRA_RELIABILITY_WIRINGS: '1' },
    mocks: {
      openai: sdkStub(),
      '../cache/single-flight': { getSingleFlight: () => ({ do: async (_key, fn) => { flights += 1; return fn(); } }) },
      './agents/speculative-executor': { argsHash: () => 'synthetic-key' },
    },
    fetchImpl: async () => { sends += 1; return { json: async () => ({ data: [{ embedding: [0, 1] }] }) }; },
  });
  await rag.embed(['ordinary']);
  assert.equal(flights, 1);
  await guard.withAcceptanceScope(IDENTITY, () => assert.rejects(rag.embed(['private']), guard.isAcceptanceSpendError));
  assert.equal(flights, 1, 'scoped work does not share the ordinary singleflight');
  assert.equal(sends, 1);
});

test('project-memory SDK is guarded even in fire-and-forget extraction', async () => {
  const guard = makeGuard();
  const constructed = [];
  let sends = 0;
  const projectMemory = loadSource('services/project-memory.js', {
    guard, env: { OPENAI_API_KEY: 'synthetic' }, mocks: { openai: sdkStub(constructed) },
    fetchImpl: async () => { sends += 1; return { json: async () => ({ choices: [{ message: { content: '{"facts":[]}' } }] }) }; },
  });
  const args = { projectId: 'p', projectName: 'test', userMessage: 'Remember my synthetic preference.', assistantMessage: 'OK' };
  await guard.withAcceptanceScope(IDENTITY, () => projectMemory.extractAndSave(args));
  assert.equal(constructed.length, 1);
  assert.equal(typeof constructed[0].options.fetch, 'function');
  assert.equal(sends, 0);
  await projectMemory.extractAndSave(args);
  assert.equal(sends, 1);
});

test('Cohere and HF preserve terminal quota errors instead of wrapping them as network failures', async () => {
  const guard = makeGuard();
  let sends = 0;
  const fetchImpl = async () => { sends += 1; throw new Error('unexpected send'); };
  const cohere = loadSource('services/rag/cohere-rerank.js', { guard });
  const nli = loadSource('services/rag/nli-faithfulness.js', { guard });
  await guard.withAcceptanceScope(IDENTITY, async () => {
    await assert.rejects(cohere.rerank({ query: 'q', documents: ['d'], options: { apiKey: 'synthetic', fetchImpl } }), guard.isAcceptanceSpendError);
    await assert.rejects(nli.verifyClaim({ claim: 'c', evidence: 'e', options: { backend: 'huggingface', huggingfaceToken: 'synthetic', fetchImpl } }), guard.isAcceptanceSpendError);
  });
  assert.equal(sends, 0);
});

test('gateway refuses scoped calls before construction and cannot fall back on quota errors', async () => {
  const guard = makeGuard();
  const constructed = [];
  const gateway = loadSource('services/ai/llm-gateway-client.js', { guard, mocks: { openai: sdkStub(constructed) } });
  const env = { LLM_GATEWAY_URL: 'https://gateway.invalid/v1', LLM_GATEWAY_KEY: 'synthetic' };
  const calls = [];
  await guard.withAcceptanceScope(IDENTITY, () => assert.rejects(gateway.callWithGatewayOrDirect({
    env, req: { headers: { 'x-sira-gateway': '1' } },
    legacy: () => { calls.push('legacy'); return {}; }, attempt: async () => { calls.push('attempt'); },
  }), guard.isAcceptanceSpendError));
  assert.equal(constructed.length, 0);
  assert.deepEqual(calls, []);
  let quotaError;
  guard.withAcceptanceScope(IDENTITY, () => {
    try { guard.denyUnbudgetedOperation(); } catch (error) { quotaError = error; }
  });
  assert.equal(gateway._internal.isGatewayFallbackable(quotaError), false);
  const sdkWrappedError = Object.assign(new Error('fetch failed'), { status: 503, cause: quotaError });
  assert.equal(gateway._internal.isGatewayFallbackable(sdkWrappedError), false);
  await assert.rejects(gateway.callWithGatewayOrDirect({
    env, req: { headers: { 'x-sira-gateway': '1' } },
    legacy: () => { calls.push('legacy'); }, attempt: async () => { throw sdkWrappedError; },
  }), guard.isAcceptanceSpendError);
  assert.deepEqual(calls, []);
  let sends = 0;
  const client = gateway.createGatewayClient({ env, fetchImpl: async () => { sends += 1; return { json: async () => ({}) }; } });
  await client.chat.completions.create({ model: 'test' });
  assert.equal(sends, 1, 'ordinary gateway still uses its supplied transport');
});

test('Goals, Codex and every runner entry deny before persistence, scheduling or tool I/O', async () => {
  const guard = makeGuard();
  const io = [];
  const forbidden = () => { io.push('side-effect'); throw new Error('unexpected I/O'); };
  const goals = loadSource('services/autonomous-goal-escalation.js', { guard });
  const codex = loadSource('services/codex/codex-run-orchestrator.js', {
    guard, immediate: forbidden, mocks: { './codex-run-store': { writeRun: forbidden, appendEvent: forbidden, updateRun: forbidden } },
  });
  const runner = loadSource('services/agent-runner/index.js', {
    guard, immediate: forbidden, mocks: { './tools': { NAMED_COLORS: {}, TOOL_DEFINITIONS: [] } },
  });
  await guard.withAcceptanceScope(IDENTITY, async () => {
    await assert.rejects(goals.maybeCreateAutonomousGoalRun({
      userId: IDENTITY.userId, chatId: IDENTITY.chatId, prompt: '/goal investigate continuously',
      prisma: { goalRun: { create: forbidden } }, appendEvent: forbidden, enqueueGoalRun: forbidden,
    }), guard.isAcceptanceSpendError);
    assert.throws(() => codex.createRunRecord({}), guard.isAcceptanceSpendError);
    assert.throws(() => codex.enqueueCodexRun({}), guard.isAcceptanceSpendError);
    await assert.rejects(codex.runCodexPipeline({}), guard.isAcceptanceSpendError);
    for (const entry of ['runAgentRunner', 'runAgentRunnerForChat', 'executeAgentRunnerTurn']) {
      await assert.rejects(runner[entry]({ instruction: 'synthetic', driver: { exec: forbidden } }), guard.isAcceptanceSpendError);
    }
  });
  assert.deepEqual(io, []);
  guard.denyUnbudgetedOperation();
  const ordinary = await goals.maybeCreateAutonomousGoalRun({ prompt: 'hello' });
  assert.equal(ordinary.created, false);
  let saved = 0;
  const ordinaryCodex = loadSource('services/codex/codex-run-orchestrator.js', {
    guard, mocks: { './codex-run-store': { writeRun: (record) => { saved += 1; return record; } } },
  });
  assert.equal(ordinaryCodex.createRunRecord({ runId: 'ordinary', goal: 'test' }).runId, 'ordinary');
  assert.equal(saved, 1);
});
