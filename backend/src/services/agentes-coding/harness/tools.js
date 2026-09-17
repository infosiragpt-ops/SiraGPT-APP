'use strict';

/**
 * Sandbox-only tool adapter for the Phase 4a harness.
 *
 * Names follow SiraCode contracts (read / write / exec / list). Every
 * path goes through jailRelPath before touching the session driver.
 * No host FS, no Docker socket, no webfetch, no control-plane writes.
 */

const { fail } = require('../coding-sandbox/errors');
const { jailRelPath } = require('../coding-sandbox/path-jail');

const TOOL_ALIASES = Object.freeze({
  read: 'read',
  read_file: 'read',
  write: 'write',
  write_file: 'write',
  exec: 'exec',
  bash: 'exec',
  shell: 'exec',
  list: 'list',
  list_files: 'list',
  ls: 'list',
});

const TOOL_DEFINITIONS = Object.freeze([
  { name: 'read', description: 'Lee un archivo del workspace de la sesión.', args: ['path'] },
  { name: 'write', description: 'Escribe un archivo en el workspace de la sesión.', args: ['path', 'content'] },
  { name: 'exec', description: 'Ejecuta un comando dentro del jail de la sesión.', args: ['command'] },
  { name: 'list', description: 'Lista archivos del workspace de la sesión.', args: ['path'] },
]);

const RESULT_PREVIEW_MAX = 2_000;
const PREVIEW_MARKER = '…[resultado truncado]';

function canonicalTool(name) {
  const raw = String(name || '').trim();
  return TOOL_ALIASES[raw] || null;
}

function previewOf(value, max = RESULT_PREVIEW_MAX) {
  const text = typeof value === 'string' ? value : safeJson(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - PREVIEW_MARKER.length))}${PREVIEW_MARKER}`;
}

function safeJson(value) {
  try {
    const str = JSON.stringify(value);
    return typeof str === 'string' ? str : String(value);
  } catch (_) {
    return '[no serializable]';
  }
}

function argsDigest(tool, args = {}) {
  if (tool === 'read' || tool === 'list') {
    return { path: String(args.path || args.file || args.dir || '.') };
  }
  if (tool === 'write') {
    const content = args.content == null ? '' : args.content;
    const bytes = Buffer.byteLength(String(content), 'utf8');
    return { path: String(args.path || args.file || ''), bytes };
  }
  if (tool === 'exec') {
    const command = String(args.command || args.cmd || '').slice(0, 80);
    return { command };
  }
  return {};
}

function toolOk(content, extra = {}) {
  return { ok: true, content: previewOf(content), ...extra };
}

function toolErr(code, message) {
  return { ok: false, code, content: String(message || ''), error: String(message || '') };
}

async function executeTool(sandbox, sessionId, name, rawArgs, opts = {}) {
  if (!sandbox) fail('E_PARAMS', 'Falta el sandbox de la sesión.');
  const tool = canonicalTool(name);
  if (!tool) fail('E_PARAMS', `Herramienta no permitida: ${name || '(vacía)'}.`);
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  const signal = opts.signal;

  if (tool === 'read') {
    const rel = jailRelPath(args.path || args.file);
    const buf = await sandbox.readFile(sessionId, rel);
    const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
    return toolOk(text, { path: rel, bytes: Buffer.byteLength(text, 'utf8') });
  }

  if (tool === 'write') {
    const rel = jailRelPath(args.path || args.file);
    const written = await sandbox.writeFile(sessionId, rel, args.content == null ? '' : args.content);
    return toolOk(`escrito ${written.path} (${written.bytes} bytes)`, {
      path: written.path,
      bytes: written.bytes,
    });
  }

  if (tool === 'list') {
    const rel = jailRelPath(args.path || args.dir || '.', { forList: true });
    const files = await sandbox.listFiles(sessionId, rel);
    const lines = (files || []).map((item) => {
      const p = typeof item === 'string' ? item : item.path;
      const size = item && item.size != null ? `\t${item.size}` : '';
      return `${p}${size}`;
    });
    return toolOk(lines.join('\n') || '(vacío)', { files: files || [], path: rel });
  }

  const command = String(args.command || args.cmd || '').trim();
  if (!command) fail('E_PARAMS', 'Falta el comando.');
  const cwd = args.cwd ? jailRelPath(args.cwd, { forList: true }) : undefined;
  const result = await sandbox.exec(sessionId, command, {
    timeoutMs: args.timeoutMs,
    cwd,
    signal,
  });
  const parts = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(`[stderr] ${result.stderr}`);
  parts.push(`[exit ${result.exitCode ?? 0}]`);
  const content = parts.join('\n');
  if (result.timedOut) return toolErr('E_TIMEOUT', content);
  if (result.ok === false || Number(result.exitCode) !== 0) {
    return toolErr('E_HARNESS_FAILED', content);
  }
  return toolOk(content, { exitCode: result.exitCode ?? 0 });
}

module.exports = {
  TOOL_ALIASES,
  TOOL_DEFINITIONS,
  RESULT_PREVIEW_MAX,
  canonicalTool,
  previewOf,
  argsDigest,
  executeTool,
};
