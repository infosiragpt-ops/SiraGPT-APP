/**
 * store.js — pluggable persistence for scheduler jobs and runs.
 *
 * Two implementations:
 *   - InMemoryStore : process-local; ideal for tests and single-node fallback.
 *   - PrismaStore   : PostgreSQL via Prisma client (tables: scheduler_jobs, scheduler_runs).
 *
 * Contract:
 *   loadJobs()                                  -> Promise<JobRow[]>
 *   upsertJob(jobRow)                           -> Promise<JobRow>
 *   updateJobState(id, patch)                   -> Promise<void>
 *   tryAcquireLock(id, runId, ownerToken, ttlMs)-> Promise<boolean>
 *   releaseLock(id, ownerToken)                 -> Promise<void>
 *   recordRun(runRow)                           -> Promise<RunRow|null>  (idempotent on runId)
 *   updateRun(runId, patch)                     -> Promise<void>
 *   listRuns(jobId, limit)                      -> Promise<RunRow[]>
 *
 * JobRow:  { id, name, schedule, enabled, state, nextRunAt, lastRunAt, lastError, runCount, successCount, failureCount, lockedBy, lockedUntil }
 * RunRow:  { runId, jobId, startedAt, finishedAt, status, attempt, error, durationMs }
 */

'use strict';

class InMemoryStore {
  constructor() {
    this.jobs = new Map();      // id -> JobRow
    this.runs = new Map();      // runId -> RunRow
    this.runIndex = new Map();  // jobId -> [runId,...]
    this.locks = new Map();     // jobId -> { ownerToken, until }
  }

  async loadJobs() {
    return [...this.jobs.values()].map(r => ({ ...r }));
  }

  async upsertJob(row) {
    const existing = this.jobs.get(row.id) || {};
    const merged = { ...existing, ...row };
    this.jobs.set(row.id, merged);
    return { ...merged };
  }

  async updateJobState(id, patch) {
    const row = this.jobs.get(id);
    if (!row) return;
    Object.assign(row, patch);
  }

  async tryAcquireLock(id, runId, ownerToken, ttlMs) {
    const now = Date.now();
    const lock = this.locks.get(id);
    if (lock && lock.until > now) return false;
    this.locks.set(id, { ownerToken, until: now + ttlMs, runId });
    return true;
  }

  async releaseLock(id, ownerToken) {
    const lock = this.locks.get(id);
    if (lock && lock.ownerToken === ownerToken) this.locks.delete(id);
  }

  async recordRun(row) {
    if (this.runs.has(row.runId)) return null; // idempotent
    const stored = { ...row };
    this.runs.set(row.runId, stored);
    const list = this.runIndex.get(row.jobId) || [];
    list.unshift(row.runId);
    this.runIndex.set(row.jobId, list);
    return { ...stored };
  }

  async updateRun(runId, patch) {
    const row = this.runs.get(runId);
    if (!row) return;
    Object.assign(row, patch);
  }

  async listRuns(jobId, limit = 20) {
    const ids = this.runIndex.get(jobId) || [];
    return ids.slice(0, limit).map(rid => ({ ...this.runs.get(rid) }));
  }
}

/**
 * PrismaStore — uses raw SQL (no generated Prisma model needed) so we can ship
 * the migration independently of `prisma generate`. Keeps the contract identical.
 */
class PrismaStore {
  /**
   * @param {object} prisma — Prisma client instance with $queryRaw / $executeRaw
   */
  constructor(prisma) {
    if (!prisma) throw new Error('PrismaStore requires a prisma client');
    this.prisma = prisma;
  }

  async loadJobs() {
    const rows = await this.prisma.$queryRaw`
      SELECT id, name, schedule, enabled, state,
             "nextRunAt", "lastRunAt", "lastError",
             "runCount", "successCount", "failureCount",
             "lockedBy", "lockedUntil"
      FROM scheduler_jobs
    `;
    return rows.map(this.#hydrateJob);
  }

  async upsertJob(row) {
    await this.prisma.$executeRaw`
      INSERT INTO scheduler_jobs (
        id, name, schedule, enabled, state,
        "nextRunAt", "lastRunAt", "lastError",
        "runCount", "successCount", "failureCount",
        "createdAt", "updatedAt"
      ) VALUES (
        ${row.id}, ${row.name}, ${row.schedule}, ${row.enabled ?? true}, ${row.state ?? 'idle'},
        ${row.nextRunAt ?? null}, ${row.lastRunAt ?? null}, ${row.lastError ?? null},
        ${row.runCount ?? 0}, ${row.successCount ?? 0}, ${row.failureCount ?? 0},
        NOW(), NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        schedule = EXCLUDED.schedule,
        enabled = EXCLUDED.enabled,
        "updatedAt" = NOW()
    `;
    return row;
  }

  async updateJobState(id, patch) {
    // Build a single SET clause from supported fields.
    const fields = ['state', 'nextRunAt', 'lastRunAt', 'lastError', 'runCount', 'successCount', 'failureCount', 'enabled'];
    const sets = [];
    const values = [];
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(patch, f)) {
        sets.push(`"${f}" = $${values.length + 1}`);
        values.push(patch[f]);
      }
    }
    if (sets.length === 0) return;
    values.push(id);
    const sql = `UPDATE scheduler_jobs SET ${sets.join(', ')}, "updatedAt" = NOW() WHERE id = $${values.length}`;
    await this.prisma.$executeRawUnsafe(sql, ...values);
  }

  async tryAcquireLock(id, runId, ownerToken, ttlMs) {
    const until = new Date(Date.now() + ttlMs);
    // Atomic conditional update: only acquire if no live lock.
    const updated = await this.prisma.$executeRaw`
      UPDATE scheduler_jobs
      SET "lockedBy" = ${ownerToken},
          "lockedUntil" = ${until},
          "updatedAt" = NOW()
      WHERE id = ${id}
        AND ("lockedUntil" IS NULL OR "lockedUntil" < NOW())
    `;
    return Number(updated) > 0;
  }

  async releaseLock(id, ownerToken) {
    await this.prisma.$executeRaw`
      UPDATE scheduler_jobs
      SET "lockedBy" = NULL, "lockedUntil" = NULL, "updatedAt" = NOW()
      WHERE id = ${id} AND "lockedBy" = ${ownerToken}
    `;
  }

  async recordRun(row) {
    // Idempotent on runId (PK).
    try {
      await this.prisma.$executeRaw`
        INSERT INTO scheduler_runs (
          "runId", "jobId", "startedAt", "finishedAt", status, attempt, error, "durationMs"
        ) VALUES (
          ${row.runId}, ${row.jobId}, ${row.startedAt}, ${row.finishedAt ?? null},
          ${row.status}, ${row.attempt ?? 0}, ${row.error ?? null}, ${row.durationMs ?? null}
        )
        ON CONFLICT ("runId") DO NOTHING
      `;
      return row;
    } catch (e) {
      return null;
    }
  }

  async updateRun(runId, patch) {
    const fields = ['finishedAt', 'status', 'attempt', 'error', 'durationMs'];
    const sets = [];
    const values = [];
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(patch, f)) {
        sets.push(`"${f}" = $${values.length + 1}`);
        values.push(patch[f]);
      }
    }
    if (sets.length === 0) return;
    values.push(runId);
    const sql = `UPDATE scheduler_runs SET ${sets.join(', ')} WHERE "runId" = $${values.length}`;
    await this.prisma.$executeRawUnsafe(sql, ...values);
  }

  async listRuns(jobId, limit = 20) {
    return this.prisma.$queryRaw`
      SELECT "runId", "jobId", "startedAt", "finishedAt", status, attempt, error, "durationMs"
      FROM scheduler_runs
      WHERE "jobId" = ${jobId}
      ORDER BY "startedAt" DESC
      LIMIT ${Number(limit)}
    `;
  }

  #hydrateJob(r) {
    return {
      id: r.id,
      name: r.name,
      schedule: r.schedule,
      enabled: r.enabled,
      state: r.state,
      nextRunAt: r.nextRunAt,
      lastRunAt: r.lastRunAt,
      lastError: r.lastError,
      runCount: Number(r.runCount || 0),
      successCount: Number(r.successCount || 0),
      failureCount: Number(r.failureCount || 0),
      lockedBy: r.lockedBy,
      lockedUntil: r.lockedUntil,
    };
  }
}

module.exports = { InMemoryStore, PrismaStore };
