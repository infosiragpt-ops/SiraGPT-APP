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

const SAMPLE_PLAN = [
  'Plan de 3 pasos:',
  '1. Crear app.py con un hello',
  '2. Añadir tests/test_app.py',
  '3. Verificar con python -m pytest',
].join('\n');

test('planificar turn captures an approved plan on the session', async () => {
  const session = await siraCode.create({ userId: 'u-plan', agent: 'planificar' });
  const result = await siraCode.prompt(session.id, 'arma un plan para hello', {
    userId: 'u-plan',
    llmTurn: async () => ({ text: SAMPLE_PLAN, toolCalls: [] }),
  });
  assert.equal(result.status, 'idle');
  assert.ok(result.plan);
  assert.equal(result.plan.status, 'ready');
  assert.ok(result.plan.stepCount >= 2);
  assert.match(result.plan.preview, /Crear app\.py/);
  const stored = siraCode.getSession(session.id);
  assert.equal(stored.plan.text, SAMPLE_PLAN);
  const publicRow = siraCode.get(session.id, 'u-plan');
  assert.equal(publicRow.plan.status, 'ready');
  assert.ok(!JSON.stringify(publicRow).includes('deepseek'));
});

test('switching planificar → construir emits Plan listo and activates the plan', async () => {
  const session = await siraCode.create({ userId: 'u-handoff', agent: 'planificar' });
  await siraCode.prompt(session.id, 'arma un plan', {
    userId: 'u-handoff',
    llmTurn: async () => ({ text: SAMPLE_PLAN, toolCalls: [] }),
  });
  const frames = [];
  const stop = siraCode.subscribe((ev) => frames.push(ev), { sessionId: session.id });
  const switched = siraCode.switchAgent(session.id, 'construir', 'u-handoff');
  stop();
  assert.equal(switched.agent, 'construir');
  assert.equal(switched.plan.status, 'active');
  assert.ok(switched.plan.stepCount >= 2);
  assert.ok(
    frames.some((ev) => ev.label === 'Plan listo' || ev.step === 'planReady' || ev.type === 'handoff'),
    'handoff must emit Plan listo',
  );
});

test('construir after handoff injects the approved plan into the LLM transcript', async () => {
  const session = await siraCode.create({ userId: 'u-act', agent: 'planificar' });
  await siraCode.prompt(session.id, 'arma un plan', {
    userId: 'u-act',
    llmTurn: async () => ({ text: SAMPLE_PLAN, toolCalls: [] }),
  });
  siraCode.switchAgent(session.id, 'construir', 'u-act');

  let sawReminder = false;
  const result = await siraCode.prompt(session.id, 'adelante', {
    userId: 'u-act',
    llmTurn: async ({ messages, agent }) => {
      assert.equal(agent, 'construir');
      const blob = messages.map((m) => m.content).join('\n');
      if (blob.includes('Plan aprobado') && blob.includes('Crear app.py')) {
        sawReminder = true;
      }
      assert.equal(/deepseek|openrouter|model_id/i.test(blob), false);
      return { text: 'Ejecuto el plan.', toolCalls: [] };
    },
  });
  assert.equal(sawReminder, true, 'construir turn must see the approved plan');
  assert.equal(result.status, 'idle');
  assert.equal(result.text, 'Ejecuto el plan.');
});

test('step budget stop emits Presupuesto agotado instead of Listo', async () => {
  const session = await siraCode.create({ userId: 'u-budget', agent: 'construir' });
  const result = await siraCode.prompt(session.id, 'lista archivos', {
    userId: 'u-budget',
    maxSteps: 1,
    llmTurn: async () => ({
      text: '',
      toolCalls: [{ name: 'glob', arguments: { pattern: '*.txt' } }],
    }),
  });
  assert.equal(result.status, 'stopped');
  assert.equal(result.stopReason, 'step_budget');
  const stored = siraCode.getSession(session.id);
  assert.ok(stored.events.some((ev) => ev.label === 'Presupuesto agotado' || ev.step === 'budgetExceeded'));
  assert.equal(stored.events.some((ev) => ev.label === 'Listo' && ev.step === 'done'), false);
});

test('transient LLM errors retry once then succeed', async () => {
  const session = await siraCode.create({ userId: 'u-retry', agent: 'construir' });
  let calls = 0;
  const result = await siraCode.prompt(session.id, 'lista archivos', {
    userId: 'u-retry',
    llmTurn: async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('fetch failed');
        err.code = 'ECONNRESET';
        throw err;
      }
      return { text: 'Reintento ok.', toolCalls: [] };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'idle');
  assert.equal(result.text, 'Reintento ok.');
  const stored = siraCode.getSession(session.id);
  assert.ok(stored.events.some((ev) => ev.label === 'Reintentando' || ev.step === 'retrying'));
});

test('abort errors are not retried as transient LLM failures', async () => {
  const session = await siraCode.create({ userId: 'u-noretry' });
  const result = await siraCode.prompt(session.id, 'espera', {
    userId: 'u-noretry',
    llmTurn: async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    },
  });
  assert.equal(result.status, 'cancelled');
});

test('short planificar replies are not stored as an approved plan', async () => {
  const session = await siraCode.create({ userId: 'u-short', agent: 'planificar' });
  const result = await siraCode.prompt(session.id, 'lista archivos', {
    userId: 'u-short',
    llmTurn: async () => ({ text: 'Listo.', toolCalls: [] }),
  });
  assert.equal(result.plan, null);
  assert.equal(siraCode.getSession(session.id).plan, null);
});

test('authorizing planificar bash with approved or a session grant allows it', () => {
  const asked = siraCode.authorizeTool('planificar', 'bash', { permission: 'default' });
  assert.equal(asked.needsPermission, true);
  const once = siraCode.authorizeTool('planificar', 'bash', { permission: 'default', approved: true });
  assert.equal(once.allowed, true);
  assert.equal(once.needsPermission, false);
  const granted = siraCode.authorizeTool('planificar', 'bash', {
    permission: 'default',
    grants: new Set(['bash']),
  });
  assert.equal(granted.allowed, true);
});

test('approved cannot unlock a denied write in planificar or Solo lectura', () => {
  const write = siraCode.authorizeTool('planificar', 'write', { permission: 'default', approved: true });
  assert.equal(write.denied, true);
  const read = siraCode.authorizeTool('construir', 'bash', { permission: 'read', approved: true });
  assert.equal(read.denied, true);
  assert.equal(read.reason, 'composer_read_only');
});

test('allowing a pending planificar bash actually runs the command', async () => {
  const session = await siraCode.create({ userId: 'u-perm', agent: 'planificar' });
  let calls = 0;
  await siraCode.prompt(session.id, 'lista archivos', {
    userId: 'u-perm',
    llmTurn: async () => {
      calls += 1;
      if (calls === 1) {
        return { text: '', toolCalls: [{ name: 'bash', arguments: { command: 'echo permiso-ok' } }] };
      }
      return { text: 'Plan listo.', toolCalls: [] };
    },
  });
  const stored = siraCode.getSession(session.id);
  assert.equal(stored.pendingPermissions.size, 1);
  const publicRow = siraCode.get(session.id, 'u-perm');
  assert.equal(publicRow.pendingPermissions.length, 1);
  assert.equal(publicRow.pendingPermissions[0].tool, 'bash');
  const pid = publicRow.pendingPermissions[0].permissionId;

  const resolved = await siraCode.resolvePermission(session.id, pid, 'allow', 'u-perm');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.allowed, true);
  assert.equal(resolved.executed, true);
  assert.equal(resolved.remembered, false);
  assert.match(String(resolved.result && resolved.result.preview), /permiso-ok/);
  assert.equal(siraCode.getSession(session.id).pendingPermissions.size, 0);
  assert.ok(stored.events.some((ev) => ev.type === 'permission_resolved' && ev.decision === 'allow'));
  assert.ok(stored.events.some((ev) => ev.type === 'tool_result' && ev.ok === true));
  assert.ok(!JSON.stringify(resolved).includes('DeepSeek'));
  assert.ok(!JSON.stringify(resolved).includes('model_id'));
});

test('denying a pending bash does not execute it', async () => {
  const session = await siraCode.create({ userId: 'u-deny', agent: 'planificar' });
  let calls = 0;
  await siraCode.prompt(session.id, 'lista archivos', {
    userId: 'u-deny',
    llmTurn: async () => {
      calls += 1;
      if (calls === 1) {
        return { text: '', toolCalls: [{ name: 'bash', arguments: { command: 'echo no-debes' } }] };
      }
      return { text: 'Plan.', toolCalls: [] };
    },
  });
  const pid = siraCode.get(session.id, 'u-deny').pendingPermissions[0].permissionId;
  const resolved = await siraCode.resolvePermission(session.id, pid, 'deny', 'u-deny');
  assert.equal(resolved.allowed, false);
  assert.equal(resolved.executed, false);
  const stored = siraCode.getSession(session.id);
  assert.equal(stored.events.some((ev) => ev.type === 'tool_result'), false);
  assert.ok(stored.events.some((ev) => ev.label === 'Permiso denegado'));
});

test('always remembers the grant so the next planificar bash does not ask', async () => {
  const session = await siraCode.create({ userId: 'u-always', agent: 'planificar' });
  let calls = 0;
  await siraCode.prompt(session.id, 'lista archivos', {
    userId: 'u-always',
    llmTurn: async () => {
      calls += 1;
      if (calls === 1) {
        return { text: '', toolCalls: [{ name: 'bash', arguments: { command: 'echo first' } }] };
      }
      return { text: 'Plan.', toolCalls: [] };
    },
  });
  const pid = siraCode.get(session.id, 'u-always').pendingPermissions[0].permissionId;
  const first = await siraCode.resolvePermission(session.id, pid, 'always', 'u-always');
  assert.equal(first.remembered, true);
  assert.equal(first.executed, true);

  let secondCalls = 0;
  const again = await siraCode.prompt(session.id, 'vuelve a listar', {
    userId: 'u-always',
    llmTurn: async () => {
      secondCalls += 1;
      if (secondCalls === 1) {
        return { text: '', toolCalls: [{ name: 'bash', arguments: { command: 'echo second' } }] };
      }
      return { text: 'Plan otra vez.', toolCalls: [] };
    },
  });
  const bash = again.toolResults.find((t) => t.tool === 'bash');
  assert.ok(bash && bash.ok, 'remembered grant must run bash without asking');
  assert.equal(siraCode.getSession(session.id).pendingPermissions.size, 0);
  assert.match(String(bash.content), /second/);
});

test('allowing a Protegido write in construir persists the file', async () => {
  const session = await siraCode.create({ userId: 'u-prot', agent: 'construir' });
  let calls = 0;
  await siraCode.prompt(session.id, 'escribe nota.txt', {
    userId: 'u-prot',
    permission: 'protected',
    llmTurn: async () => {
      calls += 1;
      if (calls === 1) {
        return { text: '', toolCalls: [{ name: 'write', arguments: { path: 'nota.txt', content: 'revisado' } }] };
      }
      return { text: 'Hecho.', toolCalls: [] };
    },
  });
  const root = siraCode.getSession(session.id).workspace.root;
  assert.equal(fs.existsSync(path.join(root, 'nota.txt')), false);
  const pid = siraCode.get(session.id, 'u-prot').pendingPermissions[0].permissionId;
  const resolved = await siraCode.resolvePermission(session.id, pid, 'allow', 'u-prot');
  assert.equal(resolved.executed, true);
  const file = await siraCode.readFile(session.id, 'nota.txt', 'u-prot');
  assert.equal(file.content, 'revisado');
});

test('resolvePermission rejects a missing card and another user', async () => {
  const session = await siraCode.create({ userId: 'owner' });
  await assert.rejects(
    () => siraCode.resolvePermission(session.id, 'perm_missing', 'allow', 'owner'),
    /permiso no encontrado/,
  );
  await assert.rejects(
    () => siraCode.resolvePermission(session.id, 'perm_missing', 'allow', 'intruder'),
    /sesión no encontrada/,
  );
});

test('permission-resume helpers normalize OpenCode-style replies', () => {
  assert.equal(siraCode.normalizeDecision('once'), 'allow');
  assert.equal(siraCode.normalizeDecision('always_allow_in_chat'), 'always');
  assert.equal(siraCode.normalizeDecision('reject'), 'deny');
  assert.equal(siraCode.normalizeDecision('nope'), null);
});

test('plan-handoff helpers count steps and classify transient LLM errors', () => {
  assert.equal(siraCode.extractStepCount(SAMPLE_PLAN), 3);
  assert.equal(siraCode.looksLikePlan('Listo.'), false);
  assert.equal(siraCode.looksLikePlan(SAMPLE_PLAN), true);
  assert.match(siraCode.buildSwitchReminder({ text: SAMPLE_PLAN }), /Plan aprobado/);
  assert.equal(siraCode.isTransientLlmError({ name: 'AbortError' }), false);
  assert.equal(siraCode.isTransientLlmError({ code: 'ECONNRESET', message: 'fetch failed' }), true);
  assert.equal(siraCode.isTransientLlmError({ status: 503, message: 'unavailable' }), true);
});
