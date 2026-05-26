'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveTaskContract } = require('../src/services/agents/task-contract-resolver');

/**
 * Provider-aware model remapping in task-contract-resolver.
 *
 * Background: the resolver historically hard-coded `model = "gpt-4o-mini"`
 * and accepted whatever OpenAI-shaped client the caller handed it. In
 * practice that client could be the user's selected provider — DeepSeek,
 * OpenRouter, Anthropic-shim, etc. — none of which accept the "gpt-4o-mini"
 * identifier. The call failed with HTTP 400 and dropped the resolver
 * into its fallback branch every single turn. These tests pin the new
 * behavior in place:
 *
 *   - If the client looks like DeepSeek, remap to deepseek-v4-{flash,pro}
 *   - If OPENAI_API_KEY is set and the client is non-OpenAI, build a
 *     side-channel OpenAI client just for the resolver
 *   - Caller-provided client + model are honored for OpenAI-native flow
 *   - The resolver NEVER throws synchronously — falls back gracefully
 *     when the chosen path errors out
 */

// Capture which (model, baseURL) tuple the resolver picked at call time.
function fakeOpenAIClient({ baseURL, onCall }) {
  return {
    baseURL,
    chat: {
      completions: {
        create: async (opts) => {
          onCall({ model: opts.model, baseURL });
          // Return a parseable but intentionally invalid contract so
          // the resolver falls through to its `fallback` branch and
          // we can assert the call WAS attempted with the right model
          // — without taking a dependency on the JSON-schema validator
          // implementation details.
          return {
            choices: [
              { message: { content: '{}' } },
            ],
          };
        },
      },
    },
  };
}

test('resolver: DeepSeek client → model remapped to deepseek-v4-flash', async () => {
  const calls = [];
  const ds = fakeOpenAIClient({
    baseURL: 'https://api.deepseek.com',
    onCall: (call) => calls.push(call),
  });
  const fallback = ({ goal }) => ({ goal, intent: 'general_chat', _fallback: true });
  const out = await resolveTaskContract({
    goal: 'hola, analiza este pdf',
    openai: ds,
    model: 'gpt-4o-mini',
    fileIds: ['f1'],
    fallback,
  });
  // The resolver must have tried the DeepSeek client at least once.
  assert.equal(calls.length, 1, 'expected one resolver call');
  assert.equal(calls[0].model, 'deepseek-v4-flash');
  assert.match(calls[0].baseURL, /deepseek\.com/);
  // Empty JSON does not validate, so we get the fallback contract.
  assert.equal(out.source, 'fallback');
});

test('resolver: DeepSeek with explicit "pro" hint stays on pro tier', async () => {
  const calls = [];
  const ds = fakeOpenAIClient({
    baseURL: 'https://api.deepseek.com',
    onCall: (call) => calls.push(call),
  });
  await resolveTaskContract({
    goal: 'resumen',
    openai: ds,
    model: 'deepseek-v4-pro',
    fileIds: [],
    fallback: () => ({ intent: 'g', _fallback: true }),
  });
  assert.equal(calls[0].model, 'deepseek-v4-pro');
});

test('resolver: OpenAI-native client → model is preserved', async () => {
  const calls = [];
  const oai = fakeOpenAIClient({
    baseURL: 'https://api.openai.com/v1',
    onCall: (call) => calls.push(call),
  });
  await resolveTaskContract({
    goal: 'genera un pdf con un memo',
    openai: oai,
    model: 'gpt-4o-mini',
    fileIds: [],
    fallback: () => ({ intent: 'g', _fallback: true }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'gpt-4o-mini');
  assert.match(calls[0].baseURL, /openai\.com/);
});

test('resolver: client with no baseURL (default OpenAI) → model preserved', async () => {
  const calls = [];
  const oai = fakeOpenAIClient({
    baseURL: undefined,
    onCall: (call) => calls.push(call),
  });
  await resolveTaskContract({
    goal: 'hola',
    openai: oai,
    model: 'gpt-4o-mini',
    fileIds: [],
    fallback: () => ({ intent: 'g', _fallback: true }),
  });
  assert.equal(calls[0].model, 'gpt-4o-mini');
});

test('resolver: openai library throw is swallowed (resolver always returns)', async () => {
  const throwing = {
    baseURL: 'https://api.deepseek.com',
    chat: { completions: { create: async () => { throw new Error('upstream 400'); } } },
  };
  const fallback = ({ goal }) => ({ goal, intent: 'g', _fallback: true });
  const out = await resolveTaskContract({
    goal: 'analiza el docx',
    openai: throwing,
    fileIds: [],
    fallback,
  });
  assert.equal(out.source, 'fallback');
  assert.equal(out.contract.intent, 'g');
});

test('resolver: empty goal → fallback (does not call LLM)', async () => {
  const calls = [];
  const oai = fakeOpenAIClient({
    baseURL: 'https://api.openai.com',
    onCall: (call) => calls.push(call),
  });
  const out = await resolveTaskContract({
    goal: '',
    openai: oai,
    fileIds: [],
    fallback: () => ({ intent: 'g', _fallback: true }),
  });
  assert.equal(calls.length, 0);
  assert.equal(out.source, 'fallback');
});

test('resolver: no openai client → fallback (does not crash)', async () => {
  const out = await resolveTaskContract({
    goal: 'hola',
    openai: null,
    fileIds: [],
    fallback: () => ({ intent: 'g', _fallback: true }),
  });
  assert.equal(out.source, 'fallback');
});

test('resolver: durationMs is recorded for observability', async () => {
  const oai = fakeOpenAIClient({
    baseURL: 'https://api.openai.com',
    onCall: () => {},
  });
  const out = await resolveTaskContract({
    goal: 'hola',
    openai: oai,
    fileIds: [],
    fallback: () => ({ intent: 'g', _fallback: true }),
  });
  assert.equal(typeof out.durationMs, 'number');
  assert.ok(out.durationMs >= 0);
});
