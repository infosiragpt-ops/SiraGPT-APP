'use strict';

/**
 * Conservative dependency scheduler for one model turn.
 *
 * Calls are kept in model order, but adjacent calls that cannot observe or
 * overwrite each other's state share a batch. Unknown and process-wide tools
 * remain exclusive. This gives Codex general parallel tool calls without
 * weakening read-after-write ordering.
 */

const FILE_READ_TOOLS = new Set(['read_file', 'read_media']);
const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file']);
const GLOBAL_READ_TOOLS = new Set([
  'list_files',
  'glob',
  'grep_search',
  'repo_map',
  'web_search',
  'web_fetch',
  'use_skill',
  'inspect_database',
  'task_logs',
  'subagent_status',
]);
const EXCLUSIVE_TOOLS = new Set([
  'run_command',
  'install_dependencies',
  'type_check',
  'dev_server_check',
  'browser_check',
  'task_stop',
  'resolve_conflict',
  'update_plan',
  'subagent_stop',
]);

function cleanPath(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function accessFor(call, { parallelSubagents = false } = {}) {
  const name = String(call?.name || '');
  const path = cleanPath(call?.args?.path);

  if (name === 'run_subagent') {
    return parallelSubagents
      ? { kind: 'isolated', reads: new Set(), writes: new Set(), parallel: true }
      : { kind: 'exclusive', reads: new Set(), writes: new Set(), parallel: false };
  }
  if (name.startsWith('mcp__') || EXCLUSIVE_TOOLS.has(name)) {
    return { kind: 'exclusive', reads: new Set(), writes: new Set(), parallel: false };
  }
  if (FILE_READ_TOOLS.has(name)) {
    return { kind: 'file-read', reads: new Set(path ? [path] : []), writes: new Set(), parallel: Boolean(path) };
  }
  if (FILE_WRITE_TOOLS.has(name)) {
    return { kind: 'file-write', reads: new Set(), writes: new Set(path ? [path] : []), parallel: Boolean(path) };
  }
  if (GLOBAL_READ_TOOLS.has(name)) {
    return { kind: 'global-read', reads: new Set(['*']), writes: new Set(), parallel: true };
  }
  return { kind: 'exclusive', reads: new Set(), writes: new Set(), parallel: false };
}

function intersects(left, right) {
  if (left.has('*') && right.size) return true;
  if (right.has('*') && left.size) return true;
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function compatible(left, right) {
  if (!left.parallel || !right.parallel) return false;
  if (left.kind === 'isolated' || right.kind === 'isolated') {
    return left.kind === 'isolated' && right.kind === 'isolated';
  }
  if (intersects(left.writes, right.writes)) return false;
  if (intersects(left.writes, right.reads)) return false;
  if (intersects(left.reads, right.writes)) return false;
  // Repository-wide reads must not race a write whose path they may discover.
  if ((left.reads.has('*') && right.writes.size) || (right.reads.has('*') && left.writes.size)) return false;
  return true;
}

function scheduleToolCalls(calls, options = {}) {
  const rows = Array.isArray(calls) ? calls : [];
  if (options.enabled === false || rows.length < 2) return rows.map((call) => [call]);

  const batches = [];
  let current = [];
  let accesses = [];

  for (const call of rows) {
    const access = accessFor(call, options);
    const canJoin = current.length > 0 && accesses.every((other) => compatible(other, access));
    if (!canJoin && current.length) {
      batches.push(current);
      current = [];
      accesses = [];
    }
    current.push(call);
    accesses.push(access);
    if (!access.parallel) {
      batches.push(current);
      current = [];
      accesses = [];
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

module.exports = {
  FILE_READ_TOOLS,
  FILE_WRITE_TOOLS,
  GLOBAL_READ_TOOLS,
  EXCLUSIVE_TOOLS,
  accessFor,
  compatible,
  scheduleToolCalls,
};
