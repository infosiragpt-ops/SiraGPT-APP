'use strict';

/**
 * host-file-tool — bounded text-file edits for autonomous repo work.
 *
 * This gives the agentic chat a real, auditable way to edit project files
 * without falling back to arbitrary shell redirection. It is intentionally
 * narrow: text files only, allowed workspace roots only, atomic writes, and
 * exact-string replacement for refactors.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  allowedWorkspaceRoots,
  defaultProjectsDir,
  describeWorkspaceRoots,
  expandHome,
  isPathProtected,
  normalizeRoot,
} = require('./workspace-roots');

const WRITE_ACTIONS = new Set(['write', 'append', 'replace']);

const DEFAULT_WORKING_DIR = defaultProjectsDir();
const ALLOWED_DIRS = new Set(allowedWorkspaceRoots());
const MAX_TEXT_BYTES = 512 * 1024;
const DEFAULT_READ_CHARS = 20000;
const MAX_READ_CHARS = 80000;
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

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function isAllowedDirectory(dir) {
  if (!dir) return true;
  const resolved = normalizeRoot(dir);
  for (const allowed of allowedWorkspaceRoots()) {
    const root = path.resolve(allowed);
    if (resolved === root || resolved.startsWith(root + path.sep)) return true;
  }
  return false;
}

function isBlockedSecretPath(filePath) {
  const base = path.basename(filePath);
  if (BLOCKED_BASENAMES.has(base)) return true;
  if (/^\.env\./.test(base) && base !== '.env.example') return true;
  return false;
}

function resolveSafePath(filePath, directory = DEFAULT_WORKING_DIR) {
  const raw = String(filePath || '').trim();
  if (!raw || raw.includes('\0')) return null;
  if (raw === '.' || raw === '..' || raw.includes('..' + path.sep) || raw.includes('/../')) return null;

  let resolved;
  if (raw.startsWith('~/')) {
    resolved = path.resolve(expandHome(raw));
  } else if (path.isAbsolute(raw)) {
    resolved = path.resolve(raw);
  } else {
    const base = normalizeRoot(directory || DEFAULT_WORKING_DIR);
    if (!isAllowedDirectory(base)) return null;
    resolved = path.resolve(base, raw);
  }

  if (!isAllowedDirectory(resolved)) return null;
  return resolved;
}

function readTextFile(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('La ruta no es un archivo regular.');
  if (stat.size > MAX_TEXT_BYTES) throw new Error(`Archivo demasiado grande para editar (${stat.size} bytes).`);
  const buf = fs.readFileSync(filePath);
  if (buf.includes(0)) throw new Error('Archivo binario no permitido.');
  return buf.toString('utf8');
}

function atomicWriteText(filePath, content) {
  const text = String(content ?? '');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_TEXT_BYTES) throw new Error(`Contenido demasiado grande (${bytes} bytes).`);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, filePath);
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

async function hostFile(args = {}, ctx = {}) {
  const action = String(args.action || '').trim();
  const filePath = resolveSafePath(args.path, args.directory);
  if (!filePath) {
    return {
      ok: false,
      error: `Ruta inválida. Solo se permiten archivos dentro de: ${describeWorkspaceRoots()}.`,
    };
  }
  if (isBlockedSecretPath(filePath)) {
    return { ok: false, error: 'Por seguridad no se leen ni editan archivos de secretos como .env o llaves privadas.' };
  }
  if (WRITE_ACTIONS.has(action) && isPathProtected(filePath)) {
    return {
      ok: false,
      error: 'Esta ruta pertenece al código fuente del propio SiraGPT y es de solo lectura para el agente. Trabaja en ~/Desktop/sira-projects. (Para permitir auto-modificación, configura SIRAGPT_ALLOW_SELF_MODIFY=1.)',
    };
  }

  ctx.onEvent?.({ type: 'tool_call', tool: 'host_file', preview: `${action || 'unknown'} ${filePath}` });

  try {
    if (action === 'read') {
      const maxChars = Math.min(MAX_READ_CHARS, Math.max(200, Number(args.maxChars || DEFAULT_READ_CHARS) || DEFAULT_READ_CHARS));
      const text = readTextFile(filePath);
      return {
        ok: true,
        action,
        path: filePath,
        hash: sha256(text),
        sizeBytes: Buffer.byteLength(text, 'utf8'),
        content: text.slice(0, maxChars),
        truncated: text.length > maxChars,
      };
    }

    if (action === 'write') {
      if (typeof args.content !== 'string') return { ok: false, error: 'content debe ser string para action=write.' };
      const before = fs.existsSync(filePath) ? readTextFile(filePath) : '';
      atomicWriteText(filePath, args.content);
      const after = readTextFile(filePath);
      return {
        ok: true,
        action,
        path: filePath,
        created: !before,
        beforeHash: before ? sha256(before) : null,
        afterHash: sha256(after),
        sizeBytes: Buffer.byteLength(after, 'utf8'),
      };
    }

    if (action === 'append') {
      if (typeof args.content !== 'string') return { ok: false, error: 'content debe ser string para action=append.' };
      const before = fs.existsSync(filePath) ? readTextFile(filePath) : '';
      const after = before + args.content;
      atomicWriteText(filePath, after);
      return {
        ok: true,
        action,
        path: filePath,
        beforeHash: before ? sha256(before) : null,
        afterHash: sha256(after),
        sizeBytes: Buffer.byteLength(after, 'utf8'),
      };
    }

    if (action === 'replace') {
      if (typeof args.oldText !== 'string' || typeof args.newText !== 'string') {
        return { ok: false, error: 'oldText y newText deben ser string para action=replace.' };
      }
      if (!fs.existsSync(filePath)) return { ok: false, error: 'El archivo no existe para aplicar replace.' };
      const before = readTextFile(filePath);
      const occurrences = countOccurrences(before, args.oldText);
      if (occurrences === 0) return { ok: false, error: 'oldText no aparece en el archivo.' };
      const expected = args.expectedOccurrences == null ? null : Number(args.expectedOccurrences);
      if (expected != null && occurrences !== expected) {
        return { ok: false, error: `Se esperaban ${expected} ocurrencias, pero hay ${occurrences}.` };
      }
      const after = args.replaceAll === true
        ? before.split(args.oldText).join(args.newText)
        : before.replace(args.oldText, args.newText);
      atomicWriteText(filePath, after);
      return {
        ok: true,
        action,
        path: filePath,
        occurrences,
        replaced: args.replaceAll === true ? occurrences : 1,
        beforeHash: sha256(before),
        afterHash: sha256(after),
        sizeBytes: Buffer.byteLength(after, 'utf8'),
      };
    }

    return { ok: false, error: 'action debe ser read, write, append o replace.' };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), action, path: filePath };
  }
}

const hostFileTool = {
  name: 'host_file',
  description: 'Read and edit text files on the host within the configured SiraGPT workspace roots. Supports read, write, append, and exact-string replace. Use this for code edits before running tests and git commit/push. Secret files such as .env and private keys are blocked.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'write', 'append', 'replace'], description: 'File operation to perform.' },
      path: { type: 'string', description: 'File path. Relative paths resolve against directory or ~/Desktop/sira-projects.' },
      directory: { type: 'string', description: 'Optional working directory for relative paths.' },
      content: { type: 'string', description: 'Content for write or append.' },
      oldText: { type: 'string', description: 'Exact existing text for replace.' },
      newText: { type: 'string', description: 'Replacement text for replace.' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence of oldText. Default false.' },
      expectedOccurrences: { type: 'integer', minimum: 1, description: 'Optional exact occurrence count guard.' },
      maxChars: { type: 'integer', minimum: 200, maximum: MAX_READ_CHARS, description: 'Read cap. Default 20000.' },
    },
    required: ['action', 'path'],
    additionalProperties: false,
  },
  execute: hostFile,
};

module.exports = {
  hostFile,
  hostFileTool,
  ALLOWED_DIRS,
  _internal: {
    countOccurrences,
    isAllowedDirectory,
    isBlockedSecretPath,
    readTextFile,
    resolveSafePath,
    sha256,
  },
};
