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
const artifacts = require('../src/services/artifacts/artifact-generator');
const agenticDegradePolicy = require('../src/services/ai/agentic-degrade-policy');

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
  const projects = options.existingProject ? [options.existingProject] : [];
  const workspaceResolutions = [];
  const agenticRuns = [];
  const artifactRuns = [];
  const plainRuns = [];
  const persistedTurns = [];
  const warnings = [];
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
    info() {}, warnError() {},
    warn(event, metadata) { warnings.push({ event, metadata }); },
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
    '../services/github/github-chat-turn': require('../src/services/github/github-chat-turn'),
    '../services/github/github-chat-handoff': require('../src/services/github/github-chat-handoff'),
    '../services/turn-progress': turnProgress,
    '../services/agent-runner/activity-trace': { createActivityTraceCollector: () => ({}) },
    '../services/rlhf/reason-codes': { resolveFeedbackReasons: () => null },
    '../services/agentic-chat-stream': {
      isEnabled: () => options.agenticEnabled !== false,
      modelSupportsFunctionCalling: () => options.modelHasTools !== false,
      resolveToolCallMode: () => options.modelHasTools === false ? 'none' : 'native',
      runAgenticChat: async (input) => {
        agenticRuns.push(input);
        const result = options.agenticResult || { finalAnswer: 'Fixture coding result', stoppedReason: 'finalized' };
        input.res.write(`data: ${JSON.stringify({ content: result.finalAnswer })}\n\n`);
        return result;
      },
      isHandledAgenticChatResult: (result) => result.stoppedReason === 'finalized',
    },
    '../services/ai/picked-model-label': { resolvePickedModelLabel: async () => 'Modelo elegido' },
    '../services/ai/agentic-degrade-policy': agenticDegradePolicy,
    '../services/agents/generated-artifact-followup': { resolveChatGeneratedArtifactFollowup: async () => [] },
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
    createProviderClient: (provider) => ({ provider }),
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
    usageService: { calculateTextTokens: () => 1 },
    streamCache: { start: async () => null },
    detectCodeTaskIntent: () => ({ isCodeTask: false, confidence: 0 }),
    artifactGenerator: {
      ...artifacts,
      generate: async (input) => {
        artifactRuns.push(input);
        return { refused: false, title: 'Fixture artifact', description: '', html: '<html>Artifact</html>' };
      },
    },
    aiService: {
      generateStream: async (input) => {
        plainRuns.push(input);
        input.res.write(`data: ${JSON.stringify({ content: 'Fixture plain completion' })}\n\n`);
        return 'Fixture plain completion';
      },
    },
    OpenAI: class FixtureOpenAI {},
    _hashUserIdForSpan: () => null,
    withAIGenerateSpan: (_attributes, callback) => callback(null),
    resolveUserSkillClearance: () => 'standard',
    MESSAGE_IDEMPOTENCY_HASH_FIELD: turnIdentity.MESSAGE_IDEMPOTENCY_HASH_FIELD,
    saveChatAndTrackUsage: async (...args) => { persistedTurns.push(args); return null; },
    postResponseBrainHook: { runShadowModeBrainPipeline: async () => {} },
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
  return { request, calls, events, projects, workspaceResolutions, agenticRuns, artifactRuns, plainRuns, persistedTurns, warnings, streamControllers, quotaEntered, quotaReleased };
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

test('interactive software requests reach the bound coding agent with the picked model instead of generating isolated artifacts', async (testContext) => {
  for (const prompt of [
    'Build an interactive bicycle store web app',
    'Crea una app web y genera una visualización de sus ventas',
  ]) {
    assert.equal(artifacts.isArtifactRequest(prompt), true);
    const harness = await fixture(testContext, { stopAfterReady: false });
    const response = await harness.request({ prompt, model: 'fixture-selected-model', provider: 'Gemini' });
    assert.equal(response.status, 200);
    assert.equal(harness.projects.length, 1);
    assert.equal(harness.artifactRuns.length, 0);
    assert.equal(harness.agenticRuns.length, 1, response.text);
    const run = harness.agenticRuns[0];
    assert.equal(run.model, 'fixture-selected-model');
    assert.equal(run.provider, 'Gemini');
    assert.equal(run.openai.provider, 'Gemini');
    assert.equal(run.userQuery, prompt);
    assert.equal(run.toolContext.codingWorkspace.projectId, harness.projects[0].id);
    assert.equal(run.toolContext.chatId, 'chat-first');
    assert.equal(run.toolContext.coworkDisabled, true);
    assert.equal(harness.events.some((event) => event.type === 'error'), false, response.text);
    assert.match(response.text, /Fixture coding result/);
    assert.match(response.text, /data: \[DONE\]/);
  }
});

test('degraded coding runs preserve their full trace and report failure without plain regeneration', async (testContext) => {
  for (const entry of [
    { stoppedReason: 'no_message', reasonCode: 'no_message', status: null },
    { stoppedReason: 'invalid_tool_calls', reasonCode: 'invalid_tool_calls', status: null },
    { stoppedReason: 'model_error: 503 fixture provider unavailable', reasonCode: 'model_error', status: 503 },
  ]) {
    const agentRun = {
      stoppedReason: entry.stoppedReason,
      interrupted: false,
      durationMs: 123456,
      toolCallCount: 19,
      steps: Array.from({ length: 19 }, (_, stepIndex) => ({
        stepIndex, type: 'tool_call', toolName: 'codex_write_file', status: 'completed', durationMs: 1200,
        args: { path: `src/fixture-${stepIndex}.js` }, result: { ok: true },
      })),
    };
    const agentActivityTrace = {
      kind: 'agent_runner_trace', version: 2, durationMs: 123456,
      activityTrace: [{ type: 'tool_result', tool: 'codex_write_file', status: 'completed' }],
    };
    const harness = await fixture(testContext, {
      stopAfterReady: false,
      agenticResult: {
        finalAnswer: 'Fixture incomplete coding response', stoppedReason: entry.stoppedReason,
        agentRun, agentActivityTrace,
      },
    });
    const response = await harness.request();
    assert.equal(response.status, 200);
    assert.equal(harness.agenticRuns.length, 1);
    assert.equal(harness.plainRuns.length, 0);
    assert.equal(harness.artifactRuns.length, 0);
    assert.equal(harness.persistedTurns.length, 1, response.text);
    const persisted = harness.persistedTurns[0];
    assert.equal(persisted[12], agentRun, entry.stoppedReason);
    assert.equal(persisted[14].activityTrace, agentActivityTrace, entry.stoppedReason);
    assert.equal(persisted[12].steps.length, 19);
    assert.equal(persisted[12].durationMs, 123456);
    assert.match(persisted[3], /No pude completar la operación.*no doy los cambios por terminados/);
    const replacement = harness.events.filter((event) => event.replace === true).at(-1);
    assert.equal(replacement.content, persisted[3]);
    assert.doesNotMatch(persisted[3], /Fixture incomplete coding response|Fixture plain completion/);
    const degraded = harness.warnings.find((warning) => warning.event === 'agentic.degraded');
    assert.equal(degraded?.metadata.reasonCode, entry.reasonCode);
    assert.equal(degraded.metadata.status ?? null, entry.status);
    assert.equal(degraded.metadata.durationMs, 123456);
    assert.doesNotMatch(JSON.stringify(degraded.metadata), /fixture provider unavailable/);
    assert.match(response.text, /data: \[DONE\]/);
    assert.equal(harness.streamControllers.size, 0);
  }
});

test('same-project continuation constraints reuse the bound workspace without generating a new project or isolated artifact', async (testContext) => {
  for (const prompt of [
    'Continúa en este mismo proyecto. Conserva lo ya creado, comprueba el backend y termina la validación. npm run build ya compiló correctamente. La vista previa está iniciada. No crees otro proyecto ni uses servicios de pago.',
    'Continúa en este mismo proyecto. No crees otro proyecto.',
    'Continúa en este mismo proyecto',
  ]) {
    const existingProject = { id: 'project-existing', name: 'Aplicación existente', status: 'ready' };
    const harness = await fixture(testContext, { stopAfterReady: false, existingProject });
    const response = await harness.request({ prompt, codingWorkspace: true });
    assert.equal(response.status, 200);
    assert.equal(harness.agenticRuns.length, 1, response.text);
    assert.equal(harness.agenticRuns[0].toolContext.codingWorkspace.projectId, existingProject.id);
    assert.equal(harness.agenticRuns[0].userQuery, prompt);
    assert.equal(harness.projects.length, 1);
    assert.equal(harness.calls.includes('create-project'), false);
    assert.ok(harness.workspaceResolutions.length > 0);
    assert.ok(harness.workspaceResolutions.every((result) => result.active && result.reused === true && result.projectId === existingProject.id));
    assert.equal(harness.plainRuns.length, 0);
    assert.equal(harness.artifactRuns.length, 0);
    assert.match(response.text, /data: \[DONE\]/);
  }
});

test('GitHub consent uses the canonical response persistence with Mini, tool-less and disabled agentic runtimes', async (testContext) => {
  for (const entry of [
    { options: { agenticEnabled: false } },
    { options: { modelHasTools: false } },
    { payload: { model: 'sira-mini' } },
    { payload: { provider: 'TypeSafe' } },
  ]) {
    const harness = await fixture(testContext, entry.options);
    const response = await harness.request({ prompt: 'pásame el link de GitHub para loguearme', ...entry.payload });
    assert.equal(response.status, 200, response.text);
    assert.equal(harness.events.filter(event => event.type === 'github_connection_required').length, 1, response.text);
    assert.equal(harness.agenticRuns.length, 0); assert.equal(harness.plainRuns.length, 0); assert.equal(harness.artifactRuns.length, 0);
    assert.equal(harness.projects.length, 0);
    assert.equal(harness.persistedTurns.length, 1);
    assert.match(harness.persistedTurns[0][3], /pendiente de tu autorización/);
    assert.equal(harness.persistedTurns[0][4], 0);
    assert.equal(harness.persistedTurns[0][14].skipUsageMetering, true);
    assert.match(response.text, /data: \[DONE\]/);
    assert.equal(harness.streamControllers.size, 0);
  }
});

test('GitHub consent route respects foreign chat rejection and explicit disableAgentic', async (testContext) => {
  const forbidden = await fixture(testContext, { foreignChat: true });
  assert.equal((await forbidden.request({ prompt: 'conecta GitHub' })).status, 404);
  assert.equal(forbidden.events.length, 0);
  const disabled = await fixture(testContext, { modelHasTools: false });
  const response = await disabled.request({ prompt: 'conecta GitHub', disableAgentic: true });
  assert.equal(response.status, 200, response.text);
  assert.equal(disabled.events.some(event => event.type === 'github_connection_required'), false);
});
