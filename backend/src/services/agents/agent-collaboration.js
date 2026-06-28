/**
 * agent-collaboration — robust multi-agent coordination layer.
 *
 * Decouples complex tasks across specialised sub-agents without any
 * UI changes. Each sub-agent receives its own goal + context, executes
 * independently (or sequentially when chaining), and the results are
 * merged into a single structured response.
 *
 * Coordination Patterns:
 *   FORK_JOIN    — Run N agents in parallel, merge results (reports, analysis)
 *   CHAIN        — Agent N receives Agent N-1's output as context
 *   FORK_VOTE    — Run N agents, pick best via LLM scoring
 *   FORK_REVIEW  — Run N agents, review each against criteria, pick/merge best
 *
 * Reliability integration:
 *   - CircuitBreaker per sub-task agent invocation (fast-fail on OPEN)
 *   - withRetry for transient sub-task failures (rate-limit, timeout, DNS)
 *   - AsyncGuard timeout protection for runaway sub-tasks
 *   - ErrorTelemetry structured error capture on failures
 *   - classifyTaskError from agent-task-runner for error classification
 *
 * @module agent-collaboration
 */

/** @private Lazy getters — enable module-level mocking in tests. */
function getRunner() { return require('./agent-task-runner'); }
function getRunnerTaskJob() { return getRunner().runAgentTaskJob; }
function getClassifyError() { return getRunner().classifyTaskError; }

const { CircuitBreaker } = require('../../utils/circuit-breaker');
const { withRetry } = require('../../utils/retry-with-backoff');
const { defaultGuard: guard } = require('../../utils/async-guard');
const { createErrorReporter } = require('../../utils/error-telemetry');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum sub-agents per coordination call */
const MAX_SUB_AGENTS = 5;

/** Default max steps per sub-agent */
const DEFAULT_MAX_STEPS = 25;

/** Default max runtime per sub-agent (ms) */
const DEFAULT_RUNTIME_MS = 180_000;

/** Default timeout for async-guard wrapping (ms) — slightly above runtime */
const GUARD_TIMEOUT_MS = 300_000;

/**
 * Default circuit breaker config for sub-agent invocations.
 * NOTE: the keys must match CircuitBreaker's actual option names
 * (`threshold`/`probeCount`) — the earlier `failureThreshold`/
 * `successThreshold`/`halfOpenMaxCalls` were silently ignored by
 * sanitizeOptions, so breakers ran with the library defaults (5/1) instead
 * of the intended 3 failures-to-open / 2 probes-to-close.
 */
const DEFAULT_CB_CONFIG = {
  name: 'agent-subtask',
  threshold: 3,
  probeCount: 2,
  timeoutMs: GUARD_TIMEOUT_MS,
};

/** Error reporter scope */
const ERROR_SCOPE = 'agent-collaboration';

// Lazy error reporter — instantiated on first failure to keep require
// order independent of OTel setup.
let _reporter = null;
function getReporter() {
  // createErrorReporter reads `service` (not `scope`); the wrong key made the
  // reporter fall back to the generic 'siragpt-backend' label.
  if (!_reporter) _reporter = createErrorReporter({ service: ERROR_SCOPE });
  return _reporter;
}

// Circuit breaker registry — keyed by pattern name so repeated calls
// share the same breaker state (e.g. fork-join failures accumulate).
const _breakers = new Map();

function getBreaker(name) {
  if (!_breakers.has(name)) {
    _breakers.set(name, new CircuitBreaker({ ...DEFAULT_CB_CONFIG, name }));
  }
  return _breakers.get(name);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate an array of sub-tasks. Returns null on success or an error
 * descriptor object.
 */
function validateSubTasks(subTasks) {
  if (!Array.isArray(subTasks) || subTasks.length === 0) {
    return { ok: false, error: 'no_sub_tasks', results: [] };
  }
  if (subTasks.length > MAX_SUB_AGENTS) {
    return { ok: false, error: `max ${MAX_SUB_AGENTS} sub-tasks allowed`, results: [] };
  }
  return null;
}

/**
 * Filter sub-tasks to only those with a valid (non-empty) goal.
 * Invalid entries are silently skipped.
 */
function filterValidSubTasks(subTasks) {
  return (subTasks || []).filter(
    (t) => t && typeof t.goal === 'string' && t.goal.trim().length > 0
  );
}

/**
 * Execute a single sub-task with reliability wrapping.
 *
 * Wraps the sub-agent invocation in:
 *  1. ClassifyTaskError for error classification
 *  2. CircuitBreaker.call for fast-fail if the pattern is degraded
 *  3. withRetry for transient rate-limit/dns/timeout retries
 *  4. guard.run for absolute wall-clock timeout
 *  5. ErrorTelemetry capture on unhandled failures
 *
 * @param {object}   task         - Sub-task descriptor (goal, context, etc.)
 * @param {number}   idx          - Index within the parent coordination
 * @param {object}   user         - Authenticated user context
 * @param {object}   options      - Coordination options
 * @param {string}   patternKey   - Circuit breaker registry key
 * @param {object}   [taskContext] - Merged context (chain passthrough)
 * @returns {Promise<object>}     - Sub-task result
 */
async function executeSubTask(task, idx, user, options, patternKey, taskContext) {
  const breaker = getBreaker(`${patternKey}:${idx}`);
  const reporter = getReporter();

  const runFn = async () => {
    const context = taskContext || task.context;

    // Offload the sub-task to the agent-task-runner (runs the ReAct loop)
    const rawResult = await getRunnerTaskJob()(
      {
        taskId: task.taskId || `${patternKey}-${Date.now()}-${idx}`,
        goal: task.goal,
        chatId: options.chatId,
        user,
        maxSteps: task.maxSteps || options.maxSteps || DEFAULT_MAX_STEPS,
        maxRuntimeMs: task.maxRuntimeMs || options.maxRuntimeMs || DEFAULT_RUNTIME_MS,
        context,
      },
      null
    );

    return rawResult;
  };

  try {
    // Guard: absolute timeout to prevent runaway sub-tasks.
    // guard.run() expects a Promise, not a thunk — the withRetry call
    // is eagerly evaluated so raceWithSignal can attach .then().
    const result = await guard.run(
      withRetry(runFn, {
        maxRetries: options.maxRetries ?? 2,
        classifyError: getClassifyError() || undefined,
        circuitBreaker: breaker,
        onRetry: (info) => {
          emitEvent(options.onEvent, 'collab_subtask_retry', {
            index: idx,
            goal: truncateGoal(task.goal),
            attempt: info?.attempt,
            error: info?.error?.message || String(info?.error),
          });
        },
        signal: options.signal || null,
      }),
      {
        timeoutMs: options.guardTimeoutMs || GUARD_TIMEOUT_MS,
        signal: options.signal || null,
      }
    );

    return result;
  } catch (err) {
    // Capture structured telemetry
    try {
      // The reporter exposes captureError (not capture) — the old call threw a
      // TypeError on every sub-task failure, silently dropping all telemetry.
      reporter.captureError(err, {
        component: 'agent-collaboration',
        pattern: patternKey,
        subTaskIndex: idx,
        goal: truncateGoal(task.goal),
      });
    } catch (_) {
      // best-effort telemetry — never let a reporter failure mask the error
    }

    // Determine if the error is a CircuitBreaker rejection
    const isCircuitOpen = err?.name === 'CircuitOpenError' ||
      (err?.message && err.message.includes('circuit breaker is open'));

    return {
      ok: false,
      error: err?.message || String(err),
      circuitOpen: isCircuitOpen,
      retryable: !isCircuitOpen && (getClassifyError()?.(err)?.retryable === true),
    };
  }
}

/**
 * Truncate a goal string for event emission / logging.
 */
function truncateGoal(goal, maxLen = 80) {
  if (!goal || typeof goal !== 'string') return '';
  if (goal.length <= maxLen) return goal;
  return goal.slice(0, maxLen - 3) + '...';
}

/**
 * Emit an event via the onEvent callback (if provided).
 */
function emitEvent(onEvent, type, payload) {
  if (typeof onEvent === 'function') {
    try {
      onEvent({ type, ...payload });
    } catch (_) {
      // best-effort: never let a misbehaving handler crash coordination
    }
  }
}

/**
 * Extract a serialisable summary from a sub-task result.
 */
function extractResultSummary(result) {
  if (!result || result.ok === false) {
    return null;
  }
  return {
    output: result.output || null,
    markdown: result.markdown || null,
    summary: result.summary || null,
    artifactIds: Array.isArray(result.artifactIds) ? result.artifactIds : [],
    steps: Array.isArray(result.steps) ? result.steps.length : 0,
  };
}

// ---------------------------------------------------------------------------
// Coordination Patterns
// ---------------------------------------------------------------------------

/**
 * FORK_JOIN — Run N agents in parallel, merge results.
 *
 * All sub-tasks execute concurrently via Promise.allSettled. Each is
 * individually protected by circuit breaker, retry, and timeout guard.
 *
 * @param {object}   params
 * @param {Array}    params.subTasks - Array of { goal, context?, maxSteps?, maxRuntimeMs?, taskId? }
 * @param {object}   params.user     - Authenticated user context
 * @param {object}   [params.options]
 * @param {string}   [params.options.chatId]
 * @param {number}   [params.options.maxSteps]
 * @param {number}   [params.options.maxRuntimeMs]
 * @param {number}   [params.options.maxRetries]
 * @param {AbortSignal} [params.options.signal]
 * @param {function} [params.options.onEvent] - SSE event callback
 * @returns {Promise<{ok, pattern, results, totalSubAgents, mergedSummary?}>}
 */
async function forkJoin({ subTasks = [], user, options = {} }) {
  const validationError = validateSubTasks(subTasks);
  if (validationError) return validationError;

  const patternKey = `forkJoin:${Date.now()}`;

  // Filter out sub-tasks with invalid goals (silent skip)
  subTasks = filterValidSubTasks(subTasks);
  if (subTasks.length === 0) {
    return { ok: false, error: 'no_valid_sub_tasks', pattern: 'fork_join', results: [], totalSubAgents: 0 };
  }

  emitEvent(options.onEvent, 'collab_start', {
    pattern: 'fork_join',
    totalSubAgents: subTasks.length,
  });

  const settled = await Promise.allSettled(
    subTasks.map((task, idx) =>
      executeSubTask(task, idx, user, options, `${patternKey}:${idx}`, null)
    )
  );

  const results = settled.map((r, idx) => {
    const task = subTasks[idx];
    if (r.status === 'fulfilled') {
      const value = r.value;
      if (value && value.ok !== false) {
        return {
          index: idx,
          goal: task.goal,
          ok: true,
          result: extractResultSummary(value),
        };
      }
      return {
        index: idx,
        goal: task.goal,
        ok: false,
        error: value?.error || 'sub-task failed',
        result: value || null,
        circuitOpen: value?.circuitOpen === true,
        retryable: value?.retryable === true,
      };
    }
    return {
      index: idx,
      goal: task.goal,
      ok: false,
      error: r.reason?.message || String(r.reason),
    };
  });

  const summary = mergeForkResults(results);

  emitEvent(options.onEvent, 'collab_done', {
    pattern: 'fork_join',
    totalSubAgents: subTasks.length,
    successfulCount: results.filter((r) => r.ok).length,
    summary: summary.mergedText?.slice(0, 300) || '',
  });

  return {
    ok: results.some((r) => r.ok),
    pattern: 'fork_join',
    results,
    totalSubAgents: subTasks.length,
    mergedSummary: summary,
  };
}

/**
 * CHAIN — Run sub-tasks sequentially. Each receives the previous
 * sub-task's output as additional context.
 *
 * @param {object}   params
 * @param {Array}    params.subTasks - Array of { goal, context?, ... }
 * @param {object}   params.user
 * @param {object}   [params.options]
 * @param {boolean}  [params.options.stopOnFailure=true] - Halt chain on failure
 * @param {AbortSignal} [params.options.signal]
 * @param {function} [params.options.onEvent]
 * @returns {Promise<{ok, pattern, results, totalSubAgents, stoppedAt?}>}
 */
async function chain({ subTasks = [], user, options = {} }) {
  const validationError = validateSubTasks(subTasks);
  if (validationError) return validationError;

  const patternKey = `chain:${Date.now()}`;
  const stopOnFailure = options.stopOnFailure !== false;

  // Filter out sub-tasks with invalid goals (silent skip)
  subTasks = filterValidSubTasks(subTasks);
  if (subTasks.length === 0) {
    return { ok: false, error: 'no_valid_sub_tasks', pattern: 'chain', results: [], totalSubAgents: 0 };
  }

  emitEvent(options.onEvent, 'collab_start', {
    pattern: 'chain',
    totalSubAgents: subTasks.length,
  });

  const results = [];
  let accumulatedContext = null;

  for (let idx = 0; idx < subTasks.length; idx++) {
    const task = subTasks[idx];

    emitEvent(options.onEvent, 'collab_step_start', {
      index: idx,
      goal: truncateGoal(task.goal),
      totalSteps: subTasks.length,
    });

    // Merge previous output into the task context for this step
    const taskContext = accumulatedContext
      ? { previousOutput: accumulatedContext, ...(task.context || {}) }
      : task.context;

    // When stopOnFailure is true, disable retries so the chain
    // stops at the first error without retrying.
    const chainExecOptions = stopOnFailure ? { ...options, maxRetries: 0 } : options;

    const result = await executeSubTask(
      task,
      idx,
      user,
      chainExecOptions,
      `${patternKey}:step${idx}`,
      taskContext
    );

    if (result && result.ok !== false) {
      results.push({
        index: idx,
        goal: task.goal,
        ok: true,
        result: extractResultSummary(result),
      });
      // Extract a serialisable summary for the next step
      accumulatedContext = result.output || result.markdown || result.summary ||
        JSON.stringify(result).slice(0, 5000);
    } else {
      results.push({
        index: idx,
        goal: task.goal,
        ok: false,
        error: result?.error || 'sub-task failed',
        result: null,
        circuitOpen: result?.circuitOpen === true,
        retryable: result?.retryable === true,
      });

      emitEvent(options.onEvent, 'collab_step_fail', {
        index: idx,
        error: result?.error || 'sub-task failed',
      });

      if (stopOnFailure) {
        emitEvent(options.onEvent, 'collab_done', {
          pattern: 'chain',
          totalSubAgents: subTasks.length,
          stoppedAt: idx,
          stoppedReason: 'failure',
        });

        return {
          ok: false,
          pattern: 'chain',
          results,
          totalSubAgents: subTasks.length,
          stoppedAt: idx,
          stoppedEarly: true,
        };
      }
    }
  }

  const allOk = results.every((r) => r.ok);

  emitEvent(options.onEvent, 'collab_done', {
    pattern: 'chain',
    totalSubAgents: subTasks.length,
    stoppedAt: results.length - 1,
    successfulCount: results.filter((r) => r.ok).length,
  });

  return {
    ok: allOk,
    pattern: 'chain',
    results,
    totalSubAgents: subTasks.length,
  };
}

/**
 * FORK_VOTE — Run N agents in parallel, then score each result using
 * an LLM judge and return the best-scoring result.
 *
 * Uses the provided `openai` client to call the judge. Falls back to
 * a simple heuristic (fewest errors wins) when no LLM is available.
 *
 * @param {object}   params
 * @param {Array}    params.subTasks
 * @param {object}   params.user
 * @param {object}   [params.options]
 * @param {object}   [params.options.openai] - OpenAI client for judge
 * @param {string}   [params.options.judgeModel='gpt-4o-mini']
 * @param {Array}    [params.options.scoringCriteria] - Criteria for the LLM judge
 * @param {AbortSignal} [params.options.signal]
 * @param {function} [params.options.onEvent]
 * @returns {Promise<{ok, pattern, results, vote, winner?}>}
 */
async function forkVote({ subTasks = [], user, options = {} }) {
  const validationError = validateSubTasks(subTasks);
  if (validationError) return validationError;

  // Delegate execution to forkJoin
  const forkResult = await forkJoin({ subTasks, user, options });

  if (!forkResult.ok) {
    return {
      ok: false,
      pattern: 'fork_vote',
      results: forkResult.results,
      vote: { method: 'execution_failed', winner: null },
    };
  }

  const successful = forkResult.results.filter((r) => r.ok);
  if (successful.length <= 1) {
    return {
      ok: successful.length === 1,
      pattern: 'fork_vote',
      results: forkResult.results,
      vote: {
        method: 'single_winner',
        winner: successful.length === 1 ? 0 : null,
        reason: successful.length === 1 ? 'only one candidate succeeded' : 'no candidates succeeded',
      },
    };
  }

  // Scoring: prefer LLM judge when available
  const winner = await scoreSubTasks(successful, options);
  const idsByRank = winner.rankings || successful.map((_, i) => i);

  emitEvent(options.onEvent, 'collab_vote', {
    method: winner.method,
    winnerIndex: winner.winnerIndex,
    scores: winner.scores,
  });

  return {
    ok: true,
    pattern: 'fork_vote',
    results: forkResult.results,
    vote: {
      method: winner.method,
      winner: winner.winnerIndex,
      winnerGoal: successful[winner.winnerIndex]?.goal,
      reason: winner.reason,
      scores: winner.scores,
      rankings: idsByRank,
    },
  };
}

/**
 * FORK_REVIEW — Run N agents in parallel, then review each result
 * against criteria and return the best (or merged) result.
 *
 * @param {object}   params
 * @param {Array}    params.subTasks
 * @param {object}   params.user
 * @param {object}   [params.options]
 * @param {object}   [params.options.openai]
 * @param {string}   [params.options.judgeModel='gpt-4o-mini']
 * @param {Array}    [params.options.reviewCriteria=['accuracy', 'completeness', 'clarity']]
 * @param {AbortSignal} [params.options.signal]
 * @param {function} [params.options.onEvent]
 * @returns {Promise<{ok, pattern, results, reviews, bestIndex?}>}
 */
async function forkReview({ subTasks = [], user, options = {} }) {
  const validationError = validateSubTasks(subTasks);
  if (validationError) return validationError;

  const forkResult = await forkJoin({ subTasks, user, options });

  const successful = forkResult.results.filter((r) => r.ok);
  if (successful.length === 0) {
    return {
      ok: false,
      pattern: 'fork_review',
      results: forkResult.results,
      reviews: [],
      bestIndex: null,
    };
  }

  const criteria = Array.isArray(options.reviewCriteria)
    ? options.reviewCriteria
    : ['accuracy', 'completeness', 'clarity', 'evidence'];

  const reviews = [];
  for (const succ of successful) {
    const review = await reviewSingleResult(succ, criteria, options);
    reviews.push(review);
  }

  // Pick the best: highest average score
  let bestIndex = 0;
  let bestScore = -1;
  for (let i = 0; i < reviews.length; i++) {
    const avg = reviews[i].averageScore;
    if (avg > bestScore) {
      bestScore = avg;
      bestIndex = i;
    }
  }

  emitEvent(options.onEvent, 'collab_review', {
    reviewedCount: reviews.length,
    bestIndex,
    bestScore,
  });

  return {
    ok: true,
    pattern: 'fork_review',
    results: forkResult.results,
    reviews,
    bestIndex: reviews.length > 0 ? bestIndex : null,
  };
}

// ---------------------------------------------------------------------------
// Scoring / Review Helpers
// ---------------------------------------------------------------------------

/**
 * Score successful sub-task results. Uses LLM judge when available,
 * falls back to heuristic (result depth, steps count).
 */
async function scoreSubTasks(successful, options) {
  const { openai, judgeModel = 'gpt-4o-mini', scoringCriteria } = options;

  if (openai && typeof openai.chat?.completions?.create === 'function') {
    try {
      const criteria = Array.isArray(scoringCriteria)
        ? scoringCriteria
        : ['relevance', 'completeness', 'quality', 'evidence'];

      const prompt = buildJudgePrompt(successful, criteria);

      const resp = await openai.chat.completions.create({
        model: judgeModel,
        temperature: 0.2,
        max_tokens: 1000,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You are an impartial judge scoring AI agent task results. Score each result on a scale of 1-10 for each criterion. Return JSON: { "scores": [{"index":0, "criteria": {"relevance":8,"completeness":7,...}, "total": 42, "reason": "..."}], "winnerIndex": 0, "reason": "summary" }`,
          },
          { role: 'user', content: prompt },
        ],
      });

      const raw = resp.choices?.[0]?.message?.content || '{}';
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed.scores) && typeof parsed.winnerIndex === 'number') {
        // buildJudgePrompt labels candidates by their ORIGINAL sub-task index
        // (succ.index), so parsed.winnerIndex / scores[].index are in original
        // space. Map them back to positions in the filtered `successful` array
        // so the caller (which does successful[winnerIndex]) picks the right
        // candidate even when a failed sub-task shifted the indices. Sort a COPY
        // so the returned scores keep their original order (no in-place mutation).
        const posOf = (originalIndex) => {
          const p = successful.findIndex((s) => s.index === originalIndex);
          return p >= 0 ? p : null;
        };
        let winnerPos = posOf(parsed.winnerIndex);
        if (winnerPos == null) winnerPos = Math.max(0, Math.min(parsed.winnerIndex, successful.length - 1));
        const rankings = [...parsed.scores]
          .sort((a, b) => (b.total || 0) - (a.total || 0))
          .map((s) => posOf(s.index))
          .filter((p) => p != null);
        return {
          method: 'llm_judge',
          winnerIndex: winnerPos,
          scores: parsed.scores,
          reason: parsed.reason || '',
          rankings: rankings.length ? rankings : successful.map((_, i) => i),
        };
      }
    } catch (_) {
      // Fall through to heuristic
    }
  }

  // Heuristic fallback: prefer sub-tasks with more detail (deeper output)
  const scores = successful.map((r, idx) => {
    const result = r.result;
    const detailScore = result?.steps || 0;
    const textLen = (result?.markdown || result?.summary || '').length;
    return { index: idx, heuristicScore: detailScore * 10 + Math.min(textLen, 100), raw: r };
  });

  scores.sort((a, b) => b.heuristicScore - a.heuristicScore);
  const winnerIndex = scores[0]?.index || 0;

  return {
    method: 'heuristic',
    winnerIndex,
    scores: scores.map((s) => ({ index: s.index, heuristicScore: s.heuristicScore })),
    reason: `heuristic: steps+content depth (winner: candidate ${winnerIndex})`,
    rankings: scores.map((s) => s.index),
  };
}

/**
 * Review a single sub-task result against criteria. Uses LLM when
 * available, heuristic fallback otherwise.
 */
async function reviewSingleResult(succ, criteria, options) {
  const { openai, judgeModel = 'gpt-4o-mini' } = options;
  const result = succ.result;
  const contentPreview = result?.markdown || result?.summary || JSON.stringify(result).slice(0, 2000);

  if (openai && typeof openai.chat?.completions?.create === 'function') {
    try {
      const resp = await openai.chat.completions.create({
        model: judgeModel,
        temperature: 0.2,
        max_tokens: 800,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `Review this agent result against these criteria: ${criteria.join(', ')}. Score each 1-10. Return JSON: { "scores": {"accuracy":8,...}, "averageScore":7.5, "strengths":["..."], "weaknesses":["..."], "recommendation":"accept|reject|revise" }`,
          },
          {
            role: 'user',
            content: `Goal: ${succ.goal}\n\nResult: ${contentPreview.slice(0, 4000)}`,
          },
        ],
      });

      const raw = resp.choices?.[0]?.message?.content || '{}';
      const parsed = JSON.parse(raw);
      if (parsed.averageScore !== undefined) {
        return {
          index: succ.index,
          goal: succ.goal,
          scores: parsed.scores,
          averageScore: parsed.averageScore,
          strengths: parsed.strengths || [],
          weaknesses: parsed.weaknesses || [],
          recommendation: parsed.recommendation || 'accept',
        };
      }
    } catch (_) {
      // Fall through
    }
  }

  // Heuristic review
  const steps = result?.steps || 0;
  const textLen = (result?.markdown || result?.summary || '').length;
  const avgScore = Math.min(10, Math.round((steps * 2 + textLen / 500) / 2));

  return {
    index: succ.index,
    goal: succ.goal,
    scores: { estimatedQuality: avgScore },
    averageScore: avgScore,
    strengths: [],
    weaknesses: [],
    recommendation: avgScore >= 5 ? 'accept' : 'revise',
  };
}

/**
 * Build an LLM judge prompt from successful sub-task results.
 */
function buildJudgePrompt(successful, criteria) {
  let prompt = `Score each candidate result on (${criteria.join(', ')}), 1-10 each.\n\n`;
  for (const succ of successful) {
    const result = succ.result;
    const preview = result?.markdown || result?.summary ||
      JSON.stringify(result).slice(0, 1500);
    prompt += `--- Candidate ${succ.index} ---\n`;
    prompt += `Goal: ${succ.goal}\n`;
    prompt += `Steps: ${result?.steps || 0}\n`;
    prompt += `Preview: ${preview.slice(0, 1000)}\n\n`;
  }
  return prompt.slice(0, 8000);
}

/**
 * Merge multiple fork results into a single coherent summary.
 * Extracts markdown/text from each, concatenates with separators.
 */
function mergeForkResults(results) {
  const parts = results
    .filter((r) => r.ok && r.result)
    .map((r, i) => {
      const content = r.result?.markdown || r.result?.summary || r.result?.output || '';
      const header = `## Resultado ${i + 1}: ${r.goal?.slice(0, 60) || `Sub-task ${i}`}`;
      return `${header}\n\n${content}`;
    });

  const artifactIds = results
    .filter((r) => r.ok && r.result?.artifactIds)
    .flatMap((r) => r.result.artifactIds);

  return {
    mergedText: parts.length > 0 ? parts.join('\n\n---\n\n') : '',
    artifactIds,
    totalSuccessful: results.filter((r) => r.ok).length,
    totalFailed: results.filter((r) => !r.ok).length,
  };
}

// ---------------------------------------------------------------------------
// Goal Decomposition
// ---------------------------------------------------------------------------

/**
 * Decompose a complex goal into sub-tasks automatically.
 *
 * When an LLM client is provided, uses it for semantic decomposition.
 * Falls back to regex-based heuristic splitting on transition words.
 *
 * @param {string} goal - The complex goal to decompose
 * @param {object} [options]
 * @param {number}   [options.maxParts=4]
 * @param {number}   [options.minFragmentLength=3]
 * @param {object}   [options.openai] - OpenAI client for LLM decomposition
 * @param {string}   [options.model='gpt-4o-mini'] - LLM model
 * @returns {Array<{goal: string, context: object}>}
 */
async function decomposeGoal(goal, options = {}) {
  if (!goal || typeof goal !== 'string') return [];
  const text = goal.trim();
  if (!text) return [];

  const maxParts = Math.min(options.maxParts || 4, MAX_SUB_AGENTS);
  const minFragmentLength = options.minFragmentLength || 3;
  const { openai, model = 'gpt-4o-mini' } = options;

  // Try LLM-based decomposition first
  if (openai && typeof openai.chat?.completions?.create === 'function') {
    try {
      const llmParts = await llmDecompose(openai, model, text, maxParts);
      if (llmParts.length >= 2) {
        return llmParts.map((g, idx) => ({
          goal: g,
          context: { partIndex: idx, totalParts: llmParts.length, source: 'llm' },
        }));
      }
    } catch (_) {
      // Fall through to regex
    }
  }

  // Regex-based heuristic fallback
  return regexDecompose(text, maxParts, minFragmentLength);
}

/**
 * LLM-based goal decomposition.
 * Asks the model to break a complex goal into sequential sub-tasks.
 */
async function llmDecompose(openai, model, text, maxParts) {
  const resp = await openai.chat.completions.create({
    model,
    temperature: 0.3,
    max_tokens: 1000,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Decompose the user's goal into a list of ${maxParts} or fewer sequential, non-overlapping sub-tasks. Each sub-task should be independently executable by an AI agent with web search and file generation tools. Return JSON: { "subTasks": ["sub-task 1 description", "sub-task 2 description", ...] }`,
      },
      { role: 'user', content: text.slice(0, 3000) },
    ],
  });

  const raw = resp.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed.subTasks) ? parsed.subTasks : [];

  return list
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter((s) => s.length >= 10)
    .slice(0, maxParts);
}

/**
 * Regex-based heuristic goal decomposition.
 * Splits on transition words commonly used in multi-part requests.
 */
function regexDecompose(text, maxParts, minFragmentLength) {
  const separators = [
    /\b(y\s|and\s|además|también|por otro lado)\b/i,
    /\b(luego|then|next|después|a continuación)\b/i,
    /\b(finalmente|finally|por último|en resumen)\b/i,
    /\b(primero|first|en primer lugar)\b/i,
    /\b(segundo|second|en segundo lugar)\b/i,
    /\b(tercero|third|en tercer lugar)\b/i,
    /\b(adicionalmente|furthermore|moreover|in addition)\b/i,
  ];

  let parts = [text];

  for (const sep of separators) {
    if (parts.length >= maxParts) break;
    const newParts = [];
    for (const part of parts) {
      const split = part.split(sep);
      for (const s of split) {
        const trimmed = s.trim();
        if (trimmed.length >= minFragmentLength) newParts.push(trimmed);
        if (newParts.length >= maxParts) break;
      }
    }
    if (newParts.length > parts.length) parts = newParts;
  }

  // Dedupe (case-insensitive) preserving order
  const seen = new Set();
  const unique = [];
  for (const p of parts) {
    const key = p.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(p.trim());
    }
  }

  const finalParts = unique.slice(0, maxParts);

  return finalParts.map((g, idx) => ({
    goal: g,
    context: { partIndex: idx, totalParts: finalParts.length, source: 'regex' },
  }));
}

// ---------------------------------------------------------------------------
// Circuit Breaker Diagnostics
// ---------------------------------------------------------------------------

/**
 * Return the state of all collaboration circuit breakers.
 * Useful for health-check endpoints.
 *
 * @returns {Array<{name, state, failures, successes, lastFailure}>}
 */
function getBreakerStates() {
  const states = [];
  for (const [name, breaker] of _breakers) {
    try {
      states.push({ name, ...breaker.toJSON() });
    } catch (_) {
      states.push({ name, state: 'unknown' });
    }
  }
  return states;
}

/**
 * Reset all collaboration circuit breakers to CLOSED state.
 * Useful for administrative / recovery endpoints.
 */
function resetBreakers() {
  for (const breaker of _breakers.values()) {
    breaker.reset();
  }
  _breakers.clear();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Coordination patterns
  forkJoin,
  chain,
  forkVote,
  forkReview,

  // Goal decomposition
  decomposeGoal,

  // Circuit breaker diagnostics
  getBreakerStates,
  resetBreakers,

  // Constants (for tests / configuration)
  MAX_SUB_AGENTS,
  DEFAULT_MAX_STEPS,
  DEFAULT_RUNTIME_MS,
  GUARD_TIMEOUT_MS,
  DEFAULT_CB_CONFIG,

  // Internal (exposed for testing)
  _internals: {
    executeSubTask,
    scoreSubTasks,
    reviewSingleResult,
    mergeForkResults,
    llmDecompose,
    regexDecompose,
    truncateGoal,
    validateSubTasks,
    getRunner,
    getRunnerTaskJob,
    getClassifyError,
  },
};
