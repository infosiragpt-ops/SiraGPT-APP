'use strict';

/**
 * Session todo list for SiraCode.
 *
 * Contract inspired by OpenCode todowrite (anomalyco/opencode, MIT):
 * pending / in_progress / completed / cancelled, exactly one in_progress.
 * Native rewrite — not a copy of vendor/opencode/src/tool/todo.ts.
 */

const STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled']);
const MAX_TODOS = 20;
const MAX_CONTENT = 240;

function toolError(code, message) {
  return { ok: false, code, error: message, content: `ERROR: ${message}` };
}

function toolOk(todos) {
  const lines = todos.map((item, idx) => `${idx + 1}. [${item.status}] ${item.content}`);
  return { ok: true, content: lines.length ? lines.join('\n') : '(sin tareas)', todos };
}

function normalizeItem(raw, idx) {
  const content = String(raw && raw.content != null ? raw.content : raw && raw.title != null ? raw.title : '').trim();
  if (!content) return null;
  const status = STATUSES.has(String(raw.status || '').trim()) ? String(raw.status).trim() : 'pending';
  const id = String(raw.id || `t${idx + 1}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || `t${idx + 1}`;
  return { id, content: content.slice(0, MAX_CONTENT), status };
}

function enforceOneInProgress(todos) {
  let seen = false;
  return todos.map((item) => {
    if (item.status !== 'in_progress') return item;
    if (!seen) {
      seen = true;
      return item;
    }
    return { ...item, status: 'pending' };
  });
}

function mergeTodos(current, incoming) {
  const byId = new Map((current || []).map((item) => [item.id, item]));
  incoming.forEach((item, idx) => {
    const next = normalizeItem(item, idx);
    if (!next) return;
    byId.set(next.id, next);
  });
  let list = [...byId.values()].slice(0, MAX_TODOS);
  return enforceOneInProgress(list);
}

function replaceTodos(incoming) {
  const list = [];
  (incoming || []).forEach((item, idx) => {
    const next = normalizeItem(item, idx);
    if (next) list.push(next);
  });
  return enforceOneInProgress(list.slice(0, MAX_TODOS));
}

function runTodo(session, args = {}) {
  if (!session || typeof session !== 'object') return toolError('session_required', 'todo requiere sesión');
  if (!Array.isArray(session.todos)) session.todos = [];
  const incoming = args.todos || args.items || args.list;
  if (incoming == null) return toolOk(session.todos);
  if (!Array.isArray(incoming)) return toolError('validation', 'todos debe ser una lista');
  session.todos = args.merge === false ? replaceTodos(incoming) : mergeTodos(session.todos, incoming);
  session.updatedAt = Date.now();
  return toolOk(session.todos);
}

module.exports = {
  runTodo,
  mergeTodos,
  replaceTodos,
  enforceOneInProgress,
  STATUSES,
};
