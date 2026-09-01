'use strict';

/**
 * Permissioned SiraCode tools: read, write/edit, bash, grep, glob.
 *
 * File tools stay inside the session workspace. bash runs through
 * execInWorkspace (scrubbed env + cwd jail). Never execs on the repo
 * root or the raw host tree.
 */

const path = require('path');
const { authorizeTool } = require('./permissions');
const { execInWorkspace } = require('./workspace');

const MAX_RESULT = 30_000;

function cap(text) {
  const str = String(text == null ? '' : text);
  return str.length > MAX_RESULT ? `${str.slice(0, MAX_RESULT)}\n…[result truncated]` : str;
}

function toolError(code, message) {
  return { ok: false, code, error: message, content: `ERROR: ${message}` };
}

function toolOk(content, extra = {}) {
  return { ok: true, content: cap(content), ...extra };
}

function matchGlob(relPath, pattern) {
  const pat = String(pattern || '').replace(/^\.\//, '');
  const escaped = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*');
  return new RegExp(`^${escaped}$`).test(relPath.replace(/^\.\//, ''));
}

async function runRead(workspace, args) {
  const rel = String(args.path || args.filename || '').trim();
  if (!rel) return toolError('validation', 'path is required');
  try {
    let text = await workspace.readFile(rel);
    const offset = Number(args.offset) || 0;
    const limit = Number(args.limit) || 0;
    if (offset > 0 || limit > 0) {
      const lines = text.split('\n');
      const start = Math.max(0, offset);
      text = lines.slice(start, limit > 0 ? start + limit : undefined).join('\n');
    }
    return toolOk(text, { path: rel });
  } catch (err) {
    return toolError(err.code || 'read_failed', err.message || 'read failed');
  }
}

async function runWrite(workspace, args) {
  const rel = String(args.path || args.filename || '').trim();
  if (!rel) return toolError('validation', 'path is required');
  try {
    const saved = await workspace.writeFile(rel, args.content == null ? '' : args.content);
    return toolOk(`wrote ${saved}`, { path: saved });
  } catch (err) {
    return toolError(err.code || 'write_failed', err.message || 'write failed');
  }
}

async function runEdit(workspace, args) {
  const rel = String(args.path || args.filename || '').trim();
  const oldStr = String(args.old_str || args.oldString || '');
  const newStr = String(args.new_str || args.newString || args.content || '');
  if (!rel) return toolError('validation', 'path is required');
  if (!oldStr) return toolError('validation', 'old_str is required');
  try {
    const current = await workspace.readFile(rel);
    const count = current.split(oldStr).length - 1;
    if (count === 0) return toolError('edit_miss', 'old_str not found');
    if (count > 1) return toolError('edit_ambiguous', 'old_str occurs more than once');
    const next = current.replace(oldStr, newStr);
    const saved = await workspace.writeFile(rel, next);
    return toolOk(`edited ${saved}`, { path: saved });
  } catch (err) {
    return toolError(err.code || 'edit_failed', err.message || 'edit failed');
  }
}

async function runBash(workspace, args, ctx = {}) {
  const command = String(args.command || args.cmd || '').trim();
  if (!command) return toolError('validation', 'command is required');
  const result = await execInWorkspace(workspace.root, command, {
    timeoutMs: Number(args.timeoutMs) || 30_000,
    signal: ctx.signal,
  });
  const parts = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(`[stderr] ${result.stderr}`);
  parts.push(result.timedOut ? `[exit ${result.exitCode} — TIMED OUT]` : `[exit ${result.exitCode}]`);
  const content = cap(parts.join('\n'));
  if (result.aborted) return toolError('aborted', `comando cancelado\n${content}`);
  if (result.timedOut) return toolError('timeout', content);
  if (Number(result.exitCode) !== 0) return { ok: false, code: 'bash_failed', error: content, content: `ERROR: ${content}` };
  return toolOk(content);
}

async function runGrep(workspace, args) {
  const pattern = String(args.pattern || args.query || '');
  if (!pattern) return toolError('validation', 'pattern is required');
  let regex;
  try {
    regex = new RegExp(pattern, args.ignoreCase ? 'i' : '');
  } catch {
    return toolError('validation', 'invalid regex');
  }
  const files = await workspace.listFiles(args.path || '.', { maxFiles: 80 });
  const hits = [];
  for (const file of files) {
    const lines = String(file.content || '').split('\n');
    lines.forEach((line, idx) => {
      if (hits.length >= 50) return;
      if (regex.test(line)) hits.push(`${file.path}:${idx + 1}:${line}`);
    });
    if (hits.length >= 50) break;
  }
  return toolOk(hits.length ? hits.join('\n') : '(no matches)');
}

async function runGlob(workspace, args) {
  const pattern = String(args.pattern || args.glob || '').trim();
  if (!pattern) return toolError('validation', 'pattern is required');
  if (/[;&|`$]/.test(pattern)) return toolError('validation', 'pattern must be a plain glob');
  const files = await workspace.listFiles('.', { maxFiles: 80 });
  const matched = files.map((f) => f.path).filter((p) => matchGlob(p, pattern) || matchGlob(path.basename(p), pattern));
  return toolOk(matched.length ? matched.join('\n') : '(no matches)');
}

const EXECUTORS = {
  read: runRead,
  write: runWrite,
  edit: runEdit,
  bash: runBash,
  grep: runGrep,
  glob: runGlob,
};

async function executeTool(session, toolName, args = {}, ctx = {}) {
  const auth = authorizeTool(session.agentId, toolName, {
    permission: session.permission || ctx.permission,
    approved: ctx.approved === true,
  });
  if (auth.denied) {
    const detail = auth.reason === 'composer_read_only'
      ? 'Solo lectura: se bloquean las escrituras y los comandos.'
      : `la herramienta ${auth.tool} no está permitida en ${session.agentId}`;
    return {
      ...toolError(auth.reason || 'permission_denied', detail),
      permission: auth,
    };
  }
  if (auth.needsPermission) {
    return {
      ok: false,
      code: 'permission_required',
      error: `bash necesita permiso en modo ${session.agentId}`,
      content: `ERROR: permiso requerido para ${auth.tool}`,
      permission: auth,
    };
  }
  const exec = EXECUTORS[auth.tool];
  if (!exec) return toolError('unknown_tool', `herramienta desconocida: ${auth.tool}`);
  const result = await exec(session.workspace, args || {}, ctx);
  return { ...result, permission: auth };
}

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Lee un archivo de texto del workspace de la sesión.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'integer' },
          limit: { type: 'integer' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description: 'Crea o sobrescribe un archivo UTF-8 en el workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description: 'Reemplaza old_str por new_str en un archivo (una sola ocurrencia).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_str: { type: 'string' },
          new_str: { type: 'string' },
        },
        required: ['path', 'old_str', 'new_str'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Ejecuta un comando bash dentro del workspace aislado. Sin red, env limpio.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Busca un patrón en los archivos del workspace.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Lista archivos del workspace que coinciden con un glob.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
        },
        required: ['pattern'],
      },
    },
  },
];

module.exports = {
  executeTool,
  TOOL_DEFINITIONS,
  EXECUTORS,
  cap,
};
