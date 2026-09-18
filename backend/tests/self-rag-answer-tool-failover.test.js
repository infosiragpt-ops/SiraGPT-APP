'use strict';

/**
 * self_rag_answer follows the picked model on its own client and, when that
 * provider errors (the live «404 The requested model was not found» with a
 * non-OpenAI picker model and a hard-coded gpt-4o-mini), answers through the
 * failover ladder instead of failing the step.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const enginePath = require.resolve('../src/services/rag/self-rag-engine');

async function withStubs({ infer, failoverClient }, fn) {
  const realEngine = require.cache[enginePath];
  require.cache[enginePath] = { exports: { infer, inferBeam: infer } };
  delete require.cache[require.resolve('../src/services/agents/task-tools')];
  const { INTERNAL } = require('../src/services/agents/task-tools');
  INTERNAL.selfRagDeps.failoverClientFactory = () => failoverClient;
  try { return await fn(INTERNAL.selfRagAnswer); }
  finally {
    INTERNAL.selfRagDeps.failoverClientFactory = null;
    if (realEngine) require.cache[enginePath] = realEngine; else delete require.cache[enginePath];
    delete require.cache[require.resolve('../src/services/agents/task-tools')];
  }
}

const picked = { tag: 'meta-client', chat: { completions: { create: async () => ({}) } } };
const ladder = { tag: 'ladder', chat: { completions: { create: async () => ({}) } } };

test('uses the picked model on the picked client first', async () => {
  const calls = [];
  await withStubs({
    infer: async (args) => { calls.push({ client: args.openai.tag, model: args.model }); return { segments: [{ text: 'Resumen en un párrafo.', source: null }] }; },
    failoverClient: ladder,
  }, async (tool) => {
    const r = await tool.execute({ question: 'Resume en un solo párrafo el documento' }, { userId: 'u1', openai: picked, model: 'muse-spark-1.3-contributor', onEvent() {} });
    assert.equal(r.ok, true);
    assert.deepEqual(calls, [{ client: 'meta-client', model: 'muse-spark-1.3-contributor' }]);
    assert.match(r.answer || r.text || JSON.stringify(r), /Resumen en un párrafo/);
  });
});

test('a provider error (404 model not found) moves the answer to the failover ladder', async () => {
  const calls = [];
  const events = [];
  await withStubs({
    infer: async (args) => {
      calls.push(args.openai.tag);
      if (args.openai.tag === 'meta-client') { const e = new Error('404 The requested model was not found.'); e.status = 404; throw e; }
      return { segments: [{ text: 'Respuesta por el ladder.', source: null }] };
    },
    failoverClient: ladder,
  }, async (tool) => {
    const r = await tool.execute({ question: 'Resume el documento' }, { userId: 'u1', openai: picked, model: 'muse-spark-1.3-contributor', onEvent: (e) => events.push(e) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(calls, ['meta-client', 'ladder']);
    assert.ok(events.some((e) => /Reintentando con otro proveedor/.test(e.preview || '')));
  });
});

test('a non-provider error (bad question / engine bug) still fails the step honestly', async () => {
  const calls = [];
  await withStubs({
    infer: async (args) => { calls.push(args.openai.tag); throw new Error('segments must be an array'); },
    failoverClient: ladder,
  }, async (tool) => {
    const r = await tool.execute({ question: 'x' }, { userId: 'u1', openai: picked, onEvent() {} });
    assert.equal(r.ok, false);
    assert.deepEqual(calls, ['meta-client'], 'no blind retry on non-provider errors');
  });
});
