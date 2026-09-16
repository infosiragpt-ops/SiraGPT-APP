'use strict';

/**
 * Build a scrubbed SFT/DPO/RM JSONL from the flywheel export and persist
 * it through the existing object-storage path (R2 when configured, local
 * uploads/ fallback otherwise).
 *
 * Never logs raw preference text, emails, or other PII. Job.result only
 * stores counts, byte size, storage kind, and an artifact pointer.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('./preference-store');
const exporter = require('./export');
const objectStorage = require('../object-storage');
const { trySubmit } = require('./train-submit');
const { isTrainSubmitEnabled } = require('./flags');

const FORMATS = new Set(['sft', 'dpo', 'pairs', 'rm']);
const DEFAULT_HYDRATE_LIMIT = 10_000;

class TrainJobError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'TrainJobError';
    this.code = code;
    this.status = status;
  }
}

function sanitizeJobId(jobId) {
  return String(jobId || 'job').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'job';
}

function summarisePiiHits(hits) {
  const kinds = Object.create(null);
  let count = 0;
  for (const h of hits || []) {
    const id = typeof h?.id === 'string' ? h.id.slice(0, 32) : 'unknown';
    const n = Number(h?.count) || 0;
    kinds[id] = (kinds[id] || 0) + n;
    count += n;
  }
  return { count, kinds };
}

function localArtifactDir(jobId, env = process.env) {
  const root = env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
  return path.join(root, 'rlhf-train', sanitizeJobId(jobId));
}

async function persistJsonl({ jobId, format, ndjson, env = process.env, storage = objectStorage }) {
  const filename = `${format === 'pairs' ? 'dpo' : format}.jsonl`;
  const key = `rlhf-train/${sanitizeJobId(jobId)}/${filename}`;
  const buf = Buffer.from(String(ndjson || ''), 'utf8');
  const dir = localArtifactDir(jobId, env);
  fs.mkdirSync(dir, { recursive: true });
  const localPath = path.join(dir, filename);
  fs.writeFileSync(localPath, buf);

  let persisted = { key, ref: localPath, storage: 'local' };
  try {
    if (storage && typeof storage.persistLocalFile === 'function') {
      persisted = await storage.persistLocalFile({
        localPath,
        key,
        contentType: 'application/x-ndjson; charset=utf-8',
        metadata: { jobId: sanitizeJobId(jobId), format, kind: 'rlhf-train' },
        deleteLocal: false,
        env,
      });
    }
  } catch {
    persisted = { key, ref: localPath, storage: 'local' };
  }

  const storageKind = persisted.storage === 'r2' || (persisted.ref && String(persisted.ref).startsWith('r2:'))
    ? 'r2'
    : 'local';
  return {
    storage: storageKind,
    key,
    ref: persisted.ref || localPath,
    localPath,
    bytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}

function publicResult(artifact, stats, submit) {
  return {
    count: stats.count,
    bytes: artifact.bytes,
    format: stats.format,
    storage: artifact.storage,
    artifactKey: artifact.key,
    sha256: artifact.sha256,
    piiHits: stats.piiHits,
    downloadPath: stats.downloadPath,
    submit: {
      submitted: !!submit?.submitted,
      reason: submit?.reason || 'prep_only',
      brandHint: submit?.brandHint || null,
    },
    __private: {
      localPath: artifact.localPath,
      ref: artifact.ref,
    },
  };
}

async function hydrateSource({ userId, limit = DEFAULT_HYDRATE_LIMIT }) {
  if (typeof store.hydrateForExport === 'function') {
    await store.hydrateForExport({ userId: userId || null, limit }).catch(() => []);
    return;
  }
  if (userId && typeof store.hydrateUser === 'function') {
    await store.hydrateUser(userId).catch(() => []);
    return;
  }
  if (typeof store.hydrateRecent === 'function') {
    await store.hydrateRecent({ limit: Math.min(1000, limit) }).catch(() => []);
  }
}

/**
 * Run one prep job. `ctx.progress` is optional (queue supplies it).
 */
async function processTrainJob(spec, ctx = {}) {
  const format = String(spec.format || 'sft').toLowerCase();
  if (!FORMATS.has(format)) {
    throw new TrainJobError('E_PARAMS', `unknown format '${format}' — use sft, dpo, or rm`);
  }
  const includeRlaif = spec.includeRlaif === true;
  const scrubPii = spec.scrubPii !== false;
  const aggressive = spec.aggressive === true;
  const minPairs = Math.max(1, Math.min(10_000, Number(spec.minPairs) || 1));
  const userId = spec.scope === 'user' ? (spec.scopeUserId || null) : null;
  const agent = typeof spec.agent === 'string' && spec.agent.trim() ? spec.agent.trim().slice(0, 32) : null;
  const jobId = spec.jobId || ctx.jobId || 'job';
  const env = spec.env || ctx.env || process.env;
  const exportData = spec.exportData || exporter.exportData;
  const persist = spec.persistJsonl || persistJsonl;
  const submitFn = spec.trySubmit || trySubmit;
  const progress = typeof ctx.progress === 'function' ? ctx.progress : async () => {};

  await progress({ stage: 'Preparando', progress: 10 });
  await hydrateSource({ userId, limit: spec.hydrateLimit || DEFAULT_HYDRATE_LIMIT });

  if (ctx.signal?.aborted) throw new TrainJobError('E_CANCELLED', 'job cancelled', 499);

  await progress({ stage: 'Exportando', progress: 40 });
  const out = await exportData({
    userId: userId || null,
    format,
    agent,
    scrubPii,
    aggressive,
    includeRlaif,
  });

  const count = Number(out?.count) || 0;
  if (count < minPairs) {
    throw new TrainJobError(
      'E_PARAMS',
      `need at least ${minPairs} ${format === 'dpo' || format === 'pairs' ? 'pairs' : 'rows'}, got ${count}`,
    );
  }

  if (ctx.signal?.aborted) throw new TrainJobError('E_CANCELLED', 'job cancelled', 499);

  await progress({ stage: 'Guardando', progress: 75 });
  const artifact = await persist({
    jobId,
    format: format === 'pairs' ? 'dpo' : format,
    ndjson: out.ndjson || '',
    env,
    storage: spec.storage || objectStorage,
  });

  const piiHits = summarisePiiHits(out.piiHits);
  let submit = { submitted: false, reason: 'prep_only' };
  if (spec.submitRequested && isTrainSubmitEnabled(env)) {
    submit = await submitFn({
      format: format === 'pairs' ? 'dpo' : format,
      count,
      bytes: artifact.bytes,
      storage: artifact.storage,
    }, env);
  } else if (spec.submitRequested) {
    submit = { submitted: false, reason: 'submit_flag_off' };
  }

  const stats = {
    count,
    format: format === 'pairs' ? 'dpo' : format,
    piiHits,
    downloadPath: `/api/rlhf/jobs/${jobId}/artifact`,
  };
  const result = publicResult(artifact, stats, submit);

  try {
    require('./metrics').recordTrainJob({
      status: 'ready',
      format: stats.format,
      count,
      bytes: artifact.bytes,
    });
  } catch {
    /* telemetry is optional */
  }

  return result;
}

module.exports = {
  TrainJobError,
  processTrainJob,
  persistJsonl,
  summarisePiiHits,
  sanitizeJobId,
  FORMATS,
  DEFAULT_HYDRATE_LIMIT,
};
