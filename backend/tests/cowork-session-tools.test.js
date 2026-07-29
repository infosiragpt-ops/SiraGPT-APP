'use strict';

// cowork-session-tools.test.js — porte #4 OpenClaw (sessions como tools).
// Cubre: scoping por usuario, paginación+cap de history, forward de send,
// not_found para sesiones ajenas, salida siempre JSON-safe y acotada, y un
// bloque de integración con el session-manager real (store en tmpdir).

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// El session-manager real persiste vía cowork-disk-persistence, que fija su
// STORE_ROOT en require-time: apuntarlo a un tmpdir ANTES de cualquier require.
process.env.SIRAGPT_COWORK_STORE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'cowork-session-tools-test-'),
);

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSessionTools,
  MAX_TOOL_OUTPUT_CHARS,
  TRUNCATION_MARKER,
  CONTENT_CLIP_MARKER,
  DEFAULT_HISTORY_LIMIT,
} = require('../src/services/cowork-session-tools');

// ─── Fake mínimo con la misma semántica que session-manager ─────────────────

function createFakeSessionManager() {
  const sessions = new Map();
  let seq = 0;

  function addMessage(sessionId, message) {
    const session = sessions.get(sessionId);
    if (!session) return null;
    const msg = {
      id: `msg_${++seq}`,
      role: message.role || 'user',
      content: message.content || '',
      timestamp: Date.now(),
      metadata: message.metadata || {},
      tokens: message.tokens || 0,
    };
    session.messages.push(msg);
    session.lastActivity = Date.now();
    return msg;
  }

  return {
    createSession(userId, opts = {}) {
      const id = opts.id || `sess_${++seq}`;
      const session = {
        id,
        userId,
        label: opts.label || `Session ${id}`,
        createdAt: Date.now(),
        lastActivity: opts.lastActivity ?? Date.now(),
        messages: [],
        summary: null,
        tags: opts.tags || [],
        tokenCount: 0,
      };
      sessions.set(id, session);
      return session;
    },
    getSession(id) {
      return sessions.get(id) || null;
    },
    listSessions(userId, opts = {}) {
      const limit = opts.limit || 20;
      let rows = [...sessions.values()].filter((s) => s.userId === userId);
      if (opts.tag) rows = rows.filter((s) => s.tags.includes(opts.tag));
      return rows
        .sort((a, b) => b.lastActivity - a.lastActivity)
        .slice(0, limit)
        .map((s) => ({
          id: s.id,
          label: s.label,
          messageCount: s.messages.length,
          tokenCount: s.tokenCount,
          createdAt: s.createdAt,
          lastActivity: s.lastActivity,
          tags: s.tags,
          summary: s.summary,
        }));
    },
    getHistory(sessionId, opts = {}) {
      const session = sessions.get(sessionId);
      if (!session) return [];
      let messages = session.messages;
      if (opts.after) {
        const idx = messages.findIndex((m) => m.id === opts.after);
        if (idx >= 0) messages = messages.slice(idx + 1);
      }
      if (opts.limit) {
        messages = opts.after ? messages.slice(0, opts.limit) : messages.slice(-opts.limit);
      }
      return messages;
    },
    addMessage,
    sendToSession(sourceId, targetId, message) {
      if (!sessions.has(sourceId) || !sessions.has(targetId)) return null;
      return addMessage(targetId, {
        role: message.role || 'user',
        content: message.content,
        metadata: {
          ...message.metadata,
          forwardedFrom: sourceId,
          forwardedAt: new Date().toISOString(),
        },
        tokens: message.tokens || 0,
      });
    },
  };
}

function toolByName(tools, name) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} presente`);
  return tool;
}

function assertJsonSafe(result) {
  let json;
  assert.doesNotThrow(() => {
    json = JSON.stringify(result);
  }, 'el resultado debe ser serializable con JSON.stringify');
  assert.equal(typeof json, 'string');
  return json;
}

// ─── buildSessionTools ──────────────────────────────────────────────────────

describe('buildSessionTools', () => {
  it('devuelve 3 descriptores bien formados', () => {
    const tools = buildSessionTools({ sessionManager: createFakeSessionManager(), userId: 'u1' });
    assert.equal(tools.length, 3);
    assert.deepEqual(tools.map((t) => t.name), ['sessions_list', 'sessions_history', 'sessions_send']);
    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.description.length > 20, `${tool.name} lleva descripción de cuándo usarla`);
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(typeof tool.inputSchema.properties, 'object');
      assert.ok(Array.isArray(tool.inputSchema.required));
      assert.equal(typeof tool.execute, 'function');
    }
  });

  it('exige sessionManager y userId en build-time', () => {
    assert.throws(() => buildSessionTools(), TypeError);
    assert.throws(() => buildSessionTools({ userId: 'u1' }), TypeError);
    assert.throws(
      () => buildSessionTools({ sessionManager: createFakeSessionManager() }),
      TypeError,
    );
  });
});

// ─── sessions_list ──────────────────────────────────────────────────────────

describe('sessions_list', () => {
  it('lista solo sesiones del propio usuario', async () => {
    const manager = createFakeSessionManager();
    manager.createSession('u1', { id: 'a', label: 'Mía 1' });
    manager.createSession('u1', { id: 'b', label: 'Mía 2' });
    manager.createSession('u2', { id: 'c', label: 'Ajena' });

    const tools = buildSessionTools({ sessionManager: manager, userId: 'u1' });
    const result = await toolByName(tools, 'sessions_list').execute({});

    assert.equal(result.count, 2);
    assert.deepEqual(result.sessions.map((s) => s.id).sort(), ['a', 'b']);
    assert.ok(!result.sessions.some((s) => s.title === 'Ajena'));
    assertJsonSafe(result);
  });

  it('incluye título, estado y conteo de mensajes', async () => {
    const manager = createFakeSessionManager();
    manager.createSession('u1', { id: 'a', label: 'Investigación' });
    manager.addMessage('a', { role: 'user', content: 'hola' });
    manager.addMessage('a', { role: 'assistant', content: 'hola!' });
    manager.createSession('u1', { id: 'old', label: 'Vieja', lastActivity: Date.now() - 60 * 60 * 1000 });

    const tools = buildSessionTools({ sessionManager: manager, userId: 'u1' });
    const result = await toolByName(tools, 'sessions_list').execute({});

    const fresh = result.sessions.find((s) => s.id === 'a');
    const stale = result.sessions.find((s) => s.id === 'old');
    assert.equal(fresh.title, 'Investigación');
    assert.equal(fresh.messageCount, 2);
    assert.equal(fresh.status, 'active');
    assert.equal(stale.status, 'idle');
  });

  it('respeta limit y nunca lanza ante un manager roto', async () => {
    const manager = createFakeSessionManager();
    for (let i = 0; i < 10; i++) manager.createSession('u1', { id: `s${i}` });
    const tools = buildSessionTools({ sessionManager: manager, userId: 'u1' });
    const limited = await toolByName(tools, 'sessions_list').execute({ limit: 3 });
    assert.equal(limited.count, 3);

    const broken = buildSessionTools({
      sessionManager: { listSessions() { throw new Error('boom'); } },
      userId: 'u1',
    });
    const errored = await toolByName(broken, 'sessions_list').execute({});
    assert.equal(errored.error, 'internal_error');
    assertJsonSafe(errored);
  });
});

// ─── sessions_history ───────────────────────────────────────────────────────

describe('sessions_history', () => {
  function seededManager() {
    const manager = createFakeSessionManager();
    manager.createSession('u1', { id: 'own', label: 'Propia' });
    manager.createSession('u2', { id: 'foreign', label: 'Ajena' });
    for (let i = 1; i <= 30; i++) {
      manager.addMessage('own', { role: i % 2 ? 'user' : 'assistant', content: `mensaje ${i}` });
      manager.addMessage('foreign', { role: 'user', content: `secreto ${i}` });
    }
    return manager;
  }

  it('pagina: default 20 más recientes, limit explícito y cursor after', async () => {
    const manager = seededManager();
    const tools = buildSessionTools({ sessionManager: manager, userId: 'u1' });
    const history = toolByName(tools, 'sessions_history');

    const byDefault = await history.execute({ sessionId: 'own' });
    assert.equal(byDefault.returned, DEFAULT_HISTORY_LIMIT);
    assert.equal(byDefault.totalMessages, 30);
    assert.equal(byDefault.hasMore, true);
    assert.equal(byDefault.messages.at(-1).content, 'mensaje 30');

    const limited = await history.execute({ sessionId: 'own', limit: 5 });
    assert.equal(limited.returned, 5);
    assert.equal(limited.messages[0].content, 'mensaje 26');

    const firstPage = await history.execute({ sessionId: 'own', limit: 10 });
    const cursor = firstPage.messages[0].id; // avanza desde el 21º
    const nextPage = await history.execute({ sessionId: 'own', limit: 5, after: cursor });
    assert.equal(nextPage.returned, 5);
    assert.equal(nextPage.messages[0].content, 'mensaje 22');
    assert.equal(nextPage.nextCursor, nextPage.messages.at(-1).id);
  });

  it('capa limit al tope y valida argumentos', async () => {
    const manager = seededManager();
    const tools = buildSessionTools({ sessionManager: manager, userId: 'u1' });
    const history = toolByName(tools, 'sessions_history');

    const capped = await history.execute({ sessionId: 'own', limit: 100000 });
    assert.equal(capped.returned, 30); // pidió más pero el tope no lanza ni pagina raro

    const invalid = await history.execute({});
    assert.equal(invalid.error, 'invalid_arguments');
  });

  it('sesión ajena o inexistente → not_found (sin filtrar contenido)', async () => {
    const manager = seededManager();
    const tools = buildSessionTools({ sessionManager: manager, userId: 'u1' });
    const history = toolByName(tools, 'sessions_history');

    const foreign = await history.execute({ sessionId: 'foreign' });
    assert.deepEqual(foreign, { error: 'not_found' });
    assert.ok(!JSON.stringify(foreign).includes('secreto'));

    const missing = await history.execute({ sessionId: 'nope' });
    assert.deepEqual(missing, { error: 'not_found' });
  });

  it('recorta mensajes largos y acota la salida total a 8000 chars', async () => {
    const manager = createFakeSessionManager();
    manager.createSession('u1', { id: 'big' });
    for (let i = 0; i < 20; i++) {
      manager.addMessage('big', { role: 'user', content: 'x'.repeat(5000) });
    }
    const tools = buildSessionTools({ sessionManager: manager, userId: 'u1' });
    const result = await toolByName(tools, 'sessions_history').execute({ sessionId: 'big' });

    const json = assertJsonSafe(result);
    assert.ok(json.length <= MAX_TOOL_OUTPUT_CHARS, `salida ${json.length} <= ${MAX_TOOL_OUTPUT_CHARS}`);
    assert.equal(result.truncated, true);
    assert.equal(result.marker, TRUNCATION_MARKER);
    // El recorte por-mensaje también actuó antes del sobre.
    assert.ok(result.partialJson.includes(CONTENT_CLIP_MARKER));
  });

  it('nunca lanza si getHistory explota', async () => {
    const manager = createFakeSessionManager();
    manager.createSession('u1', { id: 'own' });
    manager.getHistory = () => { throw new Error('kaboom'); };
    const tools = buildSessionTools({ sessionManager: manager, userId: 'u1' });
    const result = await toolByName(tools, 'sessions_history').execute({ sessionId: 'own' });
    assert.equal(result.error, 'internal_error');
    assertJsonSafe(result);
  });
});

// ─── sessions_send ──────────────────────────────────────────────────────────

describe('sessions_send', () => {
  it('reenvía con sendToSession cuando hay sesión origen propia', async () => {
    const manager = createFakeSessionManager();
    manager.createSession('u1', { id: 'src' });
    manager.createSession('u1', { id: 'dst' });
    const tools = buildSessionTools({
      sessionManager: manager,
      userId: 'u1',
      sourceSessionId: 'src',
    });

    const result = await toolByName(tools, 'sessions_send').execute({
      sessionId: 'dst',
      message: 'pásale esto a la otra sesión',
    });

    assert.equal(result.sent, true);
    assert.equal(result.sessionId, 'dst');
    assert.equal(typeof result.messageId, 'string');

    const delivered = manager.getSession('dst').messages;
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].content, 'pásale esto a la otra sesión');
    assert.equal(delivered[0].metadata.forwardedFrom, 'src');
    assertJsonSafe(result);
  });

  it('sin sesión origen hace append directo con metadata de reenvío', async () => {
    const manager = createFakeSessionManager();
    manager.createSession('u1', { id: 'dst' });
    const tools = buildSessionTools({ sessionManager: manager, userId: 'u1' });

    const result = await toolByName(tools, 'sessions_send').execute({
      sessionId: 'dst',
      message: 'hola',
    });

    assert.equal(result.sent, true);
    const delivered = manager.getSession('dst').messages;
    assert.equal(delivered[0].metadata.forwardedVia, 'sessions_send');
  });

  it('sesión ajena/inexistente → not_found; args inválidos → invalid_arguments', async () => {
    const manager = createFakeSessionManager();
    manager.createSession('u2', { id: 'foreign' });
    const tools = buildSessionTools({ sessionManager: manager, userId: 'u1' });
    const send = toolByName(tools, 'sessions_send');

    assert.deepEqual(await send.execute({ sessionId: 'foreign', message: 'x' }), { error: 'not_found' });
    assert.deepEqual(await send.execute({ sessionId: 'nope', message: 'x' }), { error: 'not_found' });
    assert.equal((await send.execute({ sessionId: 'foreign' })).error, 'invalid_arguments');
    assert.equal((await send.execute({ message: 'x' })).error, 'invalid_arguments');
  });

  it('nunca lanza si el manager explota al enviar', async () => {
    const manager = createFakeSessionManager();
    manager.createSession('u1', { id: 'dst' });
    manager.addMessage = () => { throw new Error('disk full'); };
    const tools = buildSessionTools({ sessionManager: manager, userId: 'u1' });
    const result = await toolByName(tools, 'sessions_send').execute({ sessionId: 'dst', message: 'x' });
    assert.equal(result.error, 'internal_error');
    assertJsonSafe(result);
  });
});

// ─── Integración con el session-manager real ────────────────────────────────

describe('integración con session-manager real', () => {
  const sessionManager = require('../src/services/session-manager');

  after(() => {
    sessionManager.stopCleanup();
  });

  it('list/history/send funcionan end-to-end y scoped por usuario', async () => {
    const mine = sessionManager.createSession('user-a', { label: 'Principal' });
    const other = sessionManager.createSession('user-a', { label: 'Secundaria' });
    const foreign = sessionManager.createSession('user-b', { label: 'De otro' });
    sessionManager.addMessage(mine.id, { role: 'user', content: 'contexto inicial' });

    const tools = buildSessionTools({
      sessionManager,
      userId: 'user-a',
      sourceSessionId: mine.id,
    });

    const list = await toolByName(tools, 'sessions_list').execute({});
    const ids = list.sessions.map((s) => s.id);
    assert.ok(ids.includes(mine.id) && ids.includes(other.id));
    assert.ok(!ids.includes(foreign.id));

    const sent = await toolByName(tools, 'sessions_send').execute({
      sessionId: other.id,
      message: 'resumen desde la sesión principal',
    });
    assert.equal(sent.sent, true);

    const history = await toolByName(tools, 'sessions_history').execute({ sessionId: other.id });
    assert.equal(history.returned, 1);
    assert.equal(history.messages[0].content, 'resumen desde la sesión principal');
    assert.equal(history.messages[0].forwardedFrom, mine.id);

    const denied = await toolByName(tools, 'sessions_history').execute({ sessionId: foreign.id });
    assert.deepEqual(denied, { error: 'not_found' });
    assertJsonSafe(history);
  });
});
