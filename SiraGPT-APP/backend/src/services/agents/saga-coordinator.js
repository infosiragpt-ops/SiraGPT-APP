'use strict';

/**
 * saga-coordinator — multi-step workflow orchestrator with compensations.
 *
 * For agent tasks that span multiple side-effecting operations (create
 * file → upload to S3 → notify webhook → write DB row), a partial failure
 * leaves the system in an inconsistent state. The Saga pattern fixes this
 * by associating every forward step with a compensating step that undoes
 * it. On failure at step K, the coordinator runs compensations for steps
 * K-1, K-2, … 0 in reverse order.
 *
 * Why this exists:
 *   - The agent runtime currently has no formal compensation mechanism;
 *     half-applied side effects accumulate and are visible only
 *     post-mortem via audit logs.
 *   - LangGraph supports retries but not compensations.
 *
 * Design:
 *   - In-process orchestrator. State is held in a Saga instance; on
 *     restart, recovery requires the caller to persist progress (out of
 *     scope here — pluggable through `journal` callbacks).
 *   - Forward steps and compensations are independent functions. Each
 *     compensation receives the forward step's output as input plus the
 *     accumulated `context` object that all steps share.
 *   - Two execution semantics:
 *       - 'sequential' (default): steps run in order, halt on first
 *          failure, compensate predecessors in reverse.
 *       - 'parallel': steps run concurrently; on any failure, compensate
 *          ONLY the steps that actually succeeded (in undefined order;
 *          callers should make compensations idempotent).
 *   - Compensations themselves can fail. The coordinator records each
 *     compensation's outcome but never re-throws — partial cleanup is
 *     reported via the structured result, never silently swallowed.
 *   - Optional `journal` callbacks: `onStep` / `onCompensation` fire after
 *     each transition with a snapshot suitable for persistence. Combined
 *     with an external store, this enables crash-recovery.
 *
 * Public API:
 *   - Saga class
 *   - SagaError, CompensationError
 *   - STATUS — frozen status enum
 *
 * Result shape (returned from saga.run()):
 *   {
 *     status: 'completed' | 'compensated' | 'compensation-failed',
 *     steps:        [{ name, status, value?, error? }],
 *     compensations:[{ name, status, value?, error? }],
 *     context: <merged context object>,
 *     elapsedMs: <number>,
 *   }
 */

class SagaError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SagaError';
    this.code = code;
    Object.assign(this, details);
  }
}

class CompensationError extends SagaError {
  constructor(stepName, originalError) {
    super('compensation_failed', `compensation for step "${stepName}" failed: ${originalError && originalError.message}`);
    this.name = 'CompensationError';
    this.stepName = stepName;
    this.cause = originalError;
  }
}

const STATUS = Object.freeze({
  pending: 'pending',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  skipped: 'skipped',
  compensated: 'compensated',
});

const MODE = Object.freeze({
  sequential: 'sequential',
  parallel: 'parallel',
});

class Saga {
  constructor({ name = 'saga', mode = MODE.sequential, journal, now } = {}) {
    if (mode !== MODE.sequential && mode !== MODE.parallel) {
      throw new SagaError('mode_invalid', `mode must be 'sequential' or 'parallel', got '${mode}'`);
    }
    this.name = String(name);
    this.mode = mode;
    this.journal = journal && typeof journal === 'object' ? journal : null;
    this.now = now || (() => Date.now());
    this.steps = [];
    this._stepNames = new Set();
  }

  /**
   * Register a step. `forward` is required; `compensate` is optional —
   * a step with no compensation cannot be undone (use sparingly).
   */
  step({ name, forward, compensate }) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new SagaError('step_invalid', 'step.name must be a non-empty string');
    }
    if (this._stepNames.has(name)) {
      throw new SagaError('step_duplicate', `duplicate step name: ${name}`);
    }
    if (typeof forward !== 'function') {
      throw new SagaError('step_invalid', `step.forward for '${name}' must be a function`);
    }
    if (compensate != null && typeof compensate !== 'function') {
      throw new SagaError('step_invalid', `step.compensate for '${name}' must be a function or null`);
    }
    this._stepNames.add(name);
    this.steps.push({ name, forward, compensate: compensate || null });
    return this;
  }

  async run(initialContext = {}) {
    const startedAt = this.now();
    if (this.steps.length === 0) {
      return {
        status: 'completed',
        steps: [],
        compensations: [],
        context: { ...initialContext },
        elapsedMs: 0,
      };
    }

    const context = { ...initialContext };
    const stepRecords = this.steps.map(s => ({
      name: s.name,
      status: STATUS.pending,
      value: undefined,
      error: undefined,
    }));

    if (this.mode === MODE.sequential) {
      return this._runSequential(stepRecords, context, startedAt);
    }
    return this._runParallel(stepRecords, context, startedAt);
  }

  async _runSequential(stepRecords, context, startedAt) {
    let firstFailureIdx = -1;
    let firstError = null;

    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      const record = stepRecords[i];
      record.status = STATUS.running;
      this._emitJournal('onStep', record, context);
      try {
        const value = await step.forward(context);
        record.value = value;
        record.status = STATUS.succeeded;
        this._emitJournal('onStep', record, context);
      } catch (err) {
        record.error = serializeErr(err);
        record.status = STATUS.failed;
        firstFailureIdx = i;
        firstError = err;
        this._emitJournal('onStep', record, context);
        break;
      }
    }

    if (firstFailureIdx === -1) {
      // Mark unreached as skipped (defensive; for sequential none should remain pending)
      return this._finalize('completed', stepRecords, [], context, startedAt);
    }

    // Mark not-yet-attempted steps as skipped.
    for (let i = firstFailureIdx + 1; i < stepRecords.length; i++) {
      if (stepRecords[i].status === STATUS.pending) stepRecords[i].status = STATUS.skipped;
    }

    const compensations = await this._compensate(stepRecords, context, firstFailureIdx - 1);
    const allCompOk = compensations.every(c => c.status !== STATUS.failed);
    return this._finalize(
      allCompOk ? 'compensated' : 'compensation-failed',
      stepRecords,
      compensations,
      context,
      startedAt,
      firstError,
    );
  }

  async _runParallel(stepRecords, context, startedAt) {
    const results = await Promise.all(this.steps.map(async (step, i) => {
      const record = stepRecords[i];
      record.status = STATUS.running;
      this._emitJournal('onStep', record, context);
      try {
        const value = await step.forward(context);
        record.value = value;
        record.status = STATUS.succeeded;
        this._emitJournal('onStep', record, context);
        return { ok: true, idx: i };
      } catch (err) {
        record.error = serializeErr(err);
        record.status = STATUS.failed;
        this._emitJournal('onStep', record, context);
        return { ok: false, idx: i, err };
      }
    }));

    const failed = results.filter(r => !r.ok);
    if (failed.length === 0) {
      return this._finalize('completed', stepRecords, [], context, startedAt);
    }

    // Compensate every step that succeeded (parallel mode: order undefined,
    // best-effort cleanup; callers should make compensations idempotent).
    const succeededIdxs = results.filter(r => r.ok).map(r => r.idx);
    const compensations = [];
    await Promise.all(succeededIdxs.map(async i => {
      const c = await this._compensateOne(this.steps[i], stepRecords[i], context);
      compensations.push(c);
    }));
    const allCompOk = compensations.every(c => c.status !== STATUS.failed);
    return this._finalize(
      allCompOk ? 'compensated' : 'compensation-failed',
      stepRecords,
      compensations,
      context,
      startedAt,
      failed[0].err,
    );
  }

  /** Compensate steps from `lastSucceededIdx` down to 0 in reverse order. */
  async _compensate(stepRecords, context, lastSucceededIdx) {
    const compensations = [];
    for (let i = lastSucceededIdx; i >= 0; i--) {
      const step = this.steps[i];
      const record = stepRecords[i];
      if (record.status !== STATUS.succeeded) continue;
      const c = await this._compensateOne(step, record, context);
      compensations.push(c);
    }
    return compensations;
  }

  async _compensateOne(step, stepRecord, context) {
    if (!step.compensate) {
      // No compensation registered — record as skipped, not as failure.
      const record = { name: step.name, status: STATUS.skipped, value: null };
      this._emitJournal('onCompensation', record, context);
      return record;
    }
    const record = { name: step.name, status: STATUS.running };
    this._emitJournal('onCompensation', record, context);
    try {
      const value = await step.compensate(stepRecord.value, context);
      record.status = STATUS.succeeded;
      record.value = value === undefined ? null : value;
      this._emitJournal('onCompensation', record, context);
      return record;
    } catch (err) {
      record.status = STATUS.failed;
      record.error = serializeErr(err);
      this._emitJournal('onCompensation', record, context);
      return record;
    }
  }

  _finalize(status, steps, compensations, context, startedAt, firstError) {
    return {
      status,
      steps: steps.map(s => ({ ...s })),
      compensations: compensations.map(c => ({ ...c })),
      context: { ...context },
      elapsedMs: this.now() - startedAt,
      firstError: firstError ? serializeErr(firstError) : null,
    };
  }

  _emitJournal(kind, record, context) {
    if (!this.journal) return;
    const fn = this.journal[kind];
    if (typeof fn !== 'function') return;
    try {
      fn({
        sagaName: this.name,
        kind,
        record: { ...record },
        contextSnapshot: { ...context },
        ts: this.now(),
      });
    } catch {
      // Journals must never break the saga.
    }
  }
}

function serializeErr(err) {
  if (!err) return null;
  return {
    name: err.name || 'Error',
    message: typeof err.message === 'string' ? err.message.slice(0, 500) : String(err).slice(0, 500),
    code: err.code || null,
  };
}

module.exports = {
  Saga,
  SagaError,
  CompensationError,
  STATUS,
  MODE,
};
