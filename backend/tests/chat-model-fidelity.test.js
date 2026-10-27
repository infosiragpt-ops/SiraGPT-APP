'use strict';

/**
 * The chat's secondary steps run on the model the user picked (AGENTS.md §13,
 * I12). Each test fails without its fix:
 *  - a picked DeepSeek model that hit a billing/auth error was retried as the
 *    same model through OpenRouter, silently (another provider's API);
 *  - the artifact branch («grafica…», «visualiza…») answered with OpenAI
 *    gpt-4o-mini / gpt-4o whatever the pick;
 *  - the agentic tools had no `ctx.model`, and self_rag_answer — the tool that
 *    writes the grounded answer — ran on the RAG helpers' client (OpenAI for
 *    a Claude pick) and fell back to another provider on an error;
 *  - the image recovery replaced a picked vision model's failure (its
 *    E_PROVIDER cause) with a generic «vision unavailable» copy, and other
 *    vision models could answer instead of the pick.
 * Memory, compaction and intent judges stay internal (owner decision).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { wrapDeepSeekClient } = require('../src/services/ai/deepseek-billing-failover');

function deepseekClient(handler) {
  return { chat: { completions: { create: handler } } };
}
const billingError = () => Object.assign(new Error('402 Insufficient Balance'), { status: 402 });

test('a picked DeepSeek model surfaces its billing error instead of running through OpenRouter', async () => {
  const env = { NODE_ENV: 'test' };
  const log = { warn() {} };
  let openRouterCalls = 0;
  const fallbackClientFactory = () => deepseekClient(async () => { openRouterCalls += 1; return { choices: [{ message: { content: 'vía OpenRouter' } }] }; });

  const pinned = wrapDeepSeekClient(deepseekClient(async () => { throw billingError(); }), { fallbackClientFactory, allowFallback: false, env, log });
  await assert.rejects(pinned.chat.completions.create({ model: 'deepseek-v4-flash', messages: [] }), /402 Insufficient Balance/);
  assert.equal(openRouterCalls, 0, 'never the same model on another provider');
  // The failure is memoised now; a pinned call still goes to DeepSeek itself.
  let directCalls = 0;
  const pinnedAgain = wrapDeepSeekClient(deepseekClient(async () => { directCalls += 1; return { choices: [{ message: { content: 'directo' } }] }; }), { fallbackClientFactory, allowFallback: false, env, log });
  const res = await pinnedAgain.chat.completions.create({ model: 'deepseek-v4-flash', messages: [] });
  assert.equal(res.choices[0].message.content, 'directo');
  assert.equal(directCalls, 1);
  assert.equal(openRouterCalls, 0);

  // Internal callers (no pick) keep the fallback.
  const internal = wrapDeepSeekClient(deepseekClient(async () => { throw billingError(); }), { fallbackClientFactory, env, log });
  const viaRouter = await internal.chat.completions.create({ model: 'deepseek-v4-flash', messages: [] });
  assert.equal(viaRouter.choices[0].message.content, 'vía OpenRouter');
});

const aiRoute = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');

test('the chat turn builds every client of the picked model as pinned, and DeepSeek honours it', () => {
  assert.match(aiRoute, /allowFallback: opts\.pinned !== true/);
  assert.equal((aiRoute.match(/createProviderClientForRequest\(actualProvider, req, \{ customConnection, pinned: true \}\)/g) || []).length, 2, '/generate turn client');
  assert.match(aiRoute, /const agenticClient = createProviderClient\(actualProvider, \{ customConnection, pinned: true \}\)/);
  assert.match(aiRoute, /createProviderClientForRequest\(actualProvider, req, \{ customConnection, model: actualModel, pinned: true \}\)/, 'document edit');
  assert.match(aiRoute, /modelPinned: true,/, 'the agentic loop knows the model was picked');
});

test('the artifact branch is written by the picked model, never by OPENAI_API_KEY', () => {
  const start = aiRoute.indexOf('// ─── Artifact branch');
  const end = aiRoute.indexOf('const __reasoningSink = {};', start);
  assert.ok(start > 0 && end > start);
  const branch = aiRoute.slice(start, end);
  assert.doesNotMatch(branch, /OPENAI_API_KEY|new OpenAI\(/);
  assert.match(branch, /const artifactClient = createProviderClient\(actualProvider, \{ customConnection, pinned: true \}\)/);
  assert.match(branch, /openai: artifactClient,\s+model: actualModel,/);
  // A text-only pick cannot read attached images: that turn takes the normal stream.
  assert.match(branch, /\(!__artifactHasImages \|\| nativeVisionForTurn\)/);
});

test('agentic tools get the picked model and its client; pinned only when the caller says so', async (t) => {
  const agenticStream = require('../src/services/agentic-chat-stream');
  const reactAgent = require('../src/services/react-agent');
  const seen = [];
  t.mock.method(reactAgent, 'run', async (_client, args) => {
    seen.push(args.ctx);
    return { finalAnswer: 'Hecho.', stoppedReason: 'finalized', steps: [] };
  });
  const res = { headersSent: false, writableEnded: false, write() { return true; }, end() {}, setHeader() {}, flushHeaders() {}, on() {} };
  const openai = { chat: { completions: { create: async () => { throw new Error('not used'); } } } };
  const ragClient = { tag: 'rag-openai' };
  await agenticStream.runAgenticChat({
    openai, model: 'claude-sonnet-4-6', provider: 'Anthropic', modelPinned: true,
    userQuery: 'Analiza el informe y cita las fuentes', res, toolContext: { userId: 'u-fid', openai: ragClient },
  });
  const ctx = seen.at(-1);
  assert.equal(ctx.model, 'claude-sonnet-4-6');
  assert.equal(ctx.llm, openai, 'the loop model\'s own client');
  assert.equal(ctx.openai, ragClient, 'the RAG helpers keep their client');
  assert.equal(ctx.modelPinned, true);

  await agenticStream.runAgenticChat({ openai, model: 'gpt-4o-mini', provider: 'OpenAI', userQuery: 'Analiza el informe', res, toolContext: { userId: 'u-fid' } });
  assert.equal(seen.at(-1).modelPinned, false);
});

test('self_rag_answer writes with the picked model and fails visibly instead of switching provider', async () => {
  const enginePath = require.resolve('../src/services/rag/self-rag-engine');
  const realEngine = require.cache[enginePath];
  const calls = [];
  require.cache[enginePath] = { exports: {
    infer: async (args) => {
      calls.push({ client: args.openai.tag, model: args.model });
      if (args.openai.tag === 'claude') { const e = new Error('529 Overloaded'); e.status = 529; throw e; }
      return { segments: [{ text: 'Respuesta.', source: null }] };
    },
    inferBeam: async () => ({ segments: [] }),
  } };
  delete require.cache[require.resolve('../src/services/agents/task-tools')];
  const { INTERNAL } = require('../src/services/agents/task-tools');
  INTERNAL.selfRagDeps.failoverClientFactory = () => ({ tag: 'ladder', chat: { completions: { create: async () => ({}) } } });
  try {
    const ctx = {
      userId: 'u1',
      openai: { tag: 'rag-openai' },
      llm: { tag: 'claude', chat: { completions: { create: async () => ({}) } } },
      model: 'claude-sonnet-4-6',
      modelPinned: true,
      onEvent() {},
    };
    const result = await INTERNAL.selfRagAnswer.execute({ question: 'Resume el documento' }, ctx);
    assert.deepEqual(calls, [{ client: 'claude', model: 'claude-sonnet-4-6' }], 'the picked client, never the RAG client nor the ladder');
    assert.equal(result.ok, false, 'the picked model\'s failure reaches the loop as the tool result');
    assert.match(result.error, /529 Overloaded/);
  } finally {
    INTERNAL.selfRagDeps.failoverClientFactory = null;
    if (realEngine) require.cache[enginePath] = realEngine; else delete require.cache[enginePath];
    delete require.cache[require.resolve('../src/services/agents/task-tools')];
  }
});

test('image recovery: a picked vision model is the only reader and its failure is not hidden', async () => {
  const recovery = require('../src/services/chat-attachment-recovery');
  const imageFiles = [{ id: 'img-1', mimeType: 'image/png', name: 'foto.png', path: '/tmp/foto.png', extractedText: '' }];
  const seenOpts = [];
  const failing = async (_files, _text, opts) => { seenOpts.push(opts); return ''; };
  const answer = await recovery.recoverChatAttachmentResponse({
    prompt: '¿Qué dice esta foto?', processedFiles: imageFiles, provider: 'xAI', model: 'grok-4.7', pinned: true, visionAnswerer: failing,
  });
  assert.equal(seenOpts[0].pinned, true, 'only the picked model reads it');
  assert.equal(answer, '', 'its own failure (E_PROVIDER) stays the reply, not a generic copy');

  // A text-only pick cannot see: a vision model's answer is used.
  const visionAnswer = await recovery.recoverChatAttachmentResponse({
    prompt: '¿Qué dice esta foto?', processedFiles: imageFiles, provider: 'DeepSeek', model: 'deepseek-v4-flash', pinned: true,
    visionAnswerer: async () => 'La foto muestra un recibo con un total de 42 soles.',
  });
  assert.match(visionAnswer, /recibo/);
  // Unpicked calls keep the generic copy when nobody answers.
  const generic = await recovery.recoverChatAttachmentResponse({
    prompt: '¿Qué dice esta foto?', processedFiles: imageFiles, provider: 'xAI', model: 'grok-4.7', visionAnswerer: failing,
  });
  assert.ok(generic.length > 40);
});
