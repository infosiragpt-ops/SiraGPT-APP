import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeChatPreservingUserMessages,
  mergeMessagesPreservingUserContent,
} from '../lib/message-preservation';

test('preserves a visible user message when backend refresh returns blank content by id', () => {
  const local = [
    { id: 'msg-user-1', role: 'USER', content: 'transcribir', files: [{ id: 'img-1', mimeType: 'image/png' }] },
    { id: 'msg-ai-1', role: 'ASSISTANT', content: 'Pensando...' },
  ];

  const incoming = [
    { id: 'msg-user-1', role: 'USER', content: '   ', files: [] },
    { id: 'srv-ai-1', role: 'ASSISTANT', content: 'El contenido transcrito de la imagen es...' },
  ];

  const merged = mergeMessagesPreservingUserContent(incoming, local);

  assert.equal(merged[0].content, 'transcribir');
  assert.deepEqual(merged[0].files, [{ id: 'img-1', mimeType: 'image/png' }]);
  assert.equal(merged[1].content, 'El contenido transcrito de la imagen es...');
});

test('preserves user content by ordinal when optimistic and server ids differ', () => {
  const local = [
    { id: 'msg-user-optimistic', role: 'USER', content: 'cual es la primera palabra del word ?' },
  ];

  const incoming = [
    { id: 'server-user-id', role: 'USER', content: '' },
  ];

  const merged = mergeMessagesPreservingUserContent(incoming, local);

  assert.equal(merged[0].id, 'server-user-id');
  assert.equal(merged[0].content, 'cual es la primera palabra del word ?');
});

test('does not overwrite valid server user content', () => {
  const local = [
    { id: 'msg-user-1', role: 'USER', content: 'transcribir' },
  ];

  const incoming = [
    { id: 'msg-user-1', role: 'USER', content: 'transcribir esta imagen' },
  ];

  const merged = mergeMessagesPreservingUserContent(incoming, local);

  assert.equal(merged[0].content, 'transcribir esta imagen');
});

test('merges chat refresh without altering unrelated assistant messages', () => {
  const localChat = {
    id: 'chat-1',
    messages: [
      { id: 'local-user', role: 'USER', content: 'transcribir' },
      { id: 'local-ai', role: 'ASSISTANT', content: '' },
    ],
  };

  const incomingChat = {
    id: 'chat-1',
    title: 'transcribir',
    messages: [
      { id: 'server-user', role: 'USER', content: '' },
      { id: 'server-ai', role: 'ASSISTANT', content: 'LAS NORMAS A USAR SON VANCOUVER' },
    ],
  };

  const merged = mergeChatPreservingUserMessages(incomingChat, localChat);

  assert.equal(merged.messages[0].content, 'transcribir');
  assert.equal(merged.messages[1].content, 'LAS NORMAS A USAR SON VANCOUVER');
});

test('re-inserts a visible user message if the backend refresh drops the turn', () => {
  const local = [
    { id: 'old-user', role: 'USER', content: 'hola' },
    { id: 'old-ai', role: 'ASSISTANT', content: 'Hola.' },
    { id: 'msg-user-2', role: 'USER', content: 'transcribir', files: [{ id: 'img-1', mimeType: 'image/png' }] },
    { id: 'msg-ai-2', role: 'ASSISTANT', content: '' },
  ];

  const incoming = [
    { id: 'old-user', role: 'USER', content: 'hola' },
    { id: 'old-ai', role: 'ASSISTANT', content: 'Hola.' },
    { id: 'server-ai-2', role: 'ASSISTANT', content: 'LAS NORMAS A USAR SON VANCOUVER' },
  ];

  const merged = mergeMessagesPreservingUserContent(incoming, local);

  assert.equal(merged[2].role, 'USER');
  assert.equal(merged[2].content, 'transcribir');
  assert.deepEqual((merged[2] as any).files, [{ id: 'img-1', mimeType: 'image/png' }]);
  assert.equal(merged[3].content, 'LAS NORMAS A USAR SON VANCOUVER');
});
