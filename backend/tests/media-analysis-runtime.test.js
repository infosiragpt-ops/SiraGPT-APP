'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMediaAnalysisCompletion } = require('../src/services/media-analysis-runtime');

function fixture(plan = 'PRO') {
  const user = { id: 'u', plan, monthlyLimit: 100, apiUsage: 0 };
  const calls = [], events = [], writes = [];
  const prisma = { user: { findUnique: async () => ({ ...user }), update: async ({ data }) => { user.apiUsage += data.apiUsage.increment; } },
    apiUsage: { create: async ({ data }) => writes.push(data) }, $transaction: ops => Promise.all(ops) };
  const runtime = createMediaAnalysisCompletion({ userId: 'u', chatId: 'c', prisma, model: 'user-selected-model', provider: 'selected-provider',
    client: { chat: { completions: { create: async (body, opts) => { calls.push({ body, opts }); return {
      choices: [{ message: { content: 'Evidencia' } }], usage: { prompt_tokens: 30, completion_tokens: 20 },
    }; } } } }, record: event => { events.push(event); return { cost_usd: 0.002 }; } });
  return { runtime, user, calls, events, writes };
}

test('each chunk uses selected model and records actual tokens/cost; next call stops at paid quota', async () => {
  const { runtime, calls, events, writes } = fixture();
  const signal = new AbortController().signal;
  await runtime.complete([{ role: 'user', content: 'fragmento1' }], signal);
  await runtime.complete([{ role: 'user', content: 'fragmento2' }], signal, true);
  assert.equal(calls[0].body.model, 'user-selected-model');
  assert.equal(calls[0].opts.signal, signal);
  assert.equal(writes.length, 2); assert.equal(writes[0].tokens, 50);
  assert.equal(runtime.usage.costUsd, 0.004);
  assert.equal(events.length, 2);
  await assert.rejects(runtime.complete([], signal), /quota_exhausted/);
  assert.equal(calls.length, 2);
});

test('FREE attachments stay exempt; usage telemetry still includes every analysis call', async () => {
  const { runtime, writes, events } = fixture('FREE');
  await runtime.complete([{ role: 'user', content: 'audio' }]);
  assert.equal(writes.length, 0);
  assert.equal(events.length, 1);
});

test('fresh quota reads preserve administrator unlimited entitlement', async () => {
  const { runtime, user, writes } = fixture();
  user.isAdmin = true; user.apiUsage = 500;
  await runtime.complete([{ role: 'user', content: 'audio' }]);
  assert.equal(writes.length, 0);
  assert.equal(runtime.usage.calls, 1);
});
