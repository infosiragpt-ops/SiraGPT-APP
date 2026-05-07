const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  estimateTokens,
  fitMessagesToContext,
  getContextLimit,
  MODEL_CONTEXT_LIMITS,
  tokensOfMessage,
} = require('../src/services/context-window');

describe('context-window token estimation', () => {
  test('estimateTokens handles strings, structured text parts, and unserializable values', () => {
    const circular = {};
    circular.self = circular;

    assert.equal(estimateTokens('12345'), 2);
    assert.equal(
      estimateTokens([{ text: '1234' }, { image_url: { url: 'ignored' } }, { text: '12345' }]),
      3
    );
    assert.equal(estimateTokens(circular), 0);
  });

  test('tokensOfMessage includes role overhead and content estimate', () => {
    assert.equal(tokensOfMessage({ role: 'user', content: '12345678' }), 6);
    assert.equal(tokensOfMessage(null), 0);
  });
});

describe('context limit lookup', () => {
  test('returns exact, partial, and default model context limits', () => {
    assert.equal(getContextLimit('gpt-4o'), MODEL_CONTEXT_LIMITS['gpt-4o']);
    assert.equal(getContextLimit('gpt-4o-2024-08-06'), MODEL_CONTEXT_LIMITS['gpt-4o']);
    assert.equal(getContextLimit('unknown-model'), 8192);
    assert.equal(getContextLimit(), 8192);
  });
});

describe('fitMessagesToContext', () => {
  test('returns original messages when already within budget', () => {
    const messages = [{ role: 'system', content: 'brief' }, { role: 'user', content: 'hello' }];

    const result = fitMessagesToContext(messages, 'gpt-4o');

    assert.equal(result.messages, messages);
    assert.equal(result.droppedCount, 0);
    assert.equal(result.budget, Math.floor(MODEL_CONTEXT_LIMITS['gpt-4o'] * 0.8) - 1024);
  });

  test('keeps first message and recent tail while inserting a breadcrumb for dropped middle messages', () => {
    const messages = [
      { role: 'system', content: 'system prompt' },
      ...Array.from({ length: 10 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `middle-${index} ${'x'.repeat(400)}`,
      })),
      { role: 'user', content: 'recent-1' },
      { role: 'assistant', content: 'recent-2' },
      { role: 'user', content: 'recent-3' },
      { role: 'assistant', content: 'recent-4' },
      { role: 'user', content: 'recent-5' },
    ];

    const result = fitMessagesToContext(messages, 'gpt-4', { reservedCompletionTokens: 6400 });

    assert.equal(result.messages[0], messages[0]);
    assert.equal(result.droppedCount > 0, true);
    assert.match(result.messages[1].content, /se omitieron \d+ mensaje\(s\) antiguo\(s\)/);
    assert.deepEqual(result.messages.slice(-5), messages.slice(-5));
    assert.equal(result.totalTokens <= result.budget, true);
  });

  test('handles empty or invalid message arrays', () => {
    assert.deepEqual(fitMessagesToContext(null, 'gpt-4'), {
      messages: [],
      droppedCount: 0,
      totalTokens: 0,
      budget: 0,
    });
  });
});
