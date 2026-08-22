'use strict';
const { parseLastEventId } = require('../observability/sse-event-id');
const { publicError, httpStatusFor } = require('../error_codes');

/**
 * Express-style HTTP+SSE adapter for the Agent Gateway.
 * Paths rooted at /api/gateway/*. No WhatsApp / Telegram / desktop / nodes.
 */

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function failHttp(res, code, extra) {
  const c = String(code || 'internal_error');
  const body = publicError(c, extra);
  return json(res, httpStatusFor(c), {
    ...body,
    error: { code: c, message: c },
  });
}

function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 256 * 1024;
    const onData = (c) => {
      size += c.length;
      if (size > MAX) {
        req.removeListener('data', onData);
        reject(Object.assign(new Error('payload_too_long'), { code: 'payload_too_long' }));
        return;
      }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch {
        reject(Object.assign(new Error('JSON inválido'), { code: 'bad_json' }));
      }
    });
    req.on('error', reject);
  });
}

function actorUserId(req) {
  // 3H4-BE-010 leftover: never trust client-supplied userId (query/body spoof).
  return (req && req.user && req.user.id) ? String(req.user.id) : '';
}

function queryOf(req, name) {
  // placeholder no-op kept for parseLastEventId import below

  if (req.query && req.query[name] != null) return String(req.query[name]);
  try {
    return new URL(req.url, 'http://local').searchParams.get(name);
  } catch {
    return null;
  }
}

function createGatewayRouter(gateway) {
  if (!gateway || typeof gateway.startAgent !== 'function') {
    throw new Error('createGatewayRouter requiere un gateway');
  }

  const handlers = {
    async connect(req, res) {
      try {
        const userId = actorUserId(req);
        // 3H15 leftover: handshake fail-closed without authenticated user.
        if (!userId) return failHttp(res, 'user_required');
        const body = await readBody(req);
        const conn = { handshakeDone: false, userId };
        const params = { ...body, userId };
        const out = await gateway.handleFrame(conn, {
          type: 'req', id: body.id || 'http-connect', method: 'connect', params,
        });
        json(res, out.ok ? 200 : 400, out);
      } catch (err) {
        return failHttp(res, (err && err.code) || 'bad_request', { message: err && err.message });
      }
    },

    async agent(req, res) {
      try {
        const body = await readBody(req);
        const userId = actorUserId(req);
        // 3H9 leftover: HTTP generate fail-closed without authenticated user (never unscoped).
        if (!userId) return failHttp(res, 'user_required');
        const message = String(body.message || '').trim();
        if (!message) return failHttp(res, 'empty_prompt');
        if (message.length > 8000) return failHttp(res, 'prompt_too_long');
        const started = gateway.startAgent({
          sessionKey: body.sessionKey,
          sessionId: body.sessionId,
          surface: body.surface,
          userId,
          message,
          model: body.model,
          idempotencyKey: body.idempotencyKey,
        });
        json(res, 202, { ok: true, ...started });
      } catch (err) {
        const code = (err && err.code) || 'bad_request';
        return failHttp(res, code, { message: err && err.message });
      }
    },

    async abort(req, res) {
      try {
        const body = await readBody(req);
        const sessionKey = body.sessionKey || queryOf(req, 'sessionKey');
        if (!gateway.abortSession) return failHttp(res, 'abort_unavailable');
        const userId = actorUserId(req);
        if (!userId) return failHttp(res, 'user_required');
        const out = gateway.abortSession(sessionKey, body.reason || 'user_abort', userId);
        json(res, 200, { ok: true, ...out });
      } catch (err) {
        return failHttp(res, (err && err.code) || 'bad_request', { message: err && err.message });
      }
    },

    async agentWait(req, res) {
      try {
        const body = await readBody(req);
        const runId = body.runId || queryOf(req, 'runId');
        if (!runId) return json(res, 400, { ok: false, error: { code: 'bad_request', message: 'runId es obligatorio' } });
        const userId = actorUserId(req);
        // 3H10 leftover: HTTP wait fail-closed without authenticated user.
        if (!userId) return json(res, 401, { ok: false, error: { code: 'user_required', message: 'user_required' } });
        if (typeof gateway.waitForRun !== 'function') return json(res, 501, { ok: false, error: { code: 'wait_unavailable' } });
        const out = await gateway.waitForRun(runId, body.timeoutMs, userId);
        json(res, 200, { ok: true, ...out });
      } catch (err) {
        json(res, 400, { ok: false, error: { message: err.message, code: err.code } });
      }
    },

    events(req, res) {
      const sessionKey = queryOf(req, 'sessionKey');
      if (!sessionKey) return json(res, 400, { ok: false, error: { message: 'sessionKey es obligatorio' } });
      const userId = actorUserId(req);
      // 3H10 leftover: SSE subscribe fail-closed + owner check (never unscoped generate tail).
      if (!userId) return json(res, 401, { ok: false, error: { code: 'user_required', message: 'user_required' } });
      const sess = gateway.getSession && gateway.getSession(sessionKey);
      if (sess && sess.userId && String(sess.userId) !== String(userId)) {
        return json(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } });
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      try { require('../observability/sse-event-id').attachSseIds(res, req, { resume: true }); } catch (_) {} // 3H10 leftover SSE ids
      const lastId = parseLastEventId(req);
      try {
        const replay = gateway.eventLog && typeof gateway.eventLog.replayFrom === 'function'
          ? gateway.eventLog.replayFrom(sessionKey, lastId)
          : [];
        for (const frame of replay) {
          const eventId = frame.id || frame.seq || '';
          res.write(`${eventId !== '' ? `id: ${eventId}\n` : ''}event: ${frame.event || 'message'}\ndata: ${JSON.stringify(frame)}\n\n`);
        }
      } catch (_) { /* resume best-effort */ }
      const unsub = gateway.subscribe(sessionKey, (frame) => {
        const eventId = frame.id || frame.seq || '';
        res.write(`${eventId !== '' ? `id: ${eventId}\n` : ''}event: ${frame.event || 'message'}\ndata: ${JSON.stringify(frame)}\n\n`);
      });
      const keep = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) { /* closed */ } }, 15000);
      if (keep.unref) keep.unref();
      const close = () => { clearInterval(keep); unsub(); };
      req.on('close', close);
      if (typeof res.on === 'function') res.on('close', close);
    },

    status(_req, res) { json(res, 200, gateway.status()); },

    async skills(req, res) {
      const userId = actorUserId(req);
      if (!userId) return failHttp(res, 'user_required');
      const q = String(queryOf(req, 'q') || '').trim().slice(0, 200);
      if (q) {
        let registryHits = [];
        let persistHits = [];
        try {
          const reg = require('../skills-registry');
          if (typeof reg.searchSkills === 'function') registryHits = reg.searchSkills(q, { clearance: 'authenticated', limit: 20 });
        } catch (_) { /* optional */ }
        try {
          const persist = require('../skills-persist');
          if (typeof persist.searchPersistedSkills === 'function') persistHits = persist.searchPersistedSkills({ userId, query: q, limit: 20 });
        } catch (_) { /* optional */ }
        return json(res, 200, { ok: true, query: q, skills: persistHits, registry: registryHits });
      }
      const out = await gateway.handleFrame({ handshakeDone: true, userId }, {
        type: 'req', id: 'http-skills', method: 'skills.list', params: { userId },
      });
      json(res, 200, out.ok ? out.payload : out);
    },

    async skillsDelete(req, res) {
      const userId = actorUserId(req);
      if (!userId) return failHttp(res, 'user_required');
      const name = queryOf(req, 'name') || '';
      const out = await gateway.handleFrame({ handshakeDone: true, userId }, {
        type: 'req', id: 'http-skills-d', method: 'skills.delete', params: { name, userId },
      });
      json(res, out.ok ? 200 : 400, out.ok ? out.payload : out);
    },

    async skillsLoad(req, res) {
      const userId = actorUserId(req);
      if (!userId) return failHttp(res, 'user_required');
      const name = queryOf(req, 'name') || '';
      const out = await gateway.handleFrame({ handshakeDone: true, userId }, {
        type: 'req', id: 'http-skills-l', method: 'skills.load', params: { name, userId },
      });
      json(res, 200, out.ok ? out.payload : out);
    },

    async skillsPersist(req, res) {
      try {
        const body = await readBody(req);
        const userId = actorUserId(req);
        if (!userId) return failHttp(res, 'user_required');
        const skillName = String(body.name || '').trim();
        if (!skillName) return failHttp(res, 'invalid_skill_name');
        if (String(body.body || '').length > 16000) return failHttp(res, 'payload_too_long');
        const out = await gateway.handleFrame({ handshakeDone: true, userId }, {
          type: 'req', id: 'http-skills-p', method: 'skills.persist',
          params: { name: body.name, body: body.body, description: body.description, userId },
        });
        if (out && out.payload && out.payload.error) return failHttp(res, out.payload.error);
        json(res, out.ok ? 201 : 400, out.ok ? out.payload : out);
      } catch (err) {
        return failHttp(res, (err && err.code) || 'bad_request', { message: err && err.message });
      }
    },

    async memory(req, res) {
      const userId = actorUserId(req);
      if (!userId) return failHttp(res, 'user_required');
      const q = String(queryOf(req, 'q') || '').trim().slice(0, 200);
      const out = await gateway.handleFrame({ handshakeDone: true, userId }, {
        type: 'req', id: 'http-mem', method: 'memory.search', params: { q, userId },
      });
      json(res, 200, out.ok ? out.payload : out);
    },

    async memoryPersist(req, res) {
      try {
        const body = await readBody(req);
        const userId = actorUserId(req);
        if (!userId) return failHttp(res, 'user_required');
        const text = String(body.text || '').trim();
        if (!text) return failHttp(res, 'empty_text');
        if (text.length > 4000) return failHttp(res, 'payload_too_long');
        const out = await gateway.handleFrame({ handshakeDone: true, userId }, {
          type: 'req', id: 'http-mem-p', method: 'memory.persist',
          params: { text: body.text, chatId: body.chatId, userId },
        });
        if (out && out.payload && out.payload.error) return failHttp(res, out.payload.error);
        json(res, out.ok ? 201 : 400, out.ok ? out.payload : out);
      } catch (err) {
        return failHttp(res, (err && err.code) || 'bad_request', { message: err && err.message });
      }
    },

    async memoryDelete(req, res) {
      const userId = actorUserId(req);
      if (!userId) return failHttp(res, 'user_required');
      const chatId = queryOf(req, 'chatId') || '';
      const out = await gateway.handleFrame({ handshakeDone: true, userId }, {
        type: 'req', id: 'http-mem-d', method: 'memory.delete', params: { chatId, userId },
      });
      json(res, out.ok ? 200 : 400, out.ok ? out.payload : out);
    },

    async cronGet(req, res) {
      const userId = actorUserId(req);
      if (!userId) return failHttp(res, 'user_required');
      const out = await gateway.handleFrame({ handshakeDone: true, userId }, {
        type: 'req', id: 'http-cron', method: 'cron.list', params: { userId },
      });
      json(res, 200, out.ok ? out.payload : out);
    },

    async cronPost(req, res) {
      try {
        const body = await readBody(req);
        const userId = actorUserId(req);
        if (!userId) return failHttp(res, 'user_required');
        const out = await gateway.handleFrame({ handshakeDone: true, userId }, {
          type: 'req', id: 'http-cron-c', method: 'cron.create', params: { ...body, userId },
        });
        if (out && out.payload && out.payload.error) return failHttp(res, out.payload.error);
        json(res, out.ok ? 201 : 400, out.ok ? out.payload : out);
      } catch (err) {
        return failHttp(res, (err && err.code) || 'bad_request', { message: err && err.message });
      }
    },

    async cronDelete(req, res) {
      const userId = actorUserId(req);
      if (!userId) return failHttp(res, 'user_required');
      const id = queryOf(req, 'id') || '';
      const out = await gateway.handleFrame({ handshakeDone: true, userId }, {
        type: 'req', id: 'http-cron-d', method: 'cron.delete', params: { id, userId },
      });
      json(res, out.ok ? 200 : 400, out.ok ? out.payload : out);
    },

    dlq(req, res) {
      const userId = actorUserId(req);
      if (!userId) return failHttp(res, 'user_required');
      const dlq = gateway.sessionDlq;
      if (!dlq || typeof dlq.retryable !== 'function') {
        return json(res, 200, { ok: true, items: [], retryable: [] });
      }
      const retryable = dlq.retryable({ userId, limit: 20 });
      // Never leak another user's letters; list is already user-scoped.
      return json(res, 200, {
        ok: true,
        retryable: retryable.map((r) => ({
          error: String(r.error || '').slice(0, 80),
          at: Number(r.at) || 0,
          surface: r.surface || null,
          runId: r.runId || null,
        })),
      });
    },

    async dlqPost(req, res) {
      try {
        const userId = actorUserId(req);
        if (!userId) return failHttp(res, 'user_required');
        const body = await readBody(req);
        const action = String(body.action || 'ack').trim();
        const dlq = gateway.sessionDlq;
        if (action === 'retry') return failHttp(res, 'retry_unavailable');
        if (action !== 'ack') return failHttp(res, 'bad_request');
        if (!dlq || typeof dlq.ack !== 'function') {
          return json(res, 200, { ok: true, acked: 0 });
        }
        const out = dlq.ack({ userId, runId: body.runId });
        return json(res, 200, { ok: true, acked: Number(out && out.acked) || 0 });
      } catch (err) {
        return failHttp(res, (err && err.code) || 'bad_request', { message: err && err.message });
      }
    },
  };

  const routes = [
    ['POST', '/api/gateway/connect', handlers.connect],
    ['POST', '/api/gateway/agent', handlers.agent],
    ['POST', '/api/gateway/agent/wait', handlers.agentWait],
    ['POST', '/api/gateway/abort', handlers.abort],
    ['GET', '/api/gateway/events', handlers.events],
    ['GET', '/api/gateway/status', handlers.status],
    ['GET', '/api/gateway/skills/load', handlers.skillsLoad],
    ['GET', '/api/gateway/skills', handlers.skills],
    ['POST', '/api/gateway/skills', handlers.skillsPersist],
    ['DELETE', '/api/gateway/skills', handlers.skillsDelete],
    ['GET', '/api/gateway/memory', handlers.memory],
    ['POST', '/api/gateway/memory', handlers.memoryPersist],
    ['DELETE', '/api/gateway/memory', handlers.memoryDelete],
    ['GET', '/api/gateway/cron', handlers.cronGet],
    ['POST', '/api/gateway/cron', handlers.cronPost],
    ['DELETE', '/api/gateway/cron', handlers.cronDelete],
    ['GET', '/api/gateway/dlq', handlers.dlq],
    ['POST', '/api/gateway/dlq', handlers.dlqPost],
  ];

  function attach(app) {
    for (const [method, path, fn] of routes) {
      const verb = method.toLowerCase();
      if (typeof app[verb] === 'function') app[verb](path, fn);
    }
    return app;
  }

  let router = { handlers, routes, attach };
  try {
    const express = require('express');
    if (express && typeof express.Router === 'function') {
      const r = express.Router();
      for (const [method, path, fn] of routes) r[method.toLowerCase()](path, fn);
      r.handlers = handlers;
      r.routes = routes;
      r.attach = attach;
      router = r;
    }
  } catch (_) { /* hermetic tests may not have express */ }

  return router;
}

module.exports = { createGatewayRouter };
