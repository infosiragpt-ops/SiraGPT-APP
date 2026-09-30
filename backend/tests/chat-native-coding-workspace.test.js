'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const binding = require('../src/services/codex/project-chat-binding');
const { prepareChatCodingWorkspace, codingWorkspaceEvent } = require('../src/services/codex/chat-coding-workspace');

function fixture() {
  const rows = [], reads = [], creates = [];
  const db = {
    chat: { findFirst: async ({ where }) => {
      reads.push(['chat', where]);
      return where.id === 'chat1' && where.userId === 'u1' && where.deletedAt === null ? { id: 'chat1' } : null;
    } },
    codexProject: { findMany: async ({ where, take }) => {
      reads.push(['binding', where]);
      return rows.filter((row) => row.userId === where.userId && row.brief.chatId === where.brief.equals).slice(0, take);
    } },
  };
  const projects = {
    getProject: async ({ userId, id }) => rows.find((row) => row.userId === userId && row.id === id) || null,
    createProject: async (args) => {
      creates.push(args);
      const row = { id: `p${rows.length + 1}`, status: 'ready', userId: args.userId, name: args.name, brief: args.brief };
      rows.push(row);
      return row;
    },
  };
  const input = { user: { id: 'u1' }, chatId: 'chat1', db, prompt: 'Crea una app para vender café con autenticación y PostgreSQL' };
  const deps = { binding, projects, enabled: () => true, canUse: () => true };
  return { input, deps, rows, reads, creates };
}

test('a clear first coding request prepares a named durable project without a client mode flag', async () => {
  const f = fixture();
  const pending = await prepareChatCodingWorkspace({ ...f.input, provision: false }, f.deps);
  assert.equal(pending.ok, true);
  assert.equal(pending.active, true);
  assert.equal(pending.projectId, null);
  assert.equal(f.creates.length, 0, 'quota/provider preflight performs no provisioning');
  assert.equal(codingWorkspaceEvent('chat1', pending), null);
  const ready = await prepareChatCodingWorkspace(f.input, f.deps);
  assert.equal(ready.active, true);
  assert.equal(ready.reused, false);
  assert.equal(ready.projectId, 'p1');
  assert.match(ready.projectName, /app.*café/i);
  assert.deepEqual(f.rows[0].brief, { chatId: 'chat1', source: 'agentes', instructions: 'frontend y backend' });
  assert.deepEqual(codingWorkspaceEvent('chat1', ready), { type: 'coding_workspace', chatId: 'chat1', projectId: 'p1', projectName: ready.projectName });
  const reload = await binding.findProjectForChat({ userId: 'u1', chatId: 'chat1', db: f.input.db, projects: f.deps.projects });
  assert.equal(reload.id, ready.projectId);
});

test('concurrent first turns create once and every later coding follow-up resolves the same project', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 20 }, () => prepareChatCodingWorkspace(f.input, f.deps)));
  assert.equal(f.creates.length, 1);
  assert.equal(results.filter((row) => row.reused === false).length, 1);
  assert.ok(results.every((row) => row.ok && row.projectId === 'p1'));
  const next = await prepareChatCodingWorkspace({ ...f.input, prompt: 'Añade un botón para guardar y ejecuta las pruebas' }, f.deps);
  assert.equal(next.projectId, 'p1');
  assert.equal(next.reused, true);
  assert.equal(f.creates.length, 1);
});

test('greetings, documents, skills, explanations and modality turns never read the coding store or create tools', async () => {
  const f = fixture();
  f.rows.push({ id: 'old', name: 'Existing', status: 'ready', userId: 'u1', brief: { chatId: 'chat1' } });
  for (const [prompt, extra] of [
    ['hola', {}], ['ok', {}], ['gracias', {}],
    ['Edita el Word y conserva su formato', { hasAttachments: true }],
    ['Genera un Excel de ventas', {}], ['Explica qué hace este código JavaScript', {}],
    ['Crea una app de ventas', { modality: 'images' }],
    ['resume este documento', { hasAttachments: true }],
    ['hola', { hasAttachments: true, codingWorkspace: true }],
  ]) {
    assert.deepEqual(await prepareChatCodingWorkspace({ ...f.input, prompt, ...extra }, f.deps), { ok: true, active: false }, prompt);
  }
  assert.equal(f.reads.length, 0);
  assert.equal(f.creates.length, 0);
});

test('account, ownership and disabled-tool gates fail before any provisioning', async () => {
  for (const patch of [{ enabled: () => false }, { canUse: () => false }]) {
    const f = fixture();
    assert.equal((await prepareChatCodingWorkspace(f.input, { ...f.deps, ...patch })).status, 403);
    assert.equal(f.reads.length, 0);
    assert.equal(f.creates.length, 0);
  }
  const f = fixture();
  assert.equal((await prepareChatCodingWorkspace({ ...f.input, user: { id: 'u2' } }, f.deps)).status, 404);
  assert.equal((await prepareChatCodingWorkspace({ ...f.input, chatId: 'foreign' }, f.deps)).status, 404);
  assert.equal((await prepareChatCodingWorkspace({ ...f.input, chatId: '../escape' }, f.deps)).status, 400);
  assert.equal((await prepareChatCodingWorkspace({ ...f.input, disableAgentic: true }, f.deps)).error, 'coding_tools_disabled');
  assert.equal(f.creates.length, 0);
});

test('unavailable store and failed provisioning do not invent a successful workspace or leak internals', async () => {
  const f = fixture();
  f.input.db.codexProject.findMany = async () => { throw new Error('INTERNAL_SENTINEL'); };
  const failure = await prepareChatCodingWorkspace(f.input, f.deps);
  assert.equal(failure.status, 503);
  assert.equal(failure.error, 'coding_unavailable');
  assert.ok(!JSON.stringify(failure).includes('INTERNAL_SENTINEL'));
  assert.equal(f.creates.length, 0);
  const broken = fixture();
  broken.deps.projects.createProject = async () => ({ id: 'broken', status: 'error', name: 'Broken', error: 'INTERNAL_SENTINEL' });
  const failed = await prepareChatCodingWorkspace(broken.input, broken.deps);
  assert.equal(failed.error, 'coding_provision_failed');
  assert.equal(codingWorkspaceEvent('chat1', failed), null);
  assert.ok(!JSON.stringify(failed).includes('INTERNAL_SENTINEL'));
});

test('a repository request without source asks for its URL instead of creating an empty project', async () => {
  const f = fixture();
  for (const [prompt, expected] of [
    ['Revisa mi repositorio de GitHub y arregla los errores', 'coding_repository_url_required'],
    ['Corrige la función de Python', 'coding_source_required'],
  ]) {
    const result = await prepareChatCodingWorkspace({ ...f.input, prompt }, f.deps);
    assert.equal(result.error, expected);
    assert.equal(result.status, 409);
  }
  assert.equal(f.creates.length, 0);
});

test('repository preparation uses the existing importer, then safely reuses only that repository', async () => {
  const f = fixture(), calls = [];
  const preview = { cloneRepoForChat: async (args) => {
    calls.push(args);
    const row = { id: 'repo1', status: 'ready', name: args.name, userId: 'u1', brief: { chatId: 'chat1' }, sourceControl: { repository: `${args.repoUrl}.git` } };
    f.rows.push(row);
    return { ok: true, reused: false, project: row };
  } };
  const input = { ...f.input, prompt: 'Revisa y arregla https://github.com/example/shop' };
  const ready = await prepareChatCodingWorkspace(input, { ...f.deps, preview });
  assert.equal(ready.projectId, 'repo1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].repoUrl, 'https://github.com/example/shop');
  assert.equal(f.creates.length, 0);
  const reused = await prepareChatCodingWorkspace(input, { ...f.deps, preview });
  assert.equal(reused.reused, true);
  assert.equal(reused.projectId, 'repo1');
  const other = await prepareChatCodingWorkspace({ ...input, prompt: 'Arregla https://github.com/example/other' }, { ...f.deps, preview });
  assert.equal(other.error, 'coding_chat_already_bound');
  assert.equal(calls.length, 1);
});

test('repository import failures remain visible, sanitized and cannot become an empty-app fallback', async () => {
  for (const [code, status] of [['github_auth_required', 409], ['repository_not_found', 404], ['clone_failed', 503], ['toString', 503]]) {
    const f = fixture();
    const result = await prepareChatCodingWorkspace({ ...f.input, prompt: 'Revisa https://github.com/example/shop' }, {
      ...f.deps, preview: { cloneRepoForChat: async () => ({ ok: false, code, message: 'INTERNAL_SENTINEL' }) },
    });
    assert.equal(result.status, status);
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes('INTERNAL_SENTINEL'));
    assert.equal(f.creates.length, 0);
  }
});


test('binding persists only safe provisioning instructions instead of duplicating a prompt with credentials', async () => {
  const f = fixture();
  f.input.prompt += '; password: DO_NOT_COPY_THIS_VALUE';
  const result = await prepareChatCodingWorkspace(f.input, f.deps);
  assert.equal(result.ok, true);
  assert.equal(f.rows[0].brief.instructions, 'frontend y backend');
  assert.ok(!JSON.stringify(f.rows[0].brief).includes('DO_NOT_COPY_THIS_VALUE'));
  assert.ok(!JSON.stringify(codingWorkspaceEvent('chat1', result)).includes('DO_NOT_COPY_THIS_VALUE'));
});


test('an explicit first-turn inline code fix creates a project once and preserves source only in the chat prompt', async () => {
  for (const prompt of [
    'Corrige este código: \n```python\ndef sum(a,b):\n    return a-b\n```',
    'Revisa este código: \n```javascript\nfunction sum(a,b) {return a-b;}\n```',
  ]) {
    const f = fixture();
    const input = { ...f.input, prompt };
    const first = await prepareChatCodingWorkspace(input, f.deps);
    assert.equal(first.ok, true);
    assert.equal(first.active, true);
    assert.equal(first.projectId, 'p1');
    assert.equal(f.creates.length, 1);
    assert.equal(f.rows[0].brief.instructions, 'frontend');
    assert.ok(!JSON.stringify(f.rows[0].brief).includes('return a-b'));
    const again = await prepareChatCodingWorkspace(input, f.deps);
    assert.equal(again.projectId, first.projectId);
    assert.equal(again.reused, true);
    assert.equal(f.creates.length, 1);
  }
});

test('Office documents, generic fences, empty code and educational text cannot provision an inline workspace', async () => {
  for (const prompt of [
    'Revisa este documento en Word: \n```python\nprint(1)\n```',
    'Explica este código: \n```python\nprint(1)\n```',
    'hola \n```python\nprint(1)\n```',
    'Corrige este código: \n```markdown\nUn texto cualquiera\n```',
    'Corrige este código: \n```python\n  \n```',
  ]) {
    const f = fixture();
    const result = await prepareChatCodingWorkspace({ ...f.input, prompt }, f.deps);
    assert.ok(!result.active, prompt);
    assert.equal(f.creates.length, 0, prompt);
  }
});
