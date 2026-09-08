'use strict';

/**
 * SiraGPT Agent Gateway (OpenClaw-inspired rewrite, no source copied).
 * chat → injected `runner` (executeAgentRunnerTurn / /api/ai/generate)
 * code → injected `codex`  (/api/codex/projects/:id/runs)
 * Do not assume app/api/agents/run is live.
 * sessionKey = serial lane; sessionId = transcript. DeepSeek V4 only.
 */

const crypto = require('crypto');
const {
  METHODS, EVENTS, encodeRes, encodeEvent, decode,
  validateFirstFrame, isKnownMethod, nextSeq,
} = require('./protocol');
const { createSessionQueue } = require('./queue');
const { createEventLog } = require('./event-log');
const { createSessionDlq } = require('./session-dlq');
const { SIDE_EFFECT_METHODS } = require('./protocol');
const { createIdempotencyStore, isSideEffectMethod } = require('../agent-runner/engine-advance');

const SURFACES = Object.freeze(['chat', 'code']);
const ALLOWED_MODELS = Object.freeze({
  'deepseek-v4-flash': 'deepseek-v4-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
});

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function resolveModel(model, env = process.env) {
  assertNativeGatewayGenerate(model, env);
  const raw = String(model || env.SIRAGPT_GATEWAY_MODEL || 'deepseek-v4-flash').trim();
  if (/openrouter/i.test(raw)) throw fail('OpenRouter no está permitido. Usa DeepSeek nativo (V4 Flash o V4 Pro).', 'model_forbidden');
  const key = raw.toLowerCase();
  if (ALLOWED_MODELS[key]) return ALLOWED_MODELS[key];
  if (key.includes('pro')) return 'deepseek-v4-pro';
  if (key.includes('flash') || key.includes('v4')) return 'deepseek-v4-flash';
  throw fail(`Modelo no soportado: ${raw}. Solo DeepSeek V4 Flash o V4 Pro.`, 'model_unsupported');
}

function asRunner(obj) {
  if (!obj) return null;
  if (typeof obj.run === 'function') return obj;
  if (typeof obj === 'function') return { run: obj };
  return null;
}

function pickAdapter(surface, runner, codex) {
  if (surface === 'code') return asRunner(codex) || asRunner(runner);
  return asRunner(runner);
}

function createGateway({
  runner = null, codex = null, skills = null, memory = null, cron = null, env = process.env,
} = {}) {
  const queue = createSessionQueue();
  const eventLog = createEventLog();
  const sessionDlq = createSessionDlq();
  const idempotency = createIdempotencyStore();
  const subscribers = new Map();
  const runs = new Map();
  const sessions = new Map();
  const mem = memory || { search: async () => [], persistEpisode: async (ep) => ep };
  const sk = skills || { list: async () => [], load: async (n) => ({ name: n, loaded: false }) };
  const jobs = [];

  function emitTo(sessionKey, frame) {
    try { eventLog.remember(sessionKey, frame); } catch (_) { /* ring is best-effort */ }
    const set = subscribers.get(String(sessionKey || ''));
    if (!set) return;
    for (const fn of set) { try { fn(frame); } catch (_) { /* isolate */ } }
  }

  const cronSvc = cron || {
    // 3H15 leftover: default stub never lists/creates unscoped jobs.
    list: async (userId) => {
      const uid = String(userId || '').trim();
      if (!uid) return [];
      return jobs.filter((j) => String(j.userId || '') === uid);
    },
    create: async (spec) => {
      const uid = String(spec && spec.userId || '').trim();
      if (!uid) return { ok: false, error: 'user_required', code: 'user_required' };
      const job = {
        id: newId('cron'), name: spec.name || 'aprendizaje',
        schedule: spec.schedule || '0 * * * *', prompt: spec.prompt || '',
        sessionKey: spec.sessionKey || null, createdAt: new Date().toISOString(),
        userId: uid,
      };
      jobs.push(job);
      emitTo(job.sessionKey, encodeEvent(EVENTS.CRON, { phase: 'created', job }, nextSeq()));
      return job;
    },
  };

  function subscribe(sessionKey, emitFn) {
    const key = String(sessionKey || '');
    if (!key || typeof emitFn !== 'function') throw new Error('subscribe requiere sessionKey y emitFn');
    if (!subscribers.has(key)) subscribers.set(key, new Set());
    subscribers.get(key).add(emitFn);
    return () => {
      const set = subscribers.get(key);
      if (!set) return;
      set.delete(emitFn);
      if (set.size === 0) subscribers.delete(key);
    };
  }

  function startAgent({ sessionKey, sessionId, surface, userId, message, model, idempotencyKey } = {}) {
    const key = String(sessionKey || '').trim();
    if (!key) throw fail('sessionKey es obligatorio', 'bad_request');
    if (surface !== 'chat' && surface !== 'code') throw fail('surface debe ser "chat" o "code"', 'bad_request');
    // 3H14 leftover: HTTP generate already requires user; startAgent also fail-closed on empty/oversized prompt.
    // 3H15 leftover: never unscoped generate — startAgent requires userId.
    if (!String(userId || '').trim()) throw fail('user_required', 'user_required');
    const prompt = String(message || '').trim();
    if (!prompt) throw fail('empty_prompt', 'empty_prompt');
    if (prompt.length > 8000) throw fail('prompt_too_long', 'prompt_too_long');
    const idem = String(idempotencyKey || '').trim();
    if (idem) {
      if (idem.length > 256) throw fail('idempotency_conflict', 'idempotency_conflict');
      try {
        const { claimTurnIdentityUnique } = require('../chat-turn-idempotency');
        const claimed = claimTurnIdentityUnique(`gw:${String(userId || '')}:${key}:${idem}`);
        if (!claimed.ok) throw fail('duplicate_turn', 'duplicate_turn');
      } catch (err) {
        if (err && err.code) throw err;
        throw fail('duplicate_turn', 'duplicate_turn');
      }
    }
    const resolvedModel = resolveModel(model, env);
    const runId = newId('run');
    const acceptedAt = new Date().toISOString();
    const sid = sessionId || (sessions.get(key) && sessions.get(key).sessionId) || newId('sess');
    sessions.set(key, { sessionId: sid, surface, lastRunId: runId, userId: userId || null });
    queue.claimWriter(key, runId);
    const ac = new AbortController();
    const record = {
      runId, sessionKey: key, sessionId: sid, surface,
      userId: userId || null, message: prompt,
      model: resolvedModel, acceptedAt, status: 'queued', result: null, superseded: false,
      abortController: ac,
    };
    runs.set(runId, record);
    record.done = queue.enqueue(key, () => executeTurn(record));
    return { runId, acceptedAt, sessionKey: key, sessionId: sid, surface };
  }

  function abortSession(sessionKey, reason, actorUserId) {
    const key = String(sessionKey || '').trim();
    if (!key) throw fail('sessionKey es obligatorio', 'bad_request');
    const sess = sessions.get(key);
    const owner = sess && sess.userId ? String(sess.userId) : '';
    const actorProvided = actorUserId !== undefined && actorUserId !== null;
    const actor = actorProvided ? String(actorUserId).trim() : '';
    // 3H5 leftover: HTTP abort passes actorUserId. Internal abortSession(key, reason) stays compatible.
    if (actorProvided) {
      if (owner && actor && owner !== actor) throw fail('forbidden', 'forbidden');
      if (owner && !actor) throw fail('forbidden', 'forbidden');
    }
    const out = queue.abortSession(key, reason || 'user_abort');
    const rec = runs.get(out.runId);
    if (rec) {
      rec.status = 'aborted';
      rec.aborted = true;
      // 3H9 leftover: abort must propagate to the in-flight adapter turn.
      try { rec.abortController && rec.abortController.abort(); } catch (_) {}
      try { sessionDlq.push({ sessionKey: key, runId: rec.runId, surface: rec.surface, userId: rec.userId, error: 'user_abort' }); } catch (_) {} // 3H10 leftover abort DLQ
    }
    emitTo(key, encodeEvent(EVENTS.LIFECYCLE, {
      phase: 'abort', sessionKey: key, runId: out.runId, reason: out.reason, surface: rec && rec.surface,
    }));
    return out;
  }

  async function executeTurn(record) {
    const { runId, sessionKey: key, surface } = record;
    record.status = 'running';
    emitTo(key, encodeEvent(EVENTS.LIFECYCLE, {
      phase: 'start', runId, sessionKey: key, sessionId: record.sessionId, surface,
    }));
    const onEvent = (ev) => {
      if (!ev) return;
      if (ev.type === 'tool' || ev.type === 'tool_call' || ev.type === 'tool_result') {
        emitTo(key, encodeEvent(EVENTS.TOOL, { runId, surface, ...ev }));
      }
    };
    const timeoutMs = Number.parseInt(String(env.SIRAGPT_GATEWAY_TURN_TIMEOUT_MS || '180000'), 10) || 180000;
    const ac = record.abortController || new AbortController();
    record.abortController = ac;
    let timeoutFired = false;
    const timer = setTimeout(() => {
      timeoutFired = true;
      try { ac.abort(); } catch (_) {}
    }, timeoutMs);
    try {
      const adapter = pickAdapter(surface, runner, codex);
      const runPromise = adapter
        ? Promise.resolve(adapter.run({
          runId, sessionKey: key, sessionId: record.sessionId, surface,
          userId: record.userId, message: record.message, model: record.model, onEvent,
          signal: ac.signal, timeoutMs,
        }))
        : Promise.resolve({ ok: true, text: 'Turno registrado (stub).', stub: true, surface });
      const abortPromise = new Promise((resolve) => {
        const finish = () => resolve({ __gatewayAborted: true, timeout: timeoutFired });
        if (ac.signal.aborted) { finish(); return; }
        ac.signal.addEventListener('abort', finish, { once: true });
      });
      const raced = await Promise.race([runPromise, abortPromise]);
      if (raced && raced.__gatewayAborted) {
        const isTimeout = timeoutFired;
        record.status = isTimeout ? 'error' : 'aborted';
        record.aborted = !isTimeout;
        record.error = isTimeout ? 'turn_timeout' : 'aborted';
        try { sessionDlq.push({ sessionKey: key, runId, surface, userId: record.userId, error: record.error }); } catch (_) {}
        emitTo(key, encodeEvent(EVENTS.LIFECYCLE, { phase: isTimeout ? 'error' : 'abort', runId, surface, message: record.error }));
        emitTo(key, encodeEvent(EVENTS.LIFECYCLE, { phase: 'end', runId, surface, ok: false }));
        return { ok: false, aborted: !isTimeout, timeout: isTimeout, surface };
      }
      const result = raced;
      if (timeoutFired) {
        record.status = 'error';
        record.error = 'turn_timeout';
        try { sessionDlq.push({ sessionKey: key, runId, surface, userId: record.userId, error: 'turn_timeout' }); } catch (_) {}
        emitTo(key, encodeEvent(EVENTS.LIFECYCLE, { phase: 'error', runId, surface, message: 'turn_timeout', code: 'timeout' }));
        emitTo(key, encodeEvent(EVENTS.LIFECYCLE, { phase: 'end', runId, surface, ok: false, timeout: true }));
        return { ok: false, timeout: true, surface };
      }
      if (ac.signal.aborted || queue.isAborted(key, runId)) {
        record.status = 'aborted';
        record.aborted = true;
        emitTo(key, encodeEvent(EVENTS.LIFECYCLE, { phase: 'abort', runId, surface, reason: 'session_aborted' }));
        return { ok: false, aborted: true, surface };
      }
      const text = String((result && (result.text || result.finalText || result.summary)) || 'Listo.');
      emitTo(key, encodeEvent(EVENTS.ASSISTANT, { runId, text, surface }));
      if (!queue.canCommit(key, runId)) {
        record.superseded = true;
        record.status = 'superseded';
        record.code = 'turn_superseded';
        emitTo(key, encodeEvent(EVENTS.LIFECYCLE, { phase: 'end', runId, surface, superseded: true, code: 'turn_superseded' }));
        return { ...result, superseded: true, code: 'turn_superseded' };
      }
      if (typeof mem.persistEpisode === 'function' && record.userId) {
        await mem.persistEpisode({
          userId: record.userId,
          sessionKey: key,
          sessionId: record.sessionId,
          chatId: record.sessionId || key,
          runId, surface, text, at: new Date().toISOString(),
        });
      }
      record.result = result || { text, surface };
      record.status = 'done';
      emitTo(key, encodeEvent(EVENTS.LIFECYCLE, { phase: 'end', runId, ok: true, surface }));
      queue.releaseWriter(key, runId);
      return record.result;
    } catch (err) {
      if (ac.signal.aborted || timeoutFired) {
        record.status = timeoutFired ? 'error' : 'aborted';
        record.aborted = !timeoutFired;
        record.error = timeoutFired ? 'turn_timeout' : 'aborted';
        try { sessionDlq.push({ sessionKey: key, runId, surface, userId: record.userId, error: record.error }); } catch (_) {}
        emitTo(key, encodeEvent(EVENTS.LIFECYCLE, { phase: timeoutFired ? 'error' : 'abort', runId, surface, message: record.error }));
        emitTo(key, encodeEvent(EVENTS.LIFECYCLE, { phase: 'end', runId, surface, ok: false }));
        return { ok: false, aborted: !timeoutFired, timeout: timeoutFired, surface };
      }
      record.status = 'error';
      record.error = err && err.message ? err.message : String(err);
      try { sessionDlq.push({ sessionKey: key, runId, surface, userId: record.userId, error: record.error }); } catch (_) {}
      emitTo(key, encodeEvent(EVENTS.LIFECYCLE, { phase: 'error', runId, surface, message: record.error }));
      emitTo(key, encodeEvent(EVENTS.LIFECYCLE, { phase: 'end', runId, surface, ok: false }));
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function getSession(sessionKey) {
    return sessions.get(String(sessionKey || '')) || null;
  }

  async function waitForRun(runId, timeoutMs = 30_000, actorUserId) {
    const rec = runs.get(String(runId));
    if (!rec) throw fail('runId desconocido', 'not_found');
    // 3H10 leftover: wait must not leak another user's in-flight generate.
    const owner = rec.userId ? String(rec.userId) : '';
    const actorProvided = actorUserId !== undefined && actorUserId !== null;
    const actor = actorProvided ? String(actorUserId).trim() : '';
    if (actorProvided) {
      if (owner && actor && owner !== actor) throw fail('forbidden', 'forbidden');
      if (owner && !actor) throw fail('forbidden', 'forbidden');
    }
    if (!rec.done) return rec.result;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail('Tiempo de espera agotado', 'timeout')), timeoutMs);
      if (timer.unref) timer.unref();
    });
    try { return await Promise.race([rec.done, timeout]); } finally { clearTimeout(timer); }
  }

  function status() {
    const bySurface = { chat: 0, code: 0 };
    for (const rec of runs.values()) {
      if (bySurface[rec.surface] != null) bySurface[rec.surface] += 1;
    }
    const dlqSnap = sessionDlq.snapshot();
    const qh = typeof queue.snapshot === 'function' ? queue.snapshot() : { lanes: queue.size() };
    let abortedRuns = 0;
    for (const rec of runs.values()) {
      if (rec && (rec.aborted || rec.status === 'aborted')) abortedRuns += 1;
    }
    return {
      ok: true, surfaces: SURFACES.slice(), models: Object.keys(ALLOWED_MODELS),
      adapters: { runner: Boolean(runner), codex: Boolean(codex) },
      sessions: sessions.size, runs: runs.size, bySurface, lanes: queue.size(),
      queueHonesty: { lanes: qh.lanes || 0, writers: qh.writers || 0, aborted: qh.aborted || 0, abortedRuns, pending: qh.pending || 0, maxPending: qh.maxPending || 8, order: qh.order || 'fifo' },
      scoped: { memory: true, skills: true, cron: true },
      protocolIdempotency: true,
      idempotencySize: idempotency.size(),
      deadLetterCount: dlqSnap.deadLetterCount,
      retryableDeadLetterCount: (typeof sessionDlq.retryable === 'function' ? sessionDlq.retryable({ limit: 100 }).length : 0),
      // 3H14 leftover: public status never leaks sessionKey/userId (PII-adjacent).
      deadLetter: (Array.isArray(dlqSnap.recent) ? dlqSnap.recent.map((r) => ({
        error: String(r && r.error || 'turn_failed').slice(0, 80),
        at: Number(r && r.at) || 0,
        surface: r && r.surface || null,
      })) : []),
      turnTimeoutMs: Number.parseInt(String(env.SIRAGPT_GATEWAY_TURN_TIMEOUT_MS || '180000'), 10) || 180000,
    };
  }

  async function handleFrame(conn, frame) {
    const c = conn || {};
    let decoded;
    try {
      decoded = (typeof frame === 'string' || (frame && !frame.type)) ? decode(frame) : frame;
    } catch (err) {
      return encodeRes((frame && frame.id) || '?', false, { code: 'bad_frame', message: err.message });
    }
    try {
      if (!c.handshakeDone) validateFirstFrame(c, decoded);
    } catch (err) {
      return encodeRes(decoded.id || '?', false, { code: err.code || 'handshake_required', message: err.message });
    }
    if (decoded.type !== 'req') return encodeRes(decoded.id || '?', false, { code: 'bad_frame', message: 'Se esperaba un frame req' });
    if (!isKnownMethod(decoded.method)) {
      return encodeRes(decoded.id, false, { code: 'unknown_method', message: `Método desconocido: ${decoded.method}` });
    }
    try {
      const params = decoded.params || {};
      const method = decoded.method;
      const key = params && params.idempotencyKey != null ? String(params.idempotencyKey).trim() : '';
      if (key && isSideEffectMethod(method)) {
        const claim = idempotency.claim({ key, method, params });
        if (claim.status === 'replay') return encodeRes(decoded.id, true, claim.response);
        if (!claim.ok && claim.code === 'idempotency_conflict') {
          return encodeRes(decoded.id, false, { code: 'idempotency_conflict', message: claim.error || 'idempotency_conflict' });
        }
        const payload = await dispatch(c, method, params);
        try { idempotency.remember(key, payload); } catch (_) {}
        return encodeRes(decoded.id, true, payload);
      }
      return encodeRes(decoded.id, true, await dispatch(c, method, params));
    } catch (err) {
      return encodeRes(decoded.id, false, { code: err.code || 'error', message: err.message || String(err) });
    }
  }

  async function dispatch(conn, method, params) {
    if (method === METHODS.CONNECT) {
      const sessionKey = String(params.sessionKey || conn.sessionKey || newId('lane'));
      conn.sessionKey = sessionKey;
      conn.handshakeDone = true;
      if (params.sessionId) conn.sessionId = params.sessionId;
      // 3H5 leftover: stamp userId from connection (HTTP actor), never from a spoofable later frame.
      if (params.userId) conn.userId = String(params.userId);
      else if (conn.userId) conn.userId = String(conn.userId);
      emitTo(sessionKey, encodeEvent(EVENTS.PRESENCE, { phase: 'online', sessionKey }));
      return { sessionKey, sessionId: conn.sessionId || null, protocol: 1, surfaces: SURFACES.slice() };
    }
    if (method === METHODS.AGENT) {
      return startAgent({
        sessionKey: params.sessionKey || conn.sessionKey,
        sessionId: params.sessionId || conn.sessionId,
        surface: params.surface, userId: conn.userId || params.userId,
        message: params.message, model: params.model,
        idempotencyKey: params.idempotencyKey,
      });
    }
    if (method === METHODS.AGENT_WAIT) return waitForRun(params.runId, params.timeoutMs, conn.userId || params.userId);
    if (method === METHODS.STATUS) return status();
    if (method === METHODS.SKILLS_LIST) {
      const userId = params.userId || conn.userId || null;
      if (!userId) return { skills: [], error: 'user_required' };
      return { skills: await (sk.list ? sk.list(userId) : []) };
    }
    if (method === METHODS.SKILLS_LOAD) {
      const loader = sk.load_skill || sk.load;
      const userId = params.userId || conn.userId || null;
      if (!userId) return { name: params.name, loaded: false, error: 'user_required' };
      return loader ? loader(params.name, userId) : { name: params.name, loaded: false };
    }
    if (method === METHODS.SKILLS_DELETE) {
      const userId = params.userId || conn.userId || null;
      if (!userId) return { deleted: false, error: 'user_required' };
      if (typeof sk.delete === 'function') return sk.delete(params.name, userId);
      return { deleted: false, error: 'delete_unavailable' };
    }
    if (method === METHODS.AGENT_ABORT) {
      return abortSession(params.sessionKey || conn.sessionKey, params.reason, params.userId || conn.userId);
    }
    if (method === METHODS.MEMORY_SEARCH) {
      const q = String(params.q || params.query || '').slice(0, 200);
      const userId = params.userId || conn.userId || null;
      if (!userId) return { hits: [], error: 'user_required' };
      try {
        if (mem.search) return { hits: await mem.search(q, userId) };
        if (mem.recallForTurn) return mem.recallForTurn({ query: q, userId });
        return { hits: [] };
      } catch (err) {
        return { hits: [], omitted: true, error: 'memory_search_failed' };
      }
    }
    if (method === METHODS.CRON_LIST) {
      const userId = params.userId || conn.userId || null;
      if (!userId) return { jobs: [], error: 'user_required' };
      const listed = typeof cronSvc.list === 'function' ? await cronSvc.list(userId) : [];
      return { jobs: listed };
    }
    if (method === METHODS.CRON_CREATE) {
      const userId = params.userId || conn.userId || null;
      if (!userId) return { ok: false, error: 'user_required', code: 'user_required' };
      const prompt = String(params.prompt || params.message || '').trim();
      if (!prompt) return { ok: false, error: 'empty_prompt', code: 'empty_prompt' };
      if (prompt.length > 8000) return { ok: false, error: 'prompt_too_long', code: 'prompt_too_long' };
      const jobId = params.id || params.jobId || null;
      if (jobId && String(jobId).length > 128) return { ok: false, error: 'cron_job_id_too_long', code: 'cron_job_id_too_long' };
      return cronSvc.create({ ...params, userId, prompt });
    }
    if (method === METHODS.CRON_DELETE) {
      const userId = params.userId || conn.userId || null;
      if (!userId) return { deleted: false, error: 'user_required' };
      if (typeof cronSvc.delete === 'function') return cronSvc.delete(params.id, userId);
      return { deleted: false, error: 'delete_unavailable' };
    }
    if (method === METHODS.SKILLS_PERSIST) {
      const userId = params.userId || conn.userId || null;
      if (!userId) return { persisted: false, error: 'user_required' };
      const skillName = String(params.name || '').trim();
      if (!skillName) return { persisted: false, error: 'invalid_skill_name', code: 'invalid_skill_name' };
      if (String(params.body || '').length > 16000) return { persisted: false, error: 'payload_too_long', code: 'payload_too_long' };
      if (typeof sk.persist === 'function') return sk.persist(params.name, userId, params.body, params.description);
      return { persisted: false, error: 'persist_unavailable' };
    }
    if (method === METHODS.MEMORY_PERSIST) {
      const userId = params.userId || conn.userId || null;
      if (!userId) return { indexed: 0, error: 'user_required' };
      const text = String(params.text || params.q || '').trim();
      if (!text) return { indexed: 0, error: 'empty_text', code: 'empty_text' };
      if (text.length > 4000) return { indexed: 0, error: 'payload_too_long', code: 'payload_too_long' };
      if (typeof mem.persistEpisode === 'function') return mem.persistEpisode({ userId, chatId: params.chatId, text });
      return { indexed: 0, error: 'persist_unavailable' };
    }
    if (method === METHODS.MEMORY_DELETE) {
      const userId = params.userId || conn.userId || null;
      if (!userId) return { deleted: 0, error: 'user_required' };
      if (typeof mem.delete === 'function') return mem.delete(userId, params.chatId);
      return { deleted: 0, error: 'delete_unavailable' };
    }
    throw fail(`Método desconocido: ${method}`, 'unknown_method');
  }

  return { handleFrame, startAgent, abortSession, subscribe, status, waitForRun, getSession, queue, eventLog, sessionDlq, SURFACES };
}

module.exports = { createGateway, resolveModel, pickAdapter, SURFACES, ALLOWED_MODELS };


/** OLA200_WAVE_G BE-018 — generate only native DeepSeek; reject OpenRouter leftovers. */
function assertNativeGatewayGenerate(model, env = process.env) {
  const raw = String(model || env.SIRAGPT_GATEWAY_MODEL || "");
  if (/openrouter|openai\.com|generativelanguage|gpt-4o|claude/i.test(raw)) {
    throw fail("OpenRouter/OpenAI/Gemini leftovers are forbidden on generate. Use DeepSeek V4 Flash or Pro.", "model_forbidden");
  }
  return true;
}
module.exports.assertNativeGatewayGenerate = assertNativeGatewayGenerate;


/** 3H-BE-009 — replay gateway events after Last-Event-ID. */
function gatewayReplayFrom(gateway, sessionKey, lastId) {
  if (!gateway || !gateway.eventLog || typeof gateway.eventLog.replayFrom !== 'function') return [];
  return gateway.eventLog.replayFrom(sessionKey, lastId);
}
module.exports.gatewayReplayFrom = gatewayReplayFrom;
