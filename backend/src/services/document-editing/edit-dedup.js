/**
 * document-content-hash — server-side content hashing for the /chat
 * document editor save route (POST /files/:id/edit).
 *
 * The autosave front retries failed saves with a stable `clientMutationId`
 * per logical edit. When the retry reaches the backend AFTER the first
 * attempt already landed (classic lost-response race), the route must
 * answer the existing FileVersion instead of recording a duplicate.
 *
 * The fingerprint that decides "same edit" is sha256(content) — NOT the
 * clientMutationId alone: two different edits sharing an id must never be
 * collapsed, and the same content re-sent with a fresh id is a deliberate
 * new version. Same id + same content hash ⇒ idempotent replay.
 *
 * Pure functions only, so the dedup decision is unit-testable without
 * Express/Prisma (same harness pattern as file-versioning.test.js).
 */

const crypto = require("crypto");

/** Max bytes accepted for a clientMutationId — guards the lookup key. */
const MAX_CLIENT_MUTATION_ID_LEN = 200;

/**
 * Normalize a raw clientMutationId from `req.body`. Returns null when the
 * caller did not send one (dedup disabled for that request) or when it is
 * not a sane opaque token (empty / oversized / control characters).
 */
function normalizeClientMutationId(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_CLIENT_MUTATION_ID_LEN) return null;
  // Printable ASCII + common safe punctuation; rejects control chars and
  // exotic unicode so the storage key stays bounded and readable.
  if (!/^[\x20-\x7E]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * sha256 hex digest of the UTF-8 edited content. This is the "same edit?"
 * fingerprint stored next to each dedup record.
 */
function hashDocumentContent(content) {
  if (typeof content !== "string") return null;
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Storage key namespacing the dedup record per (fileId, userId, mutation).
 * Scoping by user+file means a colliding id across documents can never
 * replay the wrong version.
 */
function buildEditDedupKey(fileId, userId, mutationId) {
  return `file-edit:${String(userId)}:${String(fileId)}:${String(mutationId)}`;
}

/**
 * Decide what POST /:id/edit should do given an existing dedup record.
 *   { action: "create" }                    — no record / different content: record a new version.
 *   { action: "replay", existingVersion }   — same id + same content: return the recorded version.
 *   { action: "conflict" }                  — same id, DIFFERENT content: refuse (client bug or stale draft).
 */
function classifyEditReplay(existingRecord, incomingContentHash) {
  if (!existingRecord || typeof existingRecord !== "object") {
    return { action: "create" };
  }
  const recordedHash = typeof existingRecord.contentHash === "string" ? existingRecord.contentHash : null;
  if (!recordedHash || recordedHash !== incomingContentHash) {
    return { action: "conflict" };
  }
  const version = existingRecord.version && typeof existingRecord.version === "object"
    ? existingRecord.version
    : null;
  if (!version) {
    // Record exists but the version snapshot was lost — safest fallback is
    // to create (the unique [fileId, version] constraint still guards races).
    return { action: "create" };
  }
  return { action: "replay", existingVersion: version };
}

module.exports = {
  MAX_CLIENT_MUTATION_ID_LEN,
  normalizeClientMutationId,
  hashDocumentContent,
  buildEditDedupKey,
  classifyEditReplay,
};
