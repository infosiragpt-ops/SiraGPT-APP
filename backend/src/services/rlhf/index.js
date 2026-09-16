'use strict';

/**
 * RLHF flywheel — public facade.
 *
 * InstructGPT (Ouyang et al. 2022) is three stages:
 *   1. collect human preferences
 *   2. fit a reward model
 *   3. optimise the policy against the RM
 *
 * SiraGPT implements all three inside the product:
 *   1. durable PreferenceEvent rows (thumbs + regenerates + optional RLAIF)
 *   2. a linear Bradley-Terry RM on the same embeddings as RAG
 *   3. inference-time best-of-N / scoring + DPO/SFT export for weight updates
 *
 * We do not run GPU PPO in-process. Exported DPO JSONL is the on-ramp to
 * an external fine-tune (OpenAI, TRL, OpenRLHF) when you have enough labels.
 */

const store = require('./preference-store');
const trainer = require('./trainer');
const policy = require('./policy');
const rlaif = require('./rlaif');
const exporter = require('./export');
const rewardModel = require('./reward-model');
const vectors = require('./vectors');
const steering = require('./steering');
const metrics = require('./metrics');
const routingBridge = require('./routing-bridge');
const flags = require('./flags');
const trainJobs = require('./train-jobs');
const trainProcessor = require('./train-processor');
const trainSubmit = require('./train-submit');

function _reset() {
  store._reset();
  trainer._reset();
  metrics.reset();
}

function pushEventIntoLedger(ledger, e) {
  if (!ledger || typeof ledger.ingestLocal !== 'function' || !e) return false;
  ledger.ingestLocal({
    userId: e.userId,
    runId: e.runId || e.messageId || e.id,
    agent: e.agent,
    request: e.promptText,
    response: e.responseText,
    helpful: e.label === 'chosen',
    notes: e.notes,
    embedding: e.promptEmbedding || e.embedding,
    at: e.createdAt,
  });
  return true;
}

async function hydrateIntoLedger(userId, ledger) {
  if (!userId || !ledger) return 0;
  const events = await store.hydrateUser(userId);
  let n = 0;
  for (const e of events) {
    if (pushEventIntoLedger(ledger, e)) n += 1;
  }
  return n;
}

async function hydrateRecentIntoLedger(ledger, { limit = 200 } = {}) {
  const events = await store.hydrateRecent({ limit });
  if (!ledger) return events.length;
  let n = 0;
  for (const e of events) {
    if (pushEventIntoLedger(ledger, e)) n += 1;
  }
  return n;
}

module.exports = {
  // collection
  isCollectionEnabled: store.isCollectionEnabled,
  attachPrisma: store.attachPrisma,
  recordEvent: store.recordEvent,
  ingestThumb: store.ingestThumb,
  recordPair: store.recordPair,
  ingestRegenerate: store.ingestRegenerate,
  findExemplars: store.findExemplars,
  hydrateUser: store.hydrateUser,
  hydrateRecent: store.hydrateRecent,
  hydrateIntoLedger,
  hydrateRecentIntoLedger,
  stats: store.stats,
  dump: store.dump,
  // reward model
  train: trainer.train,
  maybeRetrain: trainer.maybeRetrain,
  getActiveModel: trainer.getActive,
  hasActiveModel: trainer.hasActiveModel,
  loadLatestActive: trainer.loadLatestActive,
  score: trainer.score,
  scoreCompletion: policy.scoreCompletion,
  rankSamples: policy.rankSamples,
  pickBest: policy.pickBest,
  isBestOfNEnabled: policy.isBestOfNEnabled,
  // phase-2 steering + telemetry
  isSteeringEnabled: steering.isSteeringEnabled,
  buildSteeringBlock: steering.buildSteeringBlock,
  formatSteeringBlock: steering.formatSteeringBlock,
  maybeRankSamples: steering.maybeRankSamples,
  phase2Stats: metrics.phase2Stats,
  metrics,
  routingBridge,
  steering,
  // rlaif
  rlaif,
  // export
  exportData: exporter.exportData,
  // phase-3 train-prep jobs (flagged, admin, prep-only)
  isTrainJobsEnabled: flags.isTrainJobsEnabled,
  isTrainSubmitEnabled: flags.isTrainSubmitEnabled,
  isSubmitAvailable: trainSubmit.isSubmitAvailable,
  processTrainJob: trainProcessor.processTrainJob,
  trainJobs,
  trainSubmit,
  // primitives (tests)
  rewardModel,
  vectors,
  store,
  trainer,
  policy,
  exporter,
  flags,
  _reset,
};
