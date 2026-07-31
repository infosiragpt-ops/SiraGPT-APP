'use strict';

/**
 * codex/checkpoint-service — git checkpoints, rollback and diff (feature 07,
 * spec §2.1/§6). A build that touches files closes with a real commit in the
 * runner workspace — the data behind the "Checkpoint made X ago" card and its
 * three actions (Rollback here / Changes / View preview).
 *
 * All git runs through the runner's `exec` (git is allowlisted) with the fixed
 * identity from provisioning (reused via gitCommitAll). Shas are validated
 * before interpolation; args are passed as argv (no shell), so there is no
 * command injection surface. prisma/runner/llmTurn are injectable for tests.
 */

const { randomBytes } = require('node:crypto');
const { gitCommitAll } = require('./workspace');
const {
  currentBranch,
  isSafeBranchName,
  mergeRunBranch,
  runBranchName,
  startRunBranch,
} = require('./git-workflow');

const defaultPrisma = (() => {
  try { return require('../../config/database'); } catch { return null; }
})();

const SHA_RE = /^[0-9a-f]{7,40}$/;
const RECOVERY_REF_RE = /^refs\/sira\/recovery\/[a-z0-9][a-z0-9._-]{7,119}$/;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git hash-object of the empty tree
const DIFF_CAP = 500_000;
const CODEX_MERGE_LOCK_CLASS = 0x0c0df;
const mergeLockTails = new Map();

function mergeLockId(projectId) {
  const value = String(projectId || '');
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}

async function withLocalMergeLock(projectId, work) {
  const key = String(projectId);
  const previous = mergeLockTails.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  mergeLockTails.set(key, current);
  await previous.catch(() => {});
  try {
    return await work();
  } finally {
    release();
    if (mergeLockTails.get(key) === current) mergeLockTails.delete(key);
  }
}

async function withProjectMergeLock(prisma, projectId, work) {
  return withLocalMergeLock(projectId, async () => {
    const canAdvisoryLock = prisma
      && typeof prisma.$transaction === 'function'
      && typeof prisma.$queryRawUnsafe === 'function';
    if (!canAdvisoryLock) return work();
    return prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'WITH _lock AS (SELECT pg_advisory_xact_lock($1::int, $2::int)) SELECT 1::int AS locked FROM _lock',
        CODEX_MERGE_LOCK_CLASS,
        mergeLockId(projectId),
      );
      return work();
    }, { maxWait: 30_000, timeout: 180_000 });
  });
}

function isValidSha(sha) {
  return typeof sha === 'string' && SHA_RE.test(sha);
}

function isValidRecoveryRef(ref) {
  return typeof ref === 'string' && RECOVERY_REF_RE.test(ref);
}

function recoveryRefId() {
  return `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`;
}

function changedPathsFromPorcelain(raw) {
  return String(raw || '')
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .filter(Boolean)
    .slice(0, 200);
}

async function gitStatus(runner, projectId) {
  const out = await runner.exec(projectId, ['git', 'status', '--porcelain=v1', '-z']);
  if (out?.exitCode !== 0) {
    const error = new Error(`git_status_failed: ${String(out?.stderr || out?.stdout || '').slice(0, 500)}`);
    error.code = 'git_status_failed';
    throw error;
  }
  const files = changedPathsFromPorcelain(out.stdout);
  return { clean: files.length === 0, files };
}

async function gitRefSha(runner, projectId, ref) {
  const out = await runner.exec(projectId, ['git', 'rev-parse', '--verify', ref]);
  const sha = String(out?.stdout || '').trim();
  return out?.exitCode === 0 && isValidSha(sha) ? sha : null;
}

/**
 * Move tracked, staged and untracked user work under a durable private Git ref
 * before any hard reset. The stash stack itself is left unchanged.
 */
async function preserveWorkspaceChanges({
  runner,
  projectId,
  idFactory = recoveryRefId,
} = {}) {
  const state = await gitStatus(runner, projectId);
  if (state.clean) return { preserved: false, files: [] };

  const base = await runner.exec(projectId, ['git', 'rev-parse', 'HEAD']);
  const baseSha = String(base?.stdout || '').trim();
  if (base?.exitCode !== 0 || !isValidSha(baseSha)) {
    const error = new Error('recovery_base_unavailable');
    error.code = 'recovery_base_unavailable';
    throw error;
  }

  const recoveryRef = `refs/sira/recovery/${String(idFactory()).toLowerCase()}`;
  if (!isValidRecoveryRef(recoveryRef)) {
    const error = new Error('invalid_recovery_ref');
    error.code = 'invalid_recovery_ref';
    throw error;
  }

  const previousStashSha = await gitRefSha(runner, projectId, 'refs/stash');
  const stash = await runner.exec(projectId, [
    'git',
    'stash',
    'push',
    '--include-untracked',
    '--message',
    `sira-recovery:${recoveryRef.slice('refs/sira/recovery/'.length)}`,
  ]);
  if (stash?.exitCode !== 0) {
    const error = new Error(`git_stash_failed: ${String(stash?.stderr || stash?.stdout || '').slice(0, 500)}`);
    error.code = 'git_stash_failed';
    throw error;
  }

  const stashSha = await gitRefSha(runner, projectId, 'refs/stash');
  if (!stashSha || stashSha === previousStashSha) {
    // Never fall back to stash@{0}: it may be an unrelated user stash if the
    // working tree changed between status and stash.
    const error = new Error('git_stash_not_created');
    error.code = 'git_stash_not_created';
    throw error;
  }

  const pinned = await runner.exec(projectId, ['git', 'update-ref', recoveryRef, stashSha]);
  if (pinned?.exitCode !== 0) {
    await runner.exec(projectId, ['git', 'stash', 'apply', '--index', stashSha]).catch(() => null);
    const error = new Error(`git_recovery_ref_failed: ${String(pinned?.stderr || pinned?.stdout || '').slice(0, 500)}`);
    error.code = 'git_recovery_ref_failed';
    throw error;
  }

  // The custom ref now owns the recovery commit. Drop only the stack entry we
  // just created so pre-existing user stashes retain their order.
  await runner.exec(projectId, ['git', 'stash', 'drop', 'stash@{0}']).catch(() => null);
  const clean = await gitStatus(runner, projectId);
  if (!clean.clean) {
    const error = new Error('workspace_not_clean_after_preserve');
    error.code = 'workspace_not_clean_after_preserve';
    throw error;
  }
  return {
    preserved: true,
    recoveryRef,
    baseSha,
    files: state.files,
  };
}

async function devState(runner, projectId) {
  try {
    const status = await runner.devStatus(projectId);
    return {
      running: Boolean(status && (status.running || status.ready) && (status.project === projectId || status.project == null)),
      basePath: status?.basePath || null,
    };
  } catch {
    return { running: false, basePath: null };
  }
}

async function restartDev(runner, projectId, state) {
  if (!state?.running) return false;
  try {
    await runner.startDev(projectId, { basePath: state.basePath });
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore the exact HEAD, index, tracked edits and untracked files captured by
 * preserveWorkspaceChanges. Refuse a dirty destination instead of merging two
 * unrelated states. On apply failure, restore the clean pre-recovery HEAD.
 */
async function recoverWorkspaceChanges({
  runner,
  projectId,
  recoveryRef,
} = {}) {
  if (!isValidRecoveryRef(recoveryRef)) {
    return { ok: false, error: 'invalid_recovery_ref', status: 400 };
  }
  const state = await gitStatus(runner, projectId);
  if (!state.clean) {
    return { ok: false, error: 'working_tree_dirty', status: 409, files: state.files };
  }

  const recovery = await runner.exec(projectId, ['git', 'rev-parse', '--verify', `${recoveryRef}^{commit}`]);
  const recoverySha = String(recovery?.stdout || '').trim();
  if (recovery?.exitCode !== 0 || !isValidSha(recoverySha)) {
    return { ok: false, error: 'recovery_not_found', status: 404 };
  }
  const base = await runner.exec(projectId, ['git', 'rev-parse', `${recoveryRef}^1`]);
  const baseSha = String(base?.stdout || '').trim();
  if (base?.exitCode !== 0 || !isValidSha(baseSha)) {
    return { ok: false, error: 'recovery_base_unavailable', status: 409 };
  }
  const current = await runner.exec(projectId, ['git', 'rev-parse', 'HEAD']);
  const currentSha = String(current?.stdout || '').trim();
  if (current?.exitCode !== 0 || !isValidSha(currentSha)) {
    return { ok: false, error: 'current_sha_unavailable', status: 409 };
  }

  const preview = await devState(runner, projectId);
  if (preview.running) await runner.stopDev(projectId).catch(() => null);

  const reset = await runner.exec(projectId, ['git', 'reset', '--hard', baseSha]);
  if (reset?.exitCode !== 0) {
    const restarted = await restartDev(runner, projectId, preview);
    return { ok: false, error: 'reset_failed', status: 500, restarted };
  }
  const applied = await runner.exec(projectId, ['git', 'stash', 'apply', '--index', recoveryRef]);
  if (applied?.exitCode !== 0) {
    // The destination was clean before we began. Remove only partial files
    // created by this failed apply, then return to its exact original HEAD.
    await runner.exec(projectId, ['git', 'reset', '--hard', currentSha]).catch(() => null);
    await runner.exec(projectId, ['git', 'clean', '-fd']).catch(() => null);
    const restarted = await restartDev(runner, projectId, preview);
    return {
      ok: false,
      error: 'recovery_apply_failed',
      status: 409,
      detail: String(applied?.stderr || applied?.stdout || '').slice(0, 500),
      recoveryRef,
      restarted,
    };
  }

  const restoredState = await gitStatus(runner, projectId);
  const deleted = await runner.exec(projectId, ['git', 'update-ref', '-d', recoveryRef]);
  const restarted = await restartDev(runner, projectId, preview);
  return {
    ok: true,
    recoveryRef,
    baseSha,
    files: restoredState.files,
    restarted,
    recoveryRefRetained: deleted?.exitCode !== 0,
  };
}

function projectBaseBranch(project, explicit = null) {
  const candidate = String(
    explicit
    || project?.brief?.repository?.sourceBranch
    || project?.brief?.sourceBranch
    || 'main',
  ).trim();
  return isSafeBranchName(candidate) ? candidate : null;
}

async function captureWorkspaceTree({ runner, projectId }) {
  const add = await runner.exec(projectId, ['git', 'add', '-A']);
  if (add?.exitCode !== 0) throw new Error(`git_add_failed: ${String(add?.stderr || add?.stdout || '').slice(0, 500)}`);
  const tree = await runner.exec(projectId, ['git', 'write-tree']);
  const treeSha = String(tree?.stdout || '').trim();
  if (tree?.exitCode !== 0 || !isValidSha(treeSha)) {
    throw new Error(`git_write_tree_failed: ${String(tree?.stderr || tree?.stdout || '').slice(0, 500)}`);
  }
  return treeSha;
}

async function commitTreeSha({ runner, projectId, commitSha = 'HEAD' }) {
  if (commitSha !== 'HEAD' && !isValidSha(commitSha)) return null;
  const out = await runner.exec(projectId, ['git', 'rev-parse', `${commitSha}^{tree}`]);
  const treeSha = String(out?.stdout || '').trim();
  return out?.exitCode === 0 && isValidSha(treeSha) ? treeSha : null;
}

function requireDb(db) {
  if (!db || !db.codexCheckpoint) throw new Error('database unavailable');
  return db;
}

/** Never mutate a shared project workspace while a Codex run can edit it. */
async function activeRunGuard(prisma, projectId) {
  if (typeof prisma?.codexRun?.count !== 'function') return null;
  try {
    const active = await prisma.codexRun.count({
      where: { projectId, status: { in: ['queued', 'running', 'waiting_approval'] } },
    });
    return active > 0 ? { error: 'run_in_progress', status: 409 } : null;
  } catch (error) {
    return {
      error: 'run_state_unavailable',
      status: 503,
      detail: String(error?.message || error).slice(0, 200),
    };
  }
}

function parseShortstat(text) {
  const out = { additions: 0, deletions: 0, filesChanged: 0 };
  const s = String(text || '');
  const f = s.match(/(\d+)\s+files?\s+changed/);
  const a = s.match(/(\d+)\s+insertions?\(\+\)/);
  const d = s.match(/(\d+)\s+deletions?\(-\)/);
  if (f) out.filesChanged = Number(f[1]);
  if (a) out.additions = Number(a[1]);
  if (d) out.deletions = Number(d[1]);
  return out;
}

function shortSha(sha) {
  return typeof sha === 'string' ? sha.slice(0, 7) : sha;
}

function publicCheckpoint(row) {
  const metric = row.run && row.run.metric;
  return {
    id: row.id,
    commitSha: row.commitSha,
    shortSha: shortSha(row.commitSha),
    title: row.title,
    createdAt: row.createdAt,
    additions: metric ? metric.additions : null,
    deletions: metric ? metric.deletions : null,
  };
}

/** Ask the LLM for a one-line conventional-commit title; deterministic fallback. */
async function generateCheckpointTitle({ run, changedFiles, llmTurn, env = process.env }) {
  const fallback = `feat(codex): cambios de la corrida ${String(run.id || '').slice(0, 8)}`;
  if (typeof llmTurn !== 'function') return fallback;
  try {
    const messages = [
      { role: 'system', content: 'Genera UN título de commit en español, estilo conventional commits (p. ej. "feat(ui): agrega header"). Responde SOLO con la línea del título, sin comillas ni explicación.' },
      { role: 'user', content: `Contexto de la corrida: ${run.prompt || '(sin descripción)'}\nArchivos cambiados:\n${changedFiles || '(desconocidos)'}` },
    ];
    const turn = await llmTurn({ messages, tools: [], env });
    const line = String(turn?.text || '').split('\n').map((l) => l.trim()).find(Boolean);
    if (line) return line.replace(/^["'`]|["'`]$/g, '').slice(0, 100);
  } catch { /* fall through to deterministic */ }
  return fallback;
}

function checkpointCommitBody({ run, project, changedFiles, expectedTreeSha = null }) {
  const files = String(changedFiles || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 80);
  const task = String(run?.prompt || '').trim().replace(/\s+/g, ' ').slice(0, 800);
  return [
    `Run: ${run?.id || 'unknown'}`,
    `Project: ${project?.name || project?.id || run?.projectId || 'unknown'}`,
    `Mode: ${run?.mode || 'build'}`,
    expectedTreeSha ? `Verified-Tree: ${expectedTreeSha}` : null,
    task ? `Task: ${task}` : null,
    '',
    'Changed files:',
    ...(files.length ? files : ['(not reported)']),
  ].filter((line) => line !== null).join('\n');
}

/**
 * Create a checkpoint at the close of a build IF there are changes. Returns the
 * persisted checkpoint, or null when the workspace is clean (no card).
 */
async function createCheckpoint({ run, project, deps = {} }) {
  const {
    runner,
    eventStore,
    prisma = defaultPrisma,
    llmTurn,
    env,
    expectedTreeSha = null,
    clock = () => new Date(),
  } = deps;
  const projectId = project?.id || run.projectId;

  // Check for changes BEFORE touching the DB — a clean tree means no checkpoint
  // and no card, so we never need a database connection in that case.
  const status = await runner.exec(projectId, ['git', 'status', '--porcelain']);
  const changed = String(status?.stdout || '').trim();
  if (!changed) return null; // clean tree → no checkpoint

  const db = requireDb(prisma);
  const title = await generateCheckpointTitle({ run, changedFiles: changed.slice(0, 2000), llmTurn, env });
  const body = checkpointCommitBody({
    run,
    project,
    changedFiles: changed.slice(0, 4000),
    expectedTreeSha,
  });
  const commitSha = await gitCommitAll(runner, projectId, title, { body });
  const committedTreeSha = await commitTreeSha({ runner, projectId, commitSha });
  if (expectedTreeSha && committedTreeSha !== expectedTreeSha) {
    const error = new Error('checkpoint tree differs from the tree that passed verification');
    error.code = 'checkpoint_tree_mismatch';
    error.expectedTreeSha = expectedTreeSha;
    error.committedTreeSha = committedTreeSha;
    throw error;
  }

  const checkpoint = await db.codexCheckpoint.create({
    data: { runId: run.id, projectId, commitSha, title },
  });
  const createdAt = (checkpoint.createdAt ? new Date(checkpoint.createdAt) : clock()).toISOString();
  if (eventStore?.appendEvent) {
    await eventStore.appendEvent(run.id, 'checkpoint_created', { checkpointId: checkpoint.id, commitSha, title, createdAt }, { prisma: db }).catch(() => {});
  }

  // Hybrid "export to disk": mirror the just-committed source to the host
  // folder. Best-effort and non-blocking — a runner without export support
  // (older sidecar / test mocks) or an export failure must never fail the run.
  if (!runner.scope?.run && typeof runner.exportWorkspace === 'function') {
    Promise.resolve(runner.exportWorkspace(projectId)).catch(() => {});
  }
  return checkpoint;
}

/**
 * Opt-in entry point for OT-7. The caller invokes this before the agent edits
 * files; existing checkpoint callers keep their historical single-branch
 * behavior until the run orchestrator adopts this service.
 */
async function prepareRunBranch({ run, project, deps = {} }) {
  const projectId = project?.id || run?.projectId;
  const baseBranch = projectBaseBranch(project, deps.baseBranch);
  if (!baseBranch) return { ok: false, status: 'rejected', code: 'invalid_base_branch' };
  return startRunBranch({
    runner: deps.runner,
    projectId,
    runId: run?.id,
    baseBranch,
  });
}

/**
 * Close a run-scoped branch: checkpoint, persist a resumable session snapshot,
 * then merge only when verification is green. Branch mismatch is fail-closed
 * so a caller can never commit an unrelated run's workspace by accident.
 */
async function finalizeRunCheckpoint({
  run,
  project,
  verification,
  verify,
  deps = {},
}) {
  const projectId = project?.id || run?.projectId;
  const baseBranch = projectBaseBranch(project, deps.baseBranch);
  if (!baseBranch) return { ok: false, status: 'rejected', code: 'invalid_base_branch' };
  const expectedBranch = runBranchName(run?.id);
  if (!expectedBranch) {
    return { ok: false, status: 'rejected', code: 'invalid_run_id' };
  }

  const activeBranch = await currentBranch({ runner: deps.runner, projectId });
  if (activeBranch !== expectedBranch) {
    return {
      ok: false,
      status: 'blocked',
      code: 'run_branch_mismatch',
      expectedBranch,
      activeBranch,
    };
  }

  const checkpoint = await createCheckpoint({ run, project, deps });
  let sessionSnapshot = null;
  if (deps.sessionService && typeof deps.sessionService.saveSnapshot === 'function') {
    try {
      let cursorSeq = 0;
      if (typeof deps.sessionService.readTranscript === 'function') {
        const transcript = await deps.sessionService.readTranscript({
          projectId,
          sessionId: run.id,
        });
        cursorSeq = transcript?.lastSeq || 0;
      }
      sessionSnapshot = await deps.sessionService.saveSnapshot({
        projectId,
        sessionId: run.id,
        cursorSeq,
        checkpointSha: checkpoint?.commitSha || null,
        checkpointId: checkpoint?.id || null,
        loopState: {
          phase: 'checkpointed',
          runId: run.id,
          runBranch: expectedBranch,
        },
      });
    } catch (error) {
      sessionSnapshot = {
        ok: false,
        error: String(error?.code || error?.message || 'snapshot_failed').slice(0, 200),
      };
    }
  }

  const merge = await withProjectMergeLock(deps.prisma || defaultPrisma, projectId, () => (
    mergeRunBranch({
      runner: deps.runner,
      projectId,
      runId: run.id,
      baseBranch,
      verification,
      verify,
      expectedCommitSha: checkpoint?.commitSha || null,
      expectedTreeSha: deps.expectedTreeSha || null,
    })
  ));
  return {
    ok: merge.ok,
    status: merge.status,
    checkpoint,
    sessionSnapshot,
    merge,
  };
}

/**
 * Rollback the workspace to a checkpoint: stop dev (if running) → git reset
 * --hard <sha> → restart dev (only if it was running). Idempotent (resetting to
 * the current HEAD is a no-op). Ownership enforced via the project relation.
 */
async function rollbackCheckpoint({
  checkpointId,
  userId,
  projectId: expectedProjectId = null,
  runId: expectedRunId = null,
  deps = {},
}) {
  const { runner, prisma = defaultPrisma } = deps;
  const db = requireDb(prisma);
  const cp = await db.codexCheckpoint.findFirst({
    where: {
      id: checkpointId,
      project: { userId },
      ...(expectedProjectId ? { projectId: expectedProjectId } : {}),
      ...(expectedRunId ? { runId: expectedRunId } : {}),
    },
  });
  if (!cp) return { error: 'not_found', status: 404 };
  if (!isValidSha(cp.commitSha)) return { error: 'invalid_sha', status: 400 };
  const projectId = cp.projectId;
  const active = await activeRunGuard(db, projectId);
  if (active) return active;

  const previous = await runner.exec(projectId, ['git', 'rev-parse', 'HEAD']).catch(() => null);
  const previousSha = isValidSha(String(previous?.stdout || '').trim())
    ? String(previous.stdout).trim()
    : null;
  let preservation;
  try {
    preservation = await preserveWorkspaceChanges({ runner, projectId });
  } catch (error) {
    return {
      error: 'workspace_preservation_failed',
      status: 409,
      detail: String(error?.code || error?.message || error).slice(0, 400),
    };
  }

  const preview = await devState(runner, projectId);
  if (preview.running) { try { await runner.stopDev(projectId); } catch { /* ignore */ } }
  const reset = await runner.exec(projectId, ['git', 'reset', '--hard', cp.commitSha]);
  if (reset?.exitCode !== 0) {
    let recoveryRestored = !preservation.preserved;
    if (preservation.preserved) {
      const recovered = await recoverWorkspaceChanges({
        runner,
        projectId,
        recoveryRef: preservation.recoveryRef,
      }).catch(() => null);
      recoveryRestored = recovered?.ok === true;
    }
    const restarted = await restartDev(runner, projectId, preview);
    return {
      error: 'reset_failed',
      status: 500,
      detail: String(reset?.stderr || '').slice(0, 400),
      recoveryRestored,
      restarted,
    };
  }

  // Preserve the tokenized preview base path across the restart, otherwise
  // vite re-serves at / and the same-origin proxy iframe 404s.
  const restarted = await restartDev(runner, projectId, preview);
  return {
    ok: true,
    commitSha: cp.commitSha,
    previousSha,
    restarted,
    recovery: preservation.preserved
      ? {
        ref: preservation.recoveryRef,
        files: preservation.files,
      }
      : null,
  };
}

async function restoreWorkspaceSha({ projectId, commitSha, deps = {} }) {
  if (!isValidSha(commitSha)) return { ok: false, error: 'invalid_sha' };
  const active = await activeRunGuard(deps.prisma || null, projectId);
  if (active) return { ok: false, ...active };
  let preservation;
  try {
    preservation = await preserveWorkspaceChanges({ runner: deps.runner, projectId });
  } catch (error) {
    return {
      ok: false,
      error: 'workspace_preservation_failed',
      detail: String(error?.code || error?.message || error).slice(0, 400),
    };
  }
  const reset = await deps.runner.exec(projectId, ['git', 'reset', '--hard', commitSha]);
  if (reset?.exitCode === 0) {
    return {
      ok: true,
      commitSha,
      recovery: preservation.preserved
        ? { ref: preservation.recoveryRef, files: preservation.files }
        : null,
    };
  }
  let recoveryRestored = !preservation.preserved;
  if (preservation.preserved) {
    const recovered = await recoverWorkspaceChanges({
      runner: deps.runner,
      projectId,
      recoveryRef: preservation.recoveryRef,
    }).catch(() => null);
    recoveryRestored = recovered?.ok === true;
  }
  return { ok: false, error: 'reset_failed', recoveryRestored };
}

/** Unified diff of a checkpoint vs its parent (or the empty tree for the first commit). */
async function getCheckpointDiff({ checkpointId, userId, deps = {} }) {
  const { runner, prisma = defaultPrisma } = deps;
  const db = requireDb(prisma);
  const cp = await db.codexCheckpoint.findFirst({ where: { id: checkpointId, project: { userId } } });
  if (!cp) return { error: 'not_found', status: 404 };
  if (!isValidSha(cp.commitSha)) return { error: 'invalid_sha', status: 400 };
  const projectId = cp.projectId;

  const parentCheck = await runner.exec(projectId, ['git', 'rev-parse', '--verify', `${cp.commitSha}^`]).catch(() => ({ exitCode: 1 }));
  const base = parentCheck?.exitCode === 0 ? `${cp.commitSha}^` : EMPTY_TREE;

  const diffOut = await runner.exec(projectId, ['git', 'diff', base, cp.commitSha]);
  let diff = String(diffOut?.stdout || '');
  let truncated = false;
  if (diff.length > DIFF_CAP) { diff = `${diff.slice(0, DIFF_CAP)}\n…[diff truncado]`; truncated = true; }

  const statOut = await runner.exec(projectId, ['git', 'diff', '--shortstat', base, cp.commitSha]).catch(() => ({ stdout: '' }));
  const stat = parseShortstat(statOut?.stdout || '');
  return { ok: true, commitSha: cp.commitSha, diff, truncated, ...stat };
}

async function listCheckpoints({ projectId, userId, prisma = defaultPrisma }) {
  const db = requireDb(prisma);
  if (!db.codexProject) throw new Error('database unavailable');
  const project = await db.codexProject.findFirst({ where: { id: projectId, userId } });
  if (!project) return null; // not owned → route 404
  const rows = await db.codexCheckpoint.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { run: { include: { metric: true } } },
  });
  return rows.map(publicCheckpoint);
}

module.exports = {
  createCheckpoint,
  checkpointCommitBody,
  rollbackCheckpoint,
  restoreWorkspaceSha,
  preserveWorkspaceChanges,
  recoverWorkspaceChanges,
  getCheckpointDiff,
  listCheckpoints,
  generateCheckpointTitle,
  prepareRunBranch,
  finalizeRunCheckpoint,
  parseShortstat,
  isValidSha,
  isValidRecoveryRef,
  projectBaseBranch,
  captureWorkspaceTree,
  commitTreeSha,
  publicCheckpoint,
  withProjectMergeLock,
  EMPTY_TREE,
};
