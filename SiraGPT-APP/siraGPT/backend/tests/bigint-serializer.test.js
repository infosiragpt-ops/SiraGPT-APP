const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  replaceBigInt,
  serializeBigIntFields,
  safeStringify,
  bigintSerializerMiddleware,
  serializeUser,
  serializeMessage,
  serializeChat,
} = require('../src/utils/bigint-serializer');

describe('bigint serializer utilities', () => {
  test('replaceBigInt converts bigint values to strings for JSON.stringify', () => {
    assert.equal(replaceBigInt('id', 42n), '42');
    assert.equal(replaceBigInt('name', 'sira'), 'sira');
  });

  test('serializeBigIntFields recursively converts plain object and array bigints to numbers', () => {
    const date = new Date('2026-05-06T00:00:00Z');
    const input = {
      id: 10n,
      nested: {
        count: 3n,
        list: [1n, { total: 2n }],
      },
      date,
    };

    assert.deepEqual(serializeBigIntFields(input), {
      id: 10,
      nested: {
        count: 3,
        list: [1, { total: 2 }],
      },
      date,
    });
  });

  test('serializeBigIntFields preserves nullish values and non-plain objects', () => {
    const date = new Date('2026-05-06T00:00:00Z');

    assert.equal(serializeBigIntFields(null), null);
    assert.equal(serializeBigIntFields(undefined), undefined);
    assert.equal(serializeBigIntFields(date), date);
  });

  test('safeStringify handles nested bigint values with optional spacing', () => {
    assert.equal(
      safeStringify({ usage: 7n, nested: { limit: 9n } }, 2),
      '{\n  "usage": "7",\n  "nested": {\n    "limit": "9"\n  }\n}'
    );
  });

  test('bigintSerializerMiddleware wraps res.json with bigint-safe serialization', () => {
    const calls = [];
    const res = {
      json(payload) {
        calls.push({ thisValue: this, payload });
        return 'sent';
      },
    };
    let nextCalled = false;

    bigintSerializerMiddleware({}, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(res.json({ id: 12n, rows: [{ count: 2n }] }), 'sent');
    assert.deepEqual(calls, [
      {
        thisValue: res,
        payload: { id: 12, rows: [{ count: 2 }] },
      },
    ]);
  });
});

describe('domain serializers', () => {
  test('serializeUser normalizes bigint usage and missing limits', () => {
    assert.equal(serializeUser(null), null);
    assert.deepEqual(
      serializeUser({
        id: 'user-1',
        apiUsage: 4n,
        monthlyLimit: null,
        monthlyCallLimit: 20n,
      }),
      {
        id: 'user-1',
        apiUsage: 4,
        monthlyLimit: 0,
        monthlyCallLimit: 20,
      }
    );
  });

  test('serializeMessage converts token counts and preserves nullish counts', () => {
    assert.equal(serializeMessage(undefined), undefined);
    assert.deepEqual(serializeMessage({ id: 'm1', tokens: 11n }), { id: 'm1', tokens: 11 });
    assert.deepEqual(serializeMessage({ id: 'm2', tokens: null }), { id: 'm2', tokens: null });
  });

  test('serializeChat normalizes nested messages and user when present', () => {
    assert.deepEqual(
      serializeChat({
        id: 'chat-1',
        messages: [{ id: 'm1', tokens: 5n }],
        user: { id: 'user-1', apiUsage: 1n, monthlyLimit: 2n, monthlyCallLimit: 3n },
      }),
      {
        id: 'chat-1',
        messages: [{ id: 'm1', tokens: 5 }],
        user: { id: 'user-1', apiUsage: 1, monthlyLimit: 2, monthlyCallLimit: 3 },
      }
    );
  });

  test('serializeChat defaults missing messages to an empty array', () => {
    assert.equal(serializeChat(null), null);
    assert.deepEqual(serializeChat({ id: 'chat-2' }), { id: 'chat-2', messages: [], user: undefined });
  });
});
