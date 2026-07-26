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
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git hash-object of the empty tree
const DIFF_CAP = 500_000;

function isValidSha(sha) {
  return typeof sha === 'string' && SHA_RE.test(sha);
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
  const commitSha = await gitCommitAll(runner, projectId, title);
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
  if (typeof runner.exportWorkspace === 'function') {
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

  const merge = await mergeRunBranch({
    runner: deps.runner,
    projectId,
    runId: run.id,
    baseBranch,
    verification,
    verify,
    expectedCommitSha: checkpoint?.commitSha || null,
    expectedTreeSha: deps.expectedTreeSha || null,
  });
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

  let wasRunning = false;
  let devBasePath = null;
  try {
    // Multi-project runner: ask for THIS project's dev server (legacy runners
    // without ?project support answer with the last-started server; the
    // project check below keeps that path correct too).
    const st = await runner.devStatus(projectId);
    wasRunning = Boolean(st && (st.running || st.ready) && (st.project === projectId || st.project == null));
    devBasePath = st && st.basePath ? st.basePath : null;
  } catch { /* runner status best-effort */ }
  if (wasRunning) { try { await runner.stopDev(projectId); } catch { /* ignore */ } }

  const previous = await runner.exec(projectId, ['git', 'rev-parse', 'HEAD']).catch(() => null);
  const previousSha = isValidSha(String(previous?.stdout || '').trim())
    ? String(previous.stdout).trim()
    : null;
  const reset = await runner.exec(projectId, ['git', 'reset', '--hard', cp.commitSha]);
  if (reset?.exitCode !== 0) {
    return { error: 'reset_failed', status: 500, detail: String(reset?.stderr || '').slice(0, 400) };
  }

  let restarted = false;
  if (wasRunning) {
    // Preserve the tokenized preview base path across the restart, otherwise
    // vite re-serves at / and the same-origin proxy iframe 404s.
    try { await runner.startDev(projectId, { basePath: devBasePath }); restarted = true; } catch { /* ignore */ }
  }
  return { ok: true, commitSha: cp.commitSha, previousSha, restarted };
}

async function restoreWorkspaceSha({ projectId, commitSha, deps = {} }) {
  if (!isValidSha(commitSha)) return { ok: false, error: 'invalid_sha' };
  const reset = await deps.runner.exec(projectId, ['git', 'reset', '--hard', commitSha]);
  return reset?.exitCode === 0
    ? { ok: true, commitSha }
    : { ok: false, error: 'reset_failed' };
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
  rollbackCheckpoint,
  restoreWorkspaceSha,
  getCheckpointDiff,
  listCheckpoints,
  generateCheckpointTitle,
  prepareRunBranch,
  finalizeRunCheckpoint,
  parseShortstat,
  isValidSha,
  projectBaseBranch,
  captureWorkspaceTree,
  commitTreeSha,
  publicCheckpoint,
  EMPTY_TREE,
};
