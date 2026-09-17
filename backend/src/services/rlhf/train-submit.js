'use strict';

/**
 * Optional post-prep submit of a scrubbed SFT/DPO JSONL.
 *
 * There is no in-repo fine-tune client for the Sira catalog models
 * (Sira Rápido / Sira Pro). This module therefore refuses to submit:
 * it never invents a third-party aggregator, never calls a paid API,
 * and never logs artifact bytes.
 *
 * A future lote may drop a catalog adapter behind
 * `resolveCatalogFineTuneAdapter`. Until then the job stops at
 * artifact-ready. See docs/rlhf-phase3-train-pipeline.md.
 */

const { isTrainSubmitEnabled } = require('./flags');

const NO_ADAPTER_REASON = 'no_catalog_adapter';

/**
 * Probe for a first-party catalog adapter. Returns null today.
 * Do not add a third-party aggregator here.
 */
function resolveCatalogFineTuneAdapter(_env = process.env) {
  return null;
}

function isSubmitAvailable(env = process.env) {
  return isTrainSubmitEnabled(env) && !!resolveCatalogFineTuneAdapter(env);
}

/**
 * Attempt an external submit. Always a no-op until a catalog adapter exists.
 * Never throws; the job stays artifact-ready.
 */
async function trySubmit({ format, count, bytes, storage } = {}, env = process.env) {
  if (!isTrainSubmitEnabled(env)) {
    return {
      submitted: false,
      reason: 'submit_flag_off',
      brandHint: brandHint(format),
    };
  }
  const adapter = resolveCatalogFineTuneAdapter(env);
  if (!adapter || typeof adapter.submit !== 'function') {
    return {
      submitted: false,
      reason: NO_ADAPTER_REASON,
      brandHint: brandHint(format),
    };
  }
  try {
    const out = await adapter.submit({ format, count, bytes, storage });
    return {
      submitted: !!out?.submitted,
      reason: out?.reason || 'adapter',
      brandHint: brandHint(format),
    };
  } catch {
    return {
      submitted: false,
      reason: 'adapter_failed',
      brandHint: brandHint(format),
    };
  }
}

function brandHint(format) {
  const kind = format === 'dpo' || format === 'pairs' ? 'DPO' : 'SFT';
  return `Upload the scrubbed ${kind} JSONL to Sira Rápido / Sira Pro via the recipe in docs/rlhf-phase3-train-pipeline.md`;
}

module.exports = {
  resolveCatalogFineTuneAdapter,
  isSubmitAvailable,
  trySubmit,
  NO_ADAPTER_REASON,
  brandHint,
};
