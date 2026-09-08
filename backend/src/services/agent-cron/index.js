'use strict';

/**
 * F11 — cron-as-agent-turns.
 *
 * Jobs persist as JSON. tick(runner) fires due jobs as a FRESH AgentRunner
 * turn (no leftover history): runner.run({ message, sessionKey, userId,
 * surface, skills }). Cron tools are NOT attached to that turn — no
 * recursive cron by default.
 *
 * createCron({ now = Date.now, persistPath }) so tests can inject a clock
 * and a temp file.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dispatchCronJobAsAgentTurn } = require('../cron-as-turn');

const DEFAULT_PERSIST_PATH = '/tmp/siragpt-cron-jobs.json';

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function parseCronField(field, min, max) {
  const raw = String(field || '').trim();
  if (raw === '*') return null; // any
  if (/^\*\/(\d+)$/.test(raw)) {
    const step = Number(RegExp.$1);
    const set = new Set();
    if (step > 0) {
      for (let n = min; n <= max; n += 1) {
        if ((n - min) % step === 0) set.add(n);
      }
    }
    return set;
  }
  const set = new Set();
  for (const part of raw.split(',')) {
    const range = part.split('-');
    if (range.length === 2) {
      const a = Number(range[0]);
      const b = Number(range[1]);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        for (let n = Math.max(min, a); n <= Math.min(max, b); n += 1) set.add(n);
      }
    } else {
      const n = Number(part);
      if (Number.isFinite(n) && n >= min && n <= max) set.add(n);
    }
  }
  return set;
}

function cronMatches(expr, date) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minF, hourF, domF, monF, dowF] = parts;
  const checks = [
    [parseCronField(minF, 0, 59), date.getUTCMinutes()],
    [parseCronField(hourF, 0, 23), date.getUTCHours()],
    [parseCronField(domF, 1, 31), date.getUTCDate()],
    [parseCronField(monF, 1, 12), date.getUTCMonth() + 1],
    [parseCronField(dowF, 0, 6), date.getUTCDay()],
  ];
  return checks.every(([set, value]) => set == null || set.has(value));
}

function nextFromCronExpr(expr, fromMs) {
  const start = new Date(fromMs + 60_000);
  start.setUTCSeconds(0, 0);
  const cursor = new Date(start.getTime());
  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    if (cronMatches(expr, cursor)) return cursor.getTime();
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return fromMs + 24 * 3600 * 1000;
}

function computeNextRun(job, fromMs) {
  const every = Number(job.everyMs);
  if (Number.isFinite(every) && every > 0) return fromMs + every;
  if (job.cronExpr) return nextFromCronExpr(job.cronExpr, fromMs);
  return fromMs + 60_000;
}

function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, filePath);
}

function loadJobs(persistPath) {
  try {
    const raw = fs.readFileSync(persistPath, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed.jobs;
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

const CRON_CREATE_TOOL = {
  type: 'function',
  function: {
    name: 'cron.create',
    description:
      'Crea un job cron que, al vencer, dispara un turno FRESCO del agente '
      + '(sin historial previo) con el prompt y las skills indicadas. '
      + 'Usa everyMs (intervalo en ms) o cronExpr (5 campos UTC). '
      + 'No crea crons anidados: un turno disparado por cron no puede '
      + 'volver a llamar cron.create.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Mensaje del turno fresco.' },
        everyMs: { type: 'number', description: 'Intervalo en milisegundos.' },
        cronExpr: { type: 'string', description: 'Expresión cron de 5 campos (UTC).' },
        skillNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Skills a adjuntar al turno (nombres).',
        },
        sessionKey: { type: 'string', description: 'Clave de sesión base (el run usa una derivada fresca).' },
        surface: { type: 'string', description: 'Superficie (chat, api, …).' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
};

function createCron({
  now = Date.now,
  persistPath = DEFAULT_PERSIST_PATH,
} = {}) {
  const clock = typeof now === 'function' ? now : () => Number(now) || Date.now();
  const file = persistPath || DEFAULT_PERSIST_PATH;
  let jobs = loadJobs(file);

  function persist() {
    atomicWrite(file, JSON.stringify({ jobs }, null, 2));
  }

  function createJob({
    sessionKey,
    surface = 'chat',
    userId,
    prompt,
    skillNames = [],
    cronExpr = null,
    everyMs = null,
    id = null,
  } = {}) {
    const t = clock();
    const every = everyMs == null ? null : Number(everyMs);
    const expr = cronExpr ? String(cronExpr).trim() : null;
    const uid = userId == null ? '' : String(userId).trim();
    if (!uid) {
      // 3H5 leftover: never create unscoped jobs (they tick but cannot be listed).
      return { ok: false, error: 'userId es obligatorio', code: 'user_required' };
    }
    if (!String(prompt || '').trim()) {
      return { ok: false, error: 'el prompt del cron no puede estar vacío' };
    }
    if (!(Number.isFinite(every) && every > 0) && !expr) {
      return { ok: false, error: 'indica everyMs o cronExpr' };
    }
    // 3H15 leftover: oversized job id fail-closed on create (tick already capped).
    if (id && String(id).length > 128) {
      return { ok: false, error: 'cron_job_id_too_long', code: 'cron_job_id_too_long' };
    }
    const job = {
      id: id || newId(),
      sessionKey: String(sessionKey || `cron:${userId || 'anon'}`),
      surface: String(surface || 'chat'),
      userId: uid,
      prompt: String(prompt),
      skillNames: Array.isArray(skillNames) ? skillNames.map(String) : [],
      cronExpr: expr,
      everyMs: Number.isFinite(every) && every > 0 ? every : null,
      nextRunAt: computeNextRun({ everyMs: every, cronExpr: expr }, t),
      lastStatus: null,
      lastRunAt: null,
      runCount: 0,
    };
    jobs.push(job);
    persist();
    return { ok: true, job };
  }

  function listJobs({ userId } = {}) {
    const uid = userId == null ? '' : String(userId).trim();
    // 3H4-BE-011 leftover: never list another user's jobs. No userId → empty (fail-closed).
    const filtered = uid ? jobs.filter((j) => String(j.userId || '') === uid) : [];
    return filtered.map((j) => ({ ...j, skillNames: (j.skillNames || []).slice() }));
  }

  /**
   * Run every due job as a FRESH agent turn. sessionKey is unique per fire
   * so the runner cannot reuse leftover history. allowCronTools:false stops
   * recursive cron.create from the fired turn.
   */
  async function tick(runner) {
    const t = clock();
    const due = jobs.filter((j) => Number(j.nextRunAt) <= t && String(j.userId || '').trim());
    const ran = [];
    for (const job of due) {
      const runSession = `cron-run:${job.id}:${t}:${job.runCount || 0}`;
      try {
        if (runner && typeof runner.startAgent === 'function') {
          await dispatchCronJobAsAgentTurn(runner, { ...job, sessionKey: runSession }, t);
        } else if (runner && typeof runner.run === 'function') {
          await runner.run({
            message: job.prompt,
            sessionKey: runSession,
            userId: job.userId,
            surface: job.surface,
            skills: job.skillNames || [],
            fresh: true,
            allowCronTools: false,
          });
        } else {
          throw new Error('runner.run no inyectado');
        }
        job.lastStatus = 'ok';
      } catch (err) {
        job.lastStatus = 'error';
        job.lastError = err && err.message ? err.message : String(err);
      }
      job.lastRunAt = t;
      job.runCount = (job.runCount || 0) + 1;
      job.nextRunAt = computeNextRun(job, t);
      ran.push({ id: job.id, lastStatus: job.lastStatus, sessionKey: runSession });
    }
    if (due.length) persist();
    return { ran: ran.length, results: ran };
  }

  function extraToolDefinitions() {
    return [CRON_CREATE_TOOL];
  }

  function extraExecutors({ userId, surface = 'chat', sessionKey } = {}) {
    return {
      'cron.create': async (args = {}, ctx = {}) => {
        if (ctx.fromCron === true || ctx.allowCronTools === false || args.allowCronTools === false) {
          return 'ERROR: cron.create no está permitido dentro de un turno disparado por cron (sin cron recursivo).';
        }
        const result = createJob({
          sessionKey: args.sessionKey || sessionKey,
          surface: args.surface || surface,
          userId: args.userId || userId,
          prompt: args.prompt,
          skillNames: args.skillNames || args.skills || [],
          cronExpr: args.cronExpr,
          everyMs: args.everyMs,
        });
        if (!result.ok) return `ERROR: ${result.error}`;
        return JSON.stringify({ ok: true, id: result.job.id, nextRunAt: result.job.nextRunAt });
      },
    };
  }

  function deleteJob({ id, userId } = {}) {
    const uid = userId == null ? '' : String(userId).trim();
    const jobId = String(id || '').trim();
    if (!uid || !jobId) return { deleted: false, error: 'user_required' };
    const before = jobs.length;
    jobs = jobs.filter((j) => !(String(j.id) === jobId && String(j.userId || '') === uid));
    const deleted = jobs.length < before;
    if (deleted) persist();
    return { ok: deleted, deleted, id: jobId, userId: uid };
  }

  return {
    createJob,
    listJobs,
    deleteJob,
    tick,
    extraToolDefinitions,
    extraExecutors,
    persistPath: file,
  };
}

module.exports = {
  createCron,
  CRON_CREATE_TOOL,
  DEFAULT_PERSIST_PATH,
  cronMatches,
  nextFromCronExpr,
};
