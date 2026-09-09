'use strict';

/**
 * project-workspace-tools — project_read / project_write / project_exec.
 *
 * Chat-agent access to the web project linked to the current /agentes chat
 * (Etapa 2 binding: `brief.chatId`). The tools resolve the binding on every
 * call from `ctx.userId` + `ctx.chatId` and operate ONLY inside that
 * project's Codex workspace through the runner sidecar — the backend never
 * touches workspace files directly.
 *
 * Bounds (mirror the /api/codex project-files routes, no new env):
 * - paths are project-relative, traversal/absolute/NUL rejected locally
 *   (the runner re-validates with resolveProjectRelPath)
 * - secret basenames (.env*, private keys) are blocked for read AND write
 * - write: single file per call, content <= 500KB
 * - exec: argv array (no shell), <= 64 args, <= 4000 chars/arg,
 *   <= 32000 chars total, timeout 1s..120s (default 30s)
 *
 * Contract: never throw for expected tool failures — return
 * `{ ok: false, code, message }` so the loop can self-correct.
 * Codes: no_chat_context | no_project | bad_path | blocked_secret |
 * content_too_large | invalid_command | runner_unreachable | internal.
 */

const MAX_PATH_CHARS = 500;
const READ_DEFAULT_LINES = 200;
const READ_MAX_LINES = 2000;
const READ_MAX_CHARS = 80000;
const WRITE_MAX_CONTENT_BYTES = 500 * 1024;
const EXEC_MAX_ARGS = 64;
const EXEC_MAX_ARG_CHARS = 4000;
const EXEC_MAX_TOTAL_CHARS = 32000;
const EXEC_DEFAULT_TIMEOUT_MS = 30000;
const EXEC_MIN_TIMEOUT_MS = 1000;
const EXEC_MAX_TIMEOUT_MS = 120000;
const OUTPUT_MAX_CHARS = 20000;

const BLOCKED_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

function sanitizeRelPath(raw) {
  const p = String(raw || '').trim();
  if (!p || p.includes('\0')) return null;
  if (p.length > MAX_PATH_CHARS) return null;
  if (p === '.' || p === '..') return null;
  // Absolute (POSIX/Windows), drive letters, backslashes and any parent
  // segment are outside the project jail.
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\\')) return null;
  const segs = p.split('/');
  for (const s of segs) {
    if (!s || s === '.' || s === '..') return null;
  }
  return p;
}

function isBlockedSecretPath(relPath) {
  const base = String(relPath || '').split('/').pop();
  if (BLOCKED_BASENAMES.has(base)) return true;
  if (/^\.env\./.test(base) && base !== '.env.example') return true;
  return false;
}

function truncateText(value, maxChars = OUTPUT_MAX_CHARS) {
  const s = String(value || '');
  if (s.length <= maxChars) return { text: s, truncated: false };
  return { text: s.slice(0, maxChars), truncated: true };
}

function depsFromCtx(ctx) {
  const override = (ctx && ctx.projectTools) || {};
  let binding = override.binding || null;
  let runner = override.runner || null;
  if (!binding) {
    // eslint-disable-next-line global-require
    binding = require('../codex/project-chat-binding');
  }
  if (!runner) {
    try {
      // eslint-disable-next-line global-require
      const sandboxProvider = require('../codex/sandbox-provider');
      runner = sandboxProvider.createSandboxClient();
    } catch (_) {
      runner = null;
    }
  }
  return { binding, runner };
}

/**
 * Resolve the Codex project bound to this chat. Ownership is enforced by
 * the binding lookup itself (userId-first filter).
 */
async function resolveBoundProject(ctx) {
  const userId = ctx && ctx.userId != null ? String(ctx.userId) : '';
  const chatId = ctx && ctx.chatId != null ? String(ctx.chatId) : '';
  if (!userId || !chatId) {
    return {
      error: {
        ok: false,
        code: 'no_chat_context',
        message: 'No hay chat vinculado en este turno; las herramientas de proyecto necesitan el chat de /agentes.',
      },
    };
  }
  const { binding } = depsFromCtx(ctx);
  const db = (ctx && ctx.prisma) || null;
  let project = null;
  try {
    project = await binding.findProjectForChat({ userId, chatId, db });
  } catch (_) {
    project = null;
  }
  if (!project || !project.id) {
    return {
      error: {
        ok: false,
        code: 'no_project',
        message: 'Este chat aún no tiene proyecto web vinculado. Pide al usuario que pulse "Nuevo proyecto" en el panel IDE de /agentes y reintenta.',
      },
    };
  }
  return { project };
}

function runnerUnavailable() {
  return {
    ok: false,
    code: 'runner_unreachable',
    message: 'El ejecutor del proyecto no responde; reintenta en unos segundos.',
  };
}

async function projectRead(args, ctx) {
  const rel = sanitizeRelPath(args && args.path);
  if (!rel) {
    return { ok: false, code: 'bad_path', message: 'path debe ser relativo al proyecto (sin .., absolutos ni \\0).' };
  }
  if (isBlockedSecretPath(rel)) {
    return { ok: false, code: 'blocked_secret', message: 'Leer secretos (.env, claves) está bloqueado.' };
  }
  const bound = await resolveBoundProject(ctx);
  if (bound.error) return bound.error;
  const { runner } = depsFromCtx(ctx);
  if (!runner) return runnerUnavailable();
  let out;
  try {
    out = await runner.readFile(bound.project.id, rel);
  } catch (err) {
    return { ok: false, code: 'runner_unreachable', message: String((err && err.message) || err) };
  }
  const content = String((out && out.content) || '');
  const lines = content.split('\n');
  const offset = Math.max(0, Math.floor(Number(args && args.offset) || 0));
  const limit = Math.min(READ_MAX_LINES, Math.max(1, Math.floor(Number((args && args.limit) || READ_DEFAULT_LINES))));
  const slice = lines.slice(offset, offset + limit).join('\n');
  const capped = truncateText(slice, READ_MAX_CHARS);
  return {
    ok: true,
    path: rel,
    offset,
    limit,
    totalLines: lines.length,
    content: capped.text,
    truncated: capped.truncated || offset + limit < lines.length,
  };
}

async function projectWrite(args, ctx) {
  const rel = sanitizeRelPath(args && args.path);
  if (!rel) {
    return { ok: false, code: 'bad_path', message: 'path debe ser relativo al proyecto (sin .., absolutos ni \\0).' };
  }
  if (isBlockedSecretPath(rel)) {
    return { ok: false, code: 'blocked_secret', message: 'Escribir secretos (.env, claves) está bloqueado.' };
  }
  const content = typeof (args && args.content) === 'string' ? args.content : null;
  if (content == null) {
    return { ok: false, code: 'bad_path', message: 'content debe ser string.' };
  }
  if (Buffer.byteLength(content, 'utf8') > WRITE_MAX_CONTENT_BYTES) {
    return { ok: false, code: 'content_too_large', message: `content supera ${WRITE_MAX_CONTENT_BYTES} bytes.` };
  }
  const bound = await resolveBoundProject(ctx);
  if (bound.error) return bound.error;
  const { runner } = depsFromCtx(ctx);
  if (!runner) return runnerUnavailable();
  try {
    await runner.writeFiles(bound.project.id, [{ path: rel, content }]);
  } catch (err) {
    return { ok: false, code: 'runner_unreachable', message: String((err && err.message) || err) };
  }
  return { ok: true, path: rel, bytes: Buffer.byteLength(content, 'utf8') };
}

function normalizeExecCmd(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (raw.length > EXEC_MAX_ARGS) return null;
  const cmd = [];
  let total = 0;
  for (const item of raw) {
    if (typeof item !== 'string') return null;
    const s = item;
    if (!s || s.length > EXEC_MAX_ARG_CHARS) return null;
    total += s.length;
    if (total > EXEC_MAX_TOTAL_CHARS) return null;
    cmd.push(s);
  }
  return cmd;
}

async function projectExec(args, ctx) {
  const cmd = normalizeExecCmd(args && args.cmd);
  if (!cmd) {
    return {
      ok: false,
      code: 'invalid_command',
      message: `cmd debe ser un array de 1-${EXEC_MAX_ARGS} strings (sin shell), <= ${EXEC_MAX_ARG_CHARS} chars/arg y <= ${EXEC_MAX_TOTAL_CHARS} en total.`,
    };
  }
  let timeoutMs = Math.floor(Number((args && args.timeoutMs) || EXEC_DEFAULT_TIMEOUT_MS));
  if (!Number.isFinite(timeoutMs)) timeoutMs = EXEC_DEFAULT_TIMEOUT_MS;
  timeoutMs = Math.min(EXEC_MAX_TIMEOUT_MS, Math.max(EXEC_MIN_TIMEOUT_MS, timeoutMs));
  const bound = await resolveBoundProject(ctx);
  if (bound.error) return bound.error;
  const { runner } = depsFromCtx(ctx);
  if (!runner) return runnerUnavailable();
  let out;
  try {
    out = await runner.exec(bound.project.id, cmd, { timeoutMs });
  } catch (err) {
    return { ok: false, code: 'runner_unreachable', message: String((err && err.message) || err) };
  }
  const stdout = truncateText(out && out.stdout);
  const stderr = truncateText(out && out.stderr);
  return {
    ok: Boolean(out && out.ok),
    exitCode: Number.isFinite(out && out.exitCode) ? out.exitCode : null,
    timedOut: Boolean(out && out.timedOut),
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
  };
}

const projectReadTool = {
  name: 'project_read',
  description: 'Read a text file from this chat\'s linked web project (Codex workspace). Use to inspect code, configs or docs before editing. Line-based offset/limit, output capped. Fails with no_project when the chat has no linked project yet — ask the user to press "Nuevo proyecto" in the /agentes IDE panel.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project-relative file path, e.g. "src/App.tsx".' },
      offset: { type: 'integer', minimum: 0, description: 'First line (0-based). Default 0.' },
      limit: { type: 'integer', minimum: 1, maximum: READ_MAX_LINES, description: 'Max lines. Default 200.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  execute: async (args, ctx) => {
    try {
      return await projectRead(args || {}, ctx || {});
    } catch (err) {
      return { ok: false, code: 'internal', message: String((err && err.message) || err) };
    }
  },
};

const projectWriteTool = {
  name: 'project_write',
  description: 'Create or overwrite a text file in this chat\'s linked web project. Use after project_read for changes the user asked for. Single file per call, 500KB cap. Secret files (.env, private keys) are blocked. Fails with no_project when the chat has no linked project yet.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project-relative file path, e.g. "src/App.tsx".' },
      content: { type: 'string', description: 'Full new file content.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  execute: async (args, ctx) => {
    try {
      return await projectWrite(args || {}, ctx || {});
    } catch (err) {
      return { ok: false, code: 'internal', message: String((err && err.message) || err) };
    }
  },
};

const projectExecTool = {
  name: 'project_exec',
  description: 'Run a one-shot command inside this chat\'s linked web project workspace. Pass argv as an array (no shell, no pipes). Use to install dependencies, type-check, test or build. Default timeout 30s, max 120s. Output capped per stream. Fails with no_project when the chat has no linked project yet.',
  parameters: {
    type: 'object',
    properties: {
      cmd: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: EXEC_MAX_ARGS, description: 'Argv, e.g. ["bun","x","tsc","--noEmit"].' },
      timeoutMs: { type: 'integer', minimum: EXEC_MIN_TIMEOUT_MS, maximum: EXEC_MAX_TIMEOUT_MS, description: 'Command budget in ms. Default 30000.' },
    },
    required: ['cmd'],
    additionalProperties: false,
  },
  execute: async (args, ctx) => {
    try {
      return await projectExec(args || {}, ctx || {});
    } catch (err) {
      return { ok: false, code: 'internal', message: String((err && err.message) || err) };
    }
  },
};

module.exports = {
  projectReadTool,
  projectWriteTool,
  projectExecTool,
  MAX_PATH_CHARS,
  READ_DEFAULT_LINES,
  READ_MAX_LINES,
  READ_MAX_CHARS,
  WRITE_MAX_CONTENT_BYTES,
  EXEC_MAX_ARGS,
  EXEC_MAX_ARG_CHARS,
  EXEC_MAX_TOTAL_CHARS,
  EXEC_DEFAULT_TIMEOUT_MS,
  EXEC_MIN_TIMEOUT_MS,
  EXEC_MAX_TIMEOUT_MS,
  OUTPUT_MAX_CHARS,
  _internal: {
    sanitizeRelPath,
    isBlockedSecretPath,
    truncateText,
    normalizeExecCmd,
    resolveBoundProject,
    projectRead,
    projectWrite,
    projectExec,
  },
};
