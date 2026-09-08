'use strict';

/**
 * Permissioned SiraCode tools: read, write/edit, bash, grep, glob.
 * Also ls (directory listing), apply_patch, webfetch and todo.
 *
 * File tools stay inside the session workspace. bash/shell runs through
 * the native allowlist (shell-sandbox) then execInWorkspace (scrubbed
 * env + cwd jail). Never execs on the repo root or the raw host tree.
 */

const { authorizeTool } = require('./permissions');
const { execInWorkspace } = require('./workspace');
const { applyPatchToWorkspace } = require('./apply-patch');
const { truncateToolResult } = require('./tool-result');
const { runWebFetch } = require('./webfetch');
const { runTodo } = require('./todos');
const { authorizeShellCommand, ERRORS: SHELL_ERRORS } = require('./shell-sandbox');
const { searchGrep, searchGlob } = require('./search');

function cap(text) {
  return truncateToolResult(text).content;
}

function toolError(code, message) {
  return { ok: false, code, error: message, content: `ERROR: ${message}` };
}

function toolOk(content, extra = {}) {
  return { ok: true, content: cap(content), ...extra };
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
  if (!command) return toolError('validation', SHELL_ERRORS.validation);
  const agentId = (ctx.session && ctx.session.agentId) || ctx.agentId || 'construir';
  const gate = authorizeShellCommand(command, {
    workspaceRoot: workspace && workspace.root,
    agentId,
    allowNetwork: args.allowNetwork === true || args.network === true,
    timeoutMs: args.timeoutMs != null ? args.timeoutMs : args.timeout,
  });
  if (!gate.ok) return toolError(gate.code || 'command_denied', gate.error);
  const result = await execInWorkspace(workspace.root, command, {
    timeoutMs: gate.timeoutMs,
    signal: ctx.signal,
    allowNetwork: gate.allowNetwork,
  });
  const parts = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(`[stderr] ${result.stderr}`);
  if (result.truncated) parts.push('[salida recortada por límite de tamaño]');
  parts.push(result.timedOut
    ? `[exit ${result.exitCode} — ${SHELL_ERRORS.timeout}]`
    : `[exit ${result.exitCode}]`);
  const content = cap(parts.join('\n'));
  if (result.aborted) return toolError('aborted', `comando cancelado\n${content}`);
  if (result.timedOut) return toolError('timeout', `${SHELL_ERRORS.timeout}\n${content}`);
  if (Number(result.exitCode) !== 0) return { ok: false, code: 'bash_failed', error: content, content: `ERROR: ${content}` };
  return toolOk(content, { className: gate.className, truncated: Boolean(result.truncated) });
}

async function runGrep(workspace, args, ctx = {}) {
  const result = await searchGrep(workspace, args || {}, ctx);
  if (result.ok) return { ...result, content: cap(result.content) };
  return result;
}

async function runGlob(workspace, args, ctx = {}) {
  const result = await searchGlob(workspace, args || {}, ctx);
  if (result.ok) return { ...result, content: cap(result.content) };
  return result;
}

async function runLs(workspace, args) {
  const rel = String(args.path || args.dir || '.').trim() || '.';
  try {
    const entries = await workspace.listDir(rel);
    if (!entries.length) return toolOk('(empty)');
    const lines = entries.map((entry) => (
      entry.isDir ? `${entry.path}/` : `${entry.path}\t${entry.size}`
    ));
    return toolOk(lines.join('\n'), { entries });
  } catch (err) {
    return toolError(err.code || 'ls_failed', err.message || 'ls failed');
  }
}

async function runApplyPatch(workspace, args) {
  const patch = String(args.patch || args.diff || args.input || '').trim();
  if (!patch) return toolError('validation', 'patch is required');
  try {
    return await applyPatchToWorkspace(workspace, patch);
  } catch (err) {
    return toolError(err.code || 'patch_failed', err.message || 'apply_patch failed');
  }
}

async function runWebFetchTool(_workspace, args, ctx = {}) {
  return runWebFetch(args || {}, { fetch: ctx.fetch, skipDns: ctx.skipDns });
}

function runTodoTool(_workspace, args, ctx = {}) {
  return runTodo(ctx.session, args || {});
}

const EXECUTORS = {
  read: runRead,
  write: runWrite,
  edit: runEdit,
  bash: runBash,
  shell: runBash,
  grep: runGrep,
  glob: runGlob,
  ls: runLs,
  apply_patch: runApplyPatch,
  webfetch: runWebFetchTool,
  todo: runTodoTool,
};

async function executeTool(session, toolName, args = {}, ctx = {}) {
  const auth = authorizeTool(session.agentId, toolName, {
    permission: session.permission || ctx.permission,
    approved: ctx.approved === true,
    grants: session.permissionGrants,
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
      error: `${auth.tool} necesita permiso en modo ${session.agentId}`,
      content: `ERROR: permiso requerido para ${auth.tool}`,
      permission: auth,
    };
  }
  const exec = EXECUTORS[auth.tool];
  if (!exec) return toolError('unknown_tool', `herramienta desconocida: ${auth.tool}`);
  const result = await exec(session.workspace, args || {}, { ...ctx, session });
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
      description: 'Ejecuta un comando allowlisted en el sandbox del workspace (alias: shell). Sin red salvo allowNetwork. Planificar: solo lectura. No lo uses para leer o editar archivos; usa read, write, ls o apply_patch.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeoutMs: { type: 'integer' },
          allowNetwork: { type: 'boolean' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Busca un patrón (regex) en los archivos del workspace. path acota el árbol; include filtra por glob; limit acota coincidencias.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          include: { type: 'string' },
          limit: { type: 'integer' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Lista archivos del workspace que coinciden con un glob. path acota el árbol; limit acota resultados.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          limit: { type: 'integer' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ls',
      description: 'Lista el directorio del workspace (nombres y tamaño). No lee el contenido.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Aplica un parche Begin/End Patch con hunks únicos (Add/Update/Delete File).',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string' },
        },
        required: ['patch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'webfetch',
      description: 'Descarga una URL https pública (markdown/text/html). No escribe archivos.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          format: { type: 'string' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo',
      description: 'Crea o actualiza la lista de tareas de la sesión (un in_progress).',
      parameters: {
        type: 'object',
        properties: {
          todos: { type: 'array' },
        },
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
