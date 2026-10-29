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

/**
 * A handoff ends the streamed turn, not its durable transcription. Only the
 * service's delivered messages settle it; unrelated replies and generated
 * files are not delivery evidence. Batch handoffs expose one primary delivery
 * id, so every source file must be accounted for before polling stops.
 */
export function pendingMediaDeliveryRefreshKey(messages: Array<Pick<ChatMessageLike, 'id' | 'role' | 'content' | 'metadata'>> = []): string {
  const assistants = messages.flatMap((message, index) => String(message.role).toUpperCase() === 'ASSISTANT'
    ? [{ message, index, metadata: metadataOf(message.metadata) }]
    : []);
  const deliveries = assistants.filter(({ metadata }) => metadata.source === 'media-delivery');

  const pending = assistants.flatMap(({ message, index, metadata }) => {
    const task = parseAgentTaskContent(message.content);
    const deliveryId = idOf(metadata.mediaDeliveryHandoff) || idOf(task.mediaDeliveryHandoff);
    const fileIds = idsOf(metadata.transcriptionFileIds).length
      ? idsOf(metadata.transcriptionFileIds) : idsOf(task.transcriptionFileIds);
    const isHandoff = Boolean(deliveryId) || metadata.stoppedReason === 'media_delivery_handoff'
      || (task.done && !task.error && task.stoppedReason === 'media_delivery_handoff');
    if (!isHandoff || metadata.source === 'media-delivery') return [];

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
    return settled ? [] : [[message.id || index, deliveryId, remainingFiles]];
  });
  return pending.length ? JSON.stringify(pending) : '';
}
