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

const parseFilesArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const hasRichFileMetadata = (value: unknown) =>
  parseFilesArray(value).some((file) => {
    if (!file || typeof file !== 'object') return false;
    const f = file as Record<string, unknown>;
    return Boolean(
      f.name ||
      f.originalName ||
      f.filename ||
      f.mimeType ||
      f.contentType ||
      f.type ||
      f.url ||
      f.path ||
      f.preview ||
      f.thumbnailUrl ||
      f.extractedText
    );
  });

const shouldPreserveLocalFiles = (incomingFiles: unknown, localFiles: unknown) => {
  if (!hasFiles(localFiles)) return false;
  if (!hasFiles(incomingFiles)) return true;

  // Some backend refreshes return only file ids after upload. That is enough
  // for model context, but not enough for the UI to render image thumbnails,
  // document chips, previews, or extracted text. Keep the richest version that
  // was already visible in the local optimistic message.
  return hasRichFileMetadata(localFiles) && !hasRichFileMetadata(incomingFiles);
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

  // Pass 1 - preserve content of user messages that survived the server round-trip.
  // Hardened against the "text shrinks to empty" regression: when looking for
  // a local match we now also try matching by content prefix (recovers across
  // a re-issued chat object where the optimistic id was lost) AND we always
  // pick the LONGER of incoming.content vs localMatch.content for user turns
  // - user input is immutable from the user's POV, so the most-detailed
  // version we ever rendered must survive.
  let userOrdinal = -1;
  const enriched: TMessage[] = incomingMessages.map((incoming) => {
    if (!isUserMessage(incoming)) return incoming;

    userOrdinal += 1;
    let localMatch: TMessage | undefined =
      (incoming.id ? localById.get(incoming.id) : undefined) ||
      localUsersByOrdinal[userOrdinal];

    // Extra match attempt: same-content user message anywhere in local.
    // Catches the case where ordinal alignment is off because the server
    // returned more or fewer user messages than the local snapshot.
    if (!localMatch) {
      const incomingText = asText(incoming.content).trim();
      if (incomingText) {
        localMatch = localUsersByOrdinal.find(l => sameUserContent(l, incoming));
      }
    }

    if (!localMatch) return incoming;

    const next: TMessage = { ...incoming };

    const incomingText = asText(next.content);
    const localText = asText(localMatch.content);
    // Defensive: pick the LONGER non-empty content. This prevents the
    // "text disappears after assistant responds" regression where a
    // server refresh returned the same user turn with content="" while
    // local still had the original text.
    if (hasText(localText) && (!hasText(incomingText) || localText.length > incomingText.length)) {
      next.content = localText as TMessage['content'];
    }

    if (shouldPreserveLocalFiles(next.files, localMatch.files)) {
      next.files = localMatch.files as TMessage['files'];
    }

    return next;
  });

  // Pass 2 - re-insert any local user message that was DROPPED by the server.
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
