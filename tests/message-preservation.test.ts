import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeChatPreservingUserMessages,
  mergeMessagesPreservingUserContent,
  parseAgentTaskContent,
} from '../lib/message-preservation';

test('reads a persisted agent task id from the reducer meta envelope', () => {
  const content = '```agent-task-state\n' + JSON.stringify({
    meta: { taskId: 'task-from-meta' },
    done: false,
  }) + '\n```';

  assert.equal(parseAgentTaskContent(content).taskId, 'task-from-meta');
});

test('prefers the legacy top-level task id when both envelope locations exist', () => {
  const content = '```agent-task-state\n' + JSON.stringify({
    taskId: 'task-top-level',
    meta: { taskId: 'task-from-meta' },
    done: false,
  }) + '\n```';

  assert.equal(parseAgentTaskContent(content).taskId, 'task-top-level');
});

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

test('prefers completed agent task server content over longer pending local state', () => {
  const finalText = 'RESUMEN La gestion administrativa mejora la estructura organizacional.';
  const incomingContent = '```agent-task-state\n' + JSON.stringify({
    taskId: 'task-1',
    done: true,
    error: null,
    finalText,
  }) + '\n```\n\n' + finalText;
  const localContent = '```agent-task-state\n' + JSON.stringify({
    taskId: 'task-1',
    done: false,
    status: 'running',
    steps: Array.from({ length: 30 }, (_, index) => ({
      title: `Paso ${index + 1}`,
      detail: 'esperando actualizacion '.repeat(12),
    })),
  }) + '\n```';

  assert.ok(localContent.length > incomingContent.length);

  const merged = mergeMessagesPreservingUserContent(
    [
      { id: 'user-1', role: 'USER', content: 'resume el pdf' },
      { id: 'assistant-1', role: 'ASSISTANT', content: incomingContent },
    ],
    [
      { id: 'user-1', role: 'USER', content: 'resume el pdf' },
      { id: 'assistant-1', role: 'ASSISTANT', content: localContent },
    ],
  );

  assert.equal(merged[1].content, incomingContent);
});

test('keeps a locally completed task with artifacts over a stale pending refresh of the same task', () => {
  const taskId = 'task-completed-before-db-refresh';
  const incomingContent = '```agent-task-state\n' + JSON.stringify({
    taskId,
    done: false,
    status: 'running',
    steps: [{ id: 'edit', status: 'running' }],
  }) + '\n```';
  const localContent = '```agent-task-state\n' + JSON.stringify({
    taskId,
    done: true,
    finalText: 'Listo.',
    artifacts: [{ id: 'artifact-1', filename: 'Informe.docx' }],
  }) + '\n```\n\nListo.';

  const merged = mergeMessagesPreservingUserContent(
    [{ id: 'assistant-1', role: 'ASSISTANT', content: incomingContent }],
    [{ id: 'assistant-1', role: 'ASSISTANT', content: localContent }],
  );

  assert.equal(merged[0].content, localContent);
});

test('does not preserve a completed local envelope over a different incoming task', () => {
  const incomingContent = '```agent-task-state\n' + JSON.stringify({
    taskId: 'task-new',
    done: false,
    status: 'running',
  }) + '\n```';
  const localContent = '```agent-task-state\n' + JSON.stringify({
    taskId: 'task-old',
    done: true,
    finalText: 'Listo.',
  }) + '\n```\n\nListo.';

  const merged = mergeMessagesPreservingUserContent(
    [{ id: 'assistant-1', role: 'ASSISTANT', content: incomingContent }],
    [{ id: 'assistant-1', role: 'ASSISTANT', content: localContent }],
  );

  assert.equal(merged[0].content, incomingContent);
});

test('parses legacy top-level task id and completed status', () => {
  const content = '```agent-task-state\n' + JSON.stringify({
    taskId: 'legacy-task',
    status: 'completed',
    finalText: 'Terminado',
  }) + '\n```\n\nTerminado';

  const parsed = parseAgentTaskContent(content);
  assert.equal(parsed.taskId, 'legacy-task');
  assert.equal(parsed.done, true);
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

test('replaces empty msg-ai placeholder with persisted cmti row of the same turn', () => {
  const turn = { idempotencyKey: 'turn-hola' };
  const localChat = {
    id: 'chat-1',
    messages: [
      { id: 'msg-user-abc', role: 'USER', content: 'hola', metadata: turn },
      {
        id: 'msg-ai-chat-1-xyz',
        role: 'ASSISTANT',
        content: '',
        metadata: turn,
        model: { name: 'grok-4.5', displayName: 'Grok 4.5', provider: 'xAI' },
      },
    ],
  };
  const incomingChat = {
    id: 'chat-1',
    messages: [
      { id: 'cmtuser01', role: 'USER', content: 'hola', metadata: turn },
      {
        id: 'cmtassist01',
        role: 'ASSISTANT',
        content: 'Hola, Luis. ¿En qué te ayudo hoy?',
        metadata: { ...turn, generationUsage: { model: 'grok-4.5' } },
      },
    ],
  };

  const merged = mergeChatPreservingUserMessages(incomingChat, localChat);
  const assistants = merged.messages.filter((message) => String(message.role).toUpperCase() === 'ASSISTANT');
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].id, 'cmtassist01');
  assert.equal(assistants[0].content, 'Hola, Luis. ¿En qué te ayudo hoy?');
  assert.deepEqual((assistants[0] as { model?: unknown }).model, {
    name: 'grok-4.5',
    displayName: 'Grok 4.5',
    provider: 'xAI',
  });
});
