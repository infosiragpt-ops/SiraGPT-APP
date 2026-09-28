'use strict';

const { createKeyedSerialExecutor } = require('../chat-turn-idempotency');
const MAX_DOCUMENT_TURNS_PER_CHAT = 16;

/**
 * Serialize document producers for one user's chat, including file lookup,
 * sandbox work and artifact persistence. Distinct turns retain their order;
 * distinct chats may run in parallel. New chats share a per-user bucket until
 * the chat has an id, so their first document turns cannot bypass admission.
 */
function createDocumentTurnQueue() {
  const executor = createKeyedSerialExecutor();
  const outstanding = new Map();

  return {
    run({ userId, chatId, signal } = {}, operation) {
      if (typeof operation !== 'function') throw new TypeError('operation is required');
      const key = userId
        ? JSON.stringify([String(userId), chatId ? 'chat' : 'new', chatId ? String(chatId) : ''])
        : null;
      if (key) {
        const count = outstanding.get(key) || 0;
        if (count >= MAX_DOCUMENT_TURNS_PER_CHAT) {
          const error = new Error('Hay demasiadas ediciones pendientes en este chat. Espera a que terminen y vuelve a enviar el mensaje.');
          error.code = 'E_QUOTA';
          error.reason = 'document_turn_queue_full';
          error.status = 429;
          return Promise.reject(error);
        }
        outstanding.set(key, count + 1);
      }
      const run = executor.run(key, async () => {
        // Stop may arrive while this turn is queued behind a long edit. A
        // cancelled follower must never allocate a sandbox when it reaches
        // the head of the queue.
        if (signal?.aborted) {
          const error = new Error('document turn cancelled before start');
          error.name = 'AbortError';
          throw error;
        }
        return operation();
      });
      return run.finally(() => {
        if (!key) return;
        const remaining = (outstanding.get(key) || 1) - 1;
        if (remaining > 0) outstanding.set(key, remaining);
        else outstanding.delete(key);
      });
    },
  };
}

module.exports = { createDocumentTurnQueue, MAX_DOCUMENT_TURNS_PER_CHAT };
