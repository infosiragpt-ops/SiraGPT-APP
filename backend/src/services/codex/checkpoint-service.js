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

const defaultPrisma = (() => {
  try { return require('../../config/database'); } catch { return null; }
})();

const SHA_RE = /^[0-9a-f]{7,40}$/;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git hash-object of the empty tree
const DIFF_CAP = 500_000;

function isValidSha(sha) {
  return typeof sha === 'string' && SHA_RE.test(sha);
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
  const { runner, eventStore, prisma = defaultPrisma, llmTurn, env, clock = () => new Date() } = deps;
  const projectId = project?.id || run.projectId;

  // Check for changes BEFORE touching the DB — a clean tree means no checkpoint
  // and no card, so we never need a database connection in that case.
  const status = await runner.exec(projectId, ['git', 'status', '--porcelain']);
  const changed = String(status?.stdout || '').trim();
  if (!changed) return null; // clean tree → no checkpoint

  const db = requireDb(prisma);
  const title = await generateCheckpointTitle({ run, changedFiles: changed.slice(0, 2000), llmTurn, env });
  const commitSha = await gitCommitAll(runner, projectId, title);

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
 * Rollback the workspace to a checkpoint: stop dev (if running) → git reset
 * --hard <sha> → restart dev (only if it was running). Idempotent (resetting to
 * the current HEAD is a no-op). Ownership enforced via the project relation.
 */
async function rollbackCheckpoint({ checkpointId, userId, deps = {} }) {
  const { runner, prisma = defaultPrisma } = deps;
  const db = requireDb(prisma);
  const cp = await db.codexCheckpoint.findFirst({ where: { id: checkpointId, project: { userId } } });
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
  return { ok: true, commitSha: cp.commitSha, restarted };
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
  getCheckpointDiff,
  listCheckpoints,
  generateCheckpointTitle,
  parseShortstat,
  isValidSha,
  publicCheckpoint,
  EMPTY_TREE,
};
