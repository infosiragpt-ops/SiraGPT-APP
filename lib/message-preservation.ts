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

  let userOrdinal = -1;

  return incomingMessages.map((incoming) => {
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
