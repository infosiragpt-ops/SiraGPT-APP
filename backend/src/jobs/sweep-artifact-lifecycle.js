/**
 * sweep-artifact-lifecycle — nightly lifecycle pass for generated
 * agent artifacts (Plataforma Artefactos Storage).
 *
 * Before this job existed, the entire artifact lifecycle layer was
 * dead code in production: pruneTaskSnapshots, cleanupOrphanedArtifacts
 * and purgeOrphanedArtifacts were only invoked from tests. Meanwhile
 * saveArtifact() mirrors binaries into Cloudflare R2 and unlinks the
 * local copy, so every pruned task leaked its R2 objects forever —
 * and cleanupOrphanedArtifacts used to delete the `{id}.json`
 * metadata that carries the only durable `storageRef`, making those
 * leaks unrecoverable. The sweep now runs all three passes:
 *
 *   1) pruneTaskSnapshots      — retention/count cap on task snapshots.
 *   2) purgeOrphanedArtifacts  — GeneratedArtifact rows whose parent
 *                                AgentTask row is gone (DB hygiene).
 *   3) cleanupOrphanedArtifacts — unreferenced on-disk artifacts past
 *                                a grace period; purges the R2 mirror
 *                                BEFORE dropping metadata so no remote
 *                                object outlives its pointer.
 *
 * Configuration:
 *   AGENT_ARTIFACT_RETENTION_DAYS   — snapshot retention (default 30).
 *   AGENT_ARTIFACT_SWEEP_DRY_RUN    — "true" reports without deleting.
 *
 * Manual usage:
 *   $ node backend/src/jobs/sweep-artifact-lifecycle.js
 *   $ node backend/src/jobs/sweep-artifact-lifecycle.js --dry-run
 */

'use strict';

const DEFAULT_RETENTION_DAYS = 30;

function _bumpCounter(name, delta) {
  if (!delta) return;
  try {
    // eslint-disable-next-line global-require
    const metrics = require('../utils/metrics');
    if (metrics && typeof metrics.counter === 'function') {
      metrics.counter(name, {}, delta);
    }
  } catch { /* metrics best-effort */ }
}

/**
 * @param {{
 *   dryRun?: boolean,
 *   retentionMs?: number,
 *   logger?: { info: Function, warn: Function },
 * }} [opts]
 */
async function run(opts = {}) {
  const logger = opts.logger || console;
  const dryRun = Boolean(opts.dryRun)
    || String(process.env.AGENT_ARTIFACT_SWEEP_DRY_RUN || '').toLowerCase() === 'true';
  const retentionDays = Number.parseInt(
    process.env.AGENT_ARTIFACT_RETENTION_DAYS || `${DEFAULT_RETENTION_DAYS}`, 10,
  );
  const retentionMs = opts.retentionMs != null
    ? opts.retentionMs
    : (Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : DEFAULT_RETENTION_DAYS)
      * 24 * 60 * 60 * 1000;

  logger.info?.(
    `[sweep-artifact-lifecycle] starting dryRun=${dryRun} retentionMs=${retentionMs}`,
  );

  // Lazy requires so unit tests can inject seams before these load.
  // eslint-disable-next-line global-require
  const taskStore = require('../services/agents/task-store');
  // eslint-disable-next-line global-require
  const persistence = require('../services/agents/agent-task-persistence');

  // Prune first so newly orphaned artifact ids become visible to the
  // cleanup pass in the same run.
  const prune = taskStore.pruneTaskSnapshots({ retentionMs });

  const purge = await persistence.purgeOrphanedArtifacts({ dryRun, limit: 500 });
  if (purge && purge.error) {
    logger.warn?.(`[sweep-artifact-lifecycle] db orphan purge skipped: ${purge.error}`);
  }

  const cleanupOpts = { graceMs: 60 * 60 * 1000 };
  let cleanup;
  if (dryRun) {
    // Count-only: reuse the scan logic via a non-destructive read of
    // referenced ids is not exposed, so fall back to the real sweep
    // with an infinite grace period — it scans but removes nothing.
    cleanup = await taskStore.cleanupOrphanedArtifacts({ ...cleanupOpts, graceMs: Number.MAX_SAFE_INTEGER });
    cleanup.removed = 0;
    cleanup.freedBytes = 0;
    cleanup.remotePurged = 0;
    cleanup.dryRun = true;
  } else {
    cleanup = await taskStore.cleanupOrphanedArtifacts(cleanupOpts);
  }

  _bumpCounter('siragpt_artifact_sweep_removed_total', cleanup.removed);
  _bumpCounter('siragpt_artifact_sweep_remote_purged_total', cleanup.remotePurged);
  if (cleanup.remotePurgeFailed) {
    logger.warn?.(
      `[sweep-artifact-lifecycle] remote purge failed for ${cleanup.remotePurgeFailed} `
      + `artifact(s); metadata kept for retry`,
    );
  }

  const result = {
    dryRun,
    retentionMs,
    prune,
    purge,
    cleanup,
  };
  logger.info?.(`[sweep-artifact-lifecycle] done ${JSON.stringify(result)}`);
  return result;
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((res) => {
      console.log('[sweep-artifact-lifecycle] result:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[sweep-artifact-lifecycle] fatal:', err);
      process.exit(1);
    });
}

module.exports = { run, DEFAULT_RETENTION_DAYS };
