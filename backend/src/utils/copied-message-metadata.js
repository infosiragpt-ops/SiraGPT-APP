'use strict';

/**
 * Metadata of a message copied into another chat («Guardar en mi cuenta» on a
 * share). A transcription handed off to the background («te aviso aquí»)
 * belongs to the chat that asked for it: its result and its «Detener» stay
 * there. The copy keeps the words and is marked (`mediaDeliveryCopy`), so it
 * never waits on, or stops, another chat's work. Same rule as the client's
 * branch copy (lib/chat/branch-metadata.ts withoutMediaDeliveryState).
 */

const STATE_FIELDS = new Set(['mediaDeliveryHandoff', 'mediaDeliveryAmended', 'mediaDeliveryChanges']);
const STOP_REASONS = new Set(['media_delivery_handoff', 'media_delivery_amended']);

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanRecord(record) {
  const carried = Object.keys(record).some(key => STATE_FIELDS.has(key)) || STOP_REASONS.has(String(record.stoppedReason ?? ''));
  if (!carried) return record;
  const clean = Object.fromEntries(Object.entries(record).filter(([key]) => !STATE_FIELDS.has(key)
    && !(key === 'stoppedReason' && STOP_REASONS.has(String(record.stoppedReason ?? '')))));
  return { ...clean, mediaDeliveryCopy: true };
}

/** The metadata as given (object or JSON string), without the original chat's pending transcription. */
function withoutMediaDeliveryState(metadata) {
  if (isPlainRecord(metadata)) return cleanRecord(metadata);
  if (typeof metadata !== 'string') return metadata;
  let parsed;
  try { parsed = JSON.parse(metadata); } catch (_) { return metadata; }
  if (!isPlainRecord(parsed)) return metadata;
  const clean = cleanRecord(parsed);
  return clean === parsed ? metadata : JSON.stringify(clean);
}

module.exports = { withoutMediaDeliveryState };
