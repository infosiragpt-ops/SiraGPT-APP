'use strict';

/**
 * RLHF env flags.
 *
 * Collection / steering default ON (cheap). Costly surfaces default OFF:
 *   - SIRAGPT_RLHF_BEST_OF_N     inference-time sample-and-rank
 *   - SIRAGPT_RLHF_TRAIN_JOBS    admin SFT/DPO prep jobs (this lote)
 *   - SIRAGPT_RLHF_TRAIN_SUBMIT  optional external submit after prep
 *
 * SIRAGPT_RLHF_AUTO_TRAIN is the in-process Bradley-Terry RM cooldown
 * retrainer from #708. It must never enqueue a train-prep job or an
 * external fine-tune — that would burn money if someone later wires a
 * paid adapter.
 */

function envFlagOn(value) {
  if (value == null || String(value).trim() === '') return false;
  const s = String(value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes';
}

function envFlagOff(value) {
  if (value == null || String(value).trim() === '') return false;
  const s = String(value).trim().toLowerCase();
  return s === '0' || s === 'false' || s === 'off' || s === 'no';
}

function isTrainJobsEnabled(env = process.env) {
  return envFlagOn(env.SIRAGPT_RLHF_TRAIN_JOBS);
}

function isTrainSubmitEnabled(env = process.env) {
  return envFlagOn(env.SIRAGPT_RLHF_TRAIN_SUBMIT);
}

function isAutoTrainEnabled(env = process.env) {
  return !envFlagOff(env.SIRAGPT_RLHF_AUTO_TRAIN);
}

module.exports = {
  envFlagOn,
  envFlagOff,
  isTrainJobsEnabled,
  isTrainSubmitEnabled,
  isAutoTrainEnabled,
};
