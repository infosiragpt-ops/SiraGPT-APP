'use strict';

/**
 * Permissioned SiraCode tools: read, write/edit, bash, grep, glob.
 * Also ls, apply_patch, webfetch, todo and diagnostics.
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
const { runRead, runWrite, runEdit } = require('./file-tools');
const { runDiagnostics } = require('./diagnostics');

function cap(text) {
  return truncateToolResult(text).content;
}

function toolError(code, message) {
  return { ok: false, code, error: message, content: `ERROR: ${message}` };
}

function toolOk(content, extra = {}) {
  return { ok: true, content: cap(content), ...extra };
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

async function runDiagnosticsTool(workspace, args, ctx = {}) {
  const result = await runDiagnostics(workspace, args || {}, ctx);
  if (result.ok) return { ...result, content: cap(result.content) };
  return result;
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
  diagnostics: runDiagnosticsTool,
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
      description: 'Lee un archivo de texto del workspace aislado (jail). offset es 1-indexado; limit acota líneas. Rechaza binarios, tamaños excesivos y rutas fuera del workspace.',
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
      description: 'Crea o sobrescribe un archivo UTF-8 dentro del workspace. Planificar: denegado. Construir: sujeto a permiso/revisor. Tope de tamaño del jail.',
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
      description: 'Reemplaza old_str por new_str (una ocurrencia, o replaceAll). Planificar: denegado. Construir: sujeto a permiso/revisor. No interpola $ de replace.',
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
  {
    type: 'function',
    function: {
      name: 'diagnostics',
      description: 'Resume diagnósticos LSP/sintaxis del workspace (jail). path acota archivo o carpeta; severity filtra (error/warn/info/hint/all); limit acota resultados. Solo lectura: Planificar y Construir pueden usarla.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          severity: { type: 'string' },
          limit: { type: 'integer' },
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
