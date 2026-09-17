'use strict';

/**
 * agentes-coding/harness HITL permissions — Phase 4b.
 * Injectable policy + memory driver only. No real models, no Docker, no Cline dump.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const sessionHarness = require('../src/services/agentes-coding/harness');
const {
  defaultPermissionPolicy,
  isSafeWritePath,
  normalizeDecision,
  authorizeAction,
} = require('../src/services/agentes-coding/harness/permissions');
const { createCodingSandbox, CodingSandboxError } = require('../src/services/agentes-coding/coding-sandbox');
const { CATALOG } = require('../src/services/agentes-coding/coding-sandbox/errors');

const ON = { AGENTES_CODING_V2: '1' };

let express = null;
let createAgentesCodingRouter = null;
try {
  express = require('express');
  ({ createAgentesCodingRouter } = require('../src/routes/agentes-coding'));
} catch (_) {
  express = null;
  createAgentesCodingRouter = null;
}

function sandbox(extra = {}) {
  return createCodingSandbox({
    env: { ...ON, ...(extra.env || {}) },
    autoGc: false,
    ...extra,
  });
}

async function seeded(files = {
  'src/app.ts': 'export const n = 1;\n',
  'README.md': '# demo\n',
}) {
  const sb = sandbox();
  const session = await sb.createSession({ userId: 'coding-owner' });
  const raw = sb._unsafeGetRaw(session.id);
  raw.execImpl = async (cmd) => {
    const text = String(cmd || '');
    const echoed = text.match(/^echo\s+([\s\S]+)$/);
    return { stdout: echoed ? echoed[1] : text, exitCode: 0 };
  };
  for (const [p, body] of Object.entries(files)) {
    await sb.writeFile(session.id, p, body);
  }
  return { sb, session };
}

function spanishError(err, code) {
  assert.ok(err instanceof CodingSandboxError, err && err.stack);
  assert.equal(err.code, code);
  assert.match(
    err.message,
    /[áéíóúñÁÉÍÓÚÑ]|desactiv|sesión|sandbox|ruta|harness|turno|Tope|tiempo|Cancelad|archivo|válid|prompt|ejecución|permiso|deneg/i,
  );
  return true;
}

function scriptedLlm(turns) {
  let i = 0;
  return async function llmTurn() {
    const next = turns[Math.min(i, turns.length - 1)];
    i += 1;
    return typeof next === 'function' ? next() : next;
  };
}

function pendingId(run) {
  assert.ok(run.pendingPermissions && run.pendingPermissions.length >= 1, 'expected a pending permission');
  return run.pendingPermissions[0].id;
}

test('this suite never assigns process.env.AGENTES_CODING_V2', () => {
  const src = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(src, /process\.env\.AGENTES_CODING_V2\s*=/);
});

test('implementation is pattern fusion only (no Cline dump, no /code, no VS Code)', () => {
  const root = path.join(__dirname, '../src/services/agentes-coding/harness');
  const files = [];
  const walk = (dir) => {
    for (const file of fs.readdirSync(dir)) {
      const full = path.join(dir, file);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (file.endsWith('.js')) files.push(full);
    }
  };
  walk(root);
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /daytona|OpenRouter|\/code\/page/i, file);
    assert.doesNotMatch(src, /sk-[A-Za-z0-9]{10,}/, file);
    assert.doesNotMatch(src, /globalThis\.fetch|require\(['"]node-fetch['"]\)/, file);
    assert.doesNotMatch(src, /require\(['"]@cline|require\(['"]cline['"]\)|vscode\.window|WebviewPanel/i, file);
  }
});

test('error catalog includes permission codes in Spanish', () => {
  for (const code of ['E_PERMISSION_DENIED', 'E_PERMISSION_NOT_FOUND']) {
    assert.ok(CATALOG[code], code);
    assert.match(CATALOG[code].message, /[áéíóúñÁÉÍÓÚÑ]|permiso|deneg/i);
  }
});

test('default policy: read/list/safe write allow; exec and unsafe write ask', () => {
  assert.equal(isSafeWritePath('src/app.ts'), true);
  assert.equal(isSafeWritePath('notes/ok.md'), true);
  assert.equal(isSafeWritePath('README.md'), true);
  assert.equal(isSafeWritePath('.env'), false);
  assert.equal(isSafeWritePath('secrets/key.txt'), false);
  assert.equal(defaultPermissionPolicy('read', { path: 'src/app.ts' }).verdict, 'allow');
  assert.equal(defaultPermissionPolicy('list', { path: '.' }).verdict, 'allow');
  assert.equal(defaultPermissionPolicy('write', { path: 'src/app.ts' }).verdict, 'allow');
  assert.equal(defaultPermissionPolicy('write', { path: '.env' }).verdict, 'ask');
  assert.equal(defaultPermissionPolicy('exec', { command: 'npm test' }).verdict, 'ask');
  assert.equal(normalizeDecision('once'), 'allow_once');
  assert.equal(normalizeDecision('always'), 'allow_always');
  assert.equal(normalizeDecision('deny'), 'reject');
  assert.equal(authorizeAction('exec', { command: 'ls' }).needsPermission, true);
});

test('listPermissionsForRequest refuses when the flag is off', async () => {
  const sb = createCodingSandbox({ env: { AGENTES_CODING_V2: '0' }, autoGc: false });
  await assert.rejects(
    () => sessionHarness.listPermissionsForRequest(sb, 'csb_x', 'hrn_x', { AGENTES_CODING_V2: '0' }),
    (err) => spanishError(err, 'E_FLAG_OFF'),
  );
  await assert.rejects(
    () => sessionHarness.resolveForRequest(sb, 'csb_x', 'hrn_x', 'prm_x', 'allow_once', { AGENTES_CODING_V2: '0' }),
    (err) => spanishError(err, 'E_FLAG_OFF'),
  );
});

test('exec pauses the run; allow_once resumes the bounded loop', async () => {
  const { sb, session } = await seeded();
  const out = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    prompt: 'corre tests',
    llmTurn: scriptedLlm([
      { text: 'ejecuto', toolCalls: [{ name: 'exec', arguments: { command: 'echo ok' } }] },
      { text: 'listo', toolCalls: [] },
    ]),
  });
  assert.equal(out.status, 'awaiting_permission');
  assert.equal(out.pendingPermissions.length, 1);
  assert.equal(out.pendingPermissions[0].tool, 'exec');
  assert.equal(out.pendingPermissions[0].reason, 'exec_requires_approval');
  assert.match(out.pendingPermissions[0].id, /^prm_[a-f0-9]+$/);
  assert.ok(out.steps.some((s) => s.kind === 'permission_request'));
  assert.equal(out.finishedAt, null);

  const listed = await sessionHarness.listPermissions(sb, session.id, out.id);
  assert.equal(listed.permissions.length, 1);
  assert.equal(listed.permissions[0].id, out.pendingPermissions[0].id);

  const resumed = await sessionHarness.resolvePermission(
    sb,
    session.id,
    out.id,
    pendingId(out),
    'allow_once',
  );
  assert.equal(resumed.ok, true);
  assert.equal(resumed.decision, 'allow_once');
  assert.equal(resumed.remembered, false);
  assert.equal(resumed.run.status, 'done');
  assert.equal(resumed.run.text, 'listo');
  const execResult = resumed.run.steps.find((s) => s.kind === 'tool_result' && s.tool === 'exec');
  assert.equal(execResult.ok, true);
  assert.match(execResult.preview, /ok/);
  assert.equal(resumed.run.pendingPermissions.length, 0);
  assert.doesNotMatch(JSON.stringify(resumed), /model_id|OpenRouter|sk-/i);
});

test('reject stops the run with E_PERMISSION_DENIED', async () => {
  const { sb, session } = await seeded();
  const out = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    prompt: 'borra todo',
    llmTurn: scriptedLlm([
      { text: 'rm', toolCalls: [{ name: 'exec', arguments: { command: 'rm -rf .' } }] },
    ]),
  });
  assert.equal(out.status, 'awaiting_permission');
  const resolved = await sessionHarness.resolvePermission(
    sb,
    session.id,
    out.id,
    pendingId(out),
    'reject',
  );
  assert.equal(resolved.decision, 'reject');
  assert.equal(resolved.run.status, 'cancelled');
  assert.equal(resolved.run.error.code, 'E_PERMISSION_DENIED');
  assert.match(resolved.run.error.message, /permiso|deneg/i);
  assert.ok(resolved.run.steps.some((s) => s.kind === 'permission_resolved'));
  const listed = await sb.exec(session.id, 'echo still-here');
  assert.equal(listed.ok, true);
});

test('allow_always skips re-ask for the same tool in the session', async () => {
  const { sb, session } = await seeded();
  const first = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    prompt: 'echo 1',
    llmTurn: scriptedLlm([
      { text: 'uno', toolCalls: [{ name: 'exec', arguments: { command: 'echo one' } }] },
      { text: 'hecho1', toolCalls: [] },
    ]),
  });
  assert.equal(first.status, 'awaiting_permission');
  const allowed = await sessionHarness.resolvePermission(
    sb,
    session.id,
    first.id,
    pendingId(first),
    'allow_always',
  );
  assert.equal(allowed.remembered, true);
  assert.equal(allowed.run.status, 'done');

  const second = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    prompt: 'echo 2',
    llmTurn: scriptedLlm([
      { text: 'dos', toolCalls: [{ name: 'bash', arguments: { command: 'echo two' } }] },
      { text: 'hecho2', toolCalls: [] },
    ]),
  });
  assert.equal(second.status, 'done');
  assert.equal(second.pendingPermissions.length, 0);
  assert.ok(second.steps.some((s) => s.kind === 'tool_result' && s.tool === 'exec' && s.ok));
});

test('write outside the safe allowlist asks; write under src/ does not', async () => {
  const { sb, session } = await seeded();
  const unsafe = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    prompt: 'escribe secreto',
    llmTurn: scriptedLlm([
      { text: 'env', toolCalls: [{ name: 'write', arguments: { path: '.env', content: 'K=1' } }] },
      { text: 'escrito', toolCalls: [] },
    ]),
  });
  assert.equal(unsafe.status, 'awaiting_permission');
  assert.equal(unsafe.pendingPermissions[0].reason, 'write_outside_allowlist');
  const resumed = await sessionHarness.resolvePermission(
    sb,
    session.id,
    unsafe.id,
    pendingId(unsafe),
    'allow_once',
  );
  assert.equal(resumed.run.status, 'done');
  const buf = await sb.readFile(session.id, '.env');
  assert.equal(buf.toString('utf8'), 'K=1');

  const safe = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    prompt: 'escribe src',
    llmTurn: scriptedLlm([
      { text: 'src', toolCalls: [{ name: 'write', arguments: { path: 'src/ok.ts', content: 'x' } }] },
      { text: 'ok', toolCalls: [] },
    ]),
  });
  assert.equal(safe.status, 'done');
  assert.equal(safe.pendingPermissions.length, 0);
});

test('injectable policy can force ask on read and deny exec', async () => {
  const { sb, session } = await seeded();
  const asked = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    prompt: 'lee',
    permissionPolicy: () => ({ verdict: 'ask', reason: 'tool_requires_approval' }),
    llmTurn: scriptedLlm([
      { text: 'leo', toolCalls: [{ name: 'read', arguments: { path: 'README.md' } }] },
      { text: 'demo', toolCalls: [] },
    ]),
  });
  assert.equal(asked.status, 'awaiting_permission');
  assert.equal(asked.pendingPermissions[0].tool, 'read');
  const resumed = await sessionHarness.resolvePermission(
    sb,
    session.id,
    asked.id,
    pendingId(asked),
    'once',
  );
  assert.equal(resumed.run.status, 'done');
  assert.match(resumed.run.steps.find((s) => s.kind === 'tool_result').preview, /demo/);

  await assert.rejects(
    () => sessionHarness.runSession(sb, session.id, {
      env: ON,
      prompt: 'exec denegado',
      permissionPolicy: () => ({ verdict: 'deny', reason: 'policy_denied' }),
      llmTurn: scriptedLlm([
        { text: 'no', toolCalls: [{ name: 'exec', arguments: { command: 'echo x' } }] },
      ]),
    }),
    (err) => spanishError(err, 'E_PERMISSION_DENIED'),
  );
});

test('unknown permission id is E_PERMISSION_NOT_FOUND', async () => {
  const { sb, session } = await seeded();
  const out = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    prompt: 'exec',
    llmTurn: scriptedLlm([
      { text: 'x', toolCalls: [{ name: 'exec', arguments: { command: 'echo x' } }] },
    ]),
  });
  await assert.rejects(
    () => sessionHarness.resolvePermission(sb, session.id, out.id, 'prm_missing', 'allow_once'),
    (err) => spanishError(err, 'E_PERMISSION_NOT_FOUND'),
  );
});

test('invalid decision is E_PARAMS', async () => {
  const { sb, session } = await seeded();
  const out = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    prompt: 'exec',
    llmTurn: scriptedLlm([
      { text: 'x', toolCalls: [{ name: 'exec', arguments: { command: 'echo x' } }] },
    ]),
  });
  await assert.rejects(
    () => sessionHarness.resolvePermission(sb, session.id, out.id, pendingId(out), 'maybe'),
    (err) => spanishError(err, 'E_PARAMS'),
  );
});

test('awaiting_permission blocks a second harness run', async () => {
  const { sb, session } = await seeded();
  const first = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    prompt: 'uno',
    llmTurn: scriptedLlm([
      { text: 'x', toolCalls: [{ name: 'exec', arguments: { command: 'echo x' } }] },
    ]),
  });
  assert.equal(first.status, 'awaiting_permission');
  await assert.rejects(
    () => sessionHarness.runSession(sb, session.id, {
      env: ON,
      prompt: 'dos',
      llmTurn: scriptedLlm([{ text: 'no', toolCalls: [] }]),
    }),
    (err) => spanishError(err, 'E_QUOTA'),
  );
});

test('cancel works while awaiting permission', async () => {
  const { sb, session } = await seeded();
  const out = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    prompt: 'cancela permiso',
    llmTurn: scriptedLlm([
      { text: 'x', toolCalls: [{ name: 'exec', arguments: { command: 'echo x' } }] },
    ]),
  });
  const cancelled = await sessionHarness.cancelRun(sb, session.id, out.id);
  assert.equal(cancelled.run.status, 'cancelled');
  assert.equal(cancelled.run.error.code, 'E_CANCELLED');
  assert.equal(cancelled.run.pendingPermissions.length, 0);
});

test('permission HTTP routes are 404 when the flag is off', { skip: !express }, async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({ env: {}, sandbox: sandbox() }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    const paths = [
      ['GET', '/api/agentes-coding/sessions/csb_x/harness/hrn_x/permissions'],
      ['POST', '/api/agentes-coding/sessions/csb_x/harness/hrn_x/permissions/prm_x/resolve'],
    ];
    for (const [method, urlPath] of paths) {
      const sendBody = method === 'POST';
      const { status, body } = await new Promise((resolve, reject) => {
        const headers = { connection: 'close' };
        if (sendBody) headers['Content-Type'] = 'application/json';
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method,
          headers,
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
          }));
        });
        req.on('error', reject);
        req.end(sendBody ? '{"decision":"allow_once"}' : undefined);
      });
      assert.equal(status, 404, `${method} ${urlPath}`);
      assert.equal(body.error, 'not_found');
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('HTTP pause → allow_once resumes when the flag is on', { skip: !express }, async () => {
  const { sb, session } = await seeded();
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({
    env: ON,
    sandbox: sb,
    authenticate: (req, _res, next) => { req.user = { id: 'coding-owner' }; next(); },
    harnessLlm: scriptedLlm([
      { text: 'echo', toolCalls: [{ name: 'exec', arguments: { command: 'echo http' } }] },
      { text: 'hecho', toolCalls: [] },
    ]),
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const request = (method, urlPath, body) => new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const ran = await request('POST', `/api/agentes-coding/sessions/${session.id}/harness/run`, {
      prompt: 'echo por http',
    });
    assert.equal(ran.status, 201);
    assert.equal(ran.json.run.status, 'awaiting_permission');
    const permId = ran.json.run.pendingPermissions[0].id;
    const listed = await request(
      'GET',
      `/api/agentes-coding/sessions/${session.id}/harness/${ran.json.run.id}/permissions`,
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.json.permissions[0].id, permId);
    const resolved = await request(
      'POST',
      `/api/agentes-coding/sessions/${session.id}/harness/${ran.json.run.id}/permissions/${permId}/resolve`,
      { decision: 'allow_once' },
    );
    assert.equal(resolved.status, 200);
    assert.equal(resolved.json.run.status, 'done');
    assert.equal(resolved.json.decision, 'allow_once');
    assert.match(resolved.json.run.steps.find((s) => s.kind === 'tool_result').preview, /http/);
    assert.doesNotMatch(JSON.stringify(resolved.json), /model_id|OpenRouter/i);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('route source mounts permission paths behind the flag helper', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/agentes-coding.js'), 'utf8');
  assert.match(src, /\/sessions\/:id\/harness\/:runId\/permissions/);
  assert.match(src, /permissions\/:permissionId\/resolve/);
  assert.match(src, /isAgentesCodingV2Enabled/);
  assert.match(src, /error: 'not_found'/);
  assert.doesNotMatch(src, /daytona|OpenRouter|\/code\/page/i);
  assert.doesNotMatch(src, /sk-[A-Za-z0-9]{8,}/);
});
