import { parseAgentTaskContent } from './message-preservation';

type RecoveryMessage = {
  id?: string;
  chatId?: string;
  role?: string;
  content?: unknown;
  metadata?: unknown;
};

function taskReference(message: RecoveryMessage): { id: string | null; conflicting: boolean } {
  let metadata = message.metadata;
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { metadata = null; }
  }
  const metadataId = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).taskId
    : null;
  const contentId = parseAgentTaskContent(message.content).taskId;
  const ids = [...new Set([metadataId, contentId]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map(value => value.trim()))];
  return { id: ids[0] || null, conflicting: ids.length > 1 };
}

/** Task ids correlate BOTH sides of a turn; only ASSISTANT is writable here. */
export function findRecoveredAgentAssistantIndex(
  messages: RecoveryMessage[],
  options: { chatId: string; taskId: string; bubbleMessageId?: string | null; legacyMessageId?: string | null },
): number {
  if (!options.chatId || !options.taskId) return -1;
  const eligible = (message: RecoveryMessage) =>
    String(message.role || '').toUpperCase() === 'ASSISTANT'
    && (!message.chatId || message.chatId === options.chatId)
    && !taskReference(message).conflicting;
  const exact = messages.findIndex(message => eligible(message)
    && taskReference(message).id === options.taskId);
  if (exact >= 0) return exact;

  // A remembered/legacy bubble id is not permission to overwrite a USER or
  // another task. Unknown ids are adopted only through these explicit hints.
  for (const hint of [options.bubbleMessageId, options.legacyMessageId]) {
    if (!hint) continue;
    const index = messages.findIndex(message => eligible(message) && message.id === hint
      && !taskReference(message).id);
    if (index >= 0) return index;
  }
  return -1;
}
