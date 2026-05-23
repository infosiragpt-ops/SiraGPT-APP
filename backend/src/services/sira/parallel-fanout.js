/**
 * parallel-fanout — fan a single request out to N independent
 * sub-tasks, run them concurrently with bounded parallelism, and
 * reduce the partial results into one consolidated answer.
 *
 * Why this exists
 * ---------------
 * Codex CLI and Claude Code execute tools sequentially within one
 * conversation turn. When a request is naturally embarrassingly
 * parallel — "summarize each of these 10 files", "check these 4
 * websites", "evaluate these 3 plans against these 5 criteria" —
 * sequential execution wastes wall-clock time even though the
 * sub-tasks are independent.
 *
 * Cortex's fan-out:
 *   - schedules tasks with a configurable concurrency cap
 *   - enforces both a per-task and an aggregate timeout
 *   - tolerates partial failures via `failurePolicy`:
 *       "continue" — collect failures, return the survivors
 *       "abort"    — cancel pending tasks the moment one fails
 *   - reduces results through a caller-supplied reducer (default:
 *     return the array of successful results in submission order)
 *   - reports per-task elapsed time, status, and the aggregate stats
 *
 * No third-party scheduling libraries are used or copied. The semantics
 * are intentionally tighter than `Promise.allSettled`: aborts cascade
 * via a shared AbortController so executors that respect the signal
 * can release resources promptly.
 */

"use strict";

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TASK_TIMEOUT_MS = 60_000;
const DEFAULT_AGGREGATE_TIMEOUT_MS = 5 * 60 * 1000;

const FAILURE_POLICIES = Object.freeze({
  CONTINUE: "continue",
  ABORT: "abort",
});

/**
 * @typedef {object} FanoutTask
 * @property {string} [id]                         — defaults to index
 * @property {(ctx) => Promise<*>} run             — executor
 * @property {*} [meta]                            — pass-through
 *
 * @typedef {object} FanoutResult
 * @property {string} id
 * @property {boolean} ok
 * @property {*} [value]
 * @property {{name:string,message:string}} [error]
 * @property {number} elapsedMs
 * @property {string} status                       — "fulfilled" | "rejected" | "timeout" | "aborted"
 *
 * @typedef {object} FanoutOptions
 * @property {FanoutTask[]} tasks
 * @property {number} [concurrency]
 * @property {number} [taskTimeoutMs]
 * @property {number} [aggregateTimeoutMs]
 * @property {string} [failurePolicy]              — "continue" (default) or "abort"
 * @property {(results: FanoutResult[]) => *} [reducer]
 * @property {(event) => void} [onEvent]
 * @property {AbortSignal} [signal]
 */

/**
 * Run a fan-out and return the consolidated bundle.
 *
 * @param {FanoutOptions} opts
 * @returns {Promise<{ ok: boolean, results: FanoutResult[], reduced: *, stats: object, stoppedReason: string|null }>}
 */
async function runFanout(opts) {
  const {
    tasks,
    concurrency = DEFAULT_CONCURRENCY,
    taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS,
    aggregateTimeoutMs = DEFAULT_AGGREGATE_TIMEOUT_MS,
    failurePolicy = FAILURE_POLICIES.CONTINUE,
    reducer = defaultReducer,
    onEvent,
    signal,
  } = opts || {};

  if (!Array.isArray(tasks)) {
    throw new TypeError("parallel-fanout.runFanout: tasks must be an array");
  }
  if (!FAILURE_POLICIES.CONTINUE === false && failurePolicy !== FAILURE_POLICIES.CONTINUE && failurePolicy !== FAILURE_POLICIES.ABORT) {
    throw new TypeError(`parallel-fanout.runFanout: invalid failurePolicy '${failurePolicy}'`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError("parallel-fanout.runFanout: concurrency must be a positive integer");
  }

  const emit = makeEmitter(onEvent);
  const startedAt = Date.now();

  // Empty fan-outs are valid and return immediately.
  if (tasks.length === 0) {
    return Object.freeze({
      ok: true,
      results: [],
      reduced: reducer([]),
      stats: { total: 0, fulfilled: 0, rejected: 0, timeouts: 0, aborted: 0, elapsedMs: 0 },
      stoppedReason: null,
    });
  }

  const cancelGroup = new AbortController();
  const onUpstreamAbort = () => cancelGroup.abort(new Error("upstream_abort"));
  if (signal) {
    if (signal.aborted) cancelGroup.abort(new Error("upstream_abort"));
    else signal.addEventListener("abort", onUpstreamAbort, { once: true });
  }

  const aggregateTimer = setTimeout(() => {
    cancelGroup.abort(new Error("aggregate_timeout"));
  }, aggregateTimeoutMs);
  // Make sure the timer doesn't keep the process alive.
  if (typeof aggregateTimer.unref === "function") aggregateTimer.unref();

  const results = new Array(tasks.length);
  let stoppedReason = null;
  let cursor = 0;

  /**
   * Wrap a single executor with timeout + signal hookup.
   */
  async function runOne(task, index) {
    const id = typeof task.id === "string" && task.id.length ? task.id : `task-${index}`;
    const taskAc = new AbortController();
    const cascade = () => taskAc.abort(new Error("group_aborted"));
    cancelGroup.signal.addEventListener("abort", cascade, { once: true });
    const taskStartedAt = Date.now();

    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        taskAc.abort(new Error("task_timeout"));
        reject(makeStdError("TaskTimeoutError", `task '${id}' exceeded ${taskTimeoutMs}ms`));
      }, taskTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });

    let runResult;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => task.run({ signal: taskAc.signal, id, meta: task.meta })),
        timeoutPromise,
      ]);
      runResult = {
        id,
        ok: true,
        value,
        elapsedMs: Date.now() - taskStartedAt,
        status: "fulfilled",
      };
    } catch (err) {
      const isTimeout = err && err.name === "TaskTimeoutError";
      const isAborted = cancelGroup.signal.aborted && !isTimeout;
      runResult = {
        id,
        ok: false,
        error: serializeError(err),
        elapsedMs: Date.now() - taskStartedAt,
        status: isTimeout ? "timeout" : isAborted ? "aborted" : "rejected",
      };
    } finally {
      clearTimeout(timer);
      cancelGroup.signal.removeEventListener("abort", cascade);
    }

    results[index] = runResult;
    emit("task_done", { result: runResult });
    if (!runResult.ok && failurePolicy === FAILURE_POLICIES.ABORT && !cancelGroup.signal.aborted) {
      stoppedReason = "failure_policy_abort";
      cancelGroup.abort(new Error("failure_policy_abort"));
    }
    return runResult;
  }

  // Worker — pulls indexes off the shared cursor.
  async function worker() {
    while (true) {
      if (cancelGroup.signal.aborted) return;
      const myIdx = cursor;
      if (myIdx >= tasks.length) return;
      cursor += 1;
      const task = tasks[myIdx];
      if (!task || typeof task.run !== "function") {
        results[myIdx] = {
          id: task && typeof task.id === "string" ? task.id : `task-${myIdx}`,
          ok: false,
          error: { name: "TypeError", message: "task.run must be a function" },
          elapsedMs: 0,
          status: "rejected",
        };
        emit("task_done", { result: results[myIdx] });
        if (failurePolicy === FAILURE_POLICIES.ABORT) {
          stoppedReason = "failure_policy_abort";
          cancelGroup.abort(new Error("failure_policy_abort"));
        }
        continue;
      }
      await runOne(task, myIdx);
    }
  }

  const workerCount = Math.min(concurrency, tasks.length);
  const workers = [];
  for (let i = 0; i < workerCount; i += 1) workers.push(worker());

  try {
    await Promise.all(workers);
  } finally {
    clearTimeout(aggregateTimer);
    if (signal) signal.removeEventListener("abort", onUpstreamAbort);
  }

  // Fill in untouched slots — these were never started because of an
  // early abort. Mark them aborted so the result array stays dense.
  for (let i = 0; i < tasks.length; i += 1) {
    if (!results[i]) {
      results[i] = {
        id: tasks[i] && typeof tasks[i].id === "string" ? tasks[i].id : `task-${i}`,
        ok: false,
        error: { name: "AbortError", message: "task_not_started_due_to_abort" },
        elapsedMs: 0,
        status: "aborted",
      };
    }
  }

  const stats = computeStats(results, startedAt);
  if (!stoppedReason && cancelGroup.signal.aborted) {
    const reason = cancelGroup.signal.reason && cancelGroup.signal.reason.message
      ? cancelGroup.signal.reason.message
      : "aborted";
    stoppedReason = reason;
  }

  let reduced;
  try {
    reduced = reducer(results);
  } catch (err) {
    reduced = null;
    emit("reducer_error", { error: serializeError(err) });
  }

  return Object.freeze({
    ok: stats.rejected === 0 && stats.timeouts === 0 && stats.aborted === 0,
    results,
    reduced,
    stats,
    stoppedReason,
  });
}

function computeStats(results, startedAt) {
  const stats = {
    total: results.length,
    fulfilled: 0,
    rejected: 0,
    timeouts: 0,
    aborted: 0,
    elapsedMs: Date.now() - startedAt,
  };
  for (const r of results) {
    if (!r) continue;
    if (r.status === "fulfilled") stats.fulfilled += 1;
    else if (r.status === "timeout") stats.timeouts += 1;
    else if (r.status === "aborted") stats.aborted += 1;
    else stats.rejected += 1;
  }
  return stats;
}

function defaultReducer(results) {
  return results.filter((r) => r && r.ok).map((r) => r.value);
}

function serializeError(err) {
  if (!err) return null;
  return {
    name: err.name || "Error",
    message: err.message || String(err),
  };
}

function makeStdError(name, message) {
  const e = new Error(message);
  e.name = name;
  return e;
}

function makeEmitter(onEvent) {
  if (typeof onEvent !== "function") return () => {};
  return (kind, payload) => {
    try {
      onEvent({ kind, ...payload });
    } catch (_e) {
      // observers must never affect orchestration
    }
  };
}

module.exports = {
  runFanout,
  FAILURE_POLICIES,
  DEFAULT_CONCURRENCY,
  DEFAULT_TASK_TIMEOUT_MS,
  DEFAULT_AGGREGATE_TIMEOUT_MS,
  // exposed for tests
  _internals: { computeStats, defaultReducer },
};
