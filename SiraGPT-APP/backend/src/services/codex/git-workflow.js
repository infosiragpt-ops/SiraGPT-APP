'use strict';

/**
 * Run-scoped Git workflow for Codex workspaces.
 *
 * The service deliberately keeps branch creation and merge policy outside the
 * agent loop. Callers must opt in to a merge with a green verification result;
 * a missing or failed gate can never mutate the base branch.
 */

const { GIT_IDENT } = require('./workspace');

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const BRANCH_RE = /^(?!-)(?!.*(?:\.\.|\/\/|@\{|[~^:?*[\]\\]))[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const OUTPUT_CAP = 2_000;

// Directory (relative to the project workspace root) that holds per-run git
// worktrees when CODEX_RUN_WORKTREES is on. Runner exec always runs at the
// workspace root, so a relative path keeps every worktree inside the project
// workspace by construction.
const RUN_WORKTREES_DIRNAME = '.sira-worktrees';

/** CODEX_RUN_WORKTREES gate — explicit opt-in only, default OFF. */
function runWorktreesEnabled(env = process.env) {
  return /^(1|true|on|yes)$/i.test(String(env?.CODEX_RUN_WORKTREES ?? '').trim());
}

/**
 * Workspace-relative worktree path for a run, or null when the runId is not a
 * safe token (RUN_ID_RE forbids `/`, `.` and leading `-`, so a validated id
 * can never escape the workspace).
 */
function runWorktreeRelPath(runId) {
  const id = String(runId || '').trim();
  return RUN_ID_RE.test(id) ? `${RUN_WORKTREES_DIRNAME}/wt-${id}` : null;
}

/**
 * Workspace-relative cwd prefix for a run when isolated run worktrees are
 * active. Returns null when the flag is off (default) or the runId is unsafe,
 * so callers can treat it as an optional prefix without changing today's
 * behavior.
 */
function resolveRunCwd({ runId, env = process.env } = {}) {
  if (!runWorktreesEnabled(env)) return null;
  return runWorktreeRelPath(runId);
}

function runBranchName(runId) {
  const id = String(runId || '').trim();
  return RUN_ID_RE.test(id) ? `run/${id}` : null;
}

function isSafeBranchName(branch) {
  const value = String(branch || '').trim();
  if (
    !value
    || !BRANCH_RE.test(value)
    || value === 'HEAD'
    || value.startsWith('refs/')
    || value.endsWith('/')
    || value.endsWith('.')
  ) {
    return false;
  }
  return value.split('/').every(
    (segment) => segment
      && !segment.startsWith('.')
      && !segment.endsWith('.lock'),
  );
}

function redactGitOutput(value) {
  return String(value || '')
    .replace(/https:\/\/[^/@\s]+:[^/@\s]+@/gi, 'https://[REDACTED]@')
    .replace(/\b(?:ghp|github_pat|glpat|xox[baprs])_[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .slice(0, OUTPUT_CAP);
}

async function gitExec(runner, projectId, args, opts) {
  if (!runner || typeof runner.exec !== 'function') throw new TypeError('runner.exec is required');
  const out = await runner.exec(projectId, ['git', ...args], opts);
  return {
    exitCode: Number.isInteger(out?.exitCode) ? out.exitCode : 1,
    stdout: String(out?.stdout || ''),
    stderr: String(out?.stderr || ''),
  };
}

async function currentBranch({ runner, projectId }) {
  const out = await gitExec(runner, projectId, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (out.exitCode !== 0) return null;
  const branch = out.stdout.trim();
  return branch && branch !== 'HEAD' ? branch : null;
}

async function workingTreeState({ runner, projectId }) {
  const out = await gitExec(runner, projectId, ['status', '--porcelain=v1', '-z']);
  if (out.exitCode !== 0) {
    return {
      ok: false,
      status: 'error',
      code: 'git_status_failed',
      detail: redactGitOutput(out.stderr || out.stdout),
    };
  }
  const files = out.stdout
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .filter(Boolean)
    .slice(0, 200);
  return { ok: true, clean: files.length === 0, files };
}

async function branchExists({ runner, projectId, branch }) {
  const out = await gitExec(runner, projectId, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  return out.exitCode === 0;
}

async function switchBranch({ runner, projectId, branch, createFrom = null }) {
  const args = createFrom
    ? ['switch', '-c', branch, createFrom]
    : ['switch', branch];
  const out = await gitExec(runner, projectId, args);
  if (out.exitCode === 0) return { ok: true };
  return {
    ok: false,
    status: 'error',
    code: createFrom ? 'branch_create_failed' : 'branch_switch_failed',
    detail: redactGitOutput(out.stderr || out.stdout),
  };
}

function baseRunnerOf(runner) {
  if (runner && typeof runner.unscoped === 'function') {
    return runner.unscoped() || runner;
  }
  return runner;
}

/**
 * Create or resume run/<id> from the configured base. Worktree-aware runners
 * keep the base checkout untouched and return a run-scoped workspace. Legacy
 * runners retain the historical branch-switching behavior.
 */
async function startRunBranch({
  runner,
  projectId,
  runId,
  baseBranch = 'main',
} = {}) {
  const runBranch = runBranchName(runId);
  if (!runBranch) return { ok: false, status: 'rejected', code: 'invalid_run_id' };
  if (!isSafeBranchName(baseBranch)) {
    return { ok: false, status: 'rejected', code: 'invalid_base_branch' };
  }

  if (runner && typeof runner.createWorktree === 'function') {
    try {
      const created = await runner.createWorktree(projectId, runId, baseBranch);
      return {
        ok: true,
        status: 'ready',
        runBranch,
        baseBranch,
        resumed: Boolean(created?.resumed),
        worktree: true,
        worktreeDir: created?.dir || null,
      };
    } catch (error) {
      return {
        ok: false,
        status: error?.status === 409 ? 'blocked' : 'error',
        code: error?.body?.error || 'worktree_create_failed',
        detail: redactGitOutput(error?.body?.detail || error?.message || error),
        runBranch,
        baseBranch,
      };
    }
  }

  const active = await currentBranch({ runner, projectId });
  if (active === runBranch) {
    // A paused/recovered run is expected to have its own uncommitted changes.
    // They belong to this exact branch and must remain available on resume.
    return { ok: true, status: 'ready', runBranch, baseBranch, resumed: true };
  }

  const tree = await workingTreeState({ runner, projectId });
  if (!tree.ok) return tree;
  if (!tree.clean) {
    return {
      ok: false,
      status: 'blocked',
      code: 'working_tree_dirty',
      files: tree.files,
    };
  }

  if (await branchExists({ runner, projectId, branch: runBranch })) {
    const switched = await switchBranch({ runner, projectId, branch: runBranch });
    return switched.ok
      ? { ok: true, status: 'ready', runBranch, baseBranch, resumed: true }
      : { ...switched, runBranch, baseBranch };
  }

  if (active !== baseBranch) {
    const baseSwitch = await switchBranch({ runner, projectId, branch: baseBranch });
    if (!baseSwitch.ok) return { ...baseSwitch, runBranch, baseBranch };
  }
  const created = await switchBranch({
    runner,
    projectId,
    branch: runBranch,
    createFrom: baseBranch,
  });
  return created.ok
    ? { ok: true, status: 'ready', runBranch, baseBranch, resumed: false }
    : { ...created, runBranch, baseBranch };
}

async function listWorktreePaths({ runner, projectId }) {
  const out = await gitExec(runner, projectId, ['worktree', 'list', '--porcelain']);
  if (out.exitCode !== 0) return null;
  return out.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter(Boolean);
}

/**
 * Create (or resume) an isolated run worktree at
 * `<workspaceRoot>/.sira-worktrees/wt-<runId>` on branch run/<runId>, using
 * plain `git worktree` through runner.exec — the seam for runners that do NOT
 * implement the worktree HTTP contract (`runner.createWorktree`). Gated by
 * CODEX_RUN_WORKTREES (default OFF → no-op, zero runner calls) so N concurrent
 * runs of one project stop sharing a working tree only on explicit opt-in.
 */
async function startRunWorktree({
  runner,
  projectId,
  runId,
  baseBranch = 'main',
  env = process.env,
} = {}) {
  if (!runWorktreesEnabled(env)) {
    return { ok: true, status: 'skipped', code: 'run_worktrees_disabled', worktree: false };
  }
  const runBranch = runBranchName(runId);
  const worktreeDir = runWorktreeRelPath(runId);
  if (!runBranch || !worktreeDir) {
    return { ok: false, status: 'rejected', code: 'invalid_run_id' };
  }
  if (!isSafeBranchName(baseBranch)) {
    return { ok: false, status: 'rejected', code: 'invalid_base_branch' };
  }

  const existing = await listWorktreePaths({ runner, projectId });
  if (
    Array.isArray(existing)
    && existing.some((p) => p === worktreeDir || p.endsWith(`/${worktreeDir}`))
  ) {
    return {
      ok: true,
      status: 'ready',
      worktree: true,
      worktreeDir,
      runBranch,
      baseBranch,
      resumed: true,
    };
  }

  // Best-effort: keep the worktree container invisible to `git status` of the
  // base checkout (a `*` self-ignore inside the directory), so the legacy
  // clean-tree gates never see `.sira-worktrees/` as untracked noise.
  if (typeof runner?.writeFiles === 'function') {
    await runner
      .writeFiles(projectId, [{ path: `${RUN_WORKTREES_DIRNAME}/.gitignore`, content: '*\n' }])
      .catch(() => null);
  }

  const resumingBranch = await branchExists({ runner, projectId, branch: runBranch });
  const args = resumingBranch
    ? ['worktree', 'add', worktreeDir, runBranch]
    : ['worktree', 'add', worktreeDir, '-b', runBranch, baseBranch];
  const out = await gitExec(runner, projectId, args);
  if (out.exitCode !== 0) {
    return {
      ok: false,
      status: 'error',
      code: 'worktree_add_failed',
      runBranch,
      baseBranch,
      detail: redactGitOutput(out.stderr || out.stdout),
    };
  }
  return {
    ok: true,
    status: 'ready',
    worktree: true,
    worktreeDir,
    runBranch,
    baseBranch,
    resumed: false,
  };
}

/**
 * Remove a run worktree and its branch. Idempotent by contract: a missing
 * worktree or branch is a successful no-op (`removed:false`), never a throw,
 * so cleanup can run on abort paths and crash recovery unconditionally.
 */
async function removeRunWorktree({
  runner,
  projectId,
  runId,
  env = process.env,
  deleteBranch = true,
} = {}) {
  if (!runWorktreesEnabled(env)) {
    return { ok: true, status: 'skipped', code: 'run_worktrees_disabled', removed: false };
  }
  const runBranch = runBranchName(runId);
  const worktreeDir = runWorktreeRelPath(runId);
  if (!runBranch || !worktreeDir) {
    return { ok: false, status: 'rejected', code: 'invalid_run_id' };
  }

  let removed = false;
  const out = await gitExec(runner, projectId, ['worktree', 'remove', '--force', worktreeDir]);
  if (out.exitCode === 0) {
    removed = true;
  } else {
    const detail = `${out.stderr || ''}\n${out.stdout || ''}`;
    const alreadyGone = /is not a working tree|does not exist|no such file/i.test(detail);
    if (!alreadyGone) {
      return {
        ok: false,
        status: 'error',
        code: 'worktree_remove_failed',
        runBranch,
        worktreeDir,
        detail: redactGitOutput(out.stderr || out.stdout),
      };
    }
  }
  // Clear any stale administrative entry (e.g. dir deleted out-of-band).
  await gitExec(runner, projectId, ['worktree', 'prune']).catch(() => null);

  let branchDeleted = false;
  if (deleteBranch) {
    const del = await gitExec(runner, projectId, ['branch', '-D', runBranch]).catch(() => null);
    branchDeleted = del?.exitCode === 0;
  }
  return {
    ok: true,
    status: removed ? 'removed' : 'not_found',
    removed,
    branchDeleted,
    runBranch,
    worktreeDir,
  };
}

function greenVerification(verification) {
  if (verification === true) return true;
  if (!verification || verification.ok !== true) return false;
  const status = String(verification.status || 'passed').toLowerCase();
  return ['green', 'ok', 'pass', 'passed', 'success', 'succeeded'].includes(status);
}

async function evaluateVerification({ verify, verification, runId, projectId, runBranch }) {
  try {
    const result = typeof verify === 'function'
      ? await verify({ runId, projectId, runBranch })
      : verification;
    return { green: greenVerification(result), result: result ?? null };
  } catch (error) {
    return {
      green: false,
      result: {
        ok: false,
        status: 'error',
        error: redactGitOutput(error?.message || error),
      },
    };
  }
}

function parseConflictFiles(stdout) {
  return String(stdout || '')
    .split('\0')
    .map((file) => file.trim())
    .filter(Boolean)
    .slice(0, 200);
}

/**
 * Merge run/<id> into main only after a deterministic green result. Conflicts
 * are aborted and returned as data; the base branch remains unmodified.
 */
async function mergeRunBranch({
  runner,
  projectId,
  runId,
  baseBranch = 'main',
  verification,
  verify,
  expectedCommitSha = null,
  expectedTreeSha = null,
} = {}) {
  const runBranch = runBranchName(runId);
  if (!runBranch) return { ok: false, status: 'rejected', code: 'invalid_run_id' };
  if (!isSafeBranchName(baseBranch)) {
    return { ok: false, status: 'rejected', code: 'invalid_base_branch' };
  }

  const gate = await evaluateVerification({
    verify,
    verification,
    runId,
    projectId,
    runBranch,
  });
  if (!gate.green) {
    return {
      ok: false,
      status: 'blocked',
      code: 'verification_not_green',
      runBranch,
      baseBranch,
      verification: gate.result,
    };
  }

  const mergeRunner = baseRunnerOf(runner);
  if (!(await branchExists({ runner: mergeRunner, projectId, branch: runBranch }))) {
    return { ok: false, status: 'not_found', code: 'run_branch_not_found', runBranch, baseBranch };
  }

  if (expectedCommitSha) {
    const head = await gitExec(mergeRunner, projectId, ['rev-parse', runBranch]);
    const actualCommitSha = head.exitCode === 0 ? head.stdout.trim() : null;
    if (actualCommitSha !== expectedCommitSha) {
      return {
        ok: false,
        status: 'blocked',
        code: 'verified_commit_changed',
        runBranch,
        baseBranch,
      };
    }
  }
  if (expectedTreeSha) {
    const treeOut = await gitExec(mergeRunner, projectId, ['rev-parse', `${runBranch}^{tree}`]);
    const actualTreeSha = treeOut.exitCode === 0 ? treeOut.stdout.trim() : null;
    if (actualTreeSha !== expectedTreeSha) {
      return {
        ok: false,
        status: 'blocked',
        code: 'verified_tree_changed',
        runBranch,
        baseBranch,
      };
    }
  }

  const runTree = await workingTreeState({ runner, projectId });
  if (!runTree.ok) return runTree;
  if (!runTree.clean) {
    return {
      ok: false,
      status: 'blocked',
      code: 'working_tree_dirty',
      runBranch,
      baseBranch,
      files: runTree.files,
    };
  }

  if (mergeRunner !== runner) {
    const baseTree = await workingTreeState({ runner: mergeRunner, projectId });
    if (!baseTree.ok) return baseTree;
    if (!baseTree.clean) {
      return {
        ok: false,
        status: 'blocked',
        code: 'base_working_tree_dirty',
        runBranch,
        baseBranch,
        files: baseTree.files,
      };
    }
  }

  const active = await currentBranch({ runner: mergeRunner, projectId });
  if (active !== baseBranch) {
    const switched = await switchBranch({ runner: mergeRunner, projectId, branch: baseBranch });
    if (!switched.ok) return { ...switched, runBranch, baseBranch };
  }

  const merge = await gitExec(
    mergeRunner,
    projectId,
    [...GIT_IDENT, 'merge', '--no-ff', '--no-edit', runBranch],
  );
  if (merge.exitCode !== 0) {
    const unresolved = await gitExec(
      mergeRunner,
      projectId,
      ['diff', '--name-only', '--diff-filter=U', '-z'],
    ).catch(() => ({ stdout: '' }));
    const conflicts = parseConflictFiles(unresolved.stdout);
    await gitExec(mergeRunner, projectId, ['merge', '--abort']).catch(() => null);
    return {
      ok: false,
      status: conflicts.length ? 'conflict' : 'error',
      code: conflicts.length ? 'merge_conflict' : 'merge_failed',
      runBranch,
      baseBranch,
      conflicts,
      detail: redactGitOutput(merge.stderr || merge.stdout),
    };
  }

  const head = await gitExec(mergeRunner, projectId, ['rev-parse', 'HEAD']);
  if (head.exitCode !== 0) {
    return {
      ok: false,
      status: 'error',
      code: 'merged_head_unavailable',
      runBranch,
      baseBranch,
      detail: redactGitOutput(head.stderr || head.stdout),
    };
  }
  let worktreeCleanup = null;
  if (runner && typeof runner.removeWorktree === 'function') {
    try {
      const removed = await runner.removeWorktree(projectId, runId);
      worktreeCleanup = { ok: true, removed: Boolean(removed?.removed) };
    } catch (error) {
      worktreeCleanup = {
        ok: false,
        code: error?.body?.error || 'worktree_remove_failed',
        detail: redactGitOutput(error?.body?.detail || error?.message || error),
      };
    }
  }
  let exportResult = null;
  if (typeof mergeRunner.exportWorkspace === 'function') {
    try {
      const exported = await mergeRunner.exportWorkspace(projectId);
      exportResult = {
        ok: true,
        exported: exported?.exported !== false,
      };
    } catch (error) {
      exportResult = {
        ok: false,
        code: error?.body?.error || 'workspace_export_failed',
        detail: redactGitOutput(error?.body?.detail || error?.message || error),
      };
    }
  }
  const cleanupWarning = worktreeCleanup?.ok === false || exportResult?.ok === false;
  return {
    ok: true,
    status: 'merged',
    runBranch,
    baseBranch,
    commitSha: head.stdout.trim(),
    verification: gate.result,
    worktreeCleanup,
    exportResult,
    cleanupWarning,
  };
}

module.exports = {
  runBranchName,
  isSafeBranchName,
  redactGitOutput,
  currentBranch,
  workingTreeState,
  startRunBranch,
  mergeRunBranch,
  greenVerification,
  RUN_WORKTREES_DIRNAME,
  runWorktreesEnabled,
  runWorktreeRelPath,
  resolveRunCwd,
  startRunWorktree,
  removeRunWorktree,
};
