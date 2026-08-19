'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  attachConversationSummary,
  findBreadcrumbIndex,
  hashCover,
  formatDroppedForSummary,
  formatSummaryBlock,
  __test,
} = require('../src/services/conversation-summarizer');

function makeBreadcrumbMessages({ droppedCount = 3 } = {}) {
  return [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'system', content: `[Nota interna: se omitieron ${droppedCount} mensaje(s) antiguo(s) de este hilo para mantener el contexto dentro del límite del modelo. Los mensajes iniciales y los últimos 5 turnos se conservan íntegros.]` },
    { role: 'user', content: '¿Cómo vas?' },
    { role: 'assistant', content: 'Bien, ¿en qué seguimos?' },
  ];
}

function makeDroppedMessages() {
  return [
    { role: 'user', content: '¿Puedes explicarme OAuth2?' },
    { role: 'assistant', content: 'Sí, OAuth2 es un protocolo de autorización…' },
    { role: 'user', content: '¿Y el refresh token cómo funciona?' },
    { role: 'assistant', content: 'El refresh token permite obtener access tokens nuevos…' },
  ];
}

function makeFakeAnthropicClient({ reply = 'RESUMEN DE PRUEBA', shouldThrow = false, delayMs = 0 } = {}) {
  const calls = [];
  const client = {
    messages: {
      create: async (params) => {
        calls.push(params);
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        if (shouldThrow) throw new Error('boom');
        return {
          content: [
            { type: 'text', text: reply },
          ],
        };
      },
    },
  };
  return { client, calls };
}

test.beforeEach(() => {
  __test.cache.clear();
  delete process.env.ENABLE_CONVERSATION_SUMMARY;
});

test.afterEach(() => {
  __test.cache.clear();
  delete process.env.ENABLE_CONVERSATION_SUMMARY;
});

test('findBreadcrumbIndex finds the system breadcrumb', () => {
  const msgs = makeBreadcrumbMessages();
  assert.strictEqual(findBreadcrumbIndex(msgs), 1);
});

test('findBreadcrumbIndex returns -1 when no breadcrumb exists', () => {
  const msgs = [
    { role: 'system', content: 'SYSTEM' },
    { role: 'user', content: 'hola' },
  ];
  assert.strictEqual(findBreadcrumbIndex(msgs), -1);
});

test('hashCover is stable for identical content and changes when content changes', () => {
  const a = makeDroppedMessages();
  const b = makeDroppedMessages();
  assert.strictEqual(hashCover(a), hashCover(b));
  const c = [...b, { role: 'user', content: 'extra' }];
  assert.notStrictEqual(hashCover(b), hashCover(c));
});

test('formatDroppedForSummary renders sanitized lines with role labels', () => {
  const out = formatDroppedForSummary(makeDroppedMessages());
  assert.ok(out.includes('[USUARIO]:'));
  assert.ok(out.includes('[ASISTENTE]:'));
  assert.ok(out.includes('OAuth2'));
});

test('formatSummaryBlock wraps a non-empty summary with metadata header', () => {
  const block = formatSummaryBlock('Cosas que discutieron', 4);
  assert.ok(block);
  assert.ok(block.startsWith('[Nota interna: resumen del tramo omitido (4 mensajes)'));
  assert.ok(block.includes('Cosas que discutieron'));
});

test('formatSummaryBlock returns null on empty input', () => {
  assert.strictEqual(formatSummaryBlock('', 3), null);
  assert.strictEqual(formatSummaryBlock('   ', 3), null);
  assert.strictEqual(formatSummaryBlock(null, 3), null);
});

test('attachConversationSummary: no-op when no breadcrumb present', async () => {
  const { client } = makeFakeAnthropicClient();
  const result = await attachConversationSummary({
    messages: [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'hi' }],
    droppedMessages: makeDroppedMessages(),
    anthropicClient: client,
  });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.reason, 'no_breadcrumb');
});

test('attachConversationSummary: no-op when droppedMessages is empty', async () => {
  const { client } = makeFakeAnthropicClient();
  const result = await attachConversationSummary({
    messages: makeBreadcrumbMessages(),
    droppedMessages: [],
    anthropicClient: client,
  });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.reason, 'no_dropped');
});

test('attachConversationSummary: disabled by env returns reason disabled_by_env', async () => {
  process.env.ENABLE_CONVERSATION_SUMMARY = 'false';
  const { client } = makeFakeAnthropicClient();
  const result = await attachConversationSummary({
    messages: makeBreadcrumbMessages(),
    droppedMessages: makeDroppedMessages(),
    anthropicClient: client,
  });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.reason, 'disabled_by_env');
});

test('attachConversationSummary: replaces breadcrumb with LLM summary on first call', async () => {
  const { client, calls } = makeFakeAnthropicClient({ reply: 'Resumen estructurado del hilo.' });
  const result = await attachConversationSummary({
    messages: makeBreadcrumbMessages(),
    droppedMessages: makeDroppedMessages(),
    chatId: 'chat-1',
    anthropicClient: client,
  });
  assert.strictEqual(result.applied, true);
  assert.strictEqual(result.reason, 'summarized');
  assert.strictEqual(calls.length, 1);
  const updatedBreadcrumb = result.messages[1].content;
  assert.ok(updatedBreadcrumb.includes('Resumen estructurado del hilo.'));
  assert.ok(updatedBreadcrumb.startsWith('[Nota interna: resumen del tramo omitido'));
});

test('attachConversationSummary: cache hit on identical droppedMessages avoids second call', async () => {
  const { client, calls } = makeFakeAnthropicClient({ reply: 'CACHED-SUMMARY' });
  const dropped = makeDroppedMessages();
  const r1 = await attachConversationSummary({
    messages: makeBreadcrumbMessages(),
    droppedMessages: dropped,
    chatId: 'chat-cache',
    anthropicClient: client,
  });
  assert.strictEqual(r1.applied, true);
  assert.strictEqual(r1.reason, 'summarized');

  const r2 = await attachConversationSummary({
    messages: makeBreadcrumbMessages(),
    droppedMessages: dropped,
    chatId: 'chat-cache',
    anthropicClient: client,
  });
  assert.strictEqual(r2.applied, true);
  assert.strictEqual(r2.reason, 'cache_hit');
  assert.strictEqual(calls.length, 1, 'LLM should only be called once across identical inputs');
  assert.ok(r2.messages[1].content.includes('CACHED-SUMMARY'));
});

test('attachConversationSummary: forceFresh bypasses cache', async () => {
  const { client, calls } = makeFakeAnthropicClient({ reply: 'FRESH' });
  const dropped = makeDroppedMessages();
  await attachConversationSummary({
    messages: makeBreadcrumbMessages(),
    droppedMessages: dropped,
    chatId: 'chat-fresh',
    anthropicClient: client,
  });
  await attachConversationSummary({
    messages: makeBreadcrumbMessages(),
    droppedMessages: dropped,
    chatId: 'chat-fresh',
    anthropicClient: client,
    forceFresh: true,
  });
  assert.strictEqual(calls.length, 2);
});

test('attachConversationSummary: returns reason summarizer_error on LLM failure', async () => {
  const { client } = makeFakeAnthropicClient({ shouldThrow: true });
  const result = await attachConversationSummary({
    messages: makeBreadcrumbMessages(),
    droppedMessages: makeDroppedMessages(),
    chatId: 'chat-err',
    anthropicClient: client,
  });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.reason, 'summarizer_error');
  assert.ok(result.error.includes('boom'));
});

test('attachConversationSummary: returns reason summarizer_error on timeout', async () => {
  const { client } = makeFakeAnthropicClient({ delayMs: 200 });
  const result = await attachConversationSummary({
    messages: makeBreadcrumbMessages(),
    droppedMessages: makeDroppedMessages(),
    chatId: 'chat-timeout',
    anthropicClient: client,
    timeoutMs: 30,
  });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.reason, 'summarizer_error');
  assert.ok(/timeout/i.test(result.error));
});

test('attachConversationSummary: no-op when anthropic client is missing', async () => {
  const result = await attachConversationSummary({
    messages: makeBreadcrumbMessages(),
    droppedMessages: makeDroppedMessages(),
    chatId: 'chat-noclient',
  });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.reason, 'summarizer_error');
});

test('attachConversationSummary: does not mutate input messages array', async () => {
  const { client } = makeFakeAnthropicClient();
  const input = makeBreadcrumbMessages();
  const inputCopy = JSON.parse(JSON.stringify(input));
  await attachConversationSummary({
    messages: input,
    droppedMessages: makeDroppedMessages(),
    chatId: 'chat-immut',
    anthropicClient: client,
  });
  assert.deepStrictEqual(input, inputCopy);
});

test('attachConversationSummary: language=en triggers English instruction in summary prompt', async () => {
  const { client, calls } = makeFakeAnthropicClient();
  await attachConversationSummary({
    messages: makeBreadcrumbMessages(),
    droppedMessages: makeDroppedMessages(),
    chatId: 'chat-lang-en',
    language: 'en',
    anthropicClient: client,
  });
  assert.strictEqual(calls.length, 1);
  // The system prompt embeds the localized "Español/Inglés" hint, not the value of `lang` itself.
  assert.ok(/inglés/.test(calls[0].system));
});

test('LRU cache evicts oldest when full', () => {
  const lru = new __test.LruCache(3);
  lru.set('a', 1);
  lru.set('b', 2);
  lru.set('c', 3);
  lru.set('d', 4);
  assert.strictEqual(lru.get('a'), undefined);
  assert.strictEqual(lru.get('b'), 2);
  assert.strictEqual(lru.size(), 3);
});

test('LRU cache promotes on get', () => {
  const lru = new __test.LruCache(3);
  lru.set('a', 1);
  lru.set('b', 2);
  lru.set('c', 3);
  lru.get('a'); // promote a
  lru.set('d', 4);
  // Now 'b' (oldest non-promoted) should have been evicted.
  assert.strictEqual(lru.get('b'), undefined);
  assert.strictEqual(lru.get('a'), 1);
});
