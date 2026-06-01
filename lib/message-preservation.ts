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

  // Pre-index local assistants by ordinal for Pass 1b (below).
  const localAssistantsByOrdinal: TMessage[] = [];
  for (const message of localMessages) {
    if (message?.role && !isUserMessage(message)) localAssistantsByOrdinal.push(message);
  }

  // Pass 1 - preserve content of user messages that survived the server round-trip.
  // Hardened against the "text shrinks to empty" regression: when looking for
  // a local match we now also try matching by content prefix (recovers across
  // a re-issued chat object where the optimistic id was lost) AND we always
  // pick the LONGER of incoming.content vs localMatch.content for user turns
  // - user input is immutable from the user's POV, so the most-detailed
  // version we ever rendered must survive.
  let userOrdinal = -1;
  let asstOrdinal = -1;
  const enriched: TMessage[] = incomingMessages.map((incoming) => {
    if (isUserMessage(incoming)) {
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
    }

    // ── Pass 1b - preserve assistant content / files when the server's
    // copy is empty or shorter (mid-persistence race). Mirrors the
    // user-side logic above: if local rendered a real answer and the
    // refresh arrived before the backend finished saving, keep the
    // local content so the bubble doesn't flash and vanish. Also
    // guards against partial saves where the server returns a
    // truncated version of the assistant message.
    if (incoming?.role) {
      asstOrdinal += 1;
      const localMatch: TMessage | undefined =
        (incoming.id ? localById.get(incoming.id) : undefined) ||
        localAssistantsByOrdinal[asstOrdinal];
      if (!localMatch) return incoming;

      const next: TMessage = { ...incoming };
      const incomingText = asText(next.content);
      const localText = asText(localMatch.content);
      if (hasText(localText) && (!hasText(incomingText) || localText.length > incomingText.length)) {
        next.content = localText as TMessage['content'];
      }
      if (shouldPreserveLocalFiles(next.files, localMatch.files)) {
        next.files = localMatch.files as TMessage['files'];
      }
      return next;
    }

    return incoming;
  });

  // Pass 2 - re-insert any local user message that was DROPPED by the server.
  // This guards against the bug where a server refresh returns the assistant
  // turn but omits the user message that triggered it (race condition,
  // partial backend save, transcription pipeline replacing the turn, etc.).
  // A user message the user already SAW must never disappear from the UI.
  if (localUsersByOrdinal.length === 0) {
    // No local user messages to re-stitch, but Pass 3 still needs to run
    // for orphan assistant tail preservation (e.g. seed-assistant-only
    // chats where the user hasn't typed yet but a stream just finished).
    return preserveOrphanAssistantMessages(enriched, localMessages);
  }

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

  if (orphans.length === 0) {
    // No orphan users to re-insert, but Pass 3 still applies for the
    // assistant-tail race (the common case when the server merely lags
    // on persisting the just-completed assistant turn).
    return preserveOrphanAssistantMessages(enriched, localMessages);
  }

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
  // Pass 3 - tail-preserve recent assistant turns. See
  // preserveOrphanAssistantMessages for the rationale (closes the
  // "answer flashes then disappears" race after stream completion).
  return preserveOrphanAssistantMessages(result, localMessages);
}

const OPTIMISTIC_ID_RE = /^msg-(?:user|ai|temp)-/;

// Minimal structural shape for dedupe — deliberately WITHOUT ChatMessageLike's
// `[key: string]: unknown` index signature, so concrete app message types
// (e.g. the frontend `Message`) are assignable without a cast.
type DedupeMessageLike = {
  id?: string;
  role?: string;
  content?: unknown;
  timestamp?: unknown;
  createdAt?: unknown;
};

const sameContentNormalized = (a: DedupeMessageLike, b: DedupeMessageLike) => {
  const ta = asText(a?.content).trim();
  const tb = asText(b?.content).trim();
  if (!ta || !tb) return false;
  // Tolerate trivial whitespace differences (server may collapse newlines).
  return ta.replace(/\s+/g, ' ') === tb.replace(/\s+/g, ' ');
};

const richerMessage = <T extends DedupeMessageLike>(a: T, b: T): T => {
  // Prefer the copy with more content; on a tie prefer the stable
  // (non-optimistic) id because that's the server's source-of-truth record.
  const la = asText(a?.content).length;
  const lb = asText(b?.content).length;
  if (lb > la) return b;
  if (la > lb) return a;
  const aOptimistic = a?.id ? OPTIMISTIC_ID_RE.test(String(a.id)) : true;
  const bOptimistic = b?.id ? OPTIMISTIC_ID_RE.test(String(b.id)) : true;
  if (aOptimistic && !bOptimistic) return b;
  return a;
};

const isStableMessage = (message?: DedupeMessageLike) => {
  const id = message?.id ? String(message.id) : '';
  return Boolean(id) && !OPTIMISTIC_ID_RE.test(id);
};

const messageTimeMs = (message?: DedupeMessageLike) => {
  const raw = message?.timestamp ?? message?.createdAt;
  if (typeof raw !== 'string' && typeof raw !== 'number' && !(raw instanceof Date)) {
    return NaN;
  }
  const parsed = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : NaN;
};

const isRole = (message: DedupeMessageLike | undefined, role: string) =>
  String(message?.role || '').toUpperCase() === role;

/**
 * Final safety net against the optimistic-UI message-duplication bug — the
 * same turn surviving twice in the rendered list. Two failure modes collapse
 * here:
 *
 *  1. **Exact id collision** — two entries share an id (e.g. an AI placeholder
 *     that was both replaced in place AND re-stitched as an orphan). We keep
 *     the richer copy in the slot where the id first appeared.
 *  2. **Optimistic / server twins** — an optimistic message
 *     (`msg-user-…` / `msg-ai-…` / `msg-temp-…`) sitting next to its
 *     server-persisted copy (stable id, same role, same text). The server
 *     copy is canonical, so the optimistic twin is dropped. This is the
 *     exact "sigue duplicando los mensajes" case: the content-/ordinal-based
 *     merge couldn't align the two ids, so both ended up in the list.
 *
 * Insertion order is preserved and, when nothing is duplicated, the original
 * array reference is returned so React bails out of needless re-renders.
 */
export function dedupeMessages<TMessage extends DedupeMessageLike>(
  messages: TMessage[] = [],
): TMessage[] {
  if (!Array.isArray(messages) || messages.length < 2) return messages;

  // Pass A — collapse exact-id duplicates, keeping the richer copy in the
  // earliest slot the id appeared.
  const slotById = new Map<string, number>();
  const collapsed: TMessage[] = [];
  for (const message of messages) {
    const id = message?.id ? String(message.id) : '';
    if (id && slotById.has(id)) {
      const slot = slotById.get(id)!;
      collapsed[slot] = richerMessage(collapsed[slot], message);
      continue;
    }
    if (id) slotById.set(id, collapsed.length);
    collapsed.push(message);
  }

  // Pass B — drop optimistic twins whose stable-id sibling is already present.
  const hasStableTwin = (candidate: TMessage, selfIndex: number) =>
    collapsed.some((other, j) => {
      if (j === selfIndex) return false;
      if (!other?.id || OPTIMISTIC_ID_RE.test(String(other.id))) return false;
      if (String(other.role || '').toUpperCase() !== String(candidate.role || '').toUpperCase()) return false;
      return sameContentNormalized(other, candidate);
    });

  const deduped = collapsed.filter((message, index) => {
    const id = message?.id ? String(message.id) : '';
    if (id && OPTIMISTIC_ID_RE.test(id) && hasStableTwin(message, index)) {
      return false;
    }
    return true;
  });

  // Pass C — collapse ADJACENT same-role twins where BOTH carry a stable
  // (non-optimistic) server id and identical visible content. This closes the
  // one "sigue duplicando los mensajes" gap that Pass A/B can't: a turn the
  // backend persisted TWICE (two distinct cuids) — so there is no id collision
  // for Pass A and no optimistic twin for Pass B, yet the user sees the line
  // rendered twice. We require BOTH ids to be stable on purpose: two optimistic
  // sends are intentionally preserved (see message-dedupe tests — a genuine
  // rapid double-send is the user's choice, not our duplication artifact), and
  // the optimistic-vs-stable case is already Pass B's job. Restricting to
  // *adjacent* turns means a message legitimately repeated later in the
  // conversation — always separated by an assistant turn — is never swallowed.
  // Empty content never matches (sameContentNormalized bails on blanks), so
  // streaming/assistant placeholders are left untouched. Pairs with the backend
  // `persistUserMessageOnce` guard, which stops NEW double-writes at the source;
  // Pass C cleans up rows already duplicated in existing conversations.
  const collapsedAdjacent: TMessage[] = [];
  for (const message of deduped) {
    const prev = collapsedAdjacent[collapsedAdjacent.length - 1];
    const bothStable =
      !!prev && !!prev.id && !!message.id &&
      !OPTIMISTIC_ID_RE.test(String(prev.id)) &&
      !OPTIMISTIC_ID_RE.test(String(message.id));
    if (
      bothStable &&
      String(prev.role || '').toUpperCase() === String(message.role || '').toUpperCase() &&
      sameContentNormalized(prev, message)
    ) {
      collapsedAdjacent[collapsedAdjacent.length - 1] = richerMessage(prev, message);
      continue;
    }
    collapsedAdjacent.push(message);
  }

  // Pass D — collapse duplicated *turn pairs* persisted as
  // USER/ASSISTANT/USER/ASSISTANT within a tiny window. The previous backend
  // guard only caught "same user row while unanswered"; production showed a
  // second request arriving milliseconds after the first fast assistant reply,
  // so the duplicate was no longer adjacent by role. Timestamps are required
  // to avoid swallowing intentional later repeats.
  const DUPLICATE_PAIR_WINDOW_MS = 1_500;
  const collapsedPairs: TMessage[] = [];
  for (let i = 0; i < collapsedAdjacent.length; i += 1) {
    const userA = collapsedAdjacent[i];
    const assistantA = collapsedAdjacent[i + 1];
    const userB = collapsedAdjacent[i + 2];
    const assistantB = collapsedAdjacent[i + 3];
    const userGapMs = messageTimeMs(userB) - messageTimeMs(userA);
    if (
      isStableMessage(userA) &&
      isStableMessage(assistantA) &&
      isStableMessage(userB) &&
      isStableMessage(assistantB) &&
      isRole(userA, 'USER') &&
      isRole(userB, 'USER') &&
      isRole(assistantA, 'ASSISTANT') &&
      isRole(assistantB, 'ASSISTANT') &&
      sameContentNormalized(userA, userB) &&
      Number.isFinite(userGapMs) &&
      userGapMs >= 0 &&
      userGapMs <= DUPLICATE_PAIR_WINDOW_MS
    ) {
      collapsedPairs.push(userA, sameContentNormalized(assistantA, assistantB)
        ? richerMessage(assistantA, assistantB)
        : assistantA);
      i += 3;
      continue;
    }
    collapsedPairs.push(userA);
  }

  // Reference-stable when no duplicate was found (lengths can only differ if
  // Pass A, B, C or D actually removed something).
  return collapsedPairs.length === messages.length ? messages : collapsedPairs;
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
    messages: dedupeMessages(
      mergeMessagesPreservingUserContent(
        incomingChat.messages || [],
        localChat.messages || [],
      ),
    ),
  };
}

/**
 * Pass 3 - preserve LOCAL assistant messages the server hasn't echoed
 * back yet. Closes the "answer flashes then disappears" race:
 *
 *   1. Stream completes → optimistic assistant message added locally
 *   2. selectChat() refreshes from API while the backend is still
 *      persisting the turn
 *   3. Server response is missing the freshly-completed assistant turn
 *   4. Without this pass, the merge silently drops the local message
 *      and the bubble vanishes from the user's screen
 *
 * The orphan match is purely positional: a local assistant turn
 * counts as orphan when its index is BEYOND the count of assistant
 * turns the server returned (i.e. "the last one or two we added that
 * the server hasn't caught up on yet"). We never re-insert older
 * assistant messages — if the server now lists 5 assistants and local
 * has 6, only #6 (the orphan tail) is preserved. The next refresh
 * will then have an authoritative #6 from the server and we'll match
 * it by id/content, so no duplication.
 */
export function preserveOrphanAssistantMessages<TMessage extends ChatMessageLike>(
  enriched: TMessage[],
  localMessages: TMessage[],
): TMessage[] {
  if (!localMessages.length) return enriched;

  const incomingAssistantCount = enriched.filter(m => m?.role && !isUserMessage(m)).length;
  const localAssistants: TMessage[] = [];
  for (const m of localMessages) {
    if (m?.role && !isUserMessage(m)) localAssistants.push(m);
  }

  // Pass 3a: If the server returned the same number of assistant messages
  // but one of them has significantly less content than the local version,
  // graft the richer local content into the enriched list. This catches
  // the race where the backend saved a partial/stub assistant message
  // (e.g. just the first few tokens) while the client has the full stream.
  if (localAssistants.length === incomingAssistantCount && incomingAssistantCount > 0) {
    const incomingAssistants = enriched.filter(m => m?.role && !isUserMessage(m));
    let patched = false;
    const patchedEnriched = enriched.map((m) => {
      if (!m?.role || isUserMessage(m)) return m;
      const idx = incomingAssistants.indexOf(m);
      if (idx === -1) return m;
      const localVersion = localAssistants[idx];
      if (!localVersion) return m;
      const incomingText = asText(m.content);
      const localText = asText(localVersion.content);
      // If the local version has substantially more content, use it.
      if (hasText(localText) && (!hasText(incomingText) || localText.length > incomingText.length + 20)) {
        patched = true;
        return { ...m, content: localText as TMessage['content'] };
      }
      return m;
    });
    if (patched) return patchedEnriched;
  }

  if (localAssistants.length <= incomingAssistantCount) return enriched;

  const incomingIds = new Set<string>();
  for (const m of enriched) {
    if (m?.id && m?.role && !isUserMessage(m)) incomingIds.add(String(m.id));
  }

  const orphans = localAssistants.slice(incomingAssistantCount).filter((local) => {
    if (!local) return false;
    // Skip orphans whose id already exists incoming (paranoid dedupe).
    if (local.id && incomingIds.has(String(local.id))) return false;
    // Empty / placeholder messages aren't worth preserving — the next
    // refresh will surface the real content.
    return hasText(local.content) || hasFiles(local.files);
  });

  if (orphans.length === 0) return enriched;
  return [...enriched, ...orphans];
}
