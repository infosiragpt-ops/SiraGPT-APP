'use strict';

const {
  computeBodyHash,
  createIdempotencyStore,
} = require('../middleware/idempotency');

const DEFAULT_LOCK_MS = 15 * 60 * 1000;
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
let defaultStore = null;

function getDefaultStore() {
  if (!defaultStore) defaultStore = createIdempotencyStore(process.env);
  return defaultStore;
}

function normalizeKey(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  if (!key || key.length > 200 || !/^[A-Za-z0-9._~:/+=@-]+$/.test(key)) return null;
  return key;
}

function fingerprintBody(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return computeBodyHash(body);
  const copy = { ...body };
  delete copy.idempotencyKey;
  return computeBodyHash(copy);
}

function buildScopeKey(userId, route, normalizedKey) {
  return `document:${String(userId)}:${String(route)}:${normalizedKey}`;
}

function classifyExisting(existing, bodyHash, normalizedKey) {
  if (!existing) return { outcome: 'new', key: normalizedKey };
  if ((existing.bodyHash ?? null) !== (bodyHash ?? null)) {
    return { outcome: 'conflict', key: normalizedKey };
  }
  if (existing.state === 'final') {
    return { outcome: 'replay', key: normalizedKey, result: existing.result || null };
  }
  return { outcome: 'in_progress', key: normalizedKey };
}

/** Read-only probe used before quota enforcement so a completed retry is free. */
async function inspectDocumentOperation({
  userId,
  route = 'doc.generate',
  key,
  body,
  store = getDefaultStore(),
} = {}) {
  const normalizedKey = normalizeKey(key);
  if (!normalizedKey) return { outcome: key == null ? 'disabled' : 'invalid_key' };
  if (!userId) return { outcome: 'invalid_user' };
  const bodyHash = fingerprintBody(body);
  const existing = await store.get(buildScopeKey(userId, route, normalizedKey));
  return classifyExisting(existing, bodyHash, normalizedKey);
}

function durableFileUrl(file = {}) {
  for (const candidate of [file.downloadUrl, file.url]) {
    if (typeof candidate !== 'string') continue;
    const value = candidate.trim();
    if (!value || /^(?:data|blob):/i.test(value)) continue;
    if (value.startsWith('/') || /^https?:\/\//i.test(value)) return value;
  }
  return null;
}

function compactResult(result = {}) {
  const content = typeof result.content === 'string' ? result.content.slice(0, 12_000) : '';
  const durableUrl = result.file && typeof result.file === 'object'
    ? durableFileUrl(result.file)
    : null;
  const file = result.file && typeof result.file === 'object'
    ? {
        id: result.file.id || null,
        url: durableUrl,
        downloadUrl: durableUrl,
        filename: result.file.filename || result.file.name || null,
        format: result.file.format || result.format || null,
        mime: result.file.mime || result.file.mimeType || null,
        sizeBytes: Number(result.file.sizeBytes || result.file.size) || null,
      }
    : null;
  return {
    chatId: result.chatId || null,
    assistantMessageId: result.assistantMessageId || null,
    content,
    format: result.format || file?.format || null,
    file,
    assistantMessage: result.assistantMessageId ? {
      id: result.assistantMessageId,
      role: 'ASSISTANT',
      content,
      files: file ? [file] : [],
    } : null,
    completedAt: new Date().toISOString(),
  };
}

function buildDocumentReplayFrame(result = {}) {
  const replay = result && typeof result === 'object' ? result : {};
  return {
    type: 'final',
    content: typeof replay.content === 'string' ? replay.content : '',
    file: replay.file && typeof replay.file === 'object' ? replay.file : null,
    format: replay.format || replay.file?.format || null,
    assistantMessage: replay.assistantMessage && typeof replay.assistantMessage === 'object'
      ? replay.assistantMessage
      : null,
    replayed: true,
  };
}

async function beginDocumentOperation({
  userId,
  route = 'doc.generate',
  key,
  body,
  store = getDefaultStore(),
  lockMs = DEFAULT_LOCK_MS,
  ttlSeconds = DEFAULT_TTL_SECONDS,
} = {}) {
  const normalizedKey = normalizeKey(key);
  if (!normalizedKey) return { outcome: key == null ? 'disabled' : 'invalid_key' };
  if (!userId) return { outcome: 'invalid_user' };

  const bodyHash = fingerprintBody(body);
  const scopeKey = buildScopeKey(userId, route, normalizedKey);
  const claim = await store.tryAcquire(scopeKey, bodyHash, lockMs);

  if (!claim.acquired) {
    return classifyExisting(claim.existing || null, bodyHash, normalizedKey);
  }

  const leaseToken = claim.leaseToken || null;
  let settled = false;
  return {
    outcome: 'acquired',
    key: normalizedKey,
    async complete(result) {
      if (settled) return;
      const compact = compactResult(result);
      // A data:/blob: URL only works in the originating browser response.
      // Caching it without its bytes would turn every retry for 24 hours into
      // a successful-looking but non-downloadable replay. Release the claim
      // so the client can safely regenerate until durable storage succeeds.
      if (result?.file && !compact.file?.downloadUrl) {
        settled = true;
        await store.release(scopeKey, leaseToken);
        return false;
      }
      try {
        // Finalization is compare-and-set. A worker whose lease expired must
        // never overwrite the newer retry's pending or final record.
        const stored = typeof store.putIfLease === 'function'
          ? await store.putIfLease(scopeKey, leaseToken, {
          state: 'final',
          bodyHash,
          result: compact,
          }, ttlSeconds)
          : false;
        if (stored === false) {
          await store.release(scopeKey, leaseToken);
          settled = true;
          return false;
        }
        settled = true;
        return true;
      } catch (error) {
        try { await store.release(scopeKey, leaseToken); } catch { /* preserve original storage error */ }
        settled = true;
        throw error;
      }
    },
    async fail() {
      if (settled) return;
      settled = true;
      await store.release(scopeKey, leaseToken);
    },
  };
}

function _resetDefaultStoreForTests() {
  defaultStore = null;
}

module.exports = {
  beginDocumentOperation,
  inspectDocumentOperation,
  buildDocumentReplayFrame,
  compactResult,
  durableFileUrl,
  fingerprintBody,
  buildScopeKey,
  normalizeKey,
  DEFAULT_LOCK_MS,
  DEFAULT_TTL_SECONDS,
  _resetDefaultStoreForTests,
};
