'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCodingFinalizeGuard } = require('../src/services/codex/coding-finalize-guard');
const { codingTools, createTeamUsageRecorder } = require('../src/services/codex/chat-coding-workspace');
const { projectPreviewStatusTool } = require('../src/services/agents/project-preview-tools');
const { projectExecTool } = require('../src/services/agents/project-workspace-tools');
const identity = { userId: 'u', chatId: 'c', projectId: 'p' };
const ctx = { userId: 'u', chatId: 'c', codingWorkspace: { projectId: 'p' } };
const content = 'module.exports = 42;\n';
const action = (tool, args, observation) => ({ tool, args, observation });
const read = (extra = {}) => action('project_read', { path: 'answer.js' }, { ok: true, path: 'answer.js', content, offset: 0, truncated: false, ...extra });
const write = (args = {}, extra = {}) => action('project_write', { proposalId: 'proposal', ...args }, { ok: true, applied: true, proposalId: 'proposal', path: 'answer.js', content, bytes: Buffer.byteLength(content), ...extra });
const execution = () => action('project_exec', { cmd: ['node', '--test'] }, { ok: true, exitCode: 0, stdout: '# pass 1\n# fail 0\n', stderr: '', timedOut: false, truncated: false });
function verify(actions, options = {}) {
  return createCodingFinalizeGuard({ userQuery: 'Corrige el código', ...identity, ...options })({ answer: 'Cambios comprobados.', steps: [{ actions }], ctx });
}
test('proposal application is verified against exact content, followed by real execution and readback', () => {
  assert.equal(verify([write(), execution(), read()]).ok, true);
  for (const patch of [{ applied: false }, { proposalId: 'other' }, { content: undefined }, { bytes: 1 }]) {
    assert.equal(verify([write({}, patch), execution(), read()]).ok, false);
  }
  assert.equal(verify([write({ path: 'different.js' }), execution(), read()]).ok, false);
});
test('proposal reads and subagent reports cannot count as applied files or readback', () => {
  for (const draftRead of [read({ proposal: true }), { ...read(), args: { path: 'answer.js', proposalId: 'proposal' } }]) {
    assert.equal(verify([write(), execution(), draftRead]).code, 'E_CODING_READBACK_REQUIRED');
  }
  assert.equal(verify([action('run_subagent', {}, { ok: true, summary: 'Applied and tested.' }), execution(), read()]).code, 'E_CODING_WRITE_REQUIRED');
});
test('native chat preview requires a fresh real-browser proof and rejects mere server readiness', () => {
  const browser = action('project_preview_status', { verify: true }, { ok: true, project: { id: 'p' },
    status: { ready: true, running: true }, previewUrl: 'https://example.test/app/',
    verification: { kind: 'browser', mode: 'read_only', rendered: true, expectedTextFound: true, errors: [] } });
  const options = { userQuery: 'Crea una web', requireBrowserVerification: true };
  assert.equal(verify([write(), execution(), read(), browser], options).ok, true);
  for (const patch of [{ verification: undefined }, { verification: { ...browser.observation.verification, rendered: false } },
    { verification: { ...browser.observation.verification, expectedTextFound: false } },
    { verification: { ...browser.observation.verification, errors: ['page_error'] } }]) {
    assert.equal(verify([write(), execution(), read(), { ...browser, observation: { ...browser.observation, ...patch } }], options).code, 'E_CODING_BROWSER_REQUIRED');
  }
  assert.equal(verify([browser, write(), execution(), read()], options).code, 'E_CODING_PREVIEW_REQUIRED');
});
test('child usage is counted exactly once while preserving the selected parent identity', () => {
  let total = { inputTokens: 100, outputTokens: 20, tokensEstimate: 120, costUsd: 0.03 };
  const record = createTeamUsageRecorder({ getUsage: () => total });
  const step = { usage: { inputTokens: 5, outputTokens: 4, tokensEstimate: 9, costUsd: 0.01, model: 'selected', provider: 'selected-provider' } };
  record(step); record(step);
  assert.deepEqual(step.usage, { inputTokens: 105, outputTokens: 24, tokensEstimate: 129, costUsd: 0.04, model: 'selected', provider: 'selected-provider' });
  total = { inputTokens: 125, outputTokens: 25, tokensEstimate: 150, costUsd: 0.04 };
  const next = { usage: { tokensEstimate: 2, costUsd: 0.001 } }; record(next);
  assert.equal(next.usage.tokensEstimate, 32);
  assert.ok(Math.abs(next.usage.costUsd - 0.011) < 1e-10);
});
test('coding tool surface includes the team and its revision-aware wrappers without duplicate core tools', () => {
  const wrapper = (tool) => ({ ...tool, marker: true });
  const tools = codingTools({ team: { tool: { name: 'run_subagent' }, wrapWorkspaceTools: (tools) => tools.map(wrapper) } });
  assert.equal(tools.filter(t => t.name === 'run_subagent').length, 1);
  assert.equal(tools.find(t => t.name === 'project_write').marker, true);
  assert.equal(tools.find(t => t.name === 'project_read').marker, true);
  assert.equal(new Set(tools.map(t => t.name)).size, tools.length);
});
test('preview adapter forwards authorized scope and never emits screenshot bytes into model/history', async () => {
  let received;
  const controller = new AbortController();
  const result = await projectPreviewStatusTool.execute({ verify: true, expectedText: 'Inventory' }, { ...ctx, signal: controller.signal,
    projectTools: { previewService: { previewStatusForChat: async () => ({ ok: true, project: { id: 'p' }, status: { ready: true, running: true }, previewUrl: 'https://example.test/app/' }) },
      browserVerifier: async (args) => { received = args; return { ok: true, code: 'browser_verified', projectId: 'p',
        verification: { kind: 'browser', mode: 'read_only', rendered: true, errors: [] }, screenshot: { dataUrl: 'private-screenshot-pixels' } }; } } });
  assert.deepEqual(received, { userId: 'u', chatId: 'c', projectId: 'p', expectedText: 'Inventory', signal: controller.signal });
  assert.equal(result.ok, true); assert.equal(result.screenshotCaptured, true);
  assert.equal(JSON.stringify(result).includes('private-screenshot-pixels'), false);
});
test('unavailable browser is a visible failed result, not a verified preview', async () => {
  const result = await projectPreviewStatusTool.execute({ verify: true }, { ...ctx, projectTools: {
    previewService: { previewStatusForChat: async () => ({ ok: true, project: { id: 'p' }, status: { ready: true, running: true } }) },
    browserVerifier: async () => ({ ok: false, code: 'browser_unavailable' }),
  } });
  assert.equal(result.ok, false); assert.equal(result.code, 'browser_unavailable');
});
test('project execution forwards Stop and never reports success after cancellation', async () => {
  const controller = new AbortController(); let called = 0;
  const context = { ...ctx, signal: controller.signal, projectTools: {
    binding: { findProjectForChat: async () => ({ id: 'p', userId: 'u' }) },
    runner: { exec: async (_id, _cmd, options) => { called++; assert.equal(options.signal, controller.signal); controller.abort(); return { ok: true, exitCode: 0 }; } },
  } };
  assert.equal((await projectExecTool.execute({ cmd: ['node', '--test'] }, context)).code, 'E_CANCELLED');
  assert.equal((await projectExecTool.execute({ cmd: ['node', '--test'] }, context)).code, 'E_CANCELLED');
  assert.equal(called, 1);
});

test('a proposal conflict can be repaired on its known path without erasing another failed write', () => {
  const conflict = write({}, { ok: false, applied: false, code: 'file_conflict' });
  const repair = action('project_write', { path: 'answer.js', content }, { ok: true, path: 'answer.js', bytes: Buffer.byteLength(content) });
  assert.equal(verify([conflict, repair, execution(), read()]).ok, true);
  const other = action('project_write', { path: 'other.js', content }, { ok: false, code: 'file_conflict' });
  assert.equal(verify([other, conflict, repair, execution(), read()]).code, 'E_CODING_CHECK_FAILED');
});
