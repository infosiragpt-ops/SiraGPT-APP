'use strict';

/**
 * project-changes-tools — project_changes / project_open_pull_request /
 * project_pull_request_checks.
 *
 * Closes the Factory-style loop in /agentes: after editing the chat's
 * repo project (project_write / project_exec) the agent shows the diff,
 * opens a pull request against the base branch on GitHub with the user's
 * own OAuth, and can read the PR's CI. Never merges, never pushes the base.
 * Contract: never throw — `{ ok:false, code, message }`.
 */

const { _internal: previewInternal } = require('./project-preview-tools');

const { chatScope, depsFromCtx, recordRlcdOutcome } = previewInternal;

// Extra injectable collaborators for this module (tests / future engines).
function changesDeps(ctx) {
  const base = depsFromCtx(ctx);
  const o = (ctx && ctx.projectTools) || {};
  for (const key of ['workspaceChanges', 'harness', 'selfHosting', 'githubChecks']) {
    if (o[key]) base[key] = o[key];
  }
  return base;
}

function serviceFromCtx(ctx) {
  const override = ctx && ctx.projectTools && ctx.projectTools.changesService;
  if (override) return override;
  // eslint-disable-next-line global-require
  return require('../codex/chat-changes.service');
}

const projectChangesTool = {
  name: 'project_changes',
  description: 'Diff of this chat\'s repo project against its base branch (e.g. production-main): files with status and +/- counts plus a unified diff (capped ~20 KB; pass path to see one file in full). Use it to review your edits before opening a pull request, or when the user asks "qué cambiaste". Fails with no_project until project_clone_repo ran, project_not_repo when the project is not a GitHub repo.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project-relative file to show in full instead of the whole diff.' },
      maxDiffChars: { type: 'integer', minimum: 1000, maximum: 200000, description: 'Diff cap in characters. Default 20000.' },
    },
    additionalProperties: false,
  },
  execute: async (args, ctx) => {
    try {
      const scope = chatScope(ctx);
      if (scope.error) return scope.error;
      const svc = serviceFromCtx(ctx);
      return await svc.workspaceChangesForChat({
        userId: scope.userId,
        chatId: scope.chatId,
        path: args && args.path ? String(args.path) : null,
        maxDiffChars: Number(args && args.maxDiffChars) || undefined,
      }, changesDeps(ctx));
    } catch (err) {
      return { ok: false, code: 'internal', message: String((err && err.message) || err) };
    }
  },
};

const projectOpenPullRequestTool = {
  name: 'project_open_pull_request',
  description: 'Commit this chat\'s repo project changes to a run/<id> branch, sync it on top of the latest base branch and OPEN A PULL REQUEST on GitHub (base = the repo\'s default/source branch, e.g. production-main) using the user\'s connected GitHub. Never merges and never pushes the base. Requires approved:true — set it only when the user explicitly asked for a PR/"súbelo"/"crea el PR". Before calling it: run the project\'s checks with project_exec (lint/tests) and review project_changes. Codes: github_auth_required (user must connect GitHub in /conexiones), no_changes, base_branch_diverged (call again: it re-syncs), pull_request_sensitive_path / pull_request_secret_detected (remove the file), codex_forbidden.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'PR title (conventional, ≤120 chars), e.g. "fix(chat): …".' },
      body: { type: 'string', description: 'PR description in Markdown: qué cambia, por qué, cómo se probó.' },
      branch: { type: 'string', description: 'Optional run id for the branch (becomes run/<id>). Default: generated.' },
      approved: { type: 'boolean', description: 'Must be true; the user explicitly asked to open the PR.' },
    },
    required: ['title', 'approved'],
    additionalProperties: false,
  },
  execute: async (args, ctx) => {
    try {
      const scope = chatScope(ctx);
      if (scope.error) return scope.error;
      const svc = serviceFromCtx(ctx);
      const out = await svc.openPullRequestForChat({
        userId: scope.userId,
        chatId: scope.chatId,
        title: args && args.title,
        body: args && args.body ? String(args.body) : '',
        branch: args && args.branch ? String(args.branch) : null,
        approved: Boolean(args && args.approved === true),
      }, changesDeps(ctx));
      if (out && out.ok) recordRlcdOutcome(ctx, { ok: true });
      else if (out && ['base_branch_diverged', 'runner_unreachable', 'git_failed'].includes(String(out.code))) recordRlcdOutcome(ctx, { ok: false, code: 'runner_unreachable' });
      return out;
    } catch (err) {
      return { ok: false, code: 'internal', message: String((err && err.message) || err) };
    }
  },
};

const projectPullRequestChecksTool = {
  name: 'project_pull_request_checks',
  description: 'CI / checks status of a pull request of this chat\'s repo project (GitHub, user\'s connected account). Pass pr (number) from project_open_pull_request, or ref (branch). Use it after opening a PR to tell the user whether the checks passed and, if not, which steps failed so you can fix them and push again with project_open_pull_request (same branch id).',
  parameters: {
    type: 'object',
    properties: {
      pr: { type: 'integer', minimum: 1, description: 'Pull request number.' },
      ref: { type: 'string', description: 'Branch or commit to inspect instead of pr.' },
    },
    additionalProperties: false,
  },
  execute: async (args, ctx) => {
    try {
      const scope = chatScope(ctx);
      if (scope.error) return scope.error;
      const svc = serviceFromCtx(ctx);
      return await svc.pullRequestChecksForChat({
        userId: scope.userId,
        chatId: scope.chatId,
        pr: Number(args && args.pr) || null,
        ref: args && args.ref ? String(args.ref) : null,
      }, changesDeps(ctx));
    } catch (err) {
      return { ok: false, code: 'internal', message: String((err && err.message) || err) };
    }
  },
};

module.exports = { projectChangesTool, projectOpenPullRequestTool, projectPullRequestChecksTool };
