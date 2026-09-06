import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { findRecoveredAgentAssistantIndex } from '../lib/agent-task-message-recovery';
import { mergeMessagesPreservingUserContent, parseAgentTaskContent } from '../lib/message-preservation';

const taskId = 'synthetic-document-task';
const chatId = 'synthetic-document-chat';
const originalPrompt = 'En synthetic.pptx, cambia el título de la primera diapositiva a "Historia de los Dinosaurios de 1998".';
const fence = (state: Record<string, unknown>) => '```agent-task-state\n' + JSON.stringify(state) + '\n```';
const pending = fence({ meta: { taskId }, done: false, steps: [{ id: 'pending', status: 'running' }] });
const user = () => ({
  id: 'user-document-turn', chatId, role: 'USER', content: originalPrompt,
  files: [{ id: 'synthetic-file', filename: 'synthetic.pptx' }],
  metadata: { source: 'agent-task-user', taskId },
});
const assistant = () => ({
  id: 'assistant-document-turn', chatId, role: 'ASSISTANT', content: pending,
  metadata: { source: 'agent-task', taskId, status: 'running' },
});

test('recovery selects only the assistant when both persisted sides share taskId', () => {
  const messages = [user(), assistant()];
  assert.equal(findRecoveredAgentAssistantIndex(messages, { chatId, taskId }), 1);
  assert.equal(messages[0].content, originalPrompt);
});

test('a task id inside user text is never an assistant identity', () => {
  const message = { ...user(), content: pending };
  assert.equal(findRecoveredAgentAssistantIndex([message], { chatId, taskId }), -1);
});

test('remembered and legacy ids cannot authorize overwriting user/system/tool messages', () => {
  for (const role of ['USER', 'SYSTEM', 'TOOL']) {
    const message = { id: 'hint', chatId, role, content: pending };
    for (const field of ['bubbleMessageId', 'legacyMessageId']) {
      assert.equal(findRecoveredAgentAssistantIndex([message], { chatId, taskId, [field]: message.id }), -1);
    }
  }
});

test('remembered ids cannot steal another task or a different chat', () => {
  for (const message of [
    { ...assistant(), chatId: 'another-chat' },
    { ...assistant(), content: fence({ taskId: 'another-task' }), metadata: { taskId: 'another-task' } },
  ]) {
    assert.equal(findRecoveredAgentAssistantIndex([message], {
      chatId, taskId, bubbleMessageId: message.id, legacyMessageId: message.id,
    }), -1);
  }
});

test('conflicting content and metadata task ids fail closed, including fallback hints', () => {
  const message = { ...assistant(), metadata: { taskId: 'another-task' } };
  assert.equal(findRecoveredAgentAssistantIndex([message], {
    chatId, taskId, bubbleMessageId: message.id, legacyMessageId: message.id,
  }), -1);
});

test('a specifically identified legacy assistant remains recoverable without adopting arbitrary bubbles', () => {
  const message = { id: 'legacy-assistant', role: 'assistant', content: fence({ done: false }) };
  assert.equal(findRecoveredAgentAssistantIndex([message], { chatId, taskId }), -1);
  assert.equal(findRecoveredAgentAssistantIndex([message], { chatId, taskId, legacyMessageId: message.id }), 0);
});

test('JSON metadata and legacy content task ids identify the assistant', () => {
  assert.equal(findRecoveredAgentAssistantIndex([
    { ...assistant(), metadata: JSON.stringify({ source: 'agent-task', taskId }) },
  ], { chatId, taskId }), 0);
  assert.equal(findRecoveredAgentAssistantIndex([
    { ...assistant(), metadata: {}, content: fence({ taskId, done: false }) },
  ], { chatId, taskId }), 0);
});

// Execute the component's actual state updater, not a copied implementation.
// This is a deterministic state test; the separate Playwright regression
// exercises mounting, durable HTTP recovery and the rendered terminal bubble.
function runComponentRecovery(messages: any[], state: Record<string, unknown>, rememberedId: string | null = null) {
  const source = fs.readFileSync(path.join(process.cwd(), 'components/chat-interface-enhanced.tsx'), 'utf8');
  const helpersStart = source.indexOf('const AGENT_TASK_STATE_FENCE =');
  const helpersEnd = source.indexOf('const waitForAgentTaskRecoveryPoll =', helpersStart);
  const updaterStart = source.indexOf('    const upsertRecoveredBubble =');
  const updaterEnd = source.indexOf('    void (async () => {', updaterStart);
  assert.ok(helpersStart >= 0 && helpersEnd > helpersStart && updaterStart >= 0 && updaterEnd > updaterStart);
  const code = ts.transpileModule(
    source.slice(helpersStart, helpersEnd) + source.slice(updaterStart, updaterEnd)
      + '\nupsertRecoveredBubble(taskId, incomingState, incomingState.error ? "failed" : "completed");',
    { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  let chat: { id: string; messages: any[] } = { id: chatId, messages };
  new Function('initialAgentState', 'signal', 'chatId', 'bubbleMessageId', 'setCurrentChat',
    'findRecoveredAgentAssistantIndex', 'taskId', 'incomingState', code)(
    {}, { aborted: false }, chatId, rememberedId,
    (update: (current: typeof chat) => typeof chat) => { chat = update(chat); },
    findRecoveredAgentAssistantIndex, taskId, state,
  );
  return chat.messages;
}

test('the real recovery updater preserves the original user and closes the correct assistant on failure', () => {
  const originalUser = user();
  const before = [originalUser, assistant()];
  const snapshot = structuredClone(before);
  const updated = runComponentRecovery(before, {
    meta: { taskId }, done: true, error: 'target_not_found', finalText: 'No se modificó el documento.',
  });
  assert.deepEqual(before, snapshot, 'recovery must not mutate the prior state');
  assert.equal(updated[0], originalUser);
  assert.equal(updated[0].content, originalPrompt);
  assert.deepEqual(updated[0].files, originalUser.files);
  assert.equal(updated[1].id, 'assistant-document-turn');
  assert.equal(updated[1].role, 'ASSISTANT');
  assert.equal(parseAgentTaskContent(updated[1].content).done, true);
  assert.equal(parseAgentTaskContent(updated[1].content).error, true);
  assert.match(updated[1].content, /No se modificó el documento\./);
});

test('the real updater creates an assistant if only a user turn exists, even with a stale user hint', () => {
  const originalUser = user();
  const updated = runComponentRecovery([originalUser], { meta: { taskId }, done: true, finalText: 'Listo.' }, originalUser.id);
  assert.equal(updated.length, 2);
  assert.equal(updated[0], originalUser);
  assert.equal(updated[1].role, 'ASSISTANT');
  assert.notEqual(updated[1].id, originalUser.id);
  assert.equal(parseAgentTaskContent(updated[1].content).done, true);
});

for (const status of ['failed', 'error', 'cancelled', 'canceled']) {
  test(`refresh does not revive a terminal ${status} task or discard its user attachment`, () => {
    const terminal = fence({ meta: { taskId }, status, error: 'No se modificó el documento.' });
    const longPending = fence({ meta: { taskId }, done: false, steps: [{ reasoning: 'Esperando '.repeat(1000) }] });
    const incoming = [user(), { ...assistant(), content: longPending }];
    const local = [user(), { ...assistant(), content: terminal }];
    assert.equal(parseAgentTaskContent(terminal).done, true);
    const merged = mergeMessagesPreservingUserContent(incoming, local);
    assert.equal(merged[1].content, terminal);
    assert.equal(merged[0].id, user().id);
    assert.equal(merged[0].role, 'USER');
    assert.equal(merged[0].content, originalPrompt);
    assert.deepEqual(merged[0].metadata, user().metadata);
    const mergedUser = merged[0];
    assert.ok('files' in mergedUser);
    assert.equal(mergedUser.files.length, 1);
    assert.equal(mergedUser.files[0].id, 'synthetic-file');
    assert.equal(mergedUser.files[0].filename, 'synthetic.pptx');
    const terminalFromServer = mergeMessagesPreservingUserContent(local, incoming);
    assert.equal(terminalFromServer[1].content, terminal);
  });
}

test('an old long terminal failure cannot overwrite a different incoming task', () => {
  const old = fence({ meta: { taskId: 'old-task' }, done: true, error: 'error '.repeat(1000) });
  const next = fence({ meta: { taskId: 'new-task' }, done: false });
  const merged = mergeMessagesPreservingUserContent(
    [{ ...assistant(), content: next }], [{ ...assistant(), content: old }],
  );
  assert.equal(merged[0].content, next);
});
