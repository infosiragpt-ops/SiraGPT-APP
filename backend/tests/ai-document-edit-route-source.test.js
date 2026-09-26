'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Source contract for POST /api/ai/document-edit (routes/ai.js is too coupled
// to boot in isolation; the service itself is covered by chat-document-editor).
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
  assert.match(route, /send\(await deliverDocumentEdit\(\{ result, files, persist, chatId \}\)\)/);
  assert.match(route, /const assistantMessageId = await persist\(content\)/);
  assert.match(route, /streamControllers\.delete\(controllerKey\)/);
});
