const TURN_IDENTITY_FIELDS = new Set([
  "idempotencyKey",
  "idempotencyRequestHash",
  "streamId",
  "turnFingerprint",
])

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
  return JSON.stringify(clean)
}
