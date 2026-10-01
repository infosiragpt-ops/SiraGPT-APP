'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { isGithubConnectRequest, needsGithubConnection, createGithubChatHandoff } = require('../src/services/github/github-chat-handoff');

test('explicit GitHub login requests, not explanations, negations or repo instructions', () => {
  for (const text of ['pásame el link de GitHub para loguearme', 'conecta GitHub', 'quiero iniciar sesión en GitHub', 'abre GitHub para acceder', 'connect my GitHub account']) {
    assert.equal(isGithubConnectRequest(text), true, text);
  }
  for (const text of ['¿Cómo conecto GitHub?', 'do not connect GitHub', "don't open GitHub", 'never authorize GitHub', 'explica OAuth en GitHub', 'no quiero que conectes GitHub', 'no me abras GitHub', 'para qué sirve conectar GitHub', 'desconecta GitHub', 'revisa mi GitHub', 'abre https://github.com/example/repo', 'conecta el repositorio GitHub', '```conecta GitHub```', 'haz una web']) {
    assert.equal(isGithubConnectRequest(text), false, text);
  }
});

test('handoff recognizes only exact authentication errors from known GitHub tools', () => {
  assert.equal(needsGithubConnection('project_open_pull_request', { ok: false, code: 'github_auth_required' }), true);
  assert.equal(needsGithubConnection('github_open_repo', { code: 'E_GITHUB_CONNECT' }), true);
  for (const [tool, obs] of [
    ['read_url', { code: 'github_auth_required' }],
    ['project_open_pull_request', { ok: true, code: 'github_auth_required' }],
    ['project_open_pull_request', { ok: false, code: 'permission_required' }],
    ['github_open_repo', { ok: false, message: 'github_not_connected' }],
    ['github_open_repo', { ok: false, status: 503 }],
  ]) assert.equal(needsGithubConnection(tool, obs), false);
});

test('handoff emits once, scopes the chat and never sends credentials or a URL', async () => {
  const frames = [];
  const h = createGithubChatHandoff({ userId: 'u-1', chatId: 'chat-1', emit: frame => frames.push(frame) });
  await Promise.all([h.request(), h.observe('github_open_repo', { code: 'github_not_connected' })]);
  assert.equal(frames.length, 1);
  assert.deepEqual(Object.keys(frames[0]).sort(), ['chatId', 'handoffId', 'type']);
  assert.match(frames[0].handoffId, /^[a-f0-9-]{36}$/);
  assert.equal(frames[0].chatId, 'chat-1');
  for (const input of [{ userId: null, chatId: 'chat-1' }, { userId: 'u-1', chatId: '../other' }, { userId: 'u-1', chatId: 'c'.repeat(65) }, { userId: 'u-1', chatId: 'chat-1', signal: AbortSignal.abort() }]) {
    const denied = createGithubChatHandoff({ ...input, emit: () => assert.fail('must not emit') });
    assert.equal(await denied.request(), null);
  }
});

test('connecting an account bypasses coding provisioning even in an existing coding chat', async () => {
  const { prepareChatCodingWorkspace } = require('../src/services/codex/chat-coding-workspace');
  const out = await prepareChatCodingWorkspace({ user: { id: 'u-1' }, chatId: 'chat-1', prompt: 'pásame el link de GitHub para loguearme' }, {
    detect: () => assert.fail('OAuth is not a coding intent'),
  });
  assert.deepEqual(out, { ok: true, active: false });
});

test('real chat preloop requests GitHub consent without asking the model to invent a URL', async () => {
  const res = new PassThrough(); const frames = [];
  res.on('data', bytes => { for (const row of String(bytes).split('\n')) if (row.startsWith('data: ')) frames.push(JSON.parse(row.slice(6))); });
  res.setHeader = () => {};
  try {
    const out = await require('../src/services/agentic-chat-stream').runAgenticChat({
      openai: { chat: { completions: { create: () => assert.fail('OAuth must not invoke the LLM') } } },
      model: 'test-selected-model', userQuery: 'pásame el link de GitHub para loguearme', res,
      toolContext: { userId: 'u-1', chatId: 'chat-1', codingWorkspace: { projectId: 'p-1' } },
    });
    assert.equal(out.stoppedReason, 'github_connection_required');
    assert.equal(require('../src/services/agentic-chat-stream').isHandledAgenticChatResult(out), true);
    assert.equal(frames.filter(frame => frame.type === 'github_connection_required').length, 1);
    assert.doesNotMatch(out.finalAnswer, /https:|client_id|state|\/conexiones|ya.*conectad/i);
  } finally { res.destroy(); }
});

test('real chat stops after a missing GitHub connection, before another model or write call', async () => {
  const res = new PassThrough(); const frames = [];
  res.on('data', bytes => { for (const row of String(bytes).split('\n')) if (row.startsWith('data: ')) { try { frames.push(JSON.parse(row.slice(6))); } catch {} } });
  res.setHeader = () => {}; let calls = 0;
  try {
    const out = await require('../src/services/agentic-chat-stream').runAgenticChat({
      openai: { chat: { completions: { create: async () => {
        calls++; assert.equal(calls, 1);
        return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'github-1', type: 'function', function: { name: 'github_list_repos', arguments: '{}' } }] } }] };
      } } } },
      model: 'test-selected-model', userQuery: 'Lista mis repositorios disponibles.', res, maxSteps: 3,
      toolsOverride: [{ name: 'github_list_repos', description: 'List owned repos', parameters: { type: 'object', properties: {} }, execute: async () => ({ ok: false, code: 'github_not_connected' }) }],
      toolContext: { userId: 'u-1', chatId: 'chat-1', permission: 'workspace' },
    });
    assert.equal(calls, 1, JSON.stringify(out.steps));
    assert.equal(out.stoppedReason, 'github_connection_required');
    assert.equal(frames.filter(frame => frame.type === 'github_connection_required').length, 1);
    assert.match(out.finalAnswer, /pendiente de tu autorización/);
  } finally { res.destroy(); }
});

// The automatic continuation must use the canonical server-side workspace
// follow-up path; a client codingWorkspace flag is deliberately not authority.
test('the actual browser continuation resumes an existing project without creating one', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../lib/chat/github-connect-handoff.ts'), 'utf8');
  const literal = source.match(/export const GITHUB_RESUME_TEXT = ("[^\n]*")/);
  assert.ok(literal, 'the browser exposes its fixed continuation copy');
  const prompt = JSON.parse(literal[1]);
  const { detectCodingIntent } = require('../src/services/agents/software-build-intent');
  assert.equal(detectCodingIntent(prompt, { hasWorkspace: true }).kind, 'followup');
  assert.equal(detectCodingIntent(prompt, { hasWorkspace: false }).active, false);
  assert.equal(isGithubConnectRequest(prompt), false, 'the continuation must not start OAuth again');
});
