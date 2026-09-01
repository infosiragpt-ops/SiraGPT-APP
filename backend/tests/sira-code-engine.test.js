'use strict';

/**
 * SiraCode native engine — Phase 1 focused tests.
 * Offline: scripted LLM, temp workspace, no Bun / sidecar / network.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const siraCode = require('../src/services/sira-code');
const { FORBIDDEN_DISPLAY } = require('../src/services/sira-code/display');

beforeEach(() => {
  siraCode._resetForTests();
});

afterEach(async () => {
  siraCode._resetForTests();
});

function scriptedWriteLlm(relPath = 'hola.txt', content = 'hola') {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) {
      return {
        text: '',
        toolCalls: [{ name: 'write', arguments: { path: relPath, content } }],
      };
    }
    return { text: 'Hecho.', toolCalls: [] };
  };
}

function hangingLlm(gate) {
  return async ({ signal }) => {
    await new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      gate.resolve = resolve;
    });
    return { text: 'tarde', toolCalls: [] };
  };
}

test('create session defaults to construir and can switch to planificar', async () => {
  const session = await siraCode.create({ userId: 'u-1' });
  assert.equal(session.agent, 'construir');
  assert.equal(session.agentLabel, 'Construir');
  assert.match(session.id, /^sc_/);
  const switched = siraCode.switchAgent(session.id, 'planificar', 'u-1');
  assert.equal(switched.agent, 'planificar');
  assert.equal(switched.agentLabel, 'Planificar');
});

test('construir can write a file in the session workspace', async () => {
  const session = await siraCode.create({ userId: 'u-1', agent: 'construir' });
  const result = await siraCode.prompt(session.id, 'escribe hola.txt', {
    userId: 'u-1',
    llmTurn: scriptedWriteLlm('hola.txt', 'hola mundo'),
  });
  assert.equal(result.status, 'idle');
  const written = result.toolResults.find((t) => t.tool === 'write');
  assert.ok(written && written.ok, 'write must succeed in construir');
  const file = await siraCode.readFile(session.id, 'hola.txt', 'u-1');
  assert.equal(file.content, 'hola mundo');
});

test('composer Solo lectura rejects writes even in construir', async () => {
  const session = await siraCode.create({ userId: 'u-read' });
  const result = await siraCode.prompt(session.id, 'escribe hola.txt', {
    userId: 'u-read',
    permission: 'read',
    llmTurn: scriptedWriteLlm('blocked.txt', 'no'),
  });
  const written = result.toolResults.find((t) => t.tool === 'write');
  assert.ok(written, 'write was attempted');
  assert.equal(written.ok, false);
  assert.equal(written.code, 'composer_read_only');
  const root = siraCode.getSession(session.id).workspace.root;
  assert.equal(fs.existsSync(path.join(root, 'blocked.txt')), false);
});

test('composer Acceso completo does not fall back to a write deny', async () => {
  const session = await siraCode.create({ userId: 'u-full', agent: 'planificar' });
  const result = await siraCode.prompt(session.id, 'escribe hola.txt', {
    userId: 'u-full',
    permission: 'full',
    llmTurn: scriptedWriteLlm('libre.txt', 'ok'),
  });
  const written = result.toolResults.find((t) => t.tool === 'write');
  assert.ok(written && written.ok, 'full must not silently inherit planificar deny');
  const file = await siraCode.readFile(session.id, 'libre.txt', 'u-full');
  assert.equal(file.content, 'ok');
});

test('planificar cannot write; workspace file is absent', async () => {
  const session = await siraCode.create({ userId: 'u-1', agent: 'planificar' });
  const result = await siraCode.prompt(session.id, 'escribe hola.txt', {
    userId: 'u-1',
    llmTurn: scriptedWriteLlm('secreto.txt', 'no-debes-escribir'),
  });
  const written = result.toolResults.find((t) => t.tool === 'write');
  assert.ok(written, 'write was attempted');
  assert.equal(written.ok, false);
  assert.equal(written.code, 'permission_denied');
  const root = siraCode.getSession(session.id).workspace.root;
  assert.equal(fs.existsSync(path.join(root, 'secreto.txt')), false);
});

test('planificar bash emits a permission event instead of executing', async () => {
  const session = await siraCode.create({ userId: 'u-1', agent: 'planificar' });
  let calls = 0;
  const result = await siraCode.prompt(session.id, 'lista archivos', {
    userId: 'u-1',
    llmTurn: async () => {
      calls += 1;
      if (calls === 1) {
        return { text: '', toolCalls: [{ name: 'bash', arguments: { command: 'rm -rf /' } }] };
      }
      return { text: 'Plan listo.', toolCalls: [] };
    },
  });
  const bash = result.toolResults.find((t) => t.tool === 'bash');
  assert.ok(bash);
  assert.equal(bash.ok, false);
  assert.equal(bash.code, 'permission_required');
  const stored = siraCode.getSession(session.id);
  assert.ok(stored.pendingPermissions.size >= 1);
  assert.ok(stored.events.some((ev) => ev.type === 'permission'));
});

test('abort cancels an in-flight prompt (SSE cancelled stage)', async () => {
  const session = await siraCode.create({ userId: 'u-1' });
  const gate = {};
  const pending = siraCode.prompt(session.id, 'espera', {
    userId: 'u-1',
    llmTurn: hangingLlm(gate),
  });
  await new Promise((r) => setTimeout(r, 20));
  const frames = [];
  const stop = siraCode.subscribe((ev) => frames.push(ev), { sessionId: session.id });
  const aborted = siraCode.abort(session.id, 'u-1');
  assert.equal(aborted.ok, true);
  const result = await pending;
  stop();
  assert.equal(result.status, 'cancelled');
  assert.ok(
    frames.some((ev) => ev.label === 'Cancelado' || ev.step === 'cancelled' || ev.type === 'stage'),
    'cancel must emit a stage event',
  );
  const stored = siraCode.getSession(session.id);
  assert.ok(stored.events.some((ev) => ev.label === 'Cancelado' || ev.step === 'cancelled'));
});

test('health is always native; sidecar stay off by default', () => {
  const h = siraCode.health({ OPENCODE_SERVER_URL: 'http://127.0.0.1:4096', SIRAGPT_OPENCODE_SIDECAR: '' });
  assert.equal(h.ok, true);
  assert.equal(h.configured, true);
  assert.equal(h.native, true);
  assert.equal(h.engine, 'sira-code');
  assert.equal(h.sidecar, false);
  assert.equal(h.baseUrl, null);
  assert.ok(!JSON.stringify(h).includes('4096'));
  assert.ok(!FORBIDDEN_DISPLAY.test(JSON.stringify(h)));
});

test('trivial greeting never starts a SiraCode tool loop', async () => {
  const session = await siraCode.create({ userId: 'u-1', agent: 'construir' });
  let calls = 0;
  const result = await siraCode.prompt(session.id, 'Hola', {
    userId: 'u-1',
    llmTurn: async () => {
      calls += 1;
      return { text: 'no', toolCalls: [{ name: 'write', arguments: { path: 'x.txt', content: 'x' } }] };
    },
  });
  assert.equal(siraCode.shouldStartSiraCodeRun('Hola'), false);
  assert.equal(result.skipped, true);
  assert.equal(calls, 0);
  assert.equal((result.toolResults || []).length, 0);
});

test('public payloads never mention DeepSeek, OpenRouter or model_id', async () => {
  const session = await siraCode.create({ userId: 'u-1', model: 'deepseek-v4-flash' });
  const result = await siraCode.prompt(session.id, 'hola', {
    userId: 'u-1',
    model: 'openrouter/deepseek-chat',
    llmTurn: async () => ({ text: 'Listo.', toolCalls: [] }),
  });
  const blob = JSON.stringify({ session, result, health: siraCode.health() });
  assert.equal(FORBIDDEN_DISPLAY.test(blob), false, blob);
  assert.ok(!blob.includes('model_id'));
  assert.ok(!blob.includes('OpenRouter'));
  assert.ok(!blob.includes('DeepSeek'));
});

test('other users cannot read a session', async () => {
  const session = await siraCode.create({ userId: 'owner' });
  assert.throws(() => siraCode.get(session.id, 'intruder'), /sesión no encontrada/);
});
