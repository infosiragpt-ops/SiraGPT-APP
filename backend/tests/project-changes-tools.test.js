'use strict';

// Factory-style loop from /agentes: diff → run branch → sync base → PR.
// Doubles only: no runner, no GitHub, no DB.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tools = require('../src/services/agents/project-changes-tools');
const svc = require('../src/services/codex/chat-changes.service');

const ENV = { CODE_RUNNER_PREVIEW_TOKEN_SECRET: 'x'.repeat(40), PUBLIC_FRONTEND_URL: 'https://siragpt.com' };
const REPO = { repository: 'https://github.com/infosiragpt-ops/SiraGPT-APP.git', webUrl: 'https://github.com/infosiragpt-ops/SiraGPT-APP', fullName: 'infosiragpt-ops/SiraGPT-APP', private: true, defaultBranch: 'production-main', sourceBranch: 'production-main' };

function makeDb(user = { id: 'u1', isAdmin: true, isSuperAdmin: false, deletedAt: null }) {
  return { user: { findUnique: async ({ where }) => (where.id === user.id ? user : null) } };
}
function makeBinding(map = {}) {
  return { cleanChatId: (id) => id, findProjectForChat: async ({ userId, chatId }) => map[`${userId}:${chatId}`] || null };
}
function gitRunner({ oldBase = 'aaa111', newBase = 'aaa111', rebaseFails = false } = {}) {
  const calls = [];
  return {
    calls,
    exec: async (p, cmd) => {
      calls.push(cmd.join(' '));
      const a = cmd.slice(1);
      if (a[0] === 'rev-parse' && a.includes('FETCH_HEAD')) return { exitCode: 0, stdout: `${newBase}\n`, stderr: '' };
      if (a[0] === 'rev-parse') return { exitCode: 0, stdout: `${oldBase}\n`, stderr: '' };
      if (a.includes('fetch')) return { exitCode: 0, stdout: '', stderr: '' };
      if (a[0] === 'rebase' && a[1] === '--onto') return rebaseFails ? { exitCode: 1, stdout: '', stderr: 'CONFLICT (content): x' } : { exitCode: 0, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    readFile: async () => ({ ok: true, content: '' }),
  };
}
const changesDouble = {
  getWorkspaceChanges: async ({ baseBranch }) => ({
    ok: true, base: { branch: baseBranch, sha: 'aaa111' }, head: { branch: 'production-main', sha: 'bbb222', ahead: 0 },
    files: [{ path: 'lib/x.ts', status: 'modified', additions: 3, deletions: 1 }, { path: 'new.md', status: 'untracked', additions: 2, deletions: 0, uncommitted: true }],
    filesChanged: 2, additions: 5, deletions: 1, dirty: true, truncated: false,
    diff: 'diff --git a/lib/x.ts b/lib/x.ts\n+a\n-b\ndiff --git a/new.md b/new.md\n+hola\n',
  }),
  workspaceRunId: () => 'agentes-test-202609171200',
  prepareWorkspaceBranch: async ({ runId, title }) => ({ status: 'prepared', branch: `run/${runId}`, commitSha: 'ccc333', committed: true, title }),
};
const harnessDouble = {
  githubAuthConfigArgs: (t) => (t ? ['-c', 'http.extraheader=AUTH'] : []),
  scrubCredential: (s) => String(s || ''),
  buildPublishPlan: async ({ title, body }) => ({ ok: true, status: 'ready_to_publish', title, body, files: ['lib/x.ts', 'new.md'] }),
};
function hostingDouble(calls) {
  return { publishSelfHostedPullRequest: async (args) => { calls.push(args); return { ok: true, status: 'pull_request_opened', branch: `run/${args.runId}`, commitSha: 'ddd444', files: ['lib/x.ts', 'new.md'], pullRequest: { number: 42, url: 'https://github.com/infosiragpt-ops/SiraGPT-APP/pull/42', state: 'open' } }; } };
}
function ctxFor(extra = {}) {
  return { userId: 'u1', chatId: 'c1', projectTools: { db: makeDb(), runner: gitRunner(), binding: makeBinding({ 'u1:c1': { id: 'pX', name: 'SiraGPT-APP', sourceControl: REPO } }), projectService: {}, githubApi: { resolveUserToken: async () => ({ accessToken: 'gho_secret_token' }) }, env: ENV, workspaceChanges: changesDouble, harness: harnessDouble, ...extra } };
}

test('project_changes: scope + repo guards', async () => {
  assert.equal((await tools.projectChangesTool.execute({}, { userId: 'u1' })).code, 'no_chat_context');
  const none = await tools.projectChangesTool.execute({}, ctxFor({ binding: makeBinding() }));
  assert.equal(none.code, 'no_project');
  const notRepo = await tools.projectChangesTool.execute({}, ctxFor({ binding: makeBinding({ 'u1:c1': { id: 'pZ', name: 'app' } }) }));
  assert.equal(notRepo.code, 'project_not_repo');
});

test('project_changes returns an LLM-sized summary and can scope the diff to one file', async () => {
  const out = await tools.projectChangesTool.execute({}, ctxFor());
  assert.equal(out.ok, true);
  assert.equal(out.base.branch, 'production-main');
  assert.equal(out.filesChanged, 2);
  assert.deepEqual(out.files.map((f) => f.path), ['lib/x.ts', 'new.md']);
  assert.match(out.diff, /diff --git a\/new\.md/);
  const one = await tools.projectChangesTool.execute({ path: 'lib/x.ts' }, ctxFor());
  assert.match(one.diff, /lib\/x\.ts/);
  assert.doesNotMatch(one.diff, /new\.md/);
  const small = await tools.projectChangesTool.execute({ maxDiffChars: 1000 }, ctxFor({ workspaceChanges: { ...changesDouble, getWorkspaceChanges: async (a) => ({ ...(await changesDouble.getWorkspaceChanges(a)), diff: 'x'.repeat(5000) }) } }));
  assert.equal(small.truncated, true);
  assert.match(small.diff, /diff truncado/);
});

test('project_open_pull_request: needs approved:true and a title, and does not touch git otherwise', async () => {
  const runner = gitRunner();
  const hostingCalls = [];
  const ctx = ctxFor({ runner, selfHosting: hostingDouble(hostingCalls) });
  const noApprove = await tools.projectOpenPullRequestTool.execute({ title: 'fix: x' }, ctx);
  assert.equal(noApprove.code, 'approval_required');
  const noTitle = await tools.projectOpenPullRequestTool.execute({ title: '  ', approved: true }, ctx);
  assert.equal(noTitle.code, 'invalid_title');
  assert.equal(runner.calls.length, 0);
  assert.equal(hostingCalls.length, 0);
});

test('project_open_pull_request: GitHub not connected → github_auth_required with /conexiones CTA, no mutation', async () => {
  const hostingCalls = [];
  const runner = gitRunner();
  const out = await tools.projectOpenPullRequestTool.execute({ title: 'fix: x', approved: true }, ctxFor({ runner, githubApi: { resolveUserToken: async () => { const e = new Error('nope'); e.code = 'github_not_connected'; throw e; } }, selfHosting: hostingDouble(hostingCalls) }));
  assert.equal(out.code, 'github_auth_required');
  assert.match(out.message, /conexiones/);
  assert.equal(runner.calls.length, 0);
  assert.equal(hostingCalls.length, 0);
});

test('project_open_pull_request: happy path commits, syncs the base, publishes with the user token and returns prUrl without leaking it', async () => {
  const hostingCalls = [];
  const runner = gitRunner({ oldBase: 'aaa111', newBase: 'eee555' });
  const out = await tools.projectOpenPullRequestTool.execute({ title: 'feat(chat): cosa nueva', body: 'Qué cambia', approved: true }, ctxFor({ runner, selfHosting: hostingDouble(hostingCalls) }));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.prUrl, 'https://github.com/infosiragpt-ops/SiraGPT-APP/pull/42');
  assert.equal(out.base, 'production-main');
  assert.equal(out.branch, 'run/agentes-test-202609171200');
  assert.equal(out.baseSynced.changed, true);
  assert.ok(runner.calls.some((c) => /rebase --onto FETCH_HEAD aaa111 run\/agentes-test-202609171200/.test(c)));
  assert.ok(runner.calls.some((c) => /branch -f production-main FETCH_HEAD/.test(c)));
  assert.equal(hostingCalls.length, 1);
  assert.equal(hostingCalls[0].sourceBranch, 'production-main');
  assert.equal(hostingCalls[0].env.CODEX_SELF_HOST_GITHUB_TOKEN, 'gho_secret_token');
  assert.ok(hostingCalls[0].allowedRepositories.includes('https://github.com/infosiragpt-ops/SiraGPT-APP'));
  assert.equal(JSON.stringify(out).includes('gho_secret_token'), false);
  assert.equal(out.mergePolicy, 'pull_request_only');
});

test('project_open_pull_request: base moved and the rebase conflicts → base_branch_diverged, rebase aborted, nothing published', async () => {
  const hostingCalls = [];
  const runner = gitRunner({ oldBase: 'aaa111', newBase: 'eee555', rebaseFails: true });
  const out = await tools.projectOpenPullRequestTool.execute({ title: 'x', approved: true }, ctxFor({ runner, selfHosting: hostingDouble(hostingCalls) }));
  assert.equal(out.ok, false);
  assert.equal(out.code, 'base_branch_diverged');
  assert.ok(runner.calls.some((c) => c === 'git rebase --abort'));
  assert.equal(hostingCalls.length, 0);
});

test('project_open_pull_request: branch arg becomes run/<id> only when it is a safe run id', () => {
  const { branchToRunId } = svc._internal;
  assert.equal(branchToRunId('run/fix-login-42', 'fallback'), 'fix-login-42');
  assert.equal(branchToRunId('feature/bad name', 'fallback'), 'fallback');
  assert.equal(branchToRunId('', 'fallback'), 'fallback');
});

test('project_pull_request_checks delegates to github-checks with the repo and the user', async () => {
  const seen = [];
  const out = await tools.projectPullRequestChecksTool.execute({ pr: 42 }, ctxFor({ githubChecks: { githubChecksTool: async (args, ctx) => { seen.push([args, ctx]); return { isError: false, summary: '3/3 checks verdes', observation: 'ok', counts: { success: 3 } }; } } }));
  assert.equal(out.ok, true);
  assert.equal(out.summary, '3/3 checks verdes');
  assert.equal(seen[0][0].pr, 42);
  assert.equal(seen[0][0].repository, 'infosiragpt-ops/SiraGPT-APP');
  assert.equal(seen[0][1].userId, 'u1');
});

test('tools are registered in the agentic loop and the coding tool selector', () => {
  const acs = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agentic-chat-stream.js'), 'utf8');
  assert.match(acs, /projectChangesTool, projectOpenPullRequestTool, projectPullRequestChecksTool, decideWithJevTool\]/);
  const sel = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agents', 'tool-selector.js'), 'utf8');
  assert.match(sel, /project_open_pull_request/);
  for (const t of [tools.projectChangesTool, tools.projectOpenPullRequestTool, tools.projectPullRequestChecksTool]) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/);
    assert.equal(t.parameters.additionalProperties, false);
  }
});
