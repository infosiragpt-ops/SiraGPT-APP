const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildChatListWhere,
  parseBoolean,
  parsePositiveInt,
} = require('../src/services/chat-scope');

describe('parsePositiveInt', () => {
  test('parses bounded positive integers with fallback for invalid values', () => {
    assert.equal(parsePositiveInt('12', 5), 12);
    assert.equal(parsePositiveInt('0', 5, { min: 2, max: 10 }), 2);
    assert.equal(parsePositiveInt('99', 5, { min: 2, max: 10 }), 10);
    assert.equal(parsePositiveInt('abc', 5), 5);
    assert.equal(parsePositiveInt(null, 5), 5);
  });
});

describe('parseBoolean', () => {
  test('accepts true booleans and common true strings only', () => {
    assert.equal(parseBoolean(true), true);
    assert.equal(parseBoolean('true'), true);
    assert.equal(parseBoolean('1'), true);
    assert.equal(parseBoolean(1), false);
    assert.equal(parseBoolean('false'), false);
  });
});

describe('buildChatListWhere', () => {
  test('requires userId', () => {
    assert.throws(() => buildChatListWhere({}), /userId is required/);
  });

  test('scopes to standalone chats by default', () => {
    assert.deepEqual(buildChatListWhere({ userId: 'user-1' }), {
      userId: 'user-1',
      projectId: null,
    });
  });

  test('scopes to a project when projectId is provided', () => {
    assert.deepEqual(buildChatListWhere({ userId: 'user-1', projectId: 'project-1' }), {
      userId: 'user-1',
      projectId: 'project-1',
    });
  });

  test('can include project chats without projectId filtering', () => {
    assert.deepEqual(buildChatListWhere({ userId: 'user-1', includeProjects: true }), {
      userId: 'user-1',
    });
  });

  test('adds title and message search filters after trimming search text', () => {
    assert.deepEqual(buildChatListWhere({ userId: 'user-1', search: '  thesis  ' }), {
      userId: 'user-1',
      projectId: null,
      OR: [
        { title: { contains: 'thesis', mode: 'insensitive' } },
        { messages: { some: { content: { contains: 'thesis', mode: 'insensitive' } } } },
      ],
    });
  });
});
