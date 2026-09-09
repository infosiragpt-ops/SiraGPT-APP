'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAcceptanceChatAdmission, requestAccredited, chatAccredited } = require('../src/middleware/acceptance-chat-admission');
const { MODEL } = require('../src/services/ai/acceptance-spend-guard');

const body = () => ({ provider: 'Meta', model: MODEL, prompt: 'responde solo OK', chatId: 'chat-1',
  streamId: 'stream-1', idempotencyKey: 'turn-1', files: [], mentionedApps: [], permission: 'full', reasoningEffort: 'Extra high', disableAgentic: true });
const chat = () => ({ userId: 'user-1', model: MODEL, messages: [],
  _count: { agentTasks: 0, goalRuns: 0, generatedArtifacts: 0, runs: 0, coworkRuns: 0 } });

test('accepts normal UI envelope without changing the selected effort/permissions', () => {
  const input = body();
  const before = structuredClone(input);
  assert.equal(requestAccredited(input), true);
  assert.deepEqual(input, before);
  for (const effort of ['Medio', 'Bajo', 'Extra high', 'low', 'xhigh']) assert.equal(requestAccredited({ ...input, reasoningEffort: effort }), true);
  const absentOptional = { provider: 'Meta', model: MODEL, prompt: 'Responde solo con HTML autocontenido para un juego de ajedrez, sin herramientas, archivos ni enlaces.', chatId: 'chat-1', streamId: 'stream-1', idempotencyKey: 'turn-1', disableAgentic: true };
  assert.equal(requestAccredited(absentOptional), true);
  assert.equal(requestAccredited({ ...input, regenerate: false, regenerationAttempt: 0 }), true);
});

for (const [name, patch] of Object.entries({
  provider: { provider: 'OpenAI' }, model: { model: 'muse-spark-1.3' }, chat: { chatId: '' },
  nullPrompt: { prompt: null }, longPrompt: { prompt: `responde solo ${'a'.repeat(121)}` },
  toolsPrompt: { prompt: 'Busca en internet y crea una presentación' },
  files: { files: ['file-1'] }, mentionedApps: { mentionedApps: ['gmail'] }, pinnedApps: { pinnedAppIds: ['github'] },
  badFileShape: { files: {} }, agentic: { disableAgentic: false }, missingDirectGate: { disableAgentic: undefined }, unknown: { chip: 'image' },
  permission: { permission: 'administrator' }, toolPermission: { toolPermission: 'administrator' },
  reasoningType: { reasoningEffort: [] }, reasoningLength: { reasoningEffort: 'x'.repeat(17) },
  badStream: { streamId: 1 }, missingStream: { streamId: undefined }, emptyStream: { streamId: '  ' }, longIdempotency: { idempotencyKey: 'x'.repeat(201) },
  regenerate: { regenerate: 'yes' }, regenerationAttempt: { regenerationAttempt: -1 },
  regenerateTrue: { regenerate: true }, positiveRegenerationAttempt: { regenerationAttempt: 1 },
})) test(`rejects unaccredited request: ${name}`, () => assert.equal(Boolean(requestAccredited({ ...body(), ...patch })), false));

test('null and arrays are not valid request bodies', () => {
  for (const value of [null, undefined, [], 'text']) assert.equal(Boolean(requestAccredited(value)), false);
});

test('accepts plain persisted text history only', () => {
  assert.equal(chatAccredited(chat(), 'user-1'), true);
  assert.equal(chatAccredited({ ...chat(), messages: [{ role: 'USER', content: 'responde solo OK', files: [] }, { role: 'ASSISTANT', content: 'OK', files: null }] }, 'user-1'), true);
});

for (const field of ['deletedAt', 'isArchived', 'isShared', 'customGptId', 'projectId', 'coworkWorkspaceId', 'organizationId',
  'contextSummary', 'googleCalendarContext', 'isWordConnectorChat', 'isExcelConnectorChat', 'wordContent', 'excelContent']) {
  test(`rejects persisted context: ${field}`, () => assert.equal(Boolean(chatAccredited({ ...chat(), [field]: true }, 'user-1')), false));
}
for (const field of ['agentTasks', 'goalRuns', 'generatedArtifacts', 'runs', 'coworkRuns']) {
  test(`rejects persisted work: ${field}`, () => assert.equal(Boolean(chatAccredited({ ...chat(), _count: { ...chat()._count, [field]: 1 } }, 'user-1')), false));
}
test('rejects missing owner, catalog mismatch, pins, unknown counts and rich/oversized history', () => {
  for (const candidate of [null, { ...chat(), userId: 'other' }, { ...chat(), model: 'other' },
    { ...chat(), pinnedAppIds: ['gmail'] }, { ...chat(), _count: {} }, { ...chat(), _count: null },
    { ...chat(), messages: null }, { ...chat(), messages: Array(21).fill({ role: 'USER', content: 'OK' }) }]) {
    assert.equal(Boolean(chatAccredited(candidate, 'user-1')), false);
  }
  for (const message of [{ role: 'TOOL', content: 'OK' }, { role: 'USER', content: 12 },
    { role: 'USER', content: 'x'.repeat(100001) }, { role: 'USER', content: 'OK', files: ['file'] },
    { role: 'ASSISTANT', content: 'OK', agentMetadata: {} }, { role: 'ASSISTANT', content: '<artifact title="x">' },
    { role: 'ASSISTANT', content: '[CREATE_DOCUMENT:test.docx]x' }, { role: 'ASSISTANT', content: 'agent-task-state' }]) {
    assert.equal(Boolean(chatAccredited({ ...chat(), messages: [message] }, 'user-1')), false);
  }
});

function harness({ active = true, available = true, persisted = chat(), error = null } = {}) {
  const calls = [];
  const prisma = { chat: { findUnique: async query => { calls.push(query); if (error) throw error; return persisted; } } };
  const spend = { isActive: () => active, status: () => ({ available }) };
  const middleware = createAcceptanceChatAdmission({ prisma, spend });
  const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; },
    append(name, value) { this.headers[name] = this.headers[name] ? `${this.headers[name]}, ${value}` : value; },
    status(code) { this.code = code; return this; }, json(payload) { this.payload = payload; return this; } };
  let next = 0;
  return { calls, res, middleware, async run(req = { user: { id: 'user-1' }, body: body() }) { await middleware(req, res, () => { next++; }); return next; } };
}

test('outside the private campaign admission is a no-op with no DB lookup', async () => {
  const h = harness({ active: false });
  assert.equal(await h.run({}), 1);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.res.headers, {});
});
test('campaign admission owns the chat and checks availability before calling next', async () => {
  const h = harness();
  assert.equal(await h.run(), 1);
  assert.deepEqual(h.calls[0].where, { id: 'chat-1' });
  assert.equal(h.calls[0].select.userId, true);
  assert.equal(h.calls[0].select.messages.take, 21);
  assert.deepEqual(h.res.headers, { 'X-Sira-Acceptance': '1', 'Access-Control-Expose-Headers': 'X-Sira-Acceptance' });
});
test('private header exposure preserves pre-existing response headers', async () => {
  const h = harness();
  h.res.headers['Access-Control-Expose-Headers'] = 'ETag, Content-Disposition';
  assert.equal(await h.run(), 1);
  assert.equal(h.res.headers['Access-Control-Expose-Headers'], 'ETag, Content-Disposition, X-Sira-Acceptance');
  assert.equal(h.res.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(h.res.headers['Access-Control-Allow-Credentials'], undefined);
});
test('invalid input/auth blocks before DB, even if the binder was miswired', async () => {
  for (const req of [{ body: body() }, { user: { id: 'user-1' }, body: { ...body(), chip: 'image' } },
    { user: { id: 'user-1' }, body: { ...body(), regenerate: true } },
    { user: { id: 'user-1' }, body: { ...body(), regenerationAttempt: 1 } },
    { user: { id: 'user-1' }, body: body(), headers: { 'x-sira-gateway': '1' } },
    { user: { id: 'user-1' }, body: body(), headers: { 'x-org-id': 'org-1' } },
    { user: { id: 'user-1' }, body: body(), orgContext: { orgId: 'org-1' } }]) {
    const h = harness();
    assert.equal(await h.run(req), 0);
    assert.equal(h.calls.length, 0);
    assert.equal(h.res.code, 402);
    assert.equal(h.res.payload.retryable, false);
    assert.deepEqual(h.res.headers, {});
  }
});
for (const [name, options] of Object.entries({ missing: { persisted: null }, foreign: { persisted: { ...chat(), userId: 'other' } },
  unavailable: { available: false }, databaseFailure: { error: new Error('sk-secret database URL must not leak') } })) {
  test(`fails closed on ${name}`, async () => {
    const h = harness(options);
    assert.equal(await h.run(), 0);
    assert.equal(h.res.code, 402);
    assert.equal(h.res.payload.code, 'E_QUOTA');
    assert.doesNotMatch(JSON.stringify(h.res.payload), /sk-secret|database URL/);
    assert.deepEqual(h.res.headers, {});
  });
}
test('real route binds only after authentication and admits before quota/enrichment', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
  assert.match(source, /authenticateToken,\s*requireScope\('ai:generate'\),\s*acceptanceSpend.middleware.bind,\s*createAcceptanceChatAdmission\(\{ prisma \}\),\s*enforceOrgQuotaSafe/);
  assert.match(source, /if \(artifactGenerator.isArtifactRequest\(prompt\)\) \{\s*acceptanceSpend.denyUnbudgetedOperation\(\)/);
  assert.match(source, /if \(__agenticWillRun\) \{\s*acceptanceSpend.denyUnbudgetedOperation\(\)/);
  assert.match(source, /if \(directive\) \{\s*acceptanceSpend.denyUnbudgetedOperation\(\)/);
  assert.match(source, /catch \(agenticErr\) \{\s*if \(acceptanceSpend.isAcceptanceSpendError\(agenticErr\)\) throw agenticErr/);
  for (const factory of ['makeGeminiCorefJudge', 'makeGeminiJudge', 'makeHaikuJudge', 'makeGroqJudge']) {
    assert.ok(source.includes(`${factory}({ fetchImpl: guardedProviderFetch })`));
  }
  assert.match(source, /function enrichWithWebSearch\(\.\.\.args\) \{\s*acceptanceSpend.denyUnbudgetedOperation\(\);\s*return rawEnrichWithWebSearch\(\.\.\.args\)/);
});
