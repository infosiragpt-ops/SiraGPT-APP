'use strict';

/**
 * Bounded computer control helpers for /code department turns.
 *
 * Max 25 steps. Abort if the same canonical action repeats 3 times.
 * Observation mode is decided by flags.resolveObservationMode (CDP tree
 * when the model has no vision). Sessions stay up — this loop never
 * destroys the member VM.
 */

const {
  MAX_CONTROL_STEPS,
  REPEAT_ACTION_LIMIT,
} = require('./flags');

function canonicalizeAction(name, args) {
  if (!name) return '';
  const keys = Object.keys(args && typeof args === 'object' ? args : {}).sort();
  const normalized = {};
  for (const key of keys) normalized[key] = args[key];
  return JSON.stringify({ name: String(name), args: normalized });
}

function repeatedSameAction(fingerprints, limit = REPEAT_ACTION_LIMIT) {
  if (!Array.isArray(fingerprints) || fingerprints.length < limit) return false;
  const last = fingerprints[fingerprints.length - 1];
  if (!last) return false;
  return fingerprints.slice(-limit).every((item) => item === last);
}

function createRepeatGuard({ limit = REPEAT_ACTION_LIMIT } = {}) {
  const fingerprints = [];
  return {
    fingerprints,
    record(name, args) {
      const fingerprint = canonicalizeAction(name, args);
      fingerprints.push(fingerprint);
      const repeated = repeatedSameAction(fingerprints, limit);
      return { fingerprint, repeated, count: fingerprints.length };
    },
  };
}

function withRepeatGuard(tools, { guard, limit = REPEAT_ACTION_LIMIT } = {}) {
  const tracker = guard || createRepeatGuard({ limit });
  return (Array.isArray(tools) ? tools : []).map((tool) => {
    if (!tool || typeof tool.execute !== 'function') return tool;
    const original = tool.execute.bind(tool);
    return {
      ...tool,
      async execute(args, ctx) {
        if (String(tool.name || '').startsWith('computer_')) {
          const { repeated } = tracker.record(tool.name, args);
          if (repeated) {
            const err = new Error('same computer action repeated 3 times; aborting control loop');
            err.code = 'REPEATED_ACTION';
            return JSON.stringify({
              ok: false,
              error: 'repeated_action',
              message: err.message,
            });
          }
        }
        return original(args, ctx);
      },
    };
  });
}

function capControlSteps(requested) {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return MAX_CONTROL_STEPS;
  return Math.min(MAX_CONTROL_STEPS, Math.max(1, Math.floor(n)));
}

module.exports = {
  MAX_CONTROL_STEPS,
  REPEAT_ACTION_LIMIT,
  canonicalizeAction,
  repeatedSameAction,
  createRepeatGuard,
  withRepeatGuard,
  capControlSteps,
};
