'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const gateway = require('../src/services/ai-product-os/litellm-gateway');
const service = require('../src/services/ai-service');
const {
  CONNECTION_UNAVAILABLE_MESSAGE,
  publicGenerateErrorMessage,
  isProviderClientError,
  closeGenerateSseWithError,
  writeGenerateSseError,
  endGenerateSse,
} = require('../src/services/ai/generate-sse-close');
const { waitForActiveTurn } = require('../src/services/chat-turn-idempotency');
const { inferProviderFromModelId, resolveGenerateProvider } = require('../src/services/ai/provider-inference');

function mockRes() {
  const chunks = [];
  const res = {
    writableEnded: false,
    destroyed: false,
    chunks,
    write(frame) {
      chunks.push(String(frame));
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  };
  return res;
}

test('picker: Muse Spark stays Meta and is never remapped to Kimi/Sira/OpenRouter', () => {
  assert.equal(inferProviderFromModelId('muse-spark-1.2-contributor'), 'Meta');
  assert.equal(inferProviderFromModelId('muse-spark-1.2'), 'Meta');
  assert.equal(resolveGenerateProvider('Meta', 'muse-spark-1.2-contributor'), 'Meta');
  assert.equal(resolveGenerateProvider('OpenRouter', 'muse-spark-1.2-contributor'), 'Meta');
  assert.equal(resolveGenerateProvider('Kimi', 'muse-spark-1.2-contributor'), 'Meta');
  assert.equal(service.__test.providerForModel('muse-spark-1.2-contributor'), 'Meta');
  assert.equal(service.__test.isPinnedUserGenerate('Meta', 'muse-spark-1.2-contributor'), true);
  assert.deepEqual(service.__test.getFallbackChain('Meta', 'muse-spark-1.2-contributor'), []);
});

test('Meta/Muse Spark generate payload has no reasoning', () => {
  const built = gateway.buildProviderChatPayload({
    provider: 'Meta',
    model: 'muse-spark-1.2-contributor',
    stream: true,
    thinkingLevel: 'disabled',
    extra: { temperature: 0.55, reasoning: { exclude: true }, thinking: { type: 'disabled' } },
    messages: [{ role: 'user', content: 'hola' }],
  });
  assert.equal(built.provider, 'meta');
  assert.equal('reasoning' in built.payload, false);
  assert.equal('reasoning_effort' in built.payload, false);
  assert.equal('thinking' in built.payload, false);
});

test('Anthropic keeps thinking; xAI keeps reasoning_effort; OpenRouter keeps reasoning', () => {
  const anthropic = gateway.buildProviderChatPayload({
    provider: 'Anthropic',
    model: 'claude-sonnet-5',
    extra: { thinking: { type: 'disabled' }, reasoning: { exclude: true } },
    messages: [{ role: 'user', content: 'hola' }],
  });
  assert.deepEqual(anthropic.payload.thinking, { type: 'disabled' });
  assert.equal('reasoning' in anthropic.payload, false);

  const xai = gateway.buildProviderChatPayload({
    provider: 'xAI',
    model: 'grok-4.5',
    extra: { reasoning: { exclude: true }, reasoning_effort: 'low' },
    messages: [{ role: 'user', content: 'hola' }],
  });
  assert.equal('reasoning' in xai.payload, false);
  assert.equal(xai.payload.reasoning_effort, 'low');

  const openrouter = gateway.buildProviderChatPayload({
    provider: 'OpenRouter',
    model: 'openai/gpt-oss-120b',
    thinkingLevel: 'disabled',
    extra: { reasoning: { exclude: true } },
    messages: [{ role: 'user', content: 'hola' }],
  });
  assert.deepEqual(openrouter.payload.reasoning, { exclude: true });
});

test('ai-service does not attach reasoning extra for Meta trivial turns', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ai-service.js'), 'utf8');
  assert.match(src, /thinkingDisabled && currentProvider === 'OpenRouter'/);
  assert.match(src, /thinkingDisabled && currentProvider === 'Anthropic'/);
  assert.doesNotMatch(
    src,
    /if \(isTrivial \|\| String\(turnThinkingLevel\)[\s\S]{0,80}extraPayload\.reasoning = \{ exclude: true \}/,
  );
});

test('public generate error never leaks vendor or raw model_id', () => {
  assert.equal(
    publicGenerateErrorMessage({ message: '400 unknown parameter reasoning' }),
    CONNECTION_UNAVAILABLE_MESSAGE,
  );
  assert.equal(
    publicGenerateErrorMessage({ message: 'OpenRouter 502 DeepSeek muse-spark-1.2-contributor' }),
    CONNECTION_UNAVAILABLE_MESSAGE,
  );
  assert.equal(publicGenerateErrorMessage({ message: CONNECTION_UNAVAILABLE_MESSAGE }), CONNECTION_UNAVAILABLE_MESSAGE);
  assert.equal(isProviderClientError({ status: 400, message: 'unknown parameter reasoning' }), true);
  assert.equal(isProviderClientError({ name: 'AbortError', message: 'aborted' }), false);
});

test('simulated Meta 400 unknown parameter reasoning closes SSE with Spanish error, not HTTP 502', async () => {
  const res = mockRes();
  const err = new Error('400 unknown parameter reasoning');
  err.status = 400;
  const client = {
    chat: {
      completions: {
        create: async () => {
          throw err;
        },
      },
    },
  };

  const out = await service.generateStream({
    provider: 'Meta',
    model: 'muse-spark-1.2-contributor',
    client,
    messages: [{ role: 'user', content: 'hola' }],
    res,
    language: 'es',
    userPrompt: 'hola',
    qualityGuard: false,
    skipDoneSentinel: true,
    trivialTurn: true,
    thinkingLevel: 'disabled',
  });

  const body = res.chunks.join('');
  assert.equal(out, CONNECTION_UNAVAILABLE_MESSAGE);
  assert.match(body, /Conexión no disponible/);
  assert.match(body, /"type":"error"/);
  assert.match(body, /data: \[DONE\]/);
  assert.equal(res.writableEnded, true);
  assert.doesNotMatch(body, /DeepSeek|OpenRouter|muse-spark-1\.2-contributor|unknown parameter/);
});

test('SSE error helper writes a complete body even when write/end wrappers no-op', () => {
  const rawChunks = [];
  let rawEnded = false;
  const res = {
    writableEnded: false,
    destroyed: false,
    write() { return true; },
    end() { /* wrapped no-op that used to cause Caddy 502 */ },
    _siraRawWrite(frame) { rawChunks.push(String(frame)); },
    _siraRawEnd() { rawEnded = true; this.writableEnded = true; },
  };
  closeGenerateSseWithError(res, {
    message: CONNECTION_UNAVAILABLE_MESSAGE,
    code: 'connection_unavailable',
  });
  const body = rawChunks.join('');
  assert.match(body, /Conexión no disponible/);
  assert.match(body, /data: \[DONE\]/);
  assert.equal(rawEnded, true);
  assert.equal(res._siraGenerateSseClosed, true);
});

test('duplicate retry while a turn is active replays or starts fresh — does not 502', async () => {
  const pending = {
    settled: false,
    promise: new Promise(() => {}),
  };
  const inFlight = await waitForActiveTurn(pending, {
    timeoutMs: 20,
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn: (id) => clearTimeout(id),
  });
  assert.equal(inFlight.outcome, 'in_progress');

  let resolveTurn;
  const completable = {
    promise: new Promise((resolve) => { resolveTurn = resolve; }),
  };
  const wait = waitForActiveTurn(completable, { timeoutMs: 5_000 });
  resolveTurn({
    assistantMessage: { id: 'a1', content: 'Hola' },
    userMessage: { id: 'u1' },
  });
  const replay = await wait;
  assert.equal(replay.outcome, 'replay');
  assert.equal(replay.turn.assistantMessage.content, 'Hola');

  const aiRoute = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  assert.match(aiRoute, /Never skip end\(\) just because the client dropped/);
  assert.match(aiRoute, /start a fresh generate after that stream closed/);
  assert.match(aiRoute, /closeGenerateSseWithError/);
  assert.doesNotMatch(aiRoute, /if \(clientGone \|\| res\.destroyed \|\| res\.writableEnded\) return res;/);
});

test('getClient wires Meta to api.meta.ai — not OpenAI or OpenRouter', () => {
  const prev = {
    MODEL_API_KEY: process.env.MODEL_API_KEY,
    META_API_KEY: process.env.META_API_KEY,
    LLAMA_API_KEY: process.env.LLAMA_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  delete process.env.MODEL_API_KEY;
  delete process.env.META_API_KEY;
  delete process.env.LLAMA_API_KEY;
  try {
    assert.throws(() => service.getClient('Meta'), (err) => {
      assert.match(String(err && err.message), /Conexión no disponible/);
      return true;
    });
    process.env.META_API_KEY = 'meta-test-key';
    const client = service.getClient('Meta');
    assert.ok(client);
    assert.match(String(client.baseURL || ''), /api\.meta\.ai/i);
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('writeGenerateSseError + endGenerateSse produce a complete SSE trailer', () => {
  const res = mockRes();
  writeGenerateSseError(res, { message: CONNECTION_UNAVAILABLE_MESSAGE });
  endGenerateSse(res);
  assert.match(res.chunks.join(''), /data: \[DONE\]/);
  assert.equal(res.writableEnded, true);
});
