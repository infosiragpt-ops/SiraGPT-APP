'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { handleChatTurn } = require('../src/services/sira/chat-controller');
const { createSiraStorage, createInMemoryStorage } = require('../src/services/sira/storage-schema');
const { createDefaultRegistry } = require('../src/services/sira/tool-registry');

test('chat-controller passes contextual effective text into the envelope without changing raw input', async () => {
  const storage = createSiraStorage({ adapter: createInMemoryStorage() });
  const result = await handleChatTurn({
    conversationId: 'conv-contextual',
    userId: 'user-contextual',
    userMessage: 'haz la segunda parte en Word',
    history: [
      { role: 'user', content: 'dame opciones' },
      { role: 'assistant', content: '1. Resumen ejecutivo\n2. Carta laboral\n3. Marco teorico' },
    ],
    selectedModel: { provider: 'openai', modelId: 'gpt-4o-mini' },
    userPlan: 'PRO',
    requestId: 'req-contextual-controller',
    bypassSessionQueue: true,
  }, {
    storage,
    registry: createDefaultRegistry(),
  });

  assert.equal(result.request_id, 'req-contextual-controller');
  assert.equal(result.envelope.raw_input.text, 'haz la segunda parte en Word');
  assert.equal(result.envelope.contextual_understanding.applied, true);
  assert.match(result.envelope.contextual_understanding.effective_text, /Carta laboral/);
  assert.equal(result.summary.contextual_understanding_applied, true);
});
