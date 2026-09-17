'use strict';

/**
 * Durable (Prisma) + in-memory preference store.
 *
 * Prisma is attached from the process boot path (`attachPrisma`). Tests
 * and any load that never calls attachPrisma stay purely in-memory so
 * requiring this module cannot boot a database client.
 */

const {
  encodeF32,
  decodeF32,
  toFloat32,
  cosine,
  hashPrompt,
  newId,
  clampText,
} = require('./vectors');
const {
  NOTES_MAX,
  normalizeReasonCode,
  normalizeNotes,
  resolveFeedbackReasons,
} = require('./reason-codes');

const MAX_ENTRIES_PER_USER = 2000;
const PROMPT_MAX = 8000;
const RESPONSE_MAX = 16000;

/** @type {Map<string, object[]>} userId → events (newest last) */
const memory = new Map();
const hydrated = new Set();

let prismaClient = null;
let persistWarned = false;

function isCollectionEnabled(env = process.env) {
  const v = env.SIRAGPT_RLHF_ENABLED;
  if (v == null || String(v).trim() === '') return true;
  const s = String(v).trim().toLowerCase();
  return s !== '0' && s !== 'false' && s !== 'off' && s !== 'no';
}

function attachPrisma(client) {
  prismaClient = client || null;
}

function getPrisma() {
  return prismaClient;
}

function hasPrismaModel() {
  return !!(prismaClient && typeof prismaClient.preferenceEvent?.create === 'function');
}

function normalizeLabel(label, helpful) {
  if (typeof helpful === 'boolean') return helpful ? 'chosen' : 'rejected';
  const s = String(label || '').toLowerCase().trim();
  if (s === 'liked' || s === 'chosen' || s === 'up' || s === 'win') return 'chosen';
  if (s === 'disliked' || s === 'rejected' || s === 'down' || s === 'lose') return 'rejected';
  if (s === 'unlabeled' || s === 'candidate' || s === '') return 'unlabeled';
  return s;
}

function normalizeSource(source) {
  const s = String(source || 'explicit').toLowerCase().trim();
  if (['explicit', 'regenerate', 'edit', 'rlaif', 'pairwise'].includes(s)) return s;
  return 'explicit';
}

function listMemory(userId) {
  return memory.get(userId) || [];
}

function putMemory(event) {
  let list = memory.get(event.userId);
  if (!list) {
    list = [];
    memory.set(event.userId, list);
  }
  const key = event.runId || event.messageId || event.id;
  const idx = list.findIndex((e) => (e.runId || e.messageId || e.id) === key && key);
  if (idx >= 0) list[idx] = event;
  else list.push(event);
  if (list.length > MAX_ENTRIES_PER_USER) {
    list.splice(0, list.length - MAX_ENTRIES_PER_USER);
  }
  return event;
}

function toPublic(event) {
  return { ...event };
}

/**
 * Merge judgeScore objects so RLAIF HHH scores and RLCD calibration
 * can coexist on the same preference row. Incoming keys win; nested
 * `rlcd` is shallow-merged.
 */
function mergeJudgeScore(incoming, existing) {
  if (incoming == null) return existing || null;
  if (existing == null) return incoming;
  if (typeof incoming !== 'object' || typeof existing !== 'object') return incoming;
  const merged = { ...existing, ...incoming };
  if (existing.rlcd || incoming.rlcd) {
    const prev = existing.rlcd && typeof existing.rlcd === 'object' ? existing.rlcd : {};
    const next = incoming.rlcd && typeof incoming.rlcd === 'object' ? incoming.rlcd : {};
    merged.rlcd = { ...prev, ...next };
  }
  return merged;
}

function fromPrismaRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    chatId: row.chatId || null,
    messageId: row.messageId || null,
    promptMessageId: row.promptMessageId || null,
    pairId: row.pairId || null,
    runId: row.runId || row.messageId || row.id,
    agent: row.agent || null,
    source: row.source,
    label: row.label,
    promptText: row.promptText,
    responseText: row.responseText,
    promptHash: row.promptHash,
    promptEmbedding: decodeF32(row.promptEmbedding),
    responseEmbedding: decodeF32(row.responseEmbedding),
    judgeScore: row.judgeScore || null,
    reasonCode: row.reasonCode || null,
    notes: row.notes || null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : Date.now(),
    helpful: row.label === 'chosen',
    request: row.promptText,
    response: row.responseText,
    embedding: decodeF32(row.promptEmbedding),
  };
}

async function persistEvent(event) {
  if (!hasPrismaModel()) return;
  try {
    const data = {
      id: event.id,
      userId: event.userId,
      chatId: event.chatId || null,
      messageId: event.messageId || null,
      promptMessageId: event.promptMessageId || null,
      pairId: event.pairId || null,
      runId: event.runId || null,
      agent: event.agent || null,
      source: event.source,
      label: event.label,
      promptText: event.promptText,
      responseText: event.responseText,
      promptHash: event.promptHash,
      promptEmbedding: event.promptEmbedding ? encodeF32(event.promptEmbedding) : null,
      responseEmbedding: event.responseEmbedding ? encodeF32(event.responseEmbedding) : null,
      judgeScore: event.judgeScore || null,
      reasonCode: event.reasonCode || null,
      notes: event.notes || null,
    };
    await prismaClient.preferenceEvent.upsert({
      where: { id: event.id },
      create: data,
      update: {
        label: data.label,
        pairId: data.pairId,
        reasonCode: data.reasonCode,
        notes: data.notes,
        judgeScore: data.judgeScore,
        promptEmbedding: data.promptEmbedding,
        responseEmbedding: data.responseEmbedding,
        responseText: data.responseText,
        source: data.source,
      },
    });
  } catch (err) {
    if (!persistWarned) {
      persistWarned = true;
      console.warn('[rlhf] preference persist failed (continuing in-memory):', err.message || err);
    }
  }
}

async function hydrateUser(userId) {
  if (!userId || hydrated.has(userId) || !hasPrismaModel()) return listMemory(userId);
  hydrated.add(userId);
  try {
    const rows = await prismaClient.preferenceEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      take: MAX_ENTRIES_PER_USER,
    });
    for (const row of rows) putMemory(fromPrismaRow(row));
  } catch (err) {
    hydrated.delete(userId);
    console.warn('[rlhf] hydrate failed:', err.message || err);
  }
  return listMemory(userId);
}

/**
 * Load the newest preference rows across users into the in-memory store.
 * Fail-open: a missing Prisma model or query error returns [].
 */
/**
 * Load preference rows for an SFT/DPO prep job. Scoped to one user when
 * `userId` is set; otherwise the newest `limit` rows across users.
 * Additive helper — does not change hydrateRecent's 1000-row cap.
 */
async function hydrateForExport({ userId = null, limit = 10_000 } = {}) {
  if (userId) return hydrateUser(userId);
  if (!hasPrismaModel()) return [...memory.values()].flat();
  const take = Math.max(1, Math.min(50_000, Number(limit) || 10_000));
  try {
    const rows = await prismaClient.preferenceEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take,
    });
    const events = [];
    for (const row of rows.reverse()) {
      const event = fromPrismaRow(row);
      if (!event || !event.userId) continue;
      putMemory(event);
      hydrated.add(event.userId);
      events.push(event);
    }
    return events;
  } catch (err) {
    console.warn('[rlhf] hydrateForExport failed:', err.message || err);
    return [...memory.values()].flat();
  }
}

async function hydrateRecent({ limit = 200 } = {}) {
  if (!hasPrismaModel()) return [];
  const take = Math.max(1, Math.min(1000, Number(limit) || 200));
  try {
    const rows = await prismaClient.preferenceEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take,
    });
    const events = [];
    for (const row of rows.reverse()) {
      const event = fromPrismaRow(row);
      if (!event || !event.userId) continue;
      putMemory(event);
      hydrated.add(event.userId);
      events.push(event);
    }
    return events;
  } catch (err) {
    console.warn('[rlhf] hydrateRecent failed:', err.message || err);
    return [];
  }
}

function linkPairs(userId, promptHash) {
  const list = listMemory(userId).filter((e) => e.promptHash === promptHash);
  const chosen = list.filter((e) => e.label === 'chosen' && !e.pairId);
  const rejected = list.filter((e) => e.label === 'rejected' && !e.pairId);
  const n = Math.min(chosen.length, rejected.length);
  for (let i = 0; i < n; i++) {
    const pairId = newId();
    chosen[i].pairId = pairId;
    rejected[i].pairId = pairId;
  }
  return n;
}

async function embedBoth({ promptText, responseText, embedder, promptEmbedding, responseEmbedding }) {
  let p = toFloat32(promptEmbedding);
  let r = toFloat32(responseEmbedding);
  if (typeof embedder !== 'function') return { promptEmbedding: p, responseEmbedding: r };
  const needP = !p;
  const needR = !r;
  if (!needP && !needR) return { promptEmbedding: p, responseEmbedding: r };
  try {
    const texts = [];
    if (needP) texts.push(String(promptText || '').slice(0, 4000));
    if (needR) texts.push(String(responseText || '').slice(0, 4000));
    const vecs = await embedder(texts);
    let k = 0;
    if (needP) p = toFloat32(vecs?.[k++]);
    if (needR) r = toFloat32(vecs?.[k++]);
  } catch (err) {
    console.warn('[rlhf] embed failed:', err.message || err);
  }
  return { promptEmbedding: p, responseEmbedding: r };
}

/**
 * Record a preference event. Idempotent on (userId, runId|messageId).
 */
async function recordEvent(args = {}) {
  const userId = args.userId;
  if (!userId) throw new Error('rlhf.recordEvent: userId required');
  if (!isCollectionEnabled()) {
    return { stored: false, reason: 'disabled' };
  }

  const label = normalizeLabel(args.label, args.helpful);
  const source = normalizeSource(args.source);
  const runId = args.runId || args.messageId || newId();
  const promptText = clampText(args.promptText ?? args.request ?? '', PROMPT_MAX);
  const responseText = clampText(args.responseText ?? args.response ?? '', RESPONSE_MAX);
  const promptHash = args.promptHash || hashPrompt(promptText);

  const existing = listMemory(userId).find((e) => (e.runId || e.messageId) === runId);
  const id = existing?.id || args.id || newId();

  const embs = await embedBoth({
    promptText,
    responseText,
    embedder: args.embedder,
    promptEmbedding: args.promptEmbedding || args.embedding || existing?.promptEmbedding,
    responseEmbedding: args.responseEmbedding || existing?.responseEmbedding,
  });

  const event = {
    id,
    userId,
    chatId: args.chatId || existing?.chatId || null,
    messageId: args.messageId || existing?.messageId || null,
    promptMessageId: args.promptMessageId || existing?.promptMessageId || null,
    pairId: args.pairId || existing?.pairId || null,
    runId,
    agent: args.agent || existing?.agent || null,
    source,
    label,
    promptText,
    responseText,
    promptHash,
    promptEmbedding: embs.promptEmbedding,
    responseEmbedding: embs.responseEmbedding,
    judgeScore: mergeJudgeScore(args.judgeScore, existing?.judgeScore),
    reasonCode: normalizeReasonCode(args.reasonCode) || existing?.reasonCode || null,
    notes: args.notes != null
      ? normalizeNotes(args.notes)
      : (existing?.notes || null),
    createdAt: existing?.createdAt || Date.now(),
    helpful: label === 'chosen',
    request: promptText,
    response: responseText,
    embedding: embs.promptEmbedding,
  };

  putMemory(event);
  const paired = linkPairs(userId, promptHash);
  await persistEvent(event);
  if (paired > 0) {
    const list = listMemory(userId).filter((e) => e.promptHash === promptHash && e.pairId);
    await Promise.all(list.map((e) => persistEvent(e)));
  }

  maybeScheduleTrain();

  try {
    require('./metrics').recordIngest({
      source: event.source,
      label: event.label,
      agent: event.agent,
    });
  } catch {
    /* telemetry is optional */
  }

  return { stored: true, total: listMemory(userId).length, event: toPublic(event), paired };
}

function maybeScheduleTrain() {
  const v = process.env.SIRAGPT_RLHF_AUTO_TRAIN;
  if (v != null) {
    const s = String(v).trim().toLowerCase();
    if (s === '0' || s === 'false' || s === 'off') return;
  }
  try {
    // In-process Bradley-Terry RM only. Never enqueue SIRAGPT_RLHF_TRAIN_JOBS
    // or an external fine-tune — AUTO_TRAIN must stay a no-cost local fit.
    const trainer = require('./trainer');
    if (typeof trainer.maybeRetrain === 'function') trainer.maybeRetrain();
  } catch {
    /* trainer is optional at import time */
  }
}

async function ingestThumb(args) {
  const reasons = resolveFeedbackReasons(args);
  return recordEvent({
    ...args,
    source: args.source || 'explicit',
    helpful: args.helpful,
    promptText: args.request ?? args.promptText,
    responseText: args.response ?? args.responseText,
    messageId: args.messageId || args.runId,
    runId: args.runId,
    reasonCode: reasons.reasonCode,
    notes: reasons.notes,
  });
}

/**
 * Durable A/B pair for one prompt. Always shares a pairId so DPO export
 * can emit the pair even when prompt-hash auto-linking has not run yet.
 * Fail-open: missing texts return { stored: false } without throwing.
 */
async function recordPair(args = {}) {
  const userId = args.userId;
  if (!userId) throw new Error('rlhf.recordPair: userId required');
  if (!isCollectionEnabled()) return { stored: false, reason: 'disabled' };

  const promptText = clampText(args.promptText ?? args.prompt ?? args.request ?? '', PROMPT_MAX);
  const chosenText = clampText(args.chosen ?? args.chosenText ?? '', RESPONSE_MAX);
  const rejectedText = clampText(args.rejected ?? args.rejectedText ?? '', RESPONSE_MAX);
  if (!promptText || !chosenText || !rejectedText) {
    return { stored: false, reason: 'incomplete_pair' };
  }

  const reasons = resolveFeedbackReasons(args);
  const pairId = args.pairId || newId();
  const promptHash = args.promptHash || hashPrompt(promptText);
  const agent = args.agent || 'chat';
  const chatId = args.chatId || null;

  const chosen = await recordEvent({
    userId,
    chatId,
    agent,
    source: args.source || 'pairwise',
    label: 'chosen',
    pairId,
    promptText,
    responseText: chosenText,
    promptHash,
    messageId: args.chosenMessageId || args.chosenMessage?.id || null,
    runId: args.chosenRunId || args.chosenMessageId || null,
    promptMessageId: args.promptMessageId || null,
    reasonCode: reasons.reasonCode,
    notes: reasons.notes,
    embedder: args.embedder,
  });
  const rejected = await recordEvent({
    userId,
    chatId,
    agent,
    source: args.source || 'pairwise',
    label: 'rejected',
    pairId,
    promptText,
    responseText: rejectedText,
    promptHash,
    messageId: args.rejectedMessageId || args.rejectedMessage?.id || null,
    runId: args.rejectedRunId || args.rejectedMessageId || null,
    promptMessageId: args.promptMessageId || null,
    reasonCode: reasons.reasonCode,
    notes: reasons.notes,
    embedder: args.embedder,
  });

  return {
    stored: !!(chosen.stored && rejected.stored),
    pairId,
    chosen: chosen.event && { id: chosen.event.id, pairId: chosen.event.pairId, messageId: chosen.event.messageId },
    rejected: rejected.event && { id: rejected.event.id, pairId: rejected.event.pairId, messageId: rejected.event.messageId },
  };
}

async function ingestRegenerate(args) {
  const userId = args.userId;
  if (!userId) throw new Error('rlhf.ingestRegenerate: userId required');
  if (!isCollectionEnabled()) return { stored: false, reason: 'disabled' };

  await hydrateUser(userId);
  const promptText = clampText(args.promptText ?? args.prompt ?? args.request ?? '', PROMPT_MAX);
  const promptHash = hashPrompt(promptText);
  const list = listMemory(userId)
    .filter((e) => e.promptHash === promptHash && e.messageId !== args.messageId)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const prior = list[list.length - 1] || null;
  let priorUpdated = null;
  const reasons = resolveFeedbackReasons(args);
  if (prior && prior.label !== 'rejected') {
    prior.label = 'rejected';
    prior.helpful = false;
    prior.source = prior.source === 'explicit' ? 'regenerate' : prior.source;
    if (reasons.reasonCode) prior.reasonCode = reasons.reasonCode;
    if (reasons.notes) prior.notes = reasons.notes;
    await persistEvent(prior);
    priorUpdated = prior;
  }

  const created = await recordEvent({
    userId,
    chatId: args.chatId,
    messageId: args.messageId,
    runId: args.runId || args.messageId,
    agent: args.agent || 'chat',
    source: 'regenerate',
    label: 'unlabeled',
    promptText,
    responseText: args.responseText ?? args.response ?? '',
    promptHash,
    reasonCode: reasons.reasonCode,
    notes: reasons.notes,
    embedder: args.embedder,
  });

  return {
    stored: true,
    priorRejected: !!priorUpdated,
    created: created.event,
    prior: priorUpdated
      ? {
        responseText: priorUpdated.responseText || '',
        judgeScore: priorUpdated.judgeScore || null,
        agent: priorUpdated.agent || null,
        messageId: priorUpdated.messageId || null,
      }
      : null,
  };
}

async function findExemplars({ userId, request, embedder, k = 3, onlyHelpful = true, agent }) {
  if (!userId || !request) return [];
  await hydrateUser(userId);
  const list = listMemory(userId);
  if (list.length === 0) return [];
  if (typeof embedder !== 'function') return [];

  let queryVec;
  try {
    const vectors = await embedder([String(request).slice(0, 4000)]);
    queryVec = toFloat32(vectors?.[0]);
  } catch (err) {
    console.warn('[rlhf] query embed failed:', err.message);
    return [];
  }
  if (!queryVec) return [];

  const pool = list
    .filter((e) => e.promptEmbedding || e.embedding)
    .filter((e) => !onlyHelpful || e.label === 'chosen' || e.helpful === true)
    .filter((e) => !agent || e.agent === agent);
  if (pool.length === 0) return [];

  const scored = pool.map((e) => ({
    runId: e.runId,
    agent: e.agent,
    request: e.promptText || e.request,
    response: e.responseText || e.response,
    helpful: e.label === 'chosen' || e.helpful === true,
    notes: e.notes,
    judgeScore: e.judgeScore || null,
    score: cosine(queryVec, e.promptEmbedding || e.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, k));
}

function stats(userId) {
  const list = userId ? listMemory(userId) : [...memory.values()].flat();
  const chosen = list.filter((e) => e.label === 'chosen').length;
  const rejected = list.filter((e) => e.label === 'rejected').length;
  const unlabeled = list.filter((e) => e.label === 'unlabeled').length;
  const pairs = new Set(list.filter((e) => e.pairId).map((e) => e.pairId)).size;
  return {
    total: list.length,
    helpful: chosen,
    unhelpful: rejected,
    chosen,
    rejected,
    unlabeled,
    pairs,
  };
}

function dump(userId) {
  const list = userId ? listMemory(userId) : [...memory.values()].flat();
  return list.map(toPublic);
}

function pairsFor(userId) {
  const list = userId ? listMemory(userId) : [...memory.values()].flat();
  const byPair = new Map();
  for (const e of list) {
    if (!e.pairId) continue;
    let g = byPair.get(e.pairId);
    if (!g) {
      g = { pairId: e.pairId, chosen: null, rejected: null };
      byPair.set(e.pairId, g);
    }
    if (e.label === 'chosen') g.chosen = e;
    if (e.label === 'rejected') g.rejected = e;
  }
  return [...byPair.values()].filter((p) => p.chosen && p.rejected);
}

function labeledPointwise(userId) {
  const list = userId ? listMemory(userId) : [...memory.values()].flat();
  return list.filter((e) => (e.label === 'chosen' || e.label === 'rejected') && (e.promptEmbedding || e.embedding) && e.responseEmbedding);
}

function _reset() {
  memory.clear();
  hydrated.clear();
}

function ingestLocal(entry) {
  if (!entry || !entry.userId) return;
  putMemory({
    id: entry.id || entry.runId || newId(),
    userId: entry.userId,
    chatId: entry.chatId || null,
    messageId: entry.messageId || entry.runId || null,
    promptMessageId: entry.promptMessageId || null,
    pairId: entry.pairId || null,
    runId: entry.runId || entry.messageId || null,
    agent: entry.agent || null,
    source: normalizeSource(entry.source),
    label: normalizeLabel(entry.label, entry.helpful),
    promptText: entry.promptText || entry.request || '',
    responseText: entry.responseText || (typeof entry.response === 'string' ? entry.response : JSON.stringify(entry.response || '')),
    promptHash: entry.promptHash || hashPrompt(entry.promptText || entry.request || ''),
    promptEmbedding: toFloat32(entry.promptEmbedding || entry.embedding),
    responseEmbedding: toFloat32(entry.responseEmbedding),
    judgeScore: entry.judgeScore || null,
    reasonCode: normalizeReasonCode(entry.reasonCode) || null,
    notes: entry.notes || null,
    createdAt: entry.at || entry.createdAt || Date.now(),
    helpful: entry.helpful === true || entry.label === 'chosen',
    request: entry.request || entry.promptText || '',
    response: entry.response,
    embedding: toFloat32(entry.embedding || entry.promptEmbedding),
  });
}

module.exports = {
  isCollectionEnabled,
  attachPrisma,
  getPrisma,
  recordEvent,
  ingestThumb,
  recordPair,
  ingestRegenerate,
  findExemplars,
  hydrateUser,
  hydrateRecent,
  hydrateForExport,
  stats,
  dump,
  pairsFor,
  labeledPointwise,
  ingestLocal,
  mergeJudgeScore,
  _reset,
  MAX_ENTRIES_PER_USER,
  hashPrompt,
  normalizeLabel,
  resolveFeedbackReasons,
};
