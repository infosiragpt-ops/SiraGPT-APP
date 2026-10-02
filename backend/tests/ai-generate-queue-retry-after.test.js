'use strict';

// /api/ai/generate admission and routing contracts: the fair queue's real
// wait (not a constant 2 s), the plan-quota body, re-routing only onto a
// ready provider with its own client, and the honest failure copy naming the
// picker's model (owner policy: a picked model is never switched).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  fairQueueRetryAfterSeconds,
  DEFAULT_SECONDS,
  MAX_SECONDS,
} = require('../src/services/ai/generate-queue-retry-after');

const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');

test('fairQueueRetryAfterSeconds uses the queue\'s own wait, clamped to [1, 60]', () => {
  assert.equal(fairQueueRetryAfterSeconds({ retryAfterMs: 58_000 }), 58);
  assert.equal(fairQueueRetryAfterSeconds({ retryAfterMs: 1_200 }), 2, 'rounded up, never early');
  assert.equal(fairQueueRetryAfterSeconds({ retryAfterSec: 5 }), 5);
  assert.equal(fairQueueRetryAfterSeconds({}), DEFAULT_SECONDS);
  assert.equal(fairQueueRetryAfterSeconds(null), DEFAULT_SECONDS);
  assert.equal(fairQueueRetryAfterSeconds({ retryAfterMs: 10 * 60_000 }), MAX_SECONDS);
  assert.equal(fairQueueRetryAfterSeconds({ retryAfterMs: -5, retryAfterSec: 0 }), DEFAULT_SECONDS);
  assert.equal(fairQueueRetryAfterSeconds({ retryAfterMs: 'abc', retryAfterSec: 3 }), 3);
});

test('queue.rejected sends the helper\'s wait in the header and the JSON body', () => {
  const start = route.indexOf("generateLog.warn('queue.rejected'");
  assert.ok(start > 0);
  const block = route.slice(start, start + 1600);
  assert.match(block, /fairQueueRetryAfterSeconds\(fair\)/);
  assert.match(block, /res\.setHeader\('Retry-After', String\(fairRetryAfterSeconds\)\)/);
  assert.match(block, /retryAfterSeconds: fairRetryAfterSeconds/);
  assert.doesNotMatch(block, /res\.setHeader\('Retry-After', '2'\)/);
});

test('quota_exceeded carries code, retryable:false and a Spanish message', () => {
  const start = route.indexOf('if (routed.blocked) {');
  assert.ok(start > 0);
  const block = route.slice(start, start + 700);
  assert.match(block, /res\.status\(429\)\.json\(\{/);
  assert.match(block, /error: 'quota_exceeded'/);
  assert.match(block, /code: 'quota_exceeded'/);
  assert.match(block, /retryable: false/);
  assert.match(block, /message: 'Alcanzaste el límite de tu plan\. Revisa tu plan para continuar\.'/);
});

test('re-routing only lands on a ready provider and switches model + provider + client together', () => {
  const start = route.indexOf('const __targetProvider = inferProviderFromModelId(__targetModel)');
  assert.ok(start > 0);
  const block = route.slice(start, start + 3000);
  assert.match(block, /resolveGenerateProvider\(__targetProvider, __targetModel\)/);
  assert.match(block, /providerConnectionReady\(__targetRuntimeProvider\)/);
  assert.match(block, /!isCustomProvider\(__targetRuntimeProvider\)/, 'a re-route never lands on Custom');
  // The client is built into a local BEFORE anything is reassigned, and a
  // failed build keeps the current model/provider/client.
  const build = block.indexOf('__targetResolution = createProviderClientForRequest(__targetRuntimeProvider, req');
  const assign = block.indexOf('actualModel = __targetModel;');
  assert.ok(build > 0 && assign > build, 'the client is built before the model changes');
  assert.match(block.slice(build, assign), /catch \(_clientErr\)/);
  assert.match(block.slice(build, assign), /if \(__targetResolution && __targetResolution\.client\)/);
  assert.match(block.slice(assign), /actualProvider = __targetRuntimeProvider;/);
  assert.match(block.slice(assign), /openai = __targetResolution\.client;/);
});

test('the picker comment states the owner policy (no silent failover)', () => {
  const start = route.indexOf("billingStatus: require('../services/ai/billing-failover').isOutOfCredit(connectionProvider)");
  assert.ok(start > 0);
  const comment = route.slice(Math.max(0, start - 600), start);
  assert.doesNotMatch(comment, /fails over to a funded model/);
  assert.match(comment, /never switched/);
});

test('every aiService.generateStream call names the model for the honest failure copy', () => {
  const calls = route.split('aiService.generateStream({').slice(1);
  assert.ok(calls.length >= 3);
  for (const call of calls) {
    // The argument object of this call (the next call is far below).
    assert.match(call.slice(0, 3500), /modelLabel:/, call.slice(0, 120));
  }
  // Getters, never awaited in the argument list: the display-name lookup
  // stays off the first-byte path (ai-service resolves it only on failure).
  assert.match(route, /modelLabel: __turnModelLabel,/);
  for (const call of calls) {
    assert.doesNotMatch(call.slice(0, 3500).split('\n').find((l) => /modelLabel:/.test(l)) || '', /modelLabel:\s*\(?await\b/);
  }
  // Every turn hands the aiModel row it already read to the label helper.
  assert.match(route, /catalogRow: _customResolution \? _customResolution\.catalog \|\| null : null,/);
});

test('webdev: a picked model that fails is reported (the buffered error frame), never a template site', () => {
  const start = route.indexOf("'/generate-webdev'");
  assert.ok(start > 0);
  const block = route.slice(start, route.indexOf("'/generate-google-services'"));
  assert.match(block, /frame\.type === 'error' && frame\.recovered !== true\) webdevErrorFrame = frame;/);
  // A Stop during the first pass returns first; then the picked model's
  // failure is handled before any repair / template fallback.
  const stopAt = block.indexOf('if (signal.aborted) return;');
  const failAt = block.indexOf('if (webdevErrorFrame) {');
  const repairAt = block.indexOf('if (!webdevProviderFailed) {');
  assert.ok(stopAt > 0 && failAt > stopAt && repairAt > failAt, 'the failure is handled before any repair / template fallback');
  assert.match(block.slice(failAt, repairAt), /closeGenerateSseWithError\(res, \{/);
  // A failed webdev turn is persisted as the honest reply but never metered
  // (the quota counts ApiUsage rows, which saveChatAndTrackUsage now skips).
  assert.match(block, /skipUsageMetering: webdevProviderFailed/);
  assert.doesNotMatch(block, /const tokens = webdevProviderFailed \? 0/);
});

test('onProviderFailure records the transparent cause (reason, provider, wait)', () => {
  const start = route.indexOf("generateLog.warn('provider.failure_cause'");
  assert.ok(start > 0);
  const block = route.slice(Math.max(0, start - 1200), start + 400);
  assert.match(block, /failureReason: info && info\.failureReason/);
  assert.match(block, /failureProvider: info && info\.failureProvider/);
  assert.match(block, /retryAfterSeconds/);
  assert.match(block, /__turnTap\.set\(failure\)/);
});

test('a picked model with no connection is named with «no está configurada» (generate, re-lookup and document-edit)', () => {
  const helper = route.slice(route.indexOf('async function unconfiguredModelMessage('), route.indexOf('async function planGateMessage('));
  assert.match(helper, /buildFailureMessage\(\{ modelLabel, reason: 'unconfigured' \}\)/);
  assert.match(helper, /\|\| PROVIDER_UNAVAILABLE_MESSAGE/);
  const uses = route.match(/message: await unconfiguredModelMessage\(\{/g) || [];
  assert.ok(uses.length >= 3, `generate preflight, custom re-lookup and document-edit (${uses.length})`);
  // Every provider_unavailable JSON answer now carries the named copy.
  assert.doesNotMatch(route, /error: 'provider_unavailable', message: PROVIDER_UNAVAILABLE_MESSAGE/);
});

test('the plan gate names the model by its display name, never the raw catalog id', () => {
  assert.doesNotMatch(route, /El modelo "\$\{catalogEntry\.id\}"/);
  const gates = route.match(/message: await planGateMessage\(\{/g) || [];
  assert.equal(gates.length, 2);
  const helper = route.slice(route.indexOf('async function planGateMessage('), route.indexOf('function createProviderClientForRequest('));
  assert.match(helper, /`\$\{label \|\| 'El modelo elegido'\} requiere un plan/);
});

test('document-edit: a provider failure names the model and the cause, the original stays untouched', () => {
  const start = route.indexOf("const cancelled = !editBudgetExceeded && (controller.signal.aborted || isAbortError(err));");
  assert.ok(start > 0);
  const block = route.slice(start, start + 2600);
  assert.match(block, /bf\.failureCauseFor\(err\)/);
  assert.match(block, /pickedModelLabelForTurn\(\{ model: actualModel, provider: actualProvider \}\)/);
  assert.match(block, /`\$\{providerFailure\} El documento original no se modificó\.`/);
});
