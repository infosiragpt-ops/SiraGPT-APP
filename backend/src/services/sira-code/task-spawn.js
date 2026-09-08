'use strict';

/**
 * SiraCode `task` — enqueue a child agent-task job.
 *
 * Contract inspired by OpenCode's task / subagent spawn
 * (anomalyco/opencode, MIT): description, prompt, subagent_type,
 * optional task_id resume, background queue. Native CommonJS stub —
 * not a copy of vendor/opencode/src/tool/task.ts. No Effect runtime,
 * no TUI, no background-job service dump.
 *
 * The stub queues via the existing agent-task APIs
 * (`enqueueAgentTask` + optional `createTaskRecord`). It does not run
 * an LLM loop itself. Planificar may only spawn read-only children.
 */

const crypto = require('crypto');
const { truncateToolResult } = require('./tool-result');

const MAX_SPAWN_DEPTH = 3;
const MAX_PROMPT = 8_000;
const MAX_DESCRIPTION = 120;
const TASK_ID_RE = /^[a-zA-Z0-9_-]{4,80}$/;

const ERRORS = Object.freeze({
  session_required: 'task requiere sesión',
  user_required: 'task requiere usuario',
  validation_prompt: 'prompt es obligatorio',
  validation_subagent: 'subagent_type no es válido',
  validation_task_id: 'task_id inválido',
  planificar_readonly: 'Planificar solo puede lanzar subagentes de lectura',
  spawn_depth: 'profundidad de subagente excedida',
  enqueue_failed: 'no se pudo encolar la tarea hija',
});

const READ_ONLY_CHILDREN = new Set(['general', 'planificar']);

const SUBAGENT_ALIASES = Object.freeze({
  general: 'general',
  explore: 'general',
  search: 'general',
  researcher: 'general',
  planificar: 'planificar',
  plan: 'planificar',
  construir: 'construir',
  build: 'construir',
});

function cap(text) {
  return truncateToolResult(text).content;
}

function toolError(code, message) {
  return { ok: false, code, error: message, content: `ERROR: ${message}` };
}

function toolOk(content, extra = {}) {
  return { ok: true, content: cap(content), ...extra };
}

function newTaskId() {
  return `sctask_${crypto.randomBytes(8).toString('hex')}`;
}

function resolveSubagentType(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return SUBAGENT_ALIASES[key] || null;
}

function clip(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function defaultDescription(prompt) {
  const words = String(prompt || '').trim().split(/\s+/).filter(Boolean).slice(0, 5);
  return words.length ? words.join(' ') : 'tarea';
}

function parentAgentId(session, ctx) {
  return String((session && session.agentId) || ctx.agentId || 'construir').trim();
}

function parentDepth(session) {
  const n = Number(session && session.spawnDepth);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function childLedger(session) {
  if (!session || typeof session !== 'object') return null;
  if (!Array.isArray(session.childTasks)) session.childTasks = [];
  return session.childTasks;
}

function findChild(session, taskId) {
  const list = session && Array.isArray(session.childTasks) ? session.childTasks : [];
  return list.find((row) => row && row.taskId === taskId) || null;
}

async function defaultEnqueue(payload, opts) {
  const { enqueueAgentTask } = require('../agents/agent-task-queue');
  return enqueueAgentTask(payload, opts);
}

function defaultCreateRecord(payload) {
  try {
    const route = require('../../routes/agent-task');
    if (route && route.INTERNAL && typeof route.INTERNAL.createTaskRecord === 'function') {
      return route.INTERNAL.createTaskRecord({
        taskId: payload.taskId,
        userId: payload.userId,
        chatId: payload.chatId || payload.parentSessionId || null,
        displayGoal: payload.displayGoal || payload.prompt,
        model: payload.model || '',
        status: 'queued',
      });
    }
  } catch {
    // Route may be unavailable in isolated tests; enqueue is the contract.
  }
  return { taskId: payload.taskId, status: 'queued' };
}

function formatQueued(row) {
  const lines = [
    'tarea encolada',
    `id: ${row.taskId}`,
    `estado: ${row.status}`,
    `agente: ${row.subagent}`,
    `descripción: ${row.description}`,
  ];
  if (row.resumed) lines.push('reanudada: sí');
  return lines.join('\n');
}

async function runTask(_workspace, args = {}, ctx = {}) {
  const session = ctx.session;
  if (!session || typeof session !== 'object') {
    return toolError('session_required', ERRORS.session_required);
  }

  const userId = String(session.userId || ctx.userId || '').trim();
  if (!userId) return toolError('user_required', ERRORS.user_required);

  const prompt = clip(args.prompt || args.goal || args.input, MAX_PROMPT);
  if (!prompt) return toolError('validation', ERRORS.validation_prompt);

  const subagent = resolveSubagentType(args.subagent_type || args.subagent || args.agent);
  if (!subagent) return toolError('validation', ERRORS.validation_subagent);

  const description = clip(args.description || args.title, MAX_DESCRIPTION)
    || defaultDescription(prompt);

  const parent = parentAgentId(session, ctx);
  if (parent === 'planificar' && !READ_ONLY_CHILDREN.has(subagent)) {
    return toolError('planificar_readonly', ERRORS.planificar_readonly);
  }
  if (parent === 'general' && !READ_ONLY_CHILDREN.has(subagent)) {
    return toolError('planificar_readonly', ERRORS.planificar_readonly);
  }

  const depth = parentDepth(session);
  if (depth >= MAX_SPAWN_DEPTH) {
    return toolError('spawn_depth', ERRORS.spawn_depth);
  }

  const resumeRaw = String(args.task_id || args.taskId || '').trim();
  let taskId;
  let resumed = false;
  if (resumeRaw) {
    if (!TASK_ID_RE.test(resumeRaw)) {
      return toolError('validation', ERRORS.validation_task_id);
    }
    const prior = findChild(session, resumeRaw);
    if (prior && !READ_ONLY_CHILDREN.has(prior.subagent) && parent === 'planificar') {
      return toolError('planificar_readonly', ERRORS.planificar_readonly);
    }
    taskId = resumeRaw;
    resumed = true;
  } else {
    taskId = newTaskId();
  }

  const payload = {
    taskId,
    taskType: 'sira_code_subagent',
    prompt,
    userId,
    collection: ctx.collection || 'default',
    model: String(session.model || ctx.model || ''),
    thinking: 'low',
    maxSteps: Number(args.maxSteps) > 0 ? Math.min(Number(args.maxSteps), 16) : 8,
    source: 'sira-code:task',
    parentTaskId: session.taskId || null,
    parentSessionId: session.id || null,
    depth: depth + 1,
    displayGoal: `${description}: ${prompt}`.slice(0, MAX_PROMPT),
    metadata: {
      description,
      subagent,
      parentAgent: parent,
      background: args.background !== false,
      resumed,
    },
  };

  const enqueue = ctx.enqueue || session.enqueue || defaultEnqueue;
  const createRecord = ctx.createRecord || session.createRecord || defaultCreateRecord;

  try {
    const job = await enqueue(payload, { jobId: taskId, priority: 0 });
    const record = await Promise.resolve(createRecord(payload));
    const row = {
      taskId,
      status: 'queued',
      subagent,
      description,
      resumed,
      parentSessionId: session.id || null,
      jobId: (job && (job.id || job.jobId)) || taskId,
      recordId: record && (record.taskId || record.id) || taskId,
    };
    const ledger = childLedger(session);
    if (ledger) {
      const idx = ledger.findIndex((item) => item && item.taskId === taskId);
      if (idx >= 0) ledger[idx] = row;
      else ledger.push(row);
    }
    session.updatedAt = Date.now();
    return toolOk(formatQueued(row), {
      taskId,
      status: 'queued',
      subagent,
      description,
      resumed,
      queued: true,
    });
  } catch {
    return toolError('enqueue_failed', ERRORS.enqueue_failed);
  }
}

module.exports = {
  MAX_SPAWN_DEPTH,
  MAX_PROMPT,
  ERRORS,
  SUBAGENT_ALIASES,
  READ_ONLY_CHILDREN,
  resolveSubagentType,
  defaultDescription,
  runTask,
};
