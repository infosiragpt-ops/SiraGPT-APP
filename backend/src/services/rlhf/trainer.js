'use strict';

/**
 * Fit / cache / persist the active reward model from the preference store.
 *
 * Training is cheap (linear SGD on embeddings) and runs:
 *   - on demand via POST /api/rlhf/train (admin)
 *   - lazily after enough new labels (`maybeRetrain`)
 *
 * The active model lives in process memory. Prisma snapshots are best-effort
 * so a restart can reload the last active weights without retraining.
 */

const rewardModel = require('./reward-model');
const store = require('./preference-store');

const DEFAULT_MIN_NEW = 16;
const TRAIN_COOLDOWN_MS = 60_000;

let active = null; // { model, metrics, version, trainedAt, scope }
let lastTrainAt = 0;
let lastTrainCount = 0;
let inFlight = null;
let versionCounter = 0;

function getActive() {
  return active;
}

function hasActiveModel() {
  return !!(active && active.model && active.model.weights);
}

function buildDatasets(userId) {
  const pointwise = store.labeledPointwise(userId).map((e) => ({
    promptEmb: e.promptEmbedding || e.embedding,
    responseEmb: e.responseEmbedding,
    y: e.label === 'chosen' ? 1 : 0,
  }));
  const pairs = store.pairsFor(userId)
    .filter((p) => (p.chosen.promptEmbedding || p.chosen.embedding)
      && p.chosen.responseEmbedding
      && p.rejected.responseEmbedding)
    .map((p) => ({
      promptEmb: p.chosen.promptEmbedding || p.chosen.embedding || p.rejected.promptEmbedding,
      chosenEmb: p.chosen.responseEmbedding,
      rejectedEmb: p.rejected.responseEmbedding,
    }));
  return { pointwise, pairs };
}

async function persistSnapshot(result, { scope, userId }) {
  const prisma = store.getPrisma();
  if (!prisma || typeof prisma.rewardModelSnapshot?.create !== 'function') return null;
  try {
    if (result.model) {
      await prisma.rewardModelSnapshot.updateMany({
        where: { scope, userId: userId || null, active: true },
        data: { active: false },
      }).catch(() => {});
    }
    const row = await prisma.rewardModelSnapshot.create({
      data: {
        version: versionCounter,
        scope,
        userId: userId || null,
        dim: result.model.dim,
        weights: rewardModel.serialize(result.model),
        nTrain: result.metrics.nPointwise,
        nPairs: result.metrics.nPairs,
        auc: result.metrics.auc,
        logloss: result.metrics.logloss,
        active: true,
      },
    });
    return row.id;
  } catch (err) {
    console.warn('[rlhf] snapshot persist failed:', err.message || err);
    return null;
  }
}

async function loadLatestActive() {
  if (active) return active;
  const prisma = store.getPrisma();
  if (!prisma || typeof prisma.rewardModelSnapshot?.findFirst !== 'function') return null;
  try {
    const row = await prisma.rewardModelSnapshot.findFirst({
      where: { active: true, scope: 'global' },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) return null;
    const model = rewardModel.deserialize(row.weights);
    if (!model) return null;
    active = {
      model,
      metrics: {
        nPointwise: row.nTrain,
        nPairs: row.nPairs,
        auc: row.auc,
        logloss: row.logloss,
      },
      version: row.version,
      trainedAt: row.createdAt,
      scope: row.scope,
      snapshotId: row.id,
    };
    versionCounter = Math.max(versionCounter, row.version);
    return active;
  } catch (err) {
    console.warn('[rlhf] snapshot load failed:', err.message || err);
    return null;
  }
}

async function train(opts = {}) {
  const userId = opts.userId || null;
  const scope = userId && opts.scope === 'user' ? 'user' : 'global';
  const { pointwise, pairs } = buildDatasets(scope === 'user' ? userId : null);
  const result = rewardModel.train({ pointwise, pairs, opts: opts.rmOpts || {} });
  if (!result.ok) return result;

  versionCounter += 1;
  active = {
    model: result.model,
    metrics: result.metrics,
    version: versionCounter,
    trainedAt: new Date().toISOString(),
    scope,
    userId: scope === 'user' ? userId : null,
  };
  lastTrainAt = Date.now();
  lastTrainCount = store.stats(scope === 'user' ? userId : null).total;
  const snapshotId = await persistSnapshot(result, { scope, userId: active.userId });
  if (snapshotId) active.snapshotId = snapshotId;
  return { ok: true, ...active, snapshotId };
}

function maybeRetrain() {
  const now = Date.now();
  if (now - lastTrainAt < TRAIN_COOLDOWN_MS) return null;
  const total = store.stats().total;
  const minNew = Number(process.env.SIRAGPT_RLHF_TRAIN_EVERY || DEFAULT_MIN_NEW);
  if (total - lastTrainCount < (Number.isFinite(minNew) ? minNew : DEFAULT_MIN_NEW)) return null;
  if (inFlight) return inFlight;
  inFlight = Promise.resolve()
    .then(() => train())
    .catch((err) => {
      console.warn('[rlhf] auto-train failed:', err.message || err);
      return { ok: false, reason: err.message };
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

function _reset() {
  active = null;
  lastTrainAt = 0;
  lastTrainCount = 0;
  inFlight = null;
  versionCounter = 0;
}

function score(promptEmb, responseEmb) {
  if (!hasActiveModel()) return { ready: false, score: 0 };
  return {
    ready: true,
    score: rewardModel.score(active.model, promptEmb, responseEmb),
    version: active.version,
  };
}

module.exports = {
  getActive,
  hasActiveModel,
  train,
  maybeRetrain,
  loadLatestActive,
  score,
  _reset,
  DEFAULT_MIN_NEW,
  TRAIN_COOLDOWN_MS,
};
