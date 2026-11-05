const TURN_IDENTITY_FIELDS = new Set([
  "idempotencyKey",
  "idempotencyRequestHash",
  "streamId",
  "turnFingerprint",
])

// A transcription handed off to the background («te aviso aquí») belongs to
// the chat that asked for it: its result and its «Detener» stay there. A copy
// keeps the words and is marked, so it never waits on another chat's work.
const MEDIA_DELIVERY_STATE_FIELDS = new Set(["mediaDeliveryHandoff", "mediaDeliveryAmended", "mediaDeliveryChanges"])
const MEDIA_DELIVERY_STOP_REASONS = new Set(["media_delivery_handoff", "media_delivery_amended"])

/** Metadata of a message copied into another chat, without the original chat's pending transcription. */
export function withoutMediaDeliveryState(record: Record<string, unknown>): Record<string, unknown> {
  const carried = Object.keys(record).some((key) => MEDIA_DELIVERY_STATE_FIELDS.has(key))
    || MEDIA_DELIVERY_STOP_REASONS.has(String(record.stoppedReason ?? ""))
  if (!carried) return record
  const clean = Object.fromEntries(Object.entries(record).filter(([key]) => !MEDIA_DELIVERY_STATE_FIELDS.has(key)
    && !(key === "stoppedReason" && MEDIA_DELIVERY_STOP_REASONS.has(String(record.stoppedReason ?? "")))))
  return { ...clean, mediaDeliveryCopy: true }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseMetadataRecord(metadata: unknown): Record<string, unknown> | null {
  if (typeof metadata !== "string") return isPlainRecord(metadata) ? metadata : null
  try {
    const parsed: unknown = JSON.parse(metadata)
    return isPlainRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * A branch is a new conversation, not a retry of the original turn. Preserve
 * useful rendering/provenance metadata while dropping every server identity
 * that would make two copied rows collide with the source turn (or each other).
 * The API client will mint a fresh Idempotency-Key for each addMessage call.
 */
export function serializeBranchedMessageMetadata(metadata: unknown): string | undefined {
  const parsed = parseMetadataRecord(metadata)
  if (!parsed) return undefined

  const clean = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => !TURN_IDENTITY_FIELDS.has(key)),
  )
  return JSON.stringify(withoutMediaDeliveryState(clean))
}
