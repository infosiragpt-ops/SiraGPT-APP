'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const express = require('express');
const { body, validationResult } = require('express-validator');
const { tryConsumePlanQuota } = require('../src/services/plan-quota');
const { deliverDocumentEdit } = require('../src/services/document-editor/deliver-edit');

// POST /api/ai/document-edit: wiring contracts plus the isolated real handler
// below. The document-editing engine has its own chat-document-editor suite.
const source = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
const start = source.indexOf("  '/document-edit',");
const end = source.indexOf("router.post('/stop-stream'", start);
const route = source.slice(start, end);

test('document-edit shares the /generate auth, scope and org guards', () => {
  assert.ok(start > 0 && end > start);
  assert.match(route, /authenticateToken,\s*requireScope\('ai:generate'\),\s*enforceOrgQuotaSafe,\s*enforceOrgRateLimitSafe,\s*enforceOrgBudgetSafe,/);
  assert.match(route, /prisma\.chat\.findFirst\(\{ where: \{ id: chatId, userId \}/);
  assert.match(route, /permission === 'read' \|\| permission === 'protected'/);
});

test('the picked model is resolved exactly like /generate and drives the editor client', () => {
  assert.match(route, /honorPickerModel\(model, \{ provider \}\)/);
  assert.match(route, /resolveGenerateProvider\(provider, model\)/);
  assert.match(route, /resolveCustomConnectionForTurn\(/);
  assert.match(route, /providerConnectionReady\(actualProvider\)/);
  assert.match(route, /modelRouter\.isPlanEligible\(catalogEntry\.plans, userPlan\)/);
  assert.match(route, /tryConsumePlanQuota\(/);
  assert.match(route, /createProviderClientForRequest\(actualProvider, req, \{ customConnection, model: actualModel \}\)/);
  assert.match(route, /llm: \{ client, model: actualModel, provider: actualProvider, toolCallMode \}/);
});

test('only the explicit Stop aborts; edits use the persistence-confirmed delivery path', () => {
  assert.match(route, /streamControllers\.set\(controllerKey, controller\)/);
  assert.doesNotMatch(route, /res\.on\('close'[^)]*abort|req\.on\('aborted'[^)]*abort/);
  assert.match(route, /require\('\.\.\/services\/document-editor\/deliver-edit'\)/);
  assert.match(route, /send\(await deliverDocumentEdit\(\{ result, files, persist: persistResult, chatId \}\)\)/);
  assert.match(route, /const assistantMessageId = await persist\(content, \[\], \{ skipUsageMetering: true \}\)/);
  assert.match(route, /streamControllers\.delete\(controllerKey\)/);
});

// Execute the real route rather than duplicating its admission/metering logic.
// Storage and the external editor are boundaries; HTTP, validation, quota and
// delivery are the production implementations.
async function editorHttpFixture(t, mode = 'success', user = {}) {
  const saves = [];
  let editorCalls = 0;
  let clientCalls = 0;
  let expireBudget;
  const controllers = new Map();
  const router = express.Router();
  const pass = (_req, _res, next) => next();
  const context = {
    router, body, validationResult, AbortController, Buffer,
    crypto: require('node:crypto'),
    process: { env: {} },
    console: { warn() {}, error() {} },
    setInterval: () => 1, clearInterval() {},
    setTimeout: (callback) => { expireBudget = callback; return { unref() {} }; },
    clearTimeout() {},
    authenticateToken: (req, _res, next) => {
      req.user = { id: 'owner', plan: 'PRO', monthlyLimit: 10000, apiUsage: 0, ...user };
      next();
    },
    requireScope: () => pass,
    enforceOrgQuotaSafe: pass, enforceOrgRateLimitSafe: pass, enforceOrgBudgetSafe: pass,
    turnFailures: { beginTurn: () => null, noteTurn() {} },
    lookupPickerDisplayName: () => 'Modelo elegido',
    prisma: { chat: { findFirst: async ({ where }) => where.id === 'chat-1' && where.userId === 'owner' ? { id: 'chat-1' } : null } },
    honorPickerModel: (model, { provider }) => ({ model, provider }),
    isSiraMiniAlias: () => false,
    resolveGenerateProvider: (provider) => provider,
    resolveCustomConnectionForTurn: async () => ({ isCustom: false }),
    providerConnectionReady: () => true,
    modelRouter: { getModel: () => null },
    tryConsumePlanQuota,
    createProviderClientForRequest: () => { clientCalls++; return { client: {} }; },
    streamControllers: controllers,
    loadUserFile: async (id, userId) => ({ id, userId, name: 'original.docx' }),
    saveChatAndTrackUsage: async (...args) => { saves.push(args); return { assistantMessage: { id: 'saved-assistant' } }; },
    pickedModelLabelForTurn: async () => 'Modelo elegido',
    isAbortError: (error) => error?.name === 'AbortError',
    require: (name) => {
      if (name === '../services/agentic-chat-stream') return { resolveToolCallMode: () => 'native' };
      if (name === '../services/agent-runner/activity-trace') throw new Error('optional collector unavailable in fixture');
      if (name === '../services/document-editor/deliver-edit') return { deliverDocumentEdit };
      if (name === '../services/ai/billing-failover') return {
        failureCauseFor: () => 'billing', buildFailureMessage: () => 'El servicio no tiene saldo disponible.',
      };
      if (name === '../services/document-editor/chat-document-editor') return {
        toAssistantFiles: (files) => files,
        runChatDocumentEdit: async () => {
          editorCalls++;
          if (mode === 'provider-error') throw new Error('provider has no credit');
          if (mode === 'cancelled') {
            controllers.values().next().value.abort();
            throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
          }
          if (mode === 'timeout') {
            expireBudget();
            throw Object.assign(new Error('time budget'), { name: 'AbortError' });
          }
          if (mode === 'failed-result') return { ok: false, code: 'FAILED', message: 'No se pudo verificar la edición.', artifacts: [] };
          if (mode === 'unchanged') return { ok: false, code: 'NO_CHANGES_NEEDED', message: 'El documento ya cumple el pedido.', artifacts: [] };
          return { ok: true, summary: 'Edición verificada.', artifacts: [{ id: 'edited', name: 'editado.docx' }] };
        },
      };
      throw new Error(`Unexpected fixture dependency: ${name}`);
    },
  };
  vm.runInNewContext(`router.post(\n${route}`, context, { filename: 'document-edit-route.js' });
  const app = express();
  app.use(express.json());
  app.use('/api/ai', router);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ai/document-edit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Corrige el título.', model: 'chosen', provider: 'chosen-provider', chatId: 'chat-1', fileIds: ['original'], streamId: 'stream-1' }),
  });
  const text = await response.text();
  const frames = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  return { response, text, frames, saves, editorCalls, clientCalls, controllers };
}

for (const mode of ['provider-error', 'cancelled', 'timeout', 'failed-result']) {
  test(`document-edit ${mode} persists the notice without charging successful-use quota`, async (t) => {
    const result = await editorHttpFixture(t, mode);
    assert.equal(result.response.status, 200);
    assert.equal(result.saves.length, 1, 'the result remains visible in the saved conversation');
    assert.equal(result.saves[0][14].skipUsageMetering, true, 'a failed edit must not spend the user\'s quota');
    assert.equal(result.frames.at(-1).ok, false);
    assert.equal(result.frames.at(-1).assistantMessageId, 'saved-assistant');
    assert.equal(result.controllers.size, 0);
  });
}

test('document-edit success retains normal quota accounting and delivers the saved file', async (t) => {
  const result = await editorHttpFixture(t);
  assert.equal(result.saves.length, 1);
  assert.notEqual(result.saves[0][14].skipUsageMetering, true);
  assert.equal(result.frames.at(-1).ok, true);
  assert.equal(result.frames.at(-1).files[0].id, 'edited');
});

test('document-edit verified unchanged answer retains normal quota accounting', async (t) => {
  const result = await editorHttpFixture(t, 'unchanged');
  assert.equal(result.saves.length, 1);
  assert.equal(result.saves[0][14].skipUsageMetering, false);
  assert.equal(result.frames.at(-1).code, 'NO_CHANGES_NEEDED');
  assert.equal(result.frames.at(-1).assistantMessageId, 'saved-assistant');
});

test('document-edit exhausted quota returns an actionable 429 before constructing the editor client', async (t) => {
  const result = await editorHttpFixture(t, 'success', { apiUsage: 10000, monthlyLimit: 10000 });
  assert.equal(result.response.status, 429);
  const error = JSON.parse(result.text);
  assert.equal(error.error, 'Monthly API limit exceeded');
  assert.equal(error.code, 'E_QUOTA');
  assert.equal(error.retryable, false);
  assert.match(error.message, /límite.*plan/i);
  assert.equal(result.clientCalls, 0);
  assert.equal(result.editorCalls, 0);
  assert.equal(result.saves.length, 0);
});
