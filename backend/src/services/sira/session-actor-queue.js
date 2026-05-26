"use strict";

/**
 * Session actor queue for Sira chat turns.
 *
 * Mutable session operations are serialized behind a keyed actor queue so
 * concurrent events for the same session cannot race. Sira uses this contract
 * at the chat-controller boundary: one conversation/user pair is one
 * actor. Different conversations can still run concurrently.
 */

function createSessionActorQueue() {
  const tails = new Map();
  const pendingByActor = new Map();
  const runningByActor = new Map();
  let sequence = 0;

  return {
    run(actorKey, operation) {
      const key = normalizeActorKey(actorKey);
      if (typeof operation !== "function") {
        throw new Error("session-actor-queue: operation function required");
      }

      const previousTail = tails.get(key) || Promise.resolve();
      const jobId = `${key}#${++sequence}`;
      increment(pendingByActor, key);

      const runPromise = previousTail
        .catch(() => {
          // A rejected earlier job must not poison later jobs for the actor.
        })
        .then(async () => {
          increment(runningByActor, key);
          try {
            return await operation({ actorKey: key, jobId });
          } finally {
            decrement(runningByActor, key);
          }
        });

      const nextTail = runPromise
        .catch(() => {
          // The caller still receives the original rejection via runPromise.
        })
        .finally(() => {
          decrement(pendingByActor, key);
          if (tails.get(key) === nextTail) {
            tails.delete(key);
          }
        });

      tails.set(key, nextTail);
      return runPromise;
    },
    getPendingCountForActor(actorKey) {
      return pendingByActor.get(normalizeActorKey(actorKey)) || 0;
    },
    getRunningCountForActor(actorKey) {
      return runningByActor.get(normalizeActorKey(actorKey)) || 0;
    },
    getTotalPendingCount() {
      return sumMapValues(pendingByActor);
    },
    snapshot() {
      return {
        active_actors: tails.size,
        total_pending: sumMapValues(pendingByActor),
        pending_by_actor: Object.fromEntries(pendingByActor.entries()),
        running_by_actor: Object.fromEntries(runningByActor.entries()),
      };
    },
    _getTailMapForTesting() {
      return tails;
    },
  };
}

function buildChatTurnActorKey({ userId, conversationId } = {}) {
  return [
    "sira-chat",
    normalizeKeyPart(userId || "anonymous"),
    normalizeKeyPart(conversationId || "unknown-conversation"),
  ].join(":");
}

function normalizeActorKey(value) {
  const key = String(value || "").trim();
  return key || "sira-chat:anonymous:unknown-conversation";
}

function normalizeKeyPart(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function decrement(map, key) {
  const next = (map.get(key) || 1) - 1;
  if (next <= 0) {
    map.delete(key);
  } else {
    map.set(key, next);
  }
}

function sumMapValues(map) {
  let total = 0;
  for (const value of map.values()) {
    total += value;
  }
  return total;
}

module.exports = {
  createSessionActorQueue,
  buildChatTurnActorKey,
  INTERNAL: {
    normalizeActorKey,
    normalizeKeyPart,
  },
};
