'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { body, validationResult } = require('express-validator');
const workspace = require('../src/services/codex/chat-coding-workspace');
const binding = require('../src/services/codex/project-chat-binding');
const trivialTurn = require('../src/services/trivial-turn');
const turnIdentity = require('../src/services/chat-turn-idempotency');
const sseClose = require('../src/services/ai/generate-sse-close');
const { createClientGoneWriter } = require('../src/services/ai/sse-client-gone');
const turnProgress = require('../src/services/turn-progress');

const routeFile = path.resolve(__dirname, '../src/routes/ai.js');
const routeSource = fs.readFileSync(routeFile, 'utf8');
const generateStart = routeSource.indexOf("router.post(\n  '/generate',");
const generateEnd = routeSource.indexOf('// ─── Deterministic text-to-speech', generateStart);
const stopStart = routeSource.indexOf("router.post('/stop-stream',");
const stopEnd = routeSource.indexOf('// // ✅ Generate AI image response', stopStart);
assert.ok(generateStart > 0 && generateEnd > generateStart);
assert.ok(stopStart > generateEnd && stopEnd > stopStart);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(testContext, options = {}) {
  const calls = [];
  const errors = [];
  const events = [];
  const projects = [];
  const workspaceResolutions = [];
  const streamControllers = new Map();
  const quotaEntered = deferred();
  const quotaReleased = deferred();
  const router = express.Router();
  const passthrough = (_req, _res, next) => next();
  const prisma = {
    chat: {
      findUnique: async () => ({ userId: options.foreignChat ? 'other-user' : 'owner' }),
      findFirst: async ({ where }) => where.userId === 'owner' && where.id === 'chat-first'
        ? { id: where.id }
        : null,
    },
    message: { findMany: async () => [] },
    user: { findUnique: async () => null },
  };
  const workspaceDeps = {
    enabled: () => options.enabled !== false,
    canUse: () => options.allowed !== false,
    binding: {
      cleanChatId: binding.cleanChatId,
      requireOwnedChat: binding.requireOwnedChat,
      findProjectForChat: async () => projects[0] || null,
      findOrCreateProjectForChat: async ({ userId, chatId, name }) => {
        calls.push('create-project');
        assert.equal(userId, 'owner');
        assert.equal(chatId, 'chat-first');
        if (options.provisionFails) throw new Error('fixture provision failed');
        const project = { id: 'project-first', name, status: 'ready' };
        projects.push(project);
        return { project, reused: false };
      },
    },
  };
  const logger = {
    info() {}, warn() {}, warnError() {},
    error(_event, error) { errors.push(error); },
  };
  const dynamicModules = {
    '../services/codex/chat-coding-workspace': {
      ...workspace,
      prepareChatCodingWorkspace: async (input) => {
        calls.push(input.provision === false ? 'authorize-workspace' : 'prepare-workspace');
        const result = await workspace.prepareChatCodingWorkspace(input, workspaceDeps);
        workspaceResolutions.push(result);
        return result;
      },
    },
    '../services/turn-progress': turnProgress,
    '../services/agent-runner/activity-trace': { createActivityTraceCollector: () => ({}) },
    '../services/rlhf/reason-codes': { resolveFeedbackReasons: () => null },
    '../services/agentic-chat-stream': {
      isEnabled: () => options.agenticEnabled !== false,
      modelSupportsFunctionCalling: () => options.modelHasTools !== false,
      resolveToolCallMode: () => options.modelHasTools === false ? 'none' : 'native',
    },
  };
  const context = {
    router, body, validationResult, Buffer, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    process: { env: {} },
    console: { log() {}, warn() {}, info() {} },
    authenticateToken: (req, _res, next) => { req.user = { id: 'owner', plan: 'PRO' }; next(); },
    requireScope: () => passthrough,
    enforceOrgQuotaSafe: passthrough, enforceOrgRateLimitSafe: passthrough, enforceOrgBudgetSafe: passthrough,
    createGenerateLogger: () => logger, summarizeGenerateRequest: () => ({}),
    turnFailures: { beginTurn: () => null },
    prisma, streamControllers,
    claimStreamController: turnIdentity.claimStreamController,
    markActiveGenerateTurnClientDetached: turnIdentity.markActiveGenerateTurnClientDetached,
    createClientGoneWriter,
    ...trivialTurn,
    honorPickerModel: (model, { provider }) => ({ model, provider }),
    lookupPickerDisplayName: () => 'Modelo elegido',
    applyGenerateFairQueue3h63: () => ({ ok: true }),
    resolveModelForUser: (_user, model) => ({ model }),
    persistModelPreference: async () => {},
    resolveTurnIdentity: turnIdentity.resolveTurnIdentity,
    buildAiGenerateRequestFingerprint: turnIdentity.buildAiGenerateRequestFingerprint,
    buildActiveGenerateTurnKey: () => null,
    findExistingGenerateTurn: async () => null,
    promptInjectionDetector: { detect: () => ({ detected: false }) },
    agentFilters: { runPre: async () => {}, runPost: async () => {} },
    streamResume: { generateStreamId: () => 'resume-first' },
    encodeStreamResumeCursor: () => null,
    langPolicy: { resolveResponseLanguage: async () => ({ language: 'es' }) },
    resolveGenerateProvider: (provider) => provider,
    resolveCustomConnectionForTurn: async () => ({ isCustom: false }),
    providerConnectionReady: () => {
      calls.push('provider-preflight');
      return options.providerReady !== false
        && !(options.finalProviderReady === false && calls.filter((call) => call === 'provider-preflight').length > 1);
    },
    unconfiguredModelMessage: async () => 'El modelo elegido no está configurado.',
    createProviderClientForRequest: () => ({ client: {} }),
    modelRouter: { getModel: () => null },
    messageAttachments: { looksLikeDocumentFollowupQuestion: () => false },
    operationalRag: { isPureGreetingPrompt: () => false, buildRuntimeContext: async () => null },
    recoverRecentChatDocumentFiles: async () => [],
    isSiraMiniAlias: (model) => model === 'sira-mini',
    SIRA_MINI_PUBLIC_NAME: 'sira-mini',
    conversationUnderstanding: { buildConversationUnderstandingBlock: () => '' },
    masterPrompt: { buildSystemPrompt: () => ({ system: 'Fixture instruction', blocks: [], language: 'es' }) },
    chatLatencyPolicy: {
      shouldUseSemanticEnrichment: () => false,
      enrichmentBudgetMs: () => 1,
      resolveWithinBudget: (promise) => promise,
    },
    longTermMemory: { buildMemoryBlock: () => '' },
    rag: { getOpenAI: () => null },
    getMemoryAdapter: () => null,
    webSearchPlanned: () => false,
    routeSupportsVision: () => false,
    conversationCompactor: { loadChatSummaryState: async () => null, historyWhere: (chatId) => ({ chatId }) },
    contextWindow: {
      getCompletionLimit: () => 16384,
      fitMessagesToContext: (messages) => ({ messages, droppedCount: 0, totalTokens: 0 }),
    },
    tokenBudget: {
      preflight: async () => {
        calls.push('token-budget-preflight');
        return options.budgetAllowed === false
          ? { ok: false, reason: 'token_budget_exceeded', status: 402 }
          : { ok: true };
      },
    },
    usageService: {},
    tryConsumePlanQuota: async () => {
      calls.push('quota-preflight');
      quotaEntered.resolve();
      if (options.holdQuota) await quotaReleased.promise;
      return options.quotaAllowed === false
        ? { ok: false, status: 429, body: { error: 'quota_exceeded' } }
        : { ok: true };
    },
    startGenerateSseHeartbeat: () => null,
    stopGenerateSseHeartbeat: () => null,
    ...sseClose,
    require: (name) => {
      if (Object.hasOwn(dynamicModules, name)) return dynamicModules[name];
      if (/^\.\.\/services\/agent-runner\/engine-(?:adapter|3h\d+)$/.test(name)) return {};
      throw new Error(`Unconfigured route dependency: ${name}`);
    },
  };
  vm.runInNewContext(routeSource.slice(generateStart, generateEnd), context, { filename: routeFile });
  vm.runInNewContext(routeSource.slice(stopStart, stopEnd), context, { filename: routeFile });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const originalWrite = res.write.bind(res);
    res.write = (chunk, ...rest) => {
      for (const line of String(chunk).split('\n')) {
        if (!line.startsWith('data: {')) continue;
        const event = JSON.parse(line.slice(6));
        events.push(event);
        if (options.stopAfterReady !== false && event.type === 'coding_workspace') {
          const controller = streamControllers.get(`owner:${req.body.streamId}`);
          controller.__siraStopReason = 'fixture_after_workspace_ready';
          controller.abort();
        }
      }
      return originalWrite(chunk, ...rest);
    };
    next();
  });
  app.use('/api/ai', router);
  const server = app.listen(0, '127.0.0.1');
  testContext.after(async () => {
    quotaReleased.resolve();
    const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
    assert.deepEqual(errors, [], errors.map((error) => error.stack).join('\n'));
  });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}/api/ai`;
  const request = async (payload = {}, route = '/generate') => {
    const response = await fetch(`${base}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        model: 'fixture-model', provider: 'OpenAI', chatId: 'chat-first', streamId: 'stream-first',
        prompt: 'Créame una web de ventas de bicicletas con frontend y backend', ...payload,
      }),
    });
    const text = await response.text();
    return { status: response.status, text, type: response.headers.get('content-type') };
  };
  return { request, calls, events, projects, workspaceResolutions, streamControllers, quotaEntered, quotaReleased };
}

test('first chat coding prompt provisions only after provider and quota preflight, then emits the bound workspace', async (testContext) => {
  const harness = await fixture(testContext);
  const response = await harness.request();
  assert.equal(response.status, 200);
  assert.match(response.type, /text\/event-stream/);
  assert.deepEqual(harness.calls, [
    'authorize-workspace', 'provider-preflight', 'quota-preflight', 'provider-preflight',
    'token-budget-preflight', 'prepare-workspace', 'create-project',
  ]);
  assert.equal(harness.projects.length, 1);
  const event = harness.events.find((entry) => entry.type === 'coding_workspace');
  assert.deepEqual(event, {
    type: 'coding_workspace', chatId: 'chat-first', projectId: 'project-first', projectName: harness.projects[0].name,
  });
  assert.ok(event.projectName.trim());
  assert.equal(harness.events[0].type, 'start');
  assert.equal(harness.events.some((entry) => entry.type === 'error'), false, response.text);
  assert.equal(harness.streamControllers.size, 0);
});

test('provider and quota rejection never create a project or announce a workspace', async (testContext) => {
  for (const options of [{ providerReady: false }, { quotaAllowed: false }]) {
    const harness = await fixture(testContext, options);
    const response = await harness.request();
    assert.equal(response.status, options.providerReady === false ? 503 : 429);
    assert.equal(JSON.parse(response.text).error, options.providerReady === false ? 'provider_unavailable' : 'quota_exceeded');
    assert.equal(harness.projects.length, 0);
    assert.equal(harness.calls.includes('prepare-workspace'), false);
    assert.equal(harness.events.length, 0);
  }
});

test('greeting with a forged coding hint stays inactive through the final preflight', async (testContext) => {
  const harness = await fixture(testContext, { budgetAllowed: false });
  const response = await harness.request({ prompt: 'hola', codingWorkspace: true });
  assert.equal(response.status, 200);
  assert.deepEqual(harness.calls, [
    'authorize-workspace', 'provider-preflight', 'quota-preflight', 'provider-preflight', 'token-budget-preflight',
  ]);
  assert.equal(harness.projects.length, 0);
  assert.equal(harness.events.some((event) => event.type === 'coding_workspace'), false);
  assert.equal(harness.events.find((event) => event.type === 'error')?.code, 'token_budget_exceeded');
  assert.deepEqual(harness.workspaceResolutions, [{ ok: true, active: false }]);
});

test('disabled access, disabled tools and foreign chats reject before provisioning or quota consumption', async (testContext) => {
  const cases = [
    { options: { enabled: false }, status: 403, error: 'coding_forbidden' },
    { options: { allowed: false }, status: 403, error: 'coding_forbidden' },
    { payload: { disableAgentic: true }, status: 409, error: 'coding_tools_disabled' },
    { options: { foreignChat: true }, status: 404, error: 'Chat not found' },
  ];
  for (const entry of cases) {
    const harness = await fixture(testContext, entry.options);
    const response = await harness.request(entry.payload);
    assert.equal(response.status, entry.status);
    assert.equal(JSON.parse(response.text).error, entry.error);
    assert.equal(harness.projects.length, 0);
    assert.equal(harness.calls.includes('quota-preflight'), false);
    assert.equal(harness.calls.includes('prepare-workspace'), false);
  }
});

test('Stop during quota preflight cancels the first coding turn without provisioning', async (testContext) => {
  const harness = await fixture(testContext, { holdQuota: true });
  const pending = harness.request();
  await harness.quotaEntered.promise;
  const stopped = await harness.request({}, '/stop-stream');
  assert.equal(stopped.status, 200);
  assert.equal(JSON.parse(stopped.text).stopped, true);
  harness.quotaReleased.resolve();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(harness.projects.length, 0);
  assert.equal(harness.calls.includes('prepare-workspace'), false);
  assert.equal(harness.events.some((event) => event.type === 'coding_workspace'), false);
  assert.equal(harness.streamControllers.size, 0);
});

test('workspace provisioning failure emits a terminal SSE error without ready metadata', async (testContext) => {
  const harness = await fixture(testContext, { provisionFails: true });
  const response = await harness.request();
  assert.equal(response.status, 200);
  assert.equal(harness.projects.length, 0);
  assert.equal(harness.events.some((event) => event.type === 'coding_workspace'), false);
  assert.equal(harness.events.find((event) => event.type === 'error').code, 'coding_unavailable');
  assert.match(response.text, /data: \[DONE\]/);
});

test('final provider and token-budget rejection leave no project behind', async (testContext) => {
  for (const options of [{ finalProviderReady: false }, { budgetAllowed: false }]) {
    const harness = await fixture(testContext, options);
    const response = await harness.request();
    assert.equal(response.status, 200);
    assert.equal(harness.projects.length, 0);
    assert.equal(harness.calls.includes('prepare-workspace'), false);
    assert.equal(harness.events.some((event) => event.type === 'coding_workspace'), false);
    const error = harness.events.find((event) => event.type === 'error');
    assert.equal(error?.code, options.finalProviderReady === false ? 'provider_unavailable' : 'token_budget_exceeded', response.text);
  }
});

test('unavailable agentic runtime or tool-less picked model cannot provision a project', async (testContext) => {
  const cases = [
    { options: { agenticEnabled: false } },
    { options: { modelHasTools: false } },
    { payload: { model: 'sira-mini' } },
    { payload: { provider: 'TypeSafe' } },
  ];
  for (const entry of cases) {
    const harness = await fixture(testContext, entry.options);
    const response = await harness.request(entry.payload);
    assert.equal(response.status, 200);
    assert.equal(harness.projects.length, 0);
    assert.equal(harness.calls.includes('prepare-workspace'), false);
    assert.equal(harness.events.some((event) => event.type === 'coding_workspace'), false);
    assert.equal(harness.events.find((event) => event.type === 'error')?.code, 'coding_tools_unavailable', response.text);
  }
});
