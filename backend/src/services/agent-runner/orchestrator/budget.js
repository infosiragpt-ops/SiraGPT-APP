'use strict';

/**
 * F4 — Hard budgets for the orchestrator.
 *
 * Two scopes:
 *   - node: each DAG node carries { maxIterations, maxTokens };
 *   - run:  the whole orchestration has global caps (env-tunable).
 *
 * Enforcement happens at the LLM-client boundary: every sub-agent (and the
 * planner) talks to OpenRouter through a wrapped client that asserts the
 * budget BEFORE each call, so a loop that would otherwise keep retrying is
 * cut at the cap with a BudgetExceededError (`code: 'BUDGET_EXCEEDED'`).
 * No retry-forever: exceeding a node cap stops that node; exceeding the run
 * cap stops the whole orchestration with an honest Spanish error.
 */

const NODE_BUDGET_DEFAULTS = Object.freeze({ maxIterations: 8, maxTokens: 24_000 });
const NODE_BUDGET_LIMITS = Object.freeze({
  minIterations: 1,
  maxIterations: 15,
  minTokens: 1_000,
  maxTokens: 80_000,
});

const RUN_BUDGET_DEFAULTS = Object.freeze({ maxIterations: 40, maxTokens: 150_000 });

class BudgetExceededError extends Error {
  constructor(scope, kind, { used, max, nodeId = null } = {}) {
    super(`budget exceeded (${scope} ${kind}): ${used}/${max}`);
    this.name = 'BudgetExceededError';
    this.code = 'BUDGET_EXCEEDED';
    this.scope = scope; // 'node' | 'run'
    this.kind = kind; // 'iterations' | 'tokens'
    this.used = used;
    this.max = max;
    this.nodeId = nodeId;
  }
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Normalize a node budget from the plan; budgets are REQUIRED by the plan validator. */
function normalizeNodeBudget(raw = {}) {
  return {
    maxIterations: clampInt(
      raw.maxIterations,
      NODE_BUDGET_LIMITS.minIterations,
      NODE_BUDGET_LIMITS.maxIterations,
      NODE_BUDGET_DEFAULTS.maxIterations,
    ),
    maxTokens: clampInt(
      raw.maxTokens,
      NODE_BUDGET_LIMITS.minTokens,
      NODE_BUDGET_LIMITS.maxTokens,
      NODE_BUDGET_DEFAULTS.maxTokens,
    ),
  };
}

function resolveRunBudget({ env = process.env, overrides = {} } = {}) {
  return {
    maxIterations: clampInt(
      overrides.maxIterations ?? env.SIRAGPT_ORCHESTRATOR_MAX_TOTAL_ITERATIONS,
      1,
      200,
      RUN_BUDGET_DEFAULTS.maxIterations,
    ),
    maxTokens: clampInt(
      overrides.maxTokens ?? env.SIRAGPT_ORCHESTRATOR_MAX_TOTAL_TOKENS,
      1_000,
      2_000_000,
      RUN_BUDGET_DEFAULTS.maxTokens,
    ),
  };
}

function createBudgetTracker({ scope, maxIterations, maxTokens, nodeId = null }) {
  const state = {
    scope,
    nodeId,
    maxIterations,
    maxTokens,
    iterationsUsed: 0,
    tokensUsed: 0,
  };
  return {
    get state() { return { ...state }; },
    assertCanCall() {
      if (state.iterationsUsed >= state.maxIterations) {
        throw new BudgetExceededError(scope, 'iterations', {
          used: state.iterationsUsed, max: state.maxIterations, nodeId,
        });
      }
      if (state.tokensUsed >= state.maxTokens) {
        throw new BudgetExceededError(scope, 'tokens', {
          used: state.tokensUsed, max: state.maxTokens, nodeId,
        });
      }
    },
    recordCall() { state.iterationsUsed += 1; },
    recordTokens(n) {
      const tokens = Number(n);
      if (Number.isFinite(tokens) && tokens > 0) state.tokensUsed += Math.floor(tokens);
    },
  };
}

/** Prefer the provider-reported usage; fall back to a chars/4 estimate. */
function estimateResponseTokens(response) {
  const total = Number(response?.usage?.total_tokens);
  if (Number.isFinite(total) && total > 0) return Math.floor(total);
  try {
    const msg = response?.choices?.[0]?.message;
    const chars = JSON.stringify(msg || '').length;
    return Math.max(1, Math.ceil(chars / 4));
  } catch (_) {
    return 50;
  }
}

/**
 * Wrap an OpenAI-style client so every chat.completions.create call is
 * charged against ALL the given trackers, and refused (BudgetExceededError)
 * once any of them is exhausted. `onExceeded` fires once per unique
 * scope/kind so the run can trace "Presupuesto agotado".
 */
function wrapClientWithBudgets(client, trackers = [], { onExceeded = () => {} } = {}) {
  const notified = new Set();
  return {
    chat: {
      completions: {
        create: async (request, options) => {
          for (const tracker of trackers) {
            try {
              tracker.assertCanCall();
            } catch (err) {
              if (err && err.code === 'BUDGET_EXCEEDED') {
                const key = `${err.scope}:${err.kind}:${err.nodeId || ''}`;
                if (!notified.has(key)) {
                  notified.add(key);
                  try { onExceeded(err); } catch (_) { /* trace only */ }
                }
              }
              throw err;
            }
          }
          for (const tracker of trackers) tracker.recordCall();
          const response = await client.chat.completions.create(request, options);
          const tokens = estimateResponseTokens(response);
          for (const tracker of trackers) tracker.recordTokens(tokens);
          return response;
        },
      },
    },
  };
}

module.exports = {
  BudgetExceededError,
  NODE_BUDGET_DEFAULTS,
  NODE_BUDGET_LIMITS,
  RUN_BUDGET_DEFAULTS,
  normalizeNodeBudget,
  resolveRunBudget,
  createBudgetTracker,
  estimateResponseTokens,
  wrapClientWithBudgets,
};
