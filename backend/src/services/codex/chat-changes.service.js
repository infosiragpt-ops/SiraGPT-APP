'use strict';

/**
 * chat-changes.service — "Factory-style" code review loop from the /agentes
 * chat: show the diff of the chat's Codex project against its base branch,
 * commit it to a `run/<id>` branch, sync that branch on top of the latest
 * remote base and open a pull request on GitHub with the user's own OAuth.
 *
 * Same primitives as the PR #700 routes (GET /projects/:id/changes and
 * POST /projects/:id/github/publish-workspace): workspace-changes,
 * opencode-harness.buildPublishPlan and self-hosting.publishSelfHostedPullRequest.
 * Policy is structural: the base branch is never pushed and nothing merges —
 * a PR against `production-main` (or the repo's default branch) is the only
 * output. Fail-open: `{ ok:false, code, message }` instead of throwing.
 */

const workspaceChanges = require('./workspace-changes');
const opencodeHarness = require('./opencode-harness');
const selfHosting = require('./self-hosting');
const { assertCodexAccess, storedGithubToken, resolveDeps } = require('./chat-preview.service');
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/; // mirrors git-workflow.RUN_ID_RE

const DIFF_SUMMARY_CHARS = 20_000;
const MAX_FILES_LISTED = 200;

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function errorToResult(err, fallbackCode = 'internal') {
  const code = String(err?.code || fallbackCode);
  const message = String(err?.message || err || 'Error');
  const extra = err && err.details ? { details: err.details } : {};
  const hints = {
    base_branch_diverged: ' La rama base cambió en GitHub; vuelve a llamar project_open_pull_request (sincroniza la base) o revisa los conflictos con project_exec ["git","status"].',
    pull_request_sensitive_path: ' Quita ese archivo del cambio (secretos y .env no se publican).',
    pull_request_secret_detected: ' El diff contiene algo que parece un secreto; elimínalo antes de publicar.',
    pull_request_too_large: ' Reduce el PR: máximo 240 archivos.',
    pull_request_file_too_large: ' Algún archivo supera 1,5 MB.',
    repository_not_allowlisted: ' El servidor no permite publicar en ese repositorio.',
    github_auth_required: ' Pide al usuario que conecte su GitHub en Apps → GitHub (/conexiones).',
    base_missing: ' La rama base no está en el workspace; vuelve a clonar con project_clone_repo indicando branch.',
  };
  return fail(code, message + (hints[code] || ''), extra);
}

async function resolveRepoProject({ userId, chatId }, d) {
  const project = await d.binding.findProjectForChat({ userId, chatId, db: d.db, projects: d.projectService }).catch(() => null);
  if (!project || !project.id) {
    return { error: fail('no_project', 'Este chat aún no tiene proyecto vinculado. Clona primero el repositorio con project_clone_repo.') };
  }
  const sc = project.sourceControl && typeof project.sourceControl === 'object' ? project.sourceControl : null;
  const repoUrl = sc && (sc.webUrl || sc.repository);
  if (!sc || !repoUrl) {
    return { error: fail('project_not_repo', 'El proyecto de este chat no está vinculado a un repositorio de GitHub.') };
  }
  const baseBranch = String(sc.sourceBranch || sc.defaultBranch || 'main');
  return { project, repoUrl: String(repoUrl), fullName: sc.fullName || null, baseBranch };
}

function summarizeFiles(files) {
  return (Array.isArray(files) ? files : []).slice(0, MAX_FILES_LISTED).map((f) => ({
    path: f.path,
    status: f.status,
    ...(f.from ? { from: f.from } : {}),
    additions: f.additions,
    deletions: f.deletions,
    ...(f.binary ? { binary: true } : {}),
    ...(f.uncommitted ? { uncommitted: true } : {}),
  }));
}

/**
 * Diff of the chat's project against its base branch, sized for an LLM.
 */
async function workspaceChangesForChat({ userId, chatId, maxDiffChars = DIFF_SUMMARY_CHARS, path: onlyPath = null } = {}, deps = {}) {
  const d = resolveDeps(deps);
  const wc = deps.workspaceChanges || workspaceChanges;
  const resolved = await resolveRepoProject({ userId, chatId }, d);
  if (resolved.error) return resolved.error;
  const { project, repoUrl, fullName, baseBranch } = resolved;
  try {
    const changes = await wc.getWorkspaceChanges({ runner: d.runner, projectId: project.id, baseBranch });
    let diff = String(changes.diff || '');
    if (onlyPath) {
      const wanted = String(onlyPath).trim();
      const parts = diff.split(/(?=^diff --git )/m).filter((chunk) => chunk.includes(` a/${wanted} `) || chunk.includes(` b/${wanted}`) || chunk.includes(`/dev/null b/${wanted}`));
      diff = parts.join('');
    }
    const cap = Math.max(1000, Math.min(200_000, Number(maxDiffChars) || DIFF_SUMMARY_CHARS));
    const truncated = diff.length > cap;
    if (truncated) diff = `${diff.slice(0, cap)}\n…[diff truncado: pide el diff de un archivo con path]`;
    return {
      ok: true,
      project: { id: project.id, name: project.name || null },
      repository: { url: repoUrl, fullName },
      base: changes.base,
      head: changes.head,
      dirty: Boolean(changes.dirty),
      filesChanged: changes.filesChanged,
      additions: changes.additions,
      deletions: changes.deletions,
      files: summarizeFiles(changes.files),
      diff,
      truncated: truncated || Boolean(changes.truncated),
    };
  } catch (err) {
    return errorToResult(err, 'runner_unreachable');
  }
}

function branchToRunId(branch, fallback) {
  const raw = String(branch || '').trim().replace(/^run\//, '');
  if (!raw) return fallback;
  return RUN_ID_RE.test(raw) ? raw : fallback;
}

/**
 * Refresh the base branch from origin and replay the run branch on top of
 * it (the clone is shallow, so a merge is impossible; `rebase --onto` only
 * needs the run commits, which are local). Returns { synced, from, to }.
 */
async function syncRunBranchWithBase({ runner, projectId, baseBranch, runBranch, accessToken, harness = opencodeHarness }) {
  const exec = (args, opts) => runner.exec(projectId, ['git', ...args], opts);
  const oldBase = await exec(['rev-parse', '--verify', '--quiet', `${baseBranch}^{commit}`]);
  if (oldBase.exitCode !== 0) return { synced: false, reason: 'base_missing' };
  const fetched = await exec([...harness.githubAuthConfigArgs(accessToken), 'fetch', '--depth=1', 'origin', `refs/heads/${baseBranch}`], { timeoutMs: 120_000 });
  if (fetched.exitCode !== 0) return { synced: false, reason: 'fetch_failed', detail: harness.scrubCredential(fetched.stderr, accessToken).slice(0, 400) };
  const newBase = await exec(['rev-parse', 'FETCH_HEAD']);
  const from = String(oldBase.stdout || '').trim();
  const to = String(newBase.stdout || '').trim();
  if (!to || from === to) return { synced: true, from, to, changed: false };
  const rebased = await exec(['rebase', '--onto', 'FETCH_HEAD', from, runBranch], { timeoutMs: 120_000 });
  if (rebased.exitCode !== 0) {
    await exec(['rebase', '--abort']).catch(() => null);
    const err = new Error(`La rama base ${baseBranch} avanzó en GitHub y los cambios no se aplican limpiamente (${String(rebased.stderr || '').slice(0, 300)}).`);
    err.code = 'base_branch_diverged';
    throw err;
  }
  await exec(['branch', '-f', baseBranch, 'FETCH_HEAD']);
  return { synced: true, from, to, changed: true };
}

/**
 * Commit the workspace to `run/<id>`, sync it with the latest base and open
 * the pull request. Requires explicit `approved: true` from the caller.
 */
async function openPullRequestForChat({ userId, chatId, title, body = '', branch = null, approved = false } = {}, deps = {}) {
  const d = resolveDeps(deps);
  const wc = deps.workspaceChanges || workspaceChanges;
  const harness = deps.harness || opencodeHarness;
  const hosting = deps.selfHosting || selfHosting;
  if (approved !== true) {
    return fail('approval_required', 'Abrir un PR es una acción externa: llama de nuevo con approved:true solo si el usuario lo pidió explícitamente.');
  }
  const cleanTitle = String(title || '').trim().slice(0, 120);
  if (!cleanTitle) return fail('invalid_title', 'El PR necesita un título (máx. 120 caracteres).');
  const access = await assertCodexAccess({ userId, db: d.db, env: d.env });
  if (!access.ok) return access;
  const resolved = await resolveRepoProject({ userId, chatId }, d);
  if (resolved.error) return resolved.error;
  const { project, repoUrl, fullName, baseBranch } = resolved;
  const stored = await storedGithubToken(d.githubApi, userId);
  if (!stored) {
    return fail('github_auth_required', 'Esta cuenta no tiene GitHub conectado. Pide al usuario que conecte su GitHub en Apps → GitHub (/conexiones) con una cuenta que tenga permiso de escritura en el repositorio, y reintenta.');
  }
  const runId = branchToRunId(branch, wc.workspaceRunId(project.id));
  const runner = d.runner;
  try {
    const prepared = await wc.prepareWorkspaceBranch({ runner, projectId: project.id, baseBranch, runId, title: cleanTitle, body: String(body || '') });
    if (prepared.status === 'no_changes') {
      return fail('no_changes', 'No hay cambios respecto a la rama base; edita archivos con project_write antes de abrir el PR.', { base: baseBranch });
    }
    const sync = await syncRunBranchWithBase({ runner, projectId: project.id, baseBranch, runBranch: prepared.branch, accessToken: stored.accessToken, harness });
    const plan = await harness.buildPublishPlan({
      runner, projectId: project.id, repoUrl, sourceBranch: baseBranch, runId, title: cleanTitle, body: String(body || ''), hasGithubToken: true,
    });
    if (plan.status === 'no_changes') {
      return fail('no_changes', 'La rama no difiere de la base tras sincronizar; nada que publicar.', { branch: prepared.branch, base: baseBranch });
    }
    const published = await hosting.publishSelfHostedPullRequest({
      runner,
      projectId: project.id,
      runId,
      repositoryUrl: repoUrl,
      sourceBranch: baseBranch,
      title: plan.title,
      body: plan.body,
      // The user's OAuth already bounds what can be written; the operator
      // allowlist (CODEX_SELF_HOST_*) stays in force for other flows.
      allowedRepositories: [repoUrl, `${repoUrl.replace(/\.git$/i, '')}.git`],
      env: { ...d.env, CODEX_SELF_HOST_GITHUB_TOKEN: stored.accessToken },
    });
    if (published.status === 'no_changes') {
      return fail('no_changes', 'Nada que publicar.', { branch: prepared.branch, base: baseBranch });
    }
    return {
      ok: true,
      project: { id: project.id, name: project.name || null },
      repository: { url: repoUrl, fullName },
      base: baseBranch,
      branch: published.branch || prepared.branch,
      commitSha: published.commitSha || prepared.commitSha,
      files: Array.isArray(published.files) ? published.files.length : (Array.isArray(plan.files) ? plan.files.length : null),
      baseSynced: sync,
      pullRequest: published.pullRequest || null,
      prUrl: published.pullRequest && published.pullRequest.url ? published.pullRequest.url : null,
      mergePolicy: 'pull_request_only',
      next: 'Comparte prUrl con el usuario. No se hace merge desde aquí: el usuario lo revisa y fusiona en GitHub cuando el CI esté en verde (project_pull_request_checks).',
    };
  } catch (err) {
    return errorToResult(err, 'runner_unreachable');
  }
}

/**
 * CI status of the PR opened for this project (user's OAuth).
 */
async function pullRequestChecksForChat({ userId, chatId, pr = null, ref = null } = {}, deps = {}) {
  const d = resolveDeps(deps);
  const resolved = await resolveRepoProject({ userId, chatId }, d);
  if (resolved.error) return resolved.error;
  const { project, fullName, repoUrl } = resolved;
  try {
    // eslint-disable-next-line global-require
    const { githubChecksTool } = deps.githubChecks || require('./github-checks');
    const out = await githubChecksTool(
      { ...(pr ? { pr } : {}), ...(ref ? { ref } : {}), repository: fullName || repoUrl },
      { userId, githubApi: d.githubApi || undefined, projectRecord: { brief: { repository: { fullName, webUrl: repoUrl } } }, run: null },
    );
    return { ok: !out.isError, project: { id: project.id, name: project.name || null }, ...out };
  } catch (err) {
    return errorToResult(err, 'github_checks_failed');
  }
}

module.exports = {
  workspaceChangesForChat,
  openPullRequestForChat,
  pullRequestChecksForChat,
  _internal: { resolveRepoProject, summarizeFiles, branchToRunId, syncRunBranchWithBase, errorToResult, DIFF_SUMMARY_CHARS },
};
