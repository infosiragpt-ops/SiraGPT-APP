'use strict';

const { randomUUID } = require('node:crypto');

const DEFAULT_MAX_PER_RUN = 8;
const DEFAULT_RETENTION_MS = 30 * 60 * 1000;

class BackgroundSubagentManager {
  constructor({ maxPerRun = DEFAULT_MAX_PER_RUN, retentionMs = DEFAULT_RETENTION_MS } = {}) {
    this.maxPerRun = maxPerRun;
    this.retentionMs = retentionMs;
    this.tasks = new Map();
  }

  tasksForRun(runId) {
    return [...this.tasks.values()].filter((task) => task.runId === runId && !['done', 'error', 'cancelled'].includes(task.status));
  }

  start({ runId, project, agent, execute, onComplete = null, parentSignal = null }) {
    if (!runId || !project || !agent || typeof execute !== 'function') throw new Error('invalid_background_subagent');
    if (this.tasksForRun(runId).length >= this.maxPerRun) throw new Error(`background_subagent_limit:${this.maxPerRun}`);

    const taskId = `sub_${randomUUID()}`;
    const controller = new AbortController();
    const task = {
      taskId,
      runId,
      project,
      agent,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      outcome: null,
      error: null,
      controller,
    };
    const abortFromParent = () => controller.abort();
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort();
      else parentSignal.addEventListener('abort', abortFromParent, { once: true });
    }
    this.tasks.set(taskId, task);

    task.promise = Promise.resolve().then(async () => {
      if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' });
      task.status = 'running';
      task.startedAt = new Date().toISOString();
      return execute({ signal: controller.signal });
    }).then((outcome) => {
      task.outcome = outcome;
      task.status = controller.signal.aborted ? 'cancelled' : (outcome?.ok === false ? 'error' : 'done');
      if (outcome?.ok === false) task.error = String(outcome.result || 'subagent_failed').slice(0, 1000);
    }).catch((error) => {
      task.status = controller.signal.aborted || error?.code === 'ABORT_ERR' ? 'cancelled' : 'error';
      task.error = String(error?.message || error).slice(0, 1000);
    }).finally(async () => {
      task.finishedAt = new Date().toISOString();
      if (parentSignal) parentSignal.removeEventListener('abort', abortFromParent);
      if (typeof onComplete === 'function') {
        await Promise.resolve(onComplete(this.snapshot(task))).catch(() => {});
      }
      const timer = setTimeout(() => this.tasks.delete(taskId), this.retentionMs);
      if (typeof timer.unref === 'function') timer.unref();
    });

    return this.snapshot(task);
  }

  owned(taskId, { runId, project }) {
    const task = this.tasks.get(String(taskId || ''));
    if (!task || task.runId !== runId || task.project !== project) throw new Error('background_subagent_not_found');
    return task;
  }

  status({ taskId, runId, project }) {
    return this.snapshot(this.owned(taskId, { runId, project }));
  }

  stop({ taskId, runId, project }) {
    const task = this.owned(taskId, { runId, project });
    if (!['done', 'error', 'cancelled'].includes(task.status)) {
      task.status = 'stopping';
      task.controller.abort();
    }
    return this.snapshot(task);
  }

  snapshot(task) {
    return {
      taskId: task.taskId,
      runId: task.runId,
      project: task.project,
      agent: task.agent,
      status: task.status,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      outcome: task.outcome
        ? {
          ok: task.outcome.ok,
          agent: task.outcome.agent,
          result: String(task.outcome.result || '').slice(0, 6000),
          steps: Number(task.outcome.steps) || 0,
          toolCallsCount: Number(task.outcome.toolCallsCount) || 0,
          durationMs: Number(task.outcome.durationMs) || 0,
          model: task.outcome.model || null,
          effort: task.outcome.effort || null,
        }
        : null,
      error: task.error,
    };
  }

  reset() {
    for (const task of this.tasks.values()) task.controller.abort();
    this.tasks.clear();
  }
}

const backgroundSubagentManager = new BackgroundSubagentManager();

module.exports = {
  BackgroundSubagentManager,
  backgroundSubagentManager,
  DEFAULT_MAX_PER_RUN,
  DEFAULT_RETENTION_MS,
};
