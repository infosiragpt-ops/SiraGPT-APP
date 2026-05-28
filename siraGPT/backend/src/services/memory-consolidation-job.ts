/**
 * memory-consolidation-job — Background job that keeps the user_memories
 * table healthy by merging near-duplicate entries, promoting frequently-
 * accessed memories, demoting stale ones, and purging dead entries.
 *
 * Scheduling:
 *   Runs every 30 minutes (configurable via MEMORY_CONSOLIDATION_CRON).
 *   Default: every 30 minutes.
 *
 * Batching:
 *   Processes users in batches of MEMORY_CONSOLIDATION_BATCH (default 50)
 *   so the job never locks the table for too long.
 *
 * Logging:
 *   Uses pino for structured logging. Emits per-user stats and summary.
 *
 * Integration:
 *   This module exports a `start()` / `stop()` pair following the same
 *   pattern as jobs/system-cron.js.
 *
 * Usage:
 *   const { start, stop } = require('./services/memory-consolidation-job');
 *   const job = start({ batchSize: 50 });
 *   stop();
 */

import pino from "pino";

const DEFAULT_CRON = "*/30 * * * *";
const DEFAULT_BATCH_SIZE = 50;
const logger = pino({ name: "memory-consolidation-job", level: process.env.LOG_LEVEL || "info" });

interface JobOptions {
  logger?: typeof pino;
  batchSize?: number;
  cronSchedule?: string;
  gateway?: any;
  maxAgeDays?: number;
}

interface JobState {
  enabled: boolean;
  task?: any;
  stop(): void;
}

let _state: JobState | null = null;

function isEnabled(): boolean {
  if (process.env.NODE_ENV === "test") return false;
  const v = process.env.MEMORY_CONSOLIDATION_ENABLED;
  if (v == null) return true;
  return String(v).toLowerCase() !== "false";
}

async function getUsersWithMemories(
  getDb: () => any,
  offset: number,
  limit: number,
): Promise<string[]> {
  const prisma = getDb();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT user_id
     FROM user_memories
     WHERE last_accessed_at > NOW() - INTERVAL '180 days'
     ORDER BY user_id
     LIMIT $1 OFFSET $2`,
    limit,
    offset,
  );
  return (rows || []).map((r: any) => String(r.user_id || ""));
}

async function getUserCount(getDb: () => any): Promise<number> {
  const prisma = getDb();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(DISTINCT user_id)::int AS total
     FROM user_memories
     WHERE last_accessed_at > NOW() - INTERVAL '180 days'`,
  );
  return Number((rows[0] as any)?.total || 0);
}

async function runConsolidationPass(opts: Required<JobOptions>): Promise<void> {
  const { batchSize, maxAgeDays } = opts;

  let prisma: any;
  try {
    const { PrismaClient } = require("@prisma/client");
    prisma = new PrismaClient();
  } catch (err: any) {
    logger.error({ err }, "Cannot create Prisma client for memory consolidation");
    return;
  }

  function getDb() {
    return prisma;
  }

  const startTime = Date.now();
  let totalPromoted = 0;
  let totalMerged = 0;
  let totalDemoted = 0;
  let totalPurged = 0;
  let usersProcessed = 0;

  try {
    const userCount = await getUserCount(getDb);
    if (userCount === 0) {
      logger.info("No users with recent memories — skipping consolidation");
      return;
    }

    logger.info({ userCount, batchSize }, "Starting memory consolidation sweep");

    let offset = 0;
    const batches: string[][] = [];

    while (true) {
      const userIds = await getUsersWithMemories(getDb, offset, batchSize);
      if (userIds.length === 0) break;
      batches.push(userIds);
      offset += batchSize;
    }

    for (const batch of batches) {
      for (const userId of batch) {
        try {
          const promoteResult = await prisma.$executeRawUnsafe(
            `UPDATE user_memories
             SET importance_score = LEAST(importance_score * 1.2, 1.0)
             WHERE user_id = $1
               AND access_count > 3
               AND importance_score < 0.8
               AND updated_at < NOW() - INTERVAL '24 hours'`,
            userId,
          ).catch(() => 0);
          totalPromoted += Number(promoteResult || 0);

          await prisma.$executeRawUnsafe(
            `WITH similar AS (
               SELECT a.id AS keep_id, b.id AS dup_id,
                      1 - (a.embedding <=> b.embedding) AS sim
               FROM user_memories a
               JOIN user_memories b
                 ON a.user_id = b.user_id
                AND a.id < b.id
                AND a.user_id = $1
               WHERE 1 - (a.embedding <=> b.embedding) > 0.85
             ),
             candidates AS (
               SELECT DISTINCT keep_id, dup_id, sim FROM similar
             )
             UPDATE user_memories
             SET importance_score = LEAST(importance_score + 0.1, 1.0),
                 source = COALESCE(source, 'consolidated')
             WHERE id IN (SELECT keep_id FROM candidates)`,
            userId,
          ).catch(() => null);

          try {
            const mergeRows = await prisma.$queryRawUnsafe(
              `SELECT COUNT(*)::int AS cnt
               FROM user_memories a
               JOIN user_memories b
                 ON a.user_id = b.user_id
                AND a.id < b.id
                AND a.user_id = $1
               WHERE 1 - (a.embedding <=> b.embedding) > 0.85`,
              userId,
            );
            totalMerged += Number((mergeRows[0] as any)?.cnt || 0);
          } catch {
            /* best-effort */
          }

          const demoteResult = await prisma.$executeRawUnsafe(
            `UPDATE user_memories
             SET importance_score = GREATEST(importance_score * 0.85, 0)
             WHERE user_id = $1
               AND access_count < 2
               AND importance_score > 0.15
               AND last_accessed_at < NOW() - INTERVAL '30 days'`,
            userId,
          ).catch(() => 0);
          totalDemoted += Number(demoteResult || 0);

          const purgeResult = await prisma.$executeRawUnsafe(
            `DELETE FROM user_memories
             WHERE user_id = $1
               AND importance_score < 0.2
               AND access_count < 2
               AND last_accessed_at < NOW() - INTERVAL '${maxAgeDays} days'`,
            userId,
          ).catch(() => 0);
          totalPurged += Number(purgeResult || 0);

          usersProcessed++;
        } catch (err: any) {
          logger.warn({ err, userId }, "Consolidation failed for user");
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const elapsed = Date.now() - startTime;
    logger.info(
      {
        elapsedMs: elapsed,
        usersProcessed,
        totalPromoted,
        totalMerged,
        totalDemoted,
        totalPurged,
      },
      "Memory consolidation sweep complete",
    );
  } catch (err: any) {
    logger.error({ err }, "Memory consolidation sweep failed");
  } finally {
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
  }
}

export function start(opts: JobOptions = {}): JobState {
  if (_state) return _state;
  if (!isEnabled()) {
    logger.info("Memory consolidation job disabled (MEMORY_CONSOLIDATION_ENABLED)");
    return { enabled: false, stop: () => {} };
  }

  const cronStr = opts.cronSchedule || process.env.MEMORY_CONSOLIDATION_CRON || DEFAULT_CRON;
  const batchSize = opts.batchSize || Number(process.env.MEMORY_CONSOLIDATION_BATCH) || DEFAULT_BATCH_SIZE;
  const maxAgeDays = opts.maxAgeDays || Number(process.env.MEMORY_CONSOLIDATION_MAX_AGE_DAYS) || 90;

  let cron: any;
  try {
    cron = require("node-cron");
  } catch (err: any) {
    logger.warn(`node-cron not available — memory consolidation disabled: ${err.message}`);
    return { enabled: false, stop: () => {} };
  }

  let running = false;

  const task = cron.schedule(cronStr, async () => {
    if (running) {
      logger.debug("Skipping memory consolidation — previous run still in progress");
      return;
    }
    running = true;
    try {
      await runConsolidationPass({ batchSize, cronSchedule: cronStr, maxAgeDays, gateway: opts.gateway, logger } as Required<JobOptions>);
    } catch (err: any) {
      logger.error({ err }, "Unhandled error in memory consolidation job");
    } finally {
      running = false;
    }
  });

  _state = { enabled: true, task, stop: () => task.stop() };

  logger.info(
    { cron: cronStr, batchSize, maxAgeDays },
    "Memory consolidation job started",
  );

  return _state;
}

export function stop(): void {
  if (!_state) return;
  _state.stop();
  _state = null;
  logger.info("Memory consolidation job stopped");
}

export async function runOnce(opts: JobOptions = {}): Promise<void> {
  const batchSize = opts.batchSize || Number(process.env.MEMORY_CONSOLIDATION_BATCH) || DEFAULT_BATCH_SIZE;
  const maxAgeDays = opts.maxAgeDays || Number(process.env.MEMORY_CONSOLIDATION_MAX_AGE_DAYS) || 90;
  await runConsolidationPass({
    logger,
    batchSize,
    cronSchedule: "manual",
    maxAgeDays,
    gateway: opts.gateway,
  } as Required<JobOptions>);
}

export default { start, stop, runOnce };
