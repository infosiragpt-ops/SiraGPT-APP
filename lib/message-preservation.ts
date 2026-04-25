export type ChatMessageLike = {
  id?: string;
  role?: string;
  content?: unknown;
  files?: unknown;
  [key: string]: unknown;
};

export type ChatLike<TMessage extends ChatMessageLike = ChatMessageLike> = {
  id?: string;
  messages?: TMessage[];
  [key: string]: unknown;
};

const isUserMessage = (message: ChatMessageLike | undefined) =>
  String(message?.role || '').toUpperCase() === 'USER';

const asText = (value: unknown) =>
  typeof value === 'string' ? value : value == null ? '' : String(value);

const hasText = (value: unknown) => asText(value).trim().length > 0;

const hasFiles = (value: unknown) => {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value !== 'string') return false;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
};

/**
 * Backend refreshes can race with optimistic UI updates or return partial
 * records after tool pipelines. User turns are source-of-truth for the UI:
 * once the user sees their own text, a later server payload must not erase it.
 */
const isOptimisticTempId = (id?: unknown) =>
  typeof id === 'string' && /^msg-(?:user|ai|temp)-/.test(id);

const sameUserContent = (a: ChatMessageLike, b: ChatMessageLike) => {
  const ta = asText(a?.content).trim();
  const tb = asText(b?.content).trim();
  if (!ta || !tb) return false;
  // Tolerate trivial whitespace differences (server may collapse newlines).
  return ta.replace(/\s+/g, ' ') === tb.replace(/\s+/g, ' ');
};

export function mergeMessagesPreservingUserContent<TMessage extends ChatMessageLike>(
  incomingMessages: TMessage[] = [],
  localMessages: TMessage[] = [],
): TMessage[] {
  const localById = new Map<string, TMessage>();
  const localUsersByOrdinal: TMessage[] = [];

  for (const message of localMessages) {
    if (message?.id) localById.set(message.id, message);
    if (isUserMessage(message)) localUsersByOrdinal.push(message);
  }

  // Pass 1 — preserve content of user messages that survived the server round-trip.
  let userOrdinal = -1;
  const enriched: TMessage[] = incomingMessages.map((incoming) => {
    if (!isUserMessage(incoming)) return incoming;

    userOrdinal += 1;
    const localMatch =
      (incoming.id ? localById.get(incoming.id) : undefined) ||
      localUsersByOrdinal[userOrdinal];

    if (!localMatch) return incoming;

    const next: TMessage = { ...incoming };

    if (!hasText(next.content) && hasText(localMatch.content)) {
      next.content = asText(localMatch.content) as TMessage['content'];
    }

    if (!hasFiles(next.files) && hasFiles(localMatch.files)) {
      next.files = localMatch.files as TMessage['files'];
    }

    return next;
  });

  // Pass 2 — re-insert any local user message that was DROPPED by the server.
  // This guards against the bug where a server refresh returns the assistant
  // turn but omits the user message that triggered it (race condition,
  // partial backend save, transcription pipeline replacing the turn, etc.).
  // A user message the user already SAW must never disappear from the UI.
  if (localUsersByOrdinal.length === 0) return enriched;

  const incomingUserIds = new Set<string>();
  const incomingUsers: TMessage[] = [];
  for (const m of enriched) {
    if (!isUserMessage(m)) continue;
    if (m.id) incomingUserIds.add(String(m.id));
    incomingUsers.push(m);
  }

  const orphans: { localIndex: number; message: TMessage }[] = [];
  for (let i = 0; i < localMessages.length; i++) {
    const local = localMessages[i];
    if (!isUserMessage(local)) continue;
    // Server-side ids (cuid/ulid) survive round-trips. Optimistic temp ids
    // (msg-user-${ts}) won't appear in the server response, so we match
    // those by content instead.
    const surfacesById = local.id && !isOptimisticTempId(local.id) && incomingUserIds.has(String(local.id));
    if (surfacesById) continue;
    const surfacesByContent = incomingUsers.some(incoming => sameUserContent(incoming, local));
    if (surfacesByContent) continue;
    orphans.push({ localIndex: i, message: local });
  }

  if (orphans.length === 0) return enriched;

  // Re-stitch: for each orphan, insert it before the assistant message that
  // immediately follows it in the local order (so the rendered timeline
  // stays consistent with what the user actually saw).
  const result: TMessage[] = [...enriched];
  for (const { localIndex, message } of orphans) {
    // Find the next assistant message AFTER this user turn in localMessages.
    let anchorAssistantId: string | null = null;
    for (let j = localIndex + 1; j < localMessages.length; j++) {
      const m = localMessages[j] as ChatMessageLike;
      if (!isUserMessage(m) && m?.role) {
        anchorAssistantId = (m.id as string) || null;
        break;
      }
    }
    let insertIdx = result.length;
    if (anchorAssistantId) {
      const idx = result.findIndex(m => (m as ChatMessageLike).id === anchorAssistantId);
      if (idx >= 0) insertIdx = idx;
    }
    if (insertIdx === result.length) {
      const localAssistantCountBefore = localMessages
        .slice(0, localIndex)
        .filter(m => !isUserMessage(m) && !!m?.role).length;
      let assistantOrdinal = -1;
      const idx = result.findIndex(m => {
        if (isUserMessage(m) || !m?.role) return false;
        assistantOrdinal += 1;
        return assistantOrdinal >= localAssistantCountBefore;
      });
      if (idx >= 0) insertIdx = idx;
    }
    result.splice(insertIdx, 0, message);
  }
  return result;
}

export function mergeChatPreservingUserMessages<TChat extends ChatLike>(
  incomingChat: TChat,
  localChat: TChat | null | undefined,
): TChat {
  if (!incomingChat || !localChat || incomingChat.id !== localChat.id) {
    return incomingChat;
  }

  return {
    ...incomingChat,
    messages: mergeMessagesPreservingUserContent(
      incomingChat.messages || [],
      localChat.messages || [],
    ),
  };
}
