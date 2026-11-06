import { parseAgentTaskContent, type ChatMessageLike } from './message-preservation';

function metadataOf(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const idOf = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const idsOf = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.map(idOf).filter(Boolean))].sort()
  : [];

export type MediaDeliveryMessage = Pick<ChatMessageLike, 'id' | 'role' | 'content' | 'metadata'>;
export type PendingMediaDelivery = { messageId: string; deliveryId: string; fileIds: string[]; sourceFileIds: string[] };

/**
 * A handoff ends the streamed turn, not its durable transcription. Only the
 * service's delivered messages settle it; unrelated replies and generated
 * files are not delivery evidence. Batch handoffs expose one primary delivery
 * id, so every source file must be accounted for before polling stops.
 */
// One scan per messages array: the chat context, the message list, the
// composer's Stop and the follow-up router all read the same array.
// The length and last element guard an array someone appended to in place.
type PendingMemo = { length: number; last: unknown; result: PendingMediaDelivery[] }
const pendingByMessages = new WeakMap<readonly MediaDeliveryMessage[], PendingMemo>()

export function pendingMediaDeliveries(messages: readonly MediaDeliveryMessage[] = []): PendingMediaDelivery[] {
  if (!Array.isArray(messages)) return []
  const last = messages[messages.length - 1]
  const cached = pendingByMessages.get(messages)
  if (cached && cached.length === messages.length && cached.last === last) return cached.result
  const result = scanPendingMediaDeliveries(messages)
  pendingByMessages.set(messages, { length: messages.length, last, result })
  return result
}

/** One key per pending hand-off: its delivery id, or its message when it names none. */
export function pendingHandoffKey(delivery: Pick<PendingMediaDelivery, 'deliveryId' | 'messageId'>): string {
  return delivery.deliveryId || `msg:${delivery.messageId}`
}

/** The source recordings of the deliveries a chat still waits on. */
export function pendingMediaDeliveryFileIds(messages: readonly MediaDeliveryMessage[] = []): Set<string> {
  return new Set(pendingMediaDeliveries(messages).flatMap((delivery) => delivery.sourceFileIds))
}

function scanPendingMediaDeliveries(messages: readonly MediaDeliveryMessage[]): PendingMediaDelivery[] {
  const assistants = messages.flatMap((message, index) => String(message.role).toUpperCase() === 'ASSISTANT'
    ? [{ message, index, metadata: metadataOf(message.metadata) }]
    : []);
  const deliveries = assistants.filter(({ metadata }) => metadata.source === 'media-delivery');

  const pending = assistants.flatMap(({ message, index, metadata }) => {
    const task = parseAgentTaskContent(message.content);
    const deliveryId = idOf(metadata.mediaDeliveryHandoff) || idOf(task.mediaDeliveryHandoff);
    // A refine's hand-off waits on the one recording its delivery covers.
    // Older ones listed the whole batch the follow-up was attached to, and
    // never settled: the refine delivers (or stops) that recording only.
    const refinedFileId = deliveryId ? idOf(metadataOf(metadata.mediaRefine).fileId) : '';
    const fileIds = refinedFileId ? [refinedFileId] : idsOf(metadata.transcriptionFileIds).length
      ? idsOf(metadata.transcriptionFileIds) : idsOf(task.transcriptionFileIds);
    const isHandoff = Boolean(deliveryId) || metadata.stoppedReason === 'media_delivery_handoff'
      || (task.done && !task.error && task.stoppedReason === 'media_delivery_handoff');
    // A copy (a branch, a saved share) never waits on the original chat's work.
    if (!isHandoff || metadata.source === 'media-delivery' || metadata.mediaDeliveryCopy === true) return [];

    // A later request can reuse the same audio. Its older transcript must not
    // settle new work. An exact delivery id also handles fast jobs whose
    // message is committed before the handoff acknowledgement.
    const matchingDeliveries = deliveries.filter(delivery => delivery.index > index
      || (deliveryId && idOf(delivery.metadata.mediaDelivery) === deliveryId));
    const deliveredFiles = new Set(matchingDeliveries.flatMap(({ metadata }) => idsOf(metadata.transcriptionFileIds)));
    const remainingFiles = fileIds.filter(id => !deliveredFiles.has(id));
    // Concurrent edits can reuse the file id. Coverage alone cannot settle a
    // request with its own explicit delivery id, even if another finishes later.
    const hasExpectedDelivery = deliveryId
      ? matchingDeliveries.some(delivery => idOf(delivery.metadata.mediaDelivery) === deliveryId)
      : matchingDeliveries.length > 0;
    const settled = hasExpectedDelivery && remainingFiles.length === 0;
    // Progress still belongs to this request's sources even if another
    // delivery for the same file appeared later. Only its own delivery id
    // can settle this work; coverage remains separate for the refresh key.
    return settled ? [] : [{ messageId: String(message.id || index), deliveryId, fileIds: remainingFiles, sourceFileIds: fileIds }];
  });
  return pending;
}

export function pendingMediaDeliveryRefreshKey(messages: readonly MediaDeliveryMessage[] = []): string {
  const pending = pendingMediaDeliveries(messages);
  return pending.length ? JSON.stringify(pending.map(({ messageId, deliveryId, fileIds }) => [messageId, deliveryId, fileIds])) : '';
}
