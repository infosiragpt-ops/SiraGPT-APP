'use strict';

/**
 * /api/gateway — Express mount for the unified Agent Gateway.
 *
 * VPS (junto a /api/hermes, /api/ai, /api/codex en backend/index.js):
 *
 *   const gatewayRoutes = require('./src/routes/gateway');
 *   app.use('/api/gateway', gatewayRoutes);
 *
 * Rutas relativas al mount:
 *   GET  /            → status
 *   GET  /status      → status
 *   POST /connect     → handshake
 *   POST /agent       → startAgent({ surface, message, sessionKey })
 *   GET  /events?sessionKey= → SSE
 *   GET  /skills
 *   GET  /memory?q=
 *   GET  /cron
 *   POST /cron
 *
 * chat → runner wrapping executeAgentRunnerTurn (no reemplaza /api/ai/generate).
 * code → adaptador de eventos (no reemplaza el loop Codex ni la oficina 3D).
 */

const { createGateway } = require('../services/agent-gateway');
const { createGatewayRouter } = require('../services/agent-gateway/http');

function tryRequire(id) {
  try {
    return require(id);
  } catch {
    return null;
  }
}

function resolveDeepSeekModel(requested, env = process.env) {
  const raw = String(requested || env.SIRAGPT_AGENT_RUNNER_MODEL || env.SIRAGPT_GATEWAY_MODEL || 'deepseek-v4-flash');
  if (/openrouter|openai|gemini|anthropic|gpt-4o/i.test(raw)) {
    const err = new Error('OpenRouter no está permitido. Usa DeepSeek nativo (V4 Flash o V4 Pro).');
    err.code = 'model_forbidden';
    err.statusCode = 400;
    throw err;
  }
  const key = raw.toLowerCase();
  if (key.includes('pro')) return 'deepseek-v4-pro';
  return 'deepseek-v4-flash';
}

function liveMemory() {
  const f8 = tryRequire('../services/agent-runner/memory');
  const searchMod = tryRequire('../services/agent-runner/memory/search');
  const persistMod = tryRequire('../services/memory-search-persist');
  return {
    async search(q, userId) {
      if (persistMod && typeof persistMod.searchUserEpisodes === 'function' && userId) {
        try {
          const local = persistMod.searchUserEpisodes({ userId, query: q });
          if (Array.isArray(local) && local.length) return local;
        } catch (_) { /* fall through */ }
      }
      if (searchMod && typeof searchMod.searchSessions === 'function') {
        const hits = await searchMod.searchSessions({ query: q, userId: userId || null });
        return Array.isArray(hits) ? hits : (hits && hits.hits) || [];
      }
      if (f8 && typeof f8.recallForTurn === 'function') {
        return f8.recallForTurn({ query: q, userId });
      }
      return [];
    },
    async recallForTurn(args) {
      if (f8 && typeof f8.recallForTurn === 'function') return f8.recallForTurn(args);
      return [];
    },
    async delete(userId, chatId) {
      if (persistMod && typeof persistMod.deleteUserEpisodes === 'function' && userId) {
        try { return persistMod.deleteUserEpisodes({ userId, chatId }); } catch (err) {
          return { deleted: 0, error: err && err.code ? err.code : 'memory_delete_failed' };
        }
      }
      return { deleted: 0, error: 'user_required' };
    },
    async persistEpisode(ep) {
      if (persistMod && typeof persistMod.persistEpisode === 'function' && ep && ep.userId) {
        try { return persistMod.persistEpisode({ userId: ep.userId, chatId: ep.chatId || ep.sessionId || ep.sessionKey, text: ep.text }); } catch (_) {}
      }
      if (f8 && typeof f8.persistEpisode === 'function') {
        return f8.persistEpisode({
          userId: ep.userId,
          chatId: ep.sessionId || ep.sessionKey,
          instruction: ep.text || ep.instruction || '',
          summary: ep.text || '',
        });
      }
      if (searchMod && typeof searchMod.indexEpisode === 'function') {
        return searchMod.indexEpisode({
          userId: ep.userId,
          chatId: ep.sessionId || ep.sessionKey,
          text: ep.text,
        });
      }
      return ep;
    },
  };
}

function liveSkills() {
  const f8 = tryRequire('../services/agent-runner/skills');
  const manage = tryRequire('../services/agent-runner/skills/manage');
  const persist = tryRequire('../services/skills-persist');
  return {
    async list(userId) {
      // 3H15 leftover: never list unscoped (no userId → empty, never f8 dump).
      if (!userId) return [];
      if (persist && typeof persist.listPersistedSkills === 'function') {
        try { return persist.listPersistedSkills({ userId }); } catch (_) { /* fall through */ }
      }
      if (f8 && typeof f8.listSkills === 'function') return f8.listSkills();
      if (manage && typeof manage.listSkills === 'function') return manage.listSkills();
      return [];
    },
    async load(name, userId) {
      // 3H15 leftover: never load unscoped.
      if (!userId) return { name, loaded: false, error: 'user_required' };
      if (persist && typeof persist.loadPersistedSkill === 'function') {
        try {
          const hit = persist.loadPersistedSkill({ userId, name });
          if (hit && hit.ok) return hit;
        } catch (_) { /* fall through */ }
      }
      if (f8 && typeof f8.loadSkill === 'function') return f8.loadSkill(name);
      if (manage && typeof manage.loadSkill === 'function') return manage.loadSkill(name);
      return { name, loaded: false };
    },
    async delete(name, userId) {
      if (persist && userId && typeof persist.deletePersistedSkill === 'function') {
        try { return persist.deletePersistedSkill({ userId, name }); } catch (err) {
          return { deleted: false, error: err && err.code ? err.code : 'skill_delete_failed' };
        }
      }
      return { deleted: false, error: 'user_required' };
    },
    async persist(name, userId, body, description) {
      if (persist && userId && typeof persist.persistUserSkill === 'function') {
        try { return persist.persistUserSkill({ userId, name, body, description }); } catch (err) {
          return { persisted: false, error: err && (err.code || err.message) || 'skill_persist_failed' };
        }
      }
      return { persisted: false, error: 'user_required' };
    },
  };
}

function liveCron() {
  const cronMod = tryRequire('../services/agent-cron');
  if (!cronMod) return null;
  const svc = typeof cronMod.createCron === 'function' ? cronMod.createCron() : cronMod;
  return {
    list: async (userId) => {
      if (typeof svc.listJobs === 'function') return svc.listJobs({ userId });
      if (typeof svc.list === 'function') return svc.list({ userId });
      return [];
    },
    create: async (spec) => {
      if (typeof svc.createJob === 'function') return svc.createJob(spec);
      if (typeof svc.create === 'function') return svc.create(spec);
      if (typeof svc.createCron === 'function') return svc.createCron(spec);
      return spec;
    },
    delete: async (id, userId) => {
      if (typeof svc.deleteJob === 'function') return svc.deleteJob({ id, userId });
      return { deleted: false, error: 'delete_unavailable' };
    },
  };
}

/**
 * chat adapter: wraps executeAgentRunnerTurn. The ChatInterface still POSTs
 * /api/ai/generate — this is the shared control-plane entry if a turn is
 * also announced to the Gateway (or if POST /api/gateway/agent is used).
 */
async function chatRunner(args) {
  const runner = tryRequire('../services/agent-runner');
  const execute = runner && runner.executeAgentRunnerTurn;
  if (typeof execute !== 'function') {
    return { ok: true, text: 'Gateway chat: turno registrado (sin AgentRunner).', stub: true, surface: 'chat' };
  }
  const result = await execute({
    instruction: args.message,
    userId: args.userId,
    chatId: args.sessionId || args.sessionKey,
    model: resolveDeepSeekModel(args.model),
    onEvent: args.onEvent,
  });
  return {
    ok: Boolean(result && result.ok),
    text: (result && (result.summary || result.finalText)) || 'Listo.',
    surface: 'chat',
    ...result,
  };
}

/**
 * code adapter: does NOT run the Codex plan/build loop.
 * Registers the session, recalls shared memory, emits lifecycle.
 * The live /code path stays POST /api/codex/projects/:id/runs.
 */
async function codeAdapter(args) {
  const f8 = tryRequire('../services/agent-runner/memory');
  let memories = [];
  if (f8 && typeof f8.recallForTurn === 'function') {
    memories = await f8.recallForTurn({
      userId: args.userId,
      chatId: args.sessionId || args.sessionKey,
      query: args.message,
    }).catch(() => []);
  }
  if (typeof args.onEvent === 'function') {
    args.onEvent({ type: 'tool', name: 'memory.recallForTurn', ok: true, count: memories.length });
  }
  return {
    ok: true,
    text: 'Sesión code registrada en el Gateway (loop Codex intacto).',
    surface: 'code',
    memories,
  };
}

function createLiveGateway(opts = {}) {
  return createGateway({
    runner: opts.runner || { run: chatRunner },
    codex: opts.codex || { run: codeAdapter },
    memory: opts.memory || liveMemory(),
    skills: opts.skills || liveSkills(),
    cron: opts.cron || liveCron(),
    env: opts.env || process.env,
  });
}

function wrapForMount(gateway) {
  const inner = createGatewayRouter(gateway);
  let router;
  try {
    const express = require('express');
    router = express.Router();
  } catch {
    router = inner;
    router.gateway = gateway;
    return router;
  }

  // Rutas RELATIVAS: app.use('/api/gateway', router)
  const h = inner.handlers;
  router.get('/', h.status);
  router.get('/status', h.status);
  router.post('/connect', h.connect);
  router.post('/agent', h.agent);
  if (h.agentWait) router.post('/agent/wait', h.agentWait);
  if (h.abort) router.post('/abort', h.abort);
  router.get('/events', h.events);
  if (h.skillsLoad) router.get('/skills/load', h.skillsLoad);
  router.get('/skills', h.skills);
  if (h.skillsPersist) router.post('/skills', h.skillsPersist);
  if (h.skillsDelete) router.delete('/skills', h.skillsDelete);
  router.get('/memory', h.memory);
  if (h.memoryPersist) router.post('/memory', h.memoryPersist);
  if (h.memoryDelete) router.delete('/memory', h.memoryDelete);
  router.get('/cron', h.cronGet);
  router.post('/cron', h.cronPost);
  if (h.cronDelete) router.delete('/cron', h.cronDelete);
  if (h.dlq) router.get('/dlq', h.dlq);
  if (h.dlqPost) router.post('/dlq', h.dlqPost);

  router.handlers = h;
  router.routes = inner.routes;
  router.attach = typeof inner.attach === 'function' ? inner.attach : (app) => app.use('/api/gateway', router);
  router.gateway = gateway;
  return router;
}

const gateway = createLiveGateway();
const router = wrapForMount(gateway);

module.exports = router;
module.exports.resolveDeepSeekModel = resolveDeepSeekModel;
module.exports.createGatewayRouter = createGatewayRouter;
module.exports.createLiveGateway = createLiveGateway;
module.exports.createGateway = createGateway;
module.exports.gateway = gateway;
module.exports.agent = (params) => gateway.startAgent(params);
module.exports.attachCodexEventStore = function attachCodexEventStore(eventStore, { sessionKey, surface = 'code' } = {}) {
  if (!eventStore || typeof eventStore.appendEvent !== 'function') return eventStore;
  const orig = eventStore.appendEvent.bind(eventStore);
  eventStore.appendEvent = async function appendAndEmit(runId, type, payload, extra) {
    const result = await orig(runId, type, payload, extra);
    try {
      const mapped = type === 'action_start' ? 'tool_call'
        : type === 'action_end' ? 'tool_result'
        : type;
      gateway.subscribe && null;
      const set = gateway.queue; // keep a handle so the module is used
      void set;
      const frame = {
        type: 'event',
        event: mapped === 'tool_call' || mapped === 'tool_result' ? 'tool' : 'lifecycle',
        payload: { runId, surface, name: type, ...((payload && typeof payload === 'object') ? payload : { payload }) },
      };
      // Fan-out via startAgent's subscribe bus: emit through a no-op start if needed.
      if (sessionKey && typeof gateway.handleFrame === 'function') {
        // Best-effort: subscribers already attached to this sessionKey receive TOOL/LIFECYCLE.
        const emit = (gateway._emitTo || null);
        if (typeof emit === 'function') emit(sessionKey, frame);
      }
    } catch {
      /* control plane must never break Codex */
    }
    return result;
  };
  return eventStore;
};
