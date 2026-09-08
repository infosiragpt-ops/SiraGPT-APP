'use strict';

const crypto = require('crypto');

const MESSAGE_IDEMPOTENCY_HASH_FIELD = 'idempotencyRequestHash';

/**
 * Resolve the client-owned identity of a chat turn.
 *
 * Content is deliberately not part of this identity. Users frequently send
 * short prompts such as "sí" or "continúa" more than once, and equal content
 * does not mean equal intent. A retry is only the same turn when the client
 * reuses an explicit idempotency key (preferred) or stream id (legacy
 * fallback).
 */
function normalizeTurnKey(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function resolveTurnIdentity({ idempotencyKey, streamId } = {}) {
  const explicitKey = normalizeTurnKey(idempotencyKey);
  if (explicitKey) {
    return { kind: 'idempotencyKey', value: explicitKey };
  }

  const explicitStreamId = normalizeTurnKey(streamId);
  if (explicitStreamId) {
    return { kind: 'streamId', value: explicitStreamId };
  }

  return null;
}

function buildActiveGenerateTurnKey({ userId, chatId, idempotencyKey, streamId } = {}) {
  const identity = resolveTurnIdentity({ idempotencyKey, streamId });
  if (!identity || !userId || !chatId) return null;

  // JSON encoding prevents ambiguous separator collisions in user-supplied
  // keys while keeping the in-memory key inspectable during diagnostics.
  return `ai-generate:${JSON.stringify([
    String(userId),
    String(chatId),
    identity.kind,
    identity.value,
  ])}`;
}

function metadataMatchesTurnIdentity(metadata, identityInput) {
  const identity = resolveTurnIdentity(identityInput);
  if (!identity || !metadata || typeof metadata !== 'object') return false;

  if (identity.kind === 'idempotencyKey') {
    return normalizeTurnKey(metadata.idempotencyKey) === identity.value;
  }

  const storedStreamId = normalizeTurnKey(metadata.streamId);
  if (storedStreamId) return storedStreamId === identity.value;

  // Older rows used the stream id as their idempotencyKey. Keep retries for
  // those rows safe without treating a content fingerprint as an identity.
  return normalizeTurnKey(metadata.idempotencyKey) === identity.value;
}

function findDuplicateMessageByIdempotency(
  messages,
  idempotencyKey,
  parseMetadata = (value) => value,
) {
  const explicitKey = normalizeTurnKey(idempotencyKey);
  if (!explicitKey || !Array.isArray(messages)) return null;

  return messages.find((message) => {
    const metadata = parseMetadata(message?.metadata);
    return normalizeTurnKey(metadata?.idempotencyKey) === explicitKey;
  }) || null;
}

function buildTurnIdentityMetadataFilters(identityInput) {
  const identity = resolveTurnIdentity(identityInput);
  if (!identity) return [];
  if (identity.kind === 'idempotencyKey') {
    return [{ metadata: { path: ['idempotencyKey'], equals: identity.value } }];
  }
  return [
    { metadata: { path: ['streamId'], equals: identity.value } },
    // Legacy rows stored streamId in metadata.idempotencyKey.
    { metadata: { path: ['idempotencyKey'], equals: identity.value } },
  ];
}

/**
 * Load every row for one explicit turn identity without a recency/window cap.
 * New JSON-object metadata uses an indexed-friendly exact Prisma JSON filter.
 * Older rows that stored JSON as a string fall back to a full chat/role scan;
 * mixed historical turns can have one row in each representation, so an
 * exact partial result is combined with that compatibility scan.
 */
async function findMessagesByTurnIdentity({
  chatId,
  identityInput,
  findMany,
  parseMetadata = (value) => value,
  roles = null,
} = {}) {
  if (!chatId || typeof findMany !== 'function' || !resolveTurnIdentity(identityInput)) return [];
  const baseWhere = {
    chatId,
    deletedAt: null,
    ...(Array.isArray(roles) && roles.length > 0 ? { role: { in: roles } } : {}),
  };
  const metadataFilters = buildTurnIdentityMetadataFilters(identityInput);

  let exactMatching = [];
  try {
    const exact = await findMany({
      where: { ...baseWhere, OR: metadataFilters },
      orderBy: { timestamp: 'asc' },
    });
    exactMatching = (Array.isArray(exact) ? exact : []).filter((message) => (
      metadataMatchesTurnIdentity(parseMetadata(message?.metadata), identityInput)
    ));

    // We can safely avoid the compatibility scan only when the exact result
    // proves that every role requested by the caller is represented. A
    // partial USER-only result may still have a legacy string ASSISTANT row.
    const requiredRoles = Array.isArray(roles) ? [...new Set(roles)] : [];
    const exactIsComplete = requiredRoles.length > 0 && requiredRoles.every((role) => (
      exactMatching.some((message) => message?.role === role)
    ));
    if (exactIsComplete) return exactMatching;
  } catch {
    // Legacy/provider compatibility fallback below.
  }

  const legacyCandidates = await findMany({
    where: baseWhere,
    orderBy: { timestamp: 'asc' },
  });
  const legacyMatching = (Array.isArray(legacyCandidates) ? legacyCandidates : []).filter((message) => (
    metadataMatchesTurnIdentity(parseMetadata(message?.metadata), identityInput)
  ));
  const seenIds = new Set();
  return [...exactMatching, ...legacyMatching]
    .filter((message) => {
      const id = normalizeTurnKey(message?.id);
      if (!id) return true;
      if (seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    })
    .sort((left, right) => (
      new Date(left?.timestamp).getTime() - new Date(right?.timestamp).getTime()
    ));
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(',')}}`;
}

function sanitizeMessageMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};

  return Object.fromEntries(Object.entries(metadata).filter(([key]) => (
    key !== 'idempotencyKey' && key !== MESSAGE_IDEMPOTENCY_HASH_FIELD
  )));
}

/**
 * Hash the effective message payload, excluding the idempotency key itself.
 * Tokens are stringified so an HTTP number and Prisma BigInt round-trip to the
 * same value when matching older rows that predate the stored hash.
 */
function buildMessageRequestFingerprint({ role, content, tokens, files, metadata } = {}) {
  const payload = {
    role: role == null ? null : String(role),
    content: content == null ? null : String(content),
    tokens: tokens == null ? null : String(tokens),
    files: files ?? null,
    metadata: sanitizeMessageMetadata(metadata),
  };

  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/**
 * Hash the client-requested AI intent before mutable quota/model routing.
 * Retry transport identifiers are excluded; requested model, provider,
 * prompt, files, reasoning and any other body options remain significant.
 */
function buildAiGenerateRequestFingerprint({ requestBody } = {}) {
  const payload = requestBody && typeof requestBody === 'object' && !Array.isArray(requestBody)
    ? { ...requestBody }
    : {};

  // These identify/reconnect the request but do not change the work. In
  // particular, an idempotency-key retry may legitimately use a fresh stream.
  delete payload.idempotencyKey;
  delete payload.streamId;
  payload.files = payload.files ?? null;

  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function getStoredMessageRequestFingerprint(
  message,
  parseMetadata = (value) => value,
) {
  const metadata = parseMetadata(message?.metadata);
  const storedHash = normalizeTurnKey(metadata?.[MESSAGE_IDEMPOTENCY_HASH_FIELD]);
  if (storedHash) return storedHash;

  // Compatibility for messages written before request hashes were persisted.
  return buildMessageRequestFingerprint({
    role: message?.role,
    content: message?.content,
    tokens: message?.tokens,
    files: message?.files,
    metadata,
  });
}

function hasIdempotencyRequestConflict(
  messages,
  requestFingerprint,
  parseMetadata = (value) => value,
) {
  const expected = normalizeTurnKey(requestFingerprint);
  if (!expected || !Array.isArray(messages)) return false;

  const stored = messages
    .filter(Boolean)
    .map((message) => normalizeTurnKey(
      parseMetadata(message?.metadata)?.[MESSAGE_IDEMPOTENCY_HASH_FIELD],
    ))
    .filter(Boolean);

  // Legacy rows without a request hash remain replay-compatible. Every new
  // idempotent turn stores the hash on both sides of the pair.
  return stored.some((fingerprint) => fingerprint !== expected);
}

function buildMessageIdempotencyScopeKey({
  userId,
  chatId,
  idempotencyKey,
} = {}) {
  const explicitKey = normalizeTurnKey(idempotencyKey);
  if (!explicitKey || !userId || !chatId) return null;

  return `chat-message:${JSON.stringify([
    String(userId),
    String(chatId),
    explicitKey,
  ])}`;
}

function findMatchingTurnPair(messages, identityInput, parseMetadata = (value) => value) {
  if (!Array.isArray(messages) || !resolveTurnIdentity(identityInput)) return null;

  const matching = messages.filter((message) => metadataMatchesTurnIdentity(
    parseMetadata(message?.metadata),
    identityInput,
  ));
  const userMessage = matching.find((message) => message?.role === 'USER');
  if (!userMessage) return null;

  const userTimestamp = new Date(userMessage.timestamp).getTime();
  const assistantMessage = matching.find((message) => {
    if (message?.role !== 'ASSISTANT') return false;
    const assistantTimestamp = new Date(message.timestamp).getTime();
    return !Number.isFinite(userTimestamp)
      || !Number.isFinite(assistantTimestamp)
      || assistantTimestamp >= userTimestamp;
  }) || null;

  return { userMessage, assistantMessage };
}

async function waitForActiveTurn(activeTurn, {
  timeoutMs = 55_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (!activeTurn?.promise || typeof activeTurn.promise.then !== 'function') {
    return { outcome: 'failed', error: new TypeError('active turn promise is required') };
  }

  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(activeTurn.promise).then(
        (turn) => (turn?.assistantMessage
          ? { outcome: 'replay', turn }
          : { outcome: 'unavailable', turn }),
        (error) => ({ outcome: 'failed', error }),
      ),
      new Promise((resolve) => {
        timer = setTimeoutFn(() => resolve({ outcome: 'in_progress' }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeoutFn(timer);
  }
}

function createKeyedSerialExecutor() {
  const tails = new Map();

  async function run(key, operation) {
    if (!key) return operation();

    const previous = tails.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    tails.set(key, current);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (tails.get(key) === current) tails.delete(key);
    }
  }

  return {
    run,
    size: () => tails.size,
  };
}

/**
 * Claim a stop-controller registry key without allowing a reconnect/follower
 * to replace the active owner's controller. `replaceOwner` is reserved for a
 * request that has subsequently won the turn singleflight after a prior owner
 * failed and released its replay entry.
 */
function claimStreamController(
  registry,
  key,
  controller,
  { replaceOwner = false } = {},
) {
  if (!registry || typeof registry.has !== 'function' || typeof registry.set !== 'function') {
    throw new TypeError('stream controller registry must be Map-like');
  }
  if (!key || !controller) return false;
  if (!replaceOwner && registry.has(key)) return false;
  registry.set(key, controller);
  return true;
}

/**
 * Serialize the read-before-create section for one manual message identity.
 * A missing scope key deliberately bypasses both the lookup and the queue.
 */
function createMessageIdempotencyCoordinator() {
  const executor = createKeyedSerialExecutor();

  async function execute({
    scopeKey,
    requestFingerprint,
    findExisting,
    getExistingFingerprint = getStoredMessageRequestFingerprint,
    create,
  }) {
    if (typeof create !== 'function') throw new TypeError('create must be a function');

    if (!scopeKey) {
      return { outcome: 'created', message: await create() };
    }
    if (typeof findExisting !== 'function') {
      throw new TypeError('findExisting must be a function for idempotent writes');
    }

    const normalizedFingerprint = normalizeTurnKey(requestFingerprint);
    if (!normalizedFingerprint) throw new TypeError('requestFingerprint is required');

    return executor.run(scopeKey, async () => {
      const existing = await findExisting();
      if (existing) {
        const existingFingerprint = normalizeTurnKey(getExistingFingerprint(existing));
        if (existingFingerprint !== normalizedFingerprint) {
          return { outcome: 'conflict', message: existing };
        }
        return { outcome: 'duplicate', message: existing };
      }

      return { outcome: 'created', message: await create() };
    });
  }

  return {
    execute,
    pendingCount: executor.size,
  };
}

module.exports = {
  MESSAGE_IDEMPOTENCY_HASH_FIELD,
  buildActiveGenerateTurnKey,
  buildAiGenerateRequestFingerprint,
  buildMessageIdempotencyScopeKey,
  buildMessageRequestFingerprint,
  claimStreamController,
  createKeyedSerialExecutor,
  createMessageIdempotencyCoordinator,
  findMessagesByTurnIdentity,
  findDuplicateMessageByIdempotency,
  findMatchingTurnPair,
  getStoredMessageRequestFingerprint,
  hasIdempotencyRequestConflict,
  metadataMatchesTurnIdentity,
  normalizeTurnKey,
  resolveTurnIdentity,
  waitForActiveTurn,
};
