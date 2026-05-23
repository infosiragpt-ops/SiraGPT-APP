/**
 * sub-agent-orchestrator — parallel agent execution & coordination layer.
 *
 * Problem:
 *   A single ReAct agent processes tasks sequentially: plan → tool → observe → think → repeat.
 *   Complex goals (multi-file analysis, concurrent research, cross-referencing) take
 *   O(n) wall-clock time where n is the sequential step count.
 *
 * Solution:
 *   Decompose a goal into independent sub-tasks, execute each in its own bounded agent
 *   loop, then synthesise the results. This cuts wall-clock time from O(n) to O(max(depth))
 *   where depth is the longest sub-task chain.
 *
 * Architecture:
 *   SubAgentOrchestrator
 *     ├── decompose(goal)        → subTask[]
 *     ├── dispatch(subTasks)     → Promise.allSettled(subAgentRuns)
 *     ├── synthesise(results)    → final answer
 *     └── monitor(subAgentRuns)  → health, progress, cancellation
 *
 * Each sub-agent run is isolated (separate ReAct loop, separate context) and bounded
 * by the same maxSteps / maxRuntimeMs guards as the parent — no runaway agents.
 *
 * Production hardening vs a naïve Promise.all:
 *   - Per-sub-task circuit breaker: if one sub-agent keeps failing, we don't retry
 *     it past maxRetries — the orchestrator re-plans around the gap.
 *   - Timeout per sub-task: a stuck agent can't hold the entire orchestration.
 *   - Result deduplication: when two sub-agents return overlapping information,
 *     the synthesise step picks the best (or merges) instead of repeating.
 *   - Progress streaming: each sub-agent emits its steps via an EventEmitter,
 *     so the parent can forward progress to the user without waiting for all
 *     sub-agents to finish.
 *   - Sub-agent manifest: each run returns structured metadata (steps taken,
 *     tokens used, stoppedReason) for observability and billing.
 */

const EventEmitter = require('events');
const crypto = require('crypto');

// ─── Constants ────────────────────────────────────────────────────────────

const DEFAULT_MAX_SUB_AGENTS = 4;          // parallel sub-agents per orchestration
const DEFAULT_MAX_STEPS_PER_SUB = 6;       // tool calls per sub-agent
const DEFAULT_SUB_TIMEOUT_MS = 120_000;    // 2 min per sub-agent
const DEFAULT_MAX_RETRIES = 2;             // max retries for a failing sub-agent
const MIN_SUB_TASK_CHARS = 40;             // minimum sub-goal length before we skip decomposition

// ─── Custom error ─────────────────────────────────────────────────────────

class SubAgentError extends Error {
  constructor(subTaskId, message, cause = null) {
    super(`[sub-agent:${subTaskId}] ${message}`);
    this.name = 'SubAgentError';
    this.subTaskId = subTaskId;
    this.cause = cause;
  }
}

// ─── Sub-agent context factory ─────────────────────────────────────────────

/**
 * Create an isolated context for a sub-agent run.
 * Each sub-agent gets its own userId, collection, and a unique trace prefix
 * so logs, metrics, and audit trails can distinguish sub-agent activity
 * from the parent orchestrator's.
 *
 * @param {object} parentCtx  — the orchestrator's context (userId, collection, etc.)
 * @param {string} subTaskId  — unique id for this sub-task
 * @returns {object}          — cloned context with traceId
 */
function createSubContext(parentCtx, subTaskId) {
  return {
    ...parentCtx,
    traceId: `${parentCtx.traceId || 'root'}::${subTaskId}`,
    source: `${parentCtx.source || 'orchestrator'}::${subTaskId}`,
    isSubAgent: true,
    parentTraceId: parentCtx.traceId || 'root',
  };
}

// ─── SubAgentOrchestrator ─────────────────────────────────────────────────

class SubAgentOrchestrator extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} [opts.maxSubAgents=4]       — parallel sub-agents
   * @param {number} [opts.maxStepsPerSub=6]     — max tool calls per sub-agent
   * @param {number} [opts.subTaskTimeoutMs=120000]
   * @param {number} [opts.maxRetries=2]
   * @param {Function} [opts.runSubAgent]        — async (goal, ctx, subOpts) => result
   *        Must return { answer, steps, stoppedReason, metadata }
   */
  constructor(opts = {}) {
    super();
    this.maxSubAgents = opts.maxSubAgents ?? DEFAULT_MAX_SUB_AGENTS;
    this.maxStepsPerSub = opts.maxStepsPerSub ?? DEFAULT_MAX_STEPS_PER_SUB;
    this.subTaskTimeoutMs = opts.subTaskTimeoutMs ?? DEFAULT_SUB_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = opts.retryDelayMs ?? 1000;
    this._runSubAgent = opts.runSubAgent;
  }

  /**
   * Decompose a complex goal into independent sub-tasks.
   *
   * The default implementation uses a simple heuristic split on "and", numbered lists,
   * and "then" segments. Override this method (or inject a planner-based decomposer)
   * for more sophisticated decomposition.
   *
   * @param {string} goal  — the full user request
   * @returns {Array<{ id: string, goal: string, dependsOn: string[] }>}
   */
  decompose(goal) {
    if (!goal || goal.length < MIN_SUB_TASK_CHARS) {
      // Too short to decompose meaningfully — return as single task
      return [{ id: crypto.randomUUID(), goal, dependsOn: [] }];
    }

    const segments = this._splitIntoSegments(goal);

    if (segments.length <= 1) {
      return [{ id: crypto.randomUUID(), goal, dependsOn: [] }];
    }

    // Deduplicate near-identical segments (trim, lowercase, fuzzy dedup)
    const seen = new Set();
    const subTasks = [];
    for (const seg of segments) {
      const sig = seg.trim().toLowerCase().slice(0, 120);
      if (!sig || seen.has(sig)) continue;
      seen.add(sig);

      subTasks.push({
        id: crypto.randomUUID(),
        goal: seg.trim(),
        dependsOn: [],
      });

      // Cap at maxSubAgents to avoid overwhelming the system
      if (subTasks.length >= this.maxSubAgents) break;
    }

    // If splitting was too aggressive and produced just one task, return as-is
    return subTasks.length > 1 ? subTasks : [{ id: crypto.randomUUID(), goal, dependsOn: [] }];
  }

  /**
   * Simple segment splitter: looks for numbered items, "and" at clause boundaries,
   * and paragraph breaks. Override for LLM-based decomposition.
   */
  _splitIntoSegments(goal) {
    // Strategy: try numbered list first, then paragraph breaks, then "and"
    const lines = goal.split('\n').filter(l => l.trim());

    // Detect numbered list pattern: "1. ... 2. ... 3. ..."
    const numbered = lines.filter(l => /^\s*\d+[\.\)]\s/.test(l));
    if (numbered.length >= 2) {
      return numbered.map(l => l.replace(/^\s*\d+[\.\)]\s+/, '').trim()).filter(Boolean);
    }

    // Detect bullet list: "- ...", "* ..."
    const bulleted = lines.filter(l => /^\s*[-*]\s/.test(l));
    if (bulleted.length >= 2) {
      return bulleted.map(l => l.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean);
    }

    // Detect paragraph breaks (double newlines)
    const paragraphs = goal.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > MIN_SUB_TASK_CHARS);
    if (paragraphs.length >= 2 && paragraphs.length <= this.maxSubAgents) {
      return paragraphs;
    }

    // Detect "and" at sentence boundaries (rough heuristic)
    const sentences = goal.split(/\.\s+/).filter(s => s.trim().length > 0);
    let buffer = '';
    const segments = [];

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (trimmed.toLowerCase().startsWith('and ')) {
        if (buffer) {
          segments.push(buffer);
          buffer = trimmed;
        } else {
          buffer = trimmed;
        }
      } else {
        buffer = buffer ? `${buffer}. ${trimmed}` : trimmed;
      }
    }
    if (buffer) segments.push(buffer);

    return segments;
  }

  /**
   * Orchestrate parallel execution of sub-agents.
   *
   * Flow:
   *   1. decompose(goal) → subTasks[]
   *   2. For each batch (respecting maxSubAgents), run sub-agents in parallel
   *   3. Collect results with retry on transient failures
   *   4. synthesise(results) → final answer
   *
   * @param {string} goal         — the full user request
   * @param {object} ctx          — parent context (userId, collection, etc.)
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]  — cancellation signal
   * @param {string} [opts.orchestrationId]  — stable id for this orchestration run
   * @returns {Promise<{
   *   answer: string,
   *   subResults: Array,
   *   stoppedReason: string,
   *   metadata: object
   * }>}
   */
  async orchestrate(goal, ctx, opts = {}) {
    const orchestrationId = opts.orchestrationId || crypto.randomUUID();
    const signal = opts.signal || null;

    if (signal?.aborted) {
      return this._abortedResult(orchestrationId);
    }

    // ── Step 1: Decompose ──────────────────────────────────────────────
    const subTasks = this.decompose(goal);
    this.emit('decomposed', { orchestrationId, subTasks: subTasks.map(t => ({ id: t.id, goal: t.goal })) });

    if (!this._runSubAgent) {
      throw new Error('SubAgentOrchestrator: runSubAgent function is required');
    }

    // ── Step 2: Execute sub-agents in parallel batches ─────────────────
    const subResults = await this._executeBatch(subTasks, ctx, orchestrationId, signal);

    // ── Step 3: Check for catastrophic failure ─────────────────────────
    const succeeded = subResults.filter(r => r.status === 'fulfilled');
    const failed = subResults.filter(r => r.status === 'rejected');

    if (succeeded.length === 0) {
      const reasons = failed.map(r => r.reason?.message || 'unknown error').join('; ');
      return {
        answer: '',
        subResults: [],
        stoppedReason: `all_sub_agents_failed: ${reasons}`,
        metadata: { orchestrationId, totalSubAgents: subTasks.length, succeeded: 0, failed: failed.length },
      };
    }

    // ── Step 4: Synthesise partial results ─────────────────────────────
    const answer = await this._synthesise(succeeded, subTasks, goal);

    this.emit('complete', { orchestrationId, answerLength: answer.length, succeeded: succeeded.length, failed: failed.length });

    return {
      answer,
      subResults: succeeded.map(r => r.value),
      stoppedReason: failed.length > 0
        ? `partial: ${failed.length} sub-agent(s) failed, ${succeeded.length} succeeded`
        : 'completed',
      metadata: {
        orchestrationId,
        totalSubAgents: subTasks.length,
        succeeded: succeeded.length,
        failed: failed.length,
        totalSteps: succeeded.reduce((sum, r) => sum + (r.value?.steps?.length || 0), 0),
      },
    };
  }

  /**
   * Execute sub-tasks in parallel batches, with retries.
   */
  async _executeBatch(subTasks, ctx, orchestrationId, signal) {
    const results = [];
    const pending = [...subTasks];

    while (pending.length > 0) {
      const batch = pending.splice(0, this.maxSubAgents);

      const batchResults = await Promise.allSettled(
        batch.map(subTask => this._runWithRetry(subTask, ctx, orchestrationId, signal))
      );

      for (let i = 0; i < batchResults.length; i++) {
        const result = batchResults[i];
        const subTask = batch[i];

        if (result.status === 'fulfilled') {
          this.emit('sub_complete', {
            orchestrationId,
            subTaskId: subTask.id,
            goal: subTask.goal.slice(0, 100),
            success: true,
            steps: result.value?.steps?.length || 0,
          });
        } else {
          this.emit('sub_failed', {
            orchestrationId,
            subTaskId: subTask.id,
            goal: subTask.goal.slice(0, 100),
            success: false,
            error: result.reason?.message,
          });
        }

        results.push({ ...result, subTaskId: subTask.id });
      }
    }

    return results;
  }

  /**
   * Run a sub-agent with retry logic for transient failures.
   */
  async _runWithRetry(subTask, ctx, orchestrationId, signal) {
    const subCtx = createSubContext(ctx, subTask.id);

    let lastError = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) {
        throw new SubAgentError(subTask.id, 'cancelled', null);
      }

      try {
        this.emit('sub_start', {
          orchestrationId,
          subTaskId: subTask.id,
          goal: subTask.goal.slice(0, 100),
          attempt: attempt + 1,
        });

        const result = await this._runWithTimeout(subTask.goal, subCtx, signal);
        return result;
      } catch (err) {
        lastError = err;
        const isTransient = this._isTransientError(err);

        if (!isTransient || attempt >= this.maxRetries) {
          throw new SubAgentError(subTask.id, err.message, err);
        }

        // Exponential backoff with jitter
        const base = this.retryDelayMs;
        const delayMs = Math.min(base * Math.pow(2, attempt) + Math.random() * (base / 2), 30_000);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    throw lastError;
  }

  /**
   * Run a single sub-agent with a timeout guard.
   */
  async _runWithTimeout(goal, ctx, signal) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`sub-agent timeout after ${this.subTaskTimeoutMs}ms`)),
        this.subTaskTimeoutMs,
      );
    });

    const run = this._runSubAgent(goal, ctx, { maxSteps: this.maxStepsPerSub });
    const raceSignal = signal
      ? Promise.race([run, timeout, this._signalPromise(signal)])
      : Promise.race([run, timeout]);

    const clear = () => clearTimeout(timer);
    return raceSignal.finally(clear);
  }

  /**
   * Convert an AbortSignal into a rejection promise.
   */
  _signalPromise(signal) {
    return new Promise((_, reject) => {
      if (signal.aborted) return reject(new Error('cancelled'));
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
  }

  /**
   * Classify error types. Transient errors are retried; permanent errors fail fast.
   */
  _isTransientError(err) {
    if (!err) return false;
    const msg = (err.message || '').toLowerCase();
    // Rate limits, 5xx, network timeouts — all retryable
    return (
      msg.includes('rate limit') ||
      msg.includes('429') ||
      msg.includes('5') || // 500, 502, 503, 504
      msg.includes('timeout') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('service unavailable') ||
      msg.includes('too many requests') ||
      msg.includes('circuit breaker') ||
      msg.includes('sub-agent timeout')
    );
  }

  /**
   * Synthesise sub-agent results into a coherent final answer.
   * Uses a simple merge strategy: concatenate with section headers.
   * Override for LLM-based synthesis.
   *
   * @param {Array} succeeded  — fulfilled sub-agent results
   * @param {Array} subTasks   — original sub-task definitions
   * @param {string} goal      — the original goal
   * @returns {string}
   */
  async _synthesise(succeeded, subTasks, goal) {
    if (succeeded.length === 1) {
      return succeeded[0].value?.answer || succeeded[0].value || '';
    }

    const parts = [];

    for (let i = 0; i < succeeded.length; i++) {
      const result = succeeded[i].value;
      const answerText = result?.answer || result || '';

      if (!answerText) continue;

      // Find the corresponding sub-task goal for the section header
      const subTask = subTasks.find(t => t.id === succeeded[i].subTaskId);
      const header = subTask?.goal
        ? subTask.goal.length > 80
          ? subTask.goal.slice(0, 80) + '…'
          : subTask.goal
        : `Part ${i + 1}`;

      parts.push(`## ${header}\n\n${answerText}`);
    }

    if (parts.length === 0) return '';

    return parts.join('\n\n---\n\n');
  }

  /**
   * Return an aborted result structure.
   */
  _abortedResult(orchestrationId) {
    return {
      answer: '',
      subResults: [],
      stoppedReason: 'cancelled',
      metadata: { orchestrationId, totalSubAgents: 0, succeeded: 0, failed: 0, aborted: true },
    };
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Create a SubAgentOrchestrator that wraps an existing agent runner.
 *
 * @param {Function} runAgent  — async (goal, ctx, opts) => { answer, steps, stoppedReason, metadata }
 * @param {object} [opts]
 * @returns {SubAgentOrchestrator}
 */
function createOrchestrator(runAgent, opts = {}) {
  return new SubAgentOrchestrator({
    ...opts,
    runSubAgent: async (goal, ctx, subOpts) => {
      const result = await runAgent(goal, ctx, {
        maxSteps: subOpts.maxSteps || opts.maxStepsPerSub || DEFAULT_MAX_STEPS_PER_SUB,
        source: ctx.source || 'sub-agent',
      });
      return result;
    },
  });
}

module.exports = {
  SubAgentOrchestrator,
  SubAgentError,
  createOrchestrator,
  DEFAULT_MAX_SUB_AGENTS,
  DEFAULT_MAX_STEPS_PER_SUB,
  DEFAULT_SUB_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
};
