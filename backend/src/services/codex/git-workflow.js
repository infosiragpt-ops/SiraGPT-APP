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

/**
 * Create or resume run/<id> from main. A dirty workspace is reported without
 * touching refs so concurrent or interrupted work is never silently moved.
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

  if (!(await branchExists({ runner, projectId, branch: runBranch }))) {
    return { ok: false, status: 'not_found', code: 'run_branch_not_found', runBranch, baseBranch };
  }

  if (expectedCommitSha) {
    const head = await gitExec(runner, projectId, ['rev-parse', runBranch]);
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
    const treeOut = await gitExec(runner, projectId, ['rev-parse', `${runBranch}^{tree}`]);
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

  const tree = await workingTreeState({ runner, projectId });
  if (!tree.ok) return tree;
  if (!tree.clean) {
    return {
      ok: false,
      status: 'blocked',
      code: 'working_tree_dirty',
      runBranch,
      baseBranch,
      files: tree.files,
    };
  }

  const active = await currentBranch({ runner, projectId });
  if (active !== baseBranch) {
    const switched = await switchBranch({ runner, projectId, branch: baseBranch });
    if (!switched.ok) return { ...switched, runBranch, baseBranch };
  }

  const merge = await gitExec(
    runner,
    projectId,
    [...GIT_IDENT, 'merge', '--no-ff', '--no-edit', runBranch],
  );
  if (merge.exitCode !== 0) {
    const unresolved = await gitExec(
      runner,
      projectId,
      ['diff', '--name-only', '--diff-filter=U', '-z'],
    ).catch(() => ({ stdout: '' }));
    const conflicts = parseConflictFiles(unresolved.stdout);
    await gitExec(runner, projectId, ['merge', '--abort']).catch(() => null);
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

  const head = await gitExec(runner, projectId, ['rev-parse', 'HEAD']);
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
  return {
    ok: true,
    status: 'merged',
    runBranch,
    baseBranch,
    commitSha: head.stdout.trim(),
    verification: gate.result,
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
};
