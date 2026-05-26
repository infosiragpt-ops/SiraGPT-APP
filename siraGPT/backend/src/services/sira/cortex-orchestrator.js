/**
 * cortex-orchestrator — Plan → Act → Reflect → Replan loop.
 *
 * Why this exists
 * ---------------
 * Vanilla ReAct (Thought → Action → Observation), as shipped by Codex
 * CLI and Claude Code, lets a model drift when an early action returns
 * incomplete or contradictory evidence. The standard recovery path is
 * to keep iterating Action → Observation, hoping the next tool call
 * compensates for a flawed plan. That wastes tool budget and produces
 * confidently-wrong final answers.
 *
 * Cortex tightens the loop:
 *
 *   1. Plan      — break the request into ordered, named sub-goals
 *                  with a measurable "done" predicate per goal.
 *   2. Act       — execute the next pending sub-goal via the existing
 *                  agent runtime (or a caller-supplied executor),
 *                  capturing the observation + a confidence in [0,1].
 *   3. Reflect   — score the cumulative evidence against the plan;
 *                  detect contradictions, missing evidence, dead ends.
 *   4. Replan    — when reflection's confidence drops below a threshold
 *                  OR the executor reports `requestReplan: true`, the
 *                  planner produces a fresh plan with the new evidence
 *                  baked in, and the loop resumes from Act.
 *
 * The loop is bounded: at most `maxSteps` Act invocations and
 * `maxReplans` regenerations of the plan. A hard `maxRuntimeMs` budget
 * trips the loop unconditionally so a runaway never pins the worker.
 *
 * Pure orchestration. The planner, executor, and reflector are
 * injected — this module does not call an LLM directly. Tests inject
 * deterministic stubs and verify the contract.
 */

"use strict";

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_REPLANS = 2;
const DEFAULT_MAX_RUNTIME_MS = 5 * 60 * 1000;
const DEFAULT_REPLAN_CONFIDENCE = 0.55;
const DEFAULT_FINAL_CONFIDENCE = 0.7;

/**
 * Stop reasons. Stable strings — callers may switch on them.
 */
const STOP_REASONS = Object.freeze({
  COMPLETED: "completed",
  MAX_STEPS: "max_steps_reached",
  MAX_REPLANS: "max_replans_reached",
  MAX_RUNTIME: "max_runtime_reached",
  PLANNER_EMPTY: "planner_returned_empty_plan",
  EXECUTOR_FATAL: "executor_fatal_error",
  ABORTED: "aborted_by_signal",
});

/**
 * @typedef {object} SubGoal
 * @property {string} id
 * @property {string} description
 * @property {string} [done_when]   — short predicate, e.g. "we have a verified answer"
 * @property {string[]} [needs]     — sub-goal ids this one depends on
 *
 * @typedef {object} Plan
 * @property {string} summary
 * @property {SubGoal[]} subgoals
 *
 * @typedef {object} ActObservation
 * @property {SubGoal} subgoal
 * @property {*} result
 * @property {number} confidence            — in [0,1]
 * @property {boolean} [requestReplan]
 * @property {string} [reason]
 *
 * @typedef {object} ReflectionReport
 * @property {number} confidence            — overall confidence in cumulative evidence
 * @property {boolean} done
 * @property {string} [reason]
 *
 * @typedef {object} CortexRunOptions
 * @property {string} request                — the user's original request
 * @property {(ctx) => Promise<Plan>} planner
 * @property {(ctx) => Promise<ActObservation>} executor
 * @property {(ctx) => Promise<ReflectionReport>} [reflector]
 * @property {(ctx) => Promise<*>} [finalizer] — produces the final answer; defaults to last observation
 * @property {number} [maxSteps]
 * @property {number} [maxReplans]
 * @property {number} [maxRuntimeMs]
 * @property {number} [replanConfidence]    — replan when reflection.confidence < this
 * @property {number} [finalConfidence]     — terminate as completed when reflection.confidence ≥ this
 * @property {AbortSignal} [signal]
 * @property {(event) => void} [onEvent]    — observer hook (plan, act, reflect, replan, done)
 * @property {object} [meta]                — passed through to callbacks
 */

/**
 * Drive the full Plan → Act → Reflect → Replan loop.
 *
 * @param {CortexRunOptions} opts
 * @returns {Promise<{ ok: boolean, finalAnswer: *, plan: Plan, history: object[], stats: object, stopReason: string }>}
 */
async function runCortex(opts) {
  const {
    request,
    planner,
    executor,
    reflector = defaultReflector,
    finalizer = defaultFinalizer,
    maxSteps = DEFAULT_MAX_STEPS,
    maxReplans = DEFAULT_MAX_REPLANS,
    maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS,
    replanConfidence = DEFAULT_REPLAN_CONFIDENCE,
    finalConfidence = DEFAULT_FINAL_CONFIDENCE,
    signal,
    onEvent,
    meta = {},
  } = opts || {};

  if (typeof request !== "string" || request.trim().length === 0) {
    throw new TypeError("cortex.runCortex: `request` must be a non-empty string");
  }
  if (typeof planner !== "function") {
    throw new TypeError("cortex.runCortex: `planner` must be a function");
  }
  if (typeof executor !== "function") {
    throw new TypeError("cortex.runCortex: `executor` must be a function");
  }

  const startedAt = Date.now();
  const history = [];
  const stats = {
    steps: 0,
    replans: 0,
    plansGenerated: 0,
    elapsedMs: 0,
    avgConfidence: 0,
    lastConfidence: 0,
  };

  const emit = makeEmitter(onEvent);
  const isAborted = () => Boolean(signal && signal.aborted);
  const isOverBudget = () => Date.now() - startedAt >= maxRuntimeMs;

  // ── 1. Initial plan ──────────────────────────────────────────────
  let plan;
  try {
    plan = await planner({ request, history, evidence: [], meta });
  } catch (err) {
    return finalize({
      ok: false,
      finalAnswer: null,
      plan: emptyPlan(),
      history,
      stats,
      stopReason: STOP_REASONS.PLANNER_EMPTY,
      error: serializeError(err),
      startedAt,
    });
  }
  plan = normalizePlan(plan);
  stats.plansGenerated += 1;
  emit("plan", { plan, replanCount: 0 });

  if (!plan.subgoals.length) {
    return finalize({
      ok: false,
      finalAnswer: null,
      plan,
      history,
      stats,
      stopReason: STOP_REASONS.PLANNER_EMPTY,
      startedAt,
    });
  }

  let pendingIdx = 0;
  let lastObservation = null;
  let stopReason = null;

  // ── 2-4. Main loop ───────────────────────────────────────────────
  while (true) {
    if (isAborted()) {
      stopReason = STOP_REASONS.ABORTED;
      break;
    }
    if (isOverBudget()) {
      stopReason = STOP_REASONS.MAX_RUNTIME;
      break;
    }
    if (stats.steps >= maxSteps) {
      stopReason = STOP_REASONS.MAX_STEPS;
      break;
    }

    const subgoal = nextPendingSubgoal(plan, pendingIdx);
    if (!subgoal) {
      // All sub-goals consumed — fall through to reflection-driven termination.
      const reflection = safeReflect(reflector, {
        request,
        plan,
        history,
        meta,
      });
      const finalReflection = await reflection;
      stats.lastConfidence = clamp01(finalReflection.confidence);
      stats.avgConfidence = avgConfidence(history, stats.lastConfidence);
      emit("reflect", { reflection: finalReflection });
      stopReason = STOP_REASONS.COMPLETED;
      break;
    }

    // ── Act ────────────────────────────────────────────────────────
    let observation;
    try {
      observation = await executor({
        request,
        subgoal,
        plan,
        history,
        meta,
        signal,
      });
    } catch (err) {
      emit("error", { phase: "act", subgoal, error: serializeError(err) });
      // A single failed act doesn't kill the run; record the failure
      // and let the reflector decide whether to replan or abort.
      observation = {
        subgoal,
        result: null,
        confidence: 0,
        requestReplan: true,
        reason: `executor_threw:${err && err.message ? err.message : "unknown"}`,
      };
    }
    observation = normalizeObservation(observation, subgoal);
    history.push({ kind: "act", subgoal, observation });
    lastObservation = observation;
    stats.steps += 1;
    pendingIdx += 1;
    emit("act", { subgoal, observation, step: stats.steps });

    // ── Reflect ────────────────────────────────────────────────────
    let reflection;
    try {
      reflection = await reflector({ request, plan, history, meta });
    } catch (err) {
      emit("error", { phase: "reflect", error: serializeError(err) });
      reflection = { confidence: observation.confidence, done: false };
    }
    reflection = normalizeReflection(reflection, observation);
    stats.lastConfidence = reflection.confidence;
    stats.avgConfidence = avgConfidence(history, reflection.confidence);
    emit("reflect", { reflection, step: stats.steps });

    // ── Done ───────────────────────────────────────────────────────
    if (reflection.done && reflection.confidence >= finalConfidence) {
      stopReason = STOP_REASONS.COMPLETED;
      break;
    }

    // ── Replan ────────────────────────────────────────────────────
    const shouldReplan = observation.requestReplan === true
      || reflection.confidence < replanConfidence;

    if (shouldReplan) {
      if (stats.replans >= maxReplans) {
        stopReason = STOP_REASONS.MAX_REPLANS;
        break;
      }
      let nextPlan;
      try {
        nextPlan = await planner({
          request,
          history,
          evidence: collectEvidence(history),
          previousPlan: plan,
          reflection,
          meta,
        });
      } catch (err) {
        emit("error", { phase: "replan", error: serializeError(err) });
        stopReason = STOP_REASONS.EXECUTOR_FATAL;
        break;
      }
      nextPlan = normalizePlan(nextPlan);
      if (!nextPlan.subgoals.length) {
        stopReason = STOP_REASONS.PLANNER_EMPTY;
        break;
      }
      plan = nextPlan;
      pendingIdx = 0;
      stats.replans += 1;
      stats.plansGenerated += 1;
      emit("replan", { plan, replanCount: stats.replans });
    }
  }

  // ── 5. Finalize ──────────────────────────────────────────────────
  let finalAnswer = null;
  if (stopReason === STOP_REASONS.COMPLETED) {
    try {
      finalAnswer = await finalizer({
        request,
        plan,
        history,
        meta,
        lastObservation,
      });
    } catch (err) {
      emit("error", { phase: "finalize", error: serializeError(err) });
      finalAnswer = lastObservation ? lastObservation.result : null;
    }
  } else if (lastObservation) {
    finalAnswer = lastObservation.result;
  }

  return finalize({
    ok: stopReason === STOP_REASONS.COMPLETED,
    finalAnswer,
    plan,
    history,
    stats,
    stopReason,
    startedAt,
  });
}

// ── helpers ────────────────────────────────────────────────────────

function emptyPlan() {
  return { summary: "", subgoals: [] };
}

function normalizePlan(plan) {
  if (!plan || typeof plan !== "object") return emptyPlan();
  const summary = typeof plan.summary === "string" ? plan.summary : "";
  const raw = Array.isArray(plan.subgoals) ? plan.subgoals : [];
  const seen = new Set();
  const subgoals = [];
  for (let i = 0; i < raw.length; i += 1) {
    const g = raw[i];
    if (!g || typeof g !== "object") continue;
    const id = String(g.id || `sg-${i + 1}`);
    if (seen.has(id)) continue;
    seen.add(id);
    subgoals.push({
      id,
      description: typeof g.description === "string" ? g.description : "",
      done_when: typeof g.done_when === "string" ? g.done_when : "",
      needs: Array.isArray(g.needs) ? g.needs.filter((x) => typeof x === "string") : [],
    });
  }
  return { summary, subgoals };
}

function nextPendingSubgoal(plan, idx) {
  if (idx >= plan.subgoals.length) return null;
  return plan.subgoals[idx];
}

function normalizeObservation(obs, subgoal) {
  if (!obs || typeof obs !== "object") {
    return { subgoal, result: null, confidence: 0, requestReplan: true, reason: "executor_returned_invalid_observation" };
  }
  return {
    subgoal: obs.subgoal || subgoal,
    result: "result" in obs ? obs.result : null,
    confidence: clamp01(Number.isFinite(obs.confidence) ? obs.confidence : 0),
    requestReplan: obs.requestReplan === true,
    reason: typeof obs.reason === "string" ? obs.reason : "",
  };
}

function normalizeReflection(refl, observation) {
  if (!refl || typeof refl !== "object") {
    return { confidence: observation.confidence, done: false };
  }
  return {
    confidence: clamp01(Number.isFinite(refl.confidence) ? refl.confidence : observation.confidence),
    done: refl.done === true,
    reason: typeof refl.reason === "string" ? refl.reason : "",
  };
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function avgConfidence(history, latest) {
  const acts = history.filter((h) => h.kind === "act");
  if (!acts.length) return clamp01(latest);
  let sum = 0;
  for (const h of acts) sum += clamp01(h.observation.confidence);
  return sum / acts.length;
}

function collectEvidence(history) {
  return history
    .filter((h) => h.kind === "act")
    .map((h) => ({ subgoalId: h.subgoal.id, result: h.observation.result, confidence: h.observation.confidence }));
}

function serializeError(err) {
  if (!err) return null;
  return {
    name: err.name || "Error",
    message: err.message || String(err),
  };
}

function makeEmitter(onEvent) {
  if (typeof onEvent !== "function") return () => {};
  return (kind, payload) => {
    try {
      onEvent({ kind, ...payload });
    } catch (_e) {
      // Swallow observer errors — they must never break the loop.
    }
  };
}

async function safeReflect(reflector, ctx) {
  try {
    return await reflector(ctx);
  } catch (_err) {
    const last = ctx.history.length ? ctx.history[ctx.history.length - 1] : null;
    return { confidence: last && last.observation ? last.observation.confidence : 0, done: false };
  }
}

function defaultReflector({ history }) {
  // Deterministic baseline: declare done when every act crossed 0.7
  // confidence. Average is reported so callers can see overall health
  // without injecting an LLM.
  const acts = history.filter((h) => h.kind === "act");
  if (!acts.length) return Promise.resolve({ confidence: 0, done: false });
  const min = Math.min(...acts.map((h) => clamp01(h.observation.confidence)));
  const avg = avgConfidence(history, min);
  return Promise.resolve({ confidence: avg, done: min >= 0.7 });
}

function defaultFinalizer({ lastObservation }) {
  return Promise.resolve(lastObservation ? lastObservation.result : null);
}

function finalize({ ok, finalAnswer, plan, history, stats, stopReason, startedAt, error }) {
  stats.elapsedMs = Date.now() - startedAt;
  return Object.freeze({
    ok,
    finalAnswer,
    plan,
    history,
    stats,
    stopReason,
    error: error || null,
  });
}

module.exports = {
  runCortex,
  STOP_REASONS,
  // exported for tests
  _internals: {
    normalizePlan,
    normalizeObservation,
    normalizeReflection,
    clamp01,
    avgConfidence,
    collectEvidence,
    defaultReflector,
    DEFAULT_MAX_STEPS,
    DEFAULT_MAX_REPLANS,
    DEFAULT_MAX_RUNTIME_MS,
    DEFAULT_REPLAN_CONFIDENCE,
    DEFAULT_FINAL_CONFIDENCE,
  },
};
