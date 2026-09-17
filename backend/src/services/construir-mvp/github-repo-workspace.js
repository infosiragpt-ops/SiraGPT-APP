'use strict';

/**
 * Isolated CONSTRUIR repo workspace (flag AGENTES_CODING_V2 not required).
 * In-memory file map + path jail. Never seeds host .env. Exec is builtin
 * (ls/cat/pwd) or an injected runner — no process.env leak into the child.
 */

const path = require('node:path');
const crypto = require('node:crypto');

const WORKSPACE_ROOT = '/workspace';
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 400_000;
const MAX_FILES = 180;
const MAX_EXEC_MS = 15_000;

const sessions = new Map();
const lastByUserChat = new Map();

function userChatKey(userId, chatId) {
  return `u:${String(userId || '')}:c:${String(chatId || '')}`;
}

function publicError(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function jailRelPath(relPath, { forList = false } = {}) {
  if (relPath == null || relPath === '') {
    if (forList) return { ok: true, path: '.' };
    return publicError('E_PARAMS', 'Falta la ruta del archivo.');
  }
  const raw = String(relPath);
  if (raw.includes('\0') || /[\x00-\x1f]/.test(raw)) {
    return publicError('E_PATH_ESCAPE', 'La ruta contiene caracteres de control.');
  }
  let p = raw.trim();
  if (p === WORKSPACE_ROOT) p = '.';
  else if (p.startsWith(`${WORKSPACE_ROOT}/`)) p = p.slice(WORKSPACE_ROOT.length + 1);
  if (path.posix.isAbsolute(p) || path.win32.isAbsolute(p)) {
    return publicError('E_PATH_ESCAPE', 'La ruta sale del workspace aislado.');
  }
  if (p.includes('\\')) {
    return publicError('E_PATH_ESCAPE', 'La ruta no puede usar barras invertidas.');
  }
  const norm = path.posix.normalize(p);
  if (norm === '..' || norm.startsWith('../') || norm.includes('/../')) {
    return publicError('E_PATH_ESCAPE', 'La ruta sale del workspace aislado.');
  }
  if (norm.startsWith('/')) {
    return publicError('E_PATH_ESCAPE', 'La ruta sale del workspace aislado.');
  }
  const finalPath = forList && (norm === '.' || norm === '') ? '.' : norm;
  return { ok: true, path: finalPath };
}

function createMemorySandbox(initialFiles = {}, deps = {}) {
  const files = new Map();
  for (const [rel, content] of Object.entries(initialFiles || {})) {
    const jailed = jailRelPath(rel);
    if (!jailed.ok) continue;
    files.set(jailed.path, String(content ?? ''));
  }
  const execImpl = typeof deps.execImpl === 'function' ? deps.execImpl : null;

  return {
    kind: 'memory',
    files,
    async list(rel = '.') {
      const jailed = jailRelPath(rel, { forList: true });
      if (!jailed.ok) return jailed;
      const prefix = jailed.path === '.' ? '' : `${jailed.path}/`;
      const names = [];
      for (const key of files.keys()) {
        if (!prefix || key === jailed.path || key.startsWith(prefix)) names.push(key);
      }
      names.sort();
      return { ok: true, path: jailed.path, files: names, count: names.length };
    },
    async read(rel) {
      const jailed = jailRelPath(rel);
      if (!jailed.ok) return jailed;
      if (!files.has(jailed.path)) {
        return publicError('E_PARAMS', `No existe ${jailed.path} en el workspace.`);
      }
      return { ok: true, path: jailed.path, content: files.get(jailed.path) };
    },
    async write(rel, content) {
      const jailed = jailRelPath(rel);
      if (!jailed.ok) return jailed;
      const text = String(content ?? '');
      if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
        return publicError('E_QUOTA', 'El archivo supera el tope del workspace.');
      }
      if (!files.has(jailed.path) && files.size >= MAX_FILES) {
        return publicError('E_QUOTA', 'El workspace alcanzó el máximo de archivos.');
      }
      files.set(jailed.path, text);
      return { ok: true, path: jailed.path, bytes: Buffer.byteLength(text, 'utf8') };
    },
    async exec({ command, args = [], timeoutMs } = {}) {
      const cmd = String(command || '').trim();
      if (!cmd) return publicError('E_PARAMS', 'Falta el comando.');
      if (/[\\/;|&`$<>]/.test(cmd) || cmd.includes('..')) {
        return publicError('E_PATH_ESCAPE', 'El comando no es válido en el workspace aislado.');
      }
      const argv = Array.isArray(args) ? args.map((a) => String(a)) : [];
      const builtin = runBuiltinExec(files, cmd, argv);
      if (builtin) return builtin;
      if (execImpl) {
        const started = Date.now();
        const cap = Number.isFinite(timeoutMs) ? timeoutMs : MAX_EXEC_MS;
        const out = await execImpl({
          command: cmd,
          args: argv,
          timeoutMs: cap,
          cwd: WORKSPACE_ROOT,
          env: sanitizedExecEnv(),
        });
        return {
          ok: (out && out.exitCode === 0) || out?.ok === true,
          exitCode: out && Number.isFinite(out.exitCode) ? out.exitCode : (out && out.ok ? 0 : 1),
          stdout: String((out && out.stdout) || '').slice(0, 16_000),
          stderr: String((out && out.stderr) || '').slice(0, 4_000),
          durationMs: Date.now() - started,
        };
      }
      return publicError(
        'E_PARAMS',
        'En este workspace aislado solo puedes usar ls, cat o pwd (sin red y sin .env del host).',
      );
    },
    snapshot() {
      const out = {};
      for (const [k, v] of files.entries()) out[k] = v;
      return out;
    },
  };
}

function sanitizedExecEnv() {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: WORKSPACE_ROOT,
    LANG: 'C.UTF-8',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function runBuiltinExec(files, cmd, args) {
  if (cmd === 'pwd') {
    return { ok: true, exitCode: 0, stdout: `${WORKSPACE_ROOT}\n`, stderr: '' };
  }
  if (cmd === 'ls') {
    const jailed = jailRelPath(args[0] || '.', { forList: true });
    if (!jailed.ok) return jailed;
    const prefix = jailed.path === '.' ? '' : `${jailed.path}/`;
    const names = [];
    for (const key of files.keys()) {
      if (!prefix || key === jailed.path || key.startsWith(prefix)) names.push(key);
    }
    names.sort();
    return { ok: true, exitCode: 0, stdout: `${names.join('\n')}\n`, stderr: '' };
  }
  if (cmd === 'cat') {
    if (!args[0]) return publicError('E_PARAMS', 'cat necesita una ruta.');
    const jailed = jailRelPath(args[0]);
    if (!jailed.ok) return jailed;
    if (!files.has(jailed.path)) {
      return { ok: false, exitCode: 1, stdout: '', stderr: `No existe ${jailed.path}\n` };
    }
    return { ok: true, exitCode: 0, stdout: files.get(jailed.path), stderr: '' };
  }
  return null;
}

function sweepExpired(now = Date.now()) {
  for (const [id, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(id);
      const key = userChatKey(session.userId, session.chatId);
      if (lastByUserChat.get(key) === id) lastByUserChat.delete(key);
    }
  }
}

function newWorkspaceId() {
  return `cws_${crypto.randomBytes(8).toString('hex')}`;
}

function createSession(opts = {}) {
  sweepExpired();
  const userId = String(opts.userId || '');
  if (!userId) return publicError('E_PARAMS', 'Falta el usuario.');
  const sandbox = opts.sandbox || createMemorySandbox(opts.files || {}, { execImpl: opts.execImpl });
  const originals = {};
  const snap = typeof sandbox.snapshot === 'function' ? sandbox.snapshot() : { ...(opts.files || {}) };
  for (const [k, v] of Object.entries(snap)) originals[k] = v;
  const id = String(opts.id || newWorkspaceId());
  const session = {
    id,
    userId,
    chatId: opts.chatId ? String(opts.chatId) : '',
    owner: opts.owner,
    repo: opts.repo,
    fullName: opts.fullName,
    defaultBranch: opts.defaultBranch || 'main',
    baseSha: opts.baseSha || null,
    baseTreeSha: opts.baseTreeSha || null,
    htmlUrl: opts.htmlUrl || null,
    brandLabel: opts.brandLabel || 'Sira Rápido',
    createdAt: Date.now(),
    sandbox,
    originals,
    truncated: Boolean(opts.truncated),
  };
  sessions.set(id, session);
  lastByUserChat.set(userChatKey(userId, session.chatId), id);
  return { ok: true, session };
}

function getSession({ workspaceId, userId, chatId } = {}) {
  sweepExpired();
  const uid = String(userId || '');
  if (!uid) return publicError('E_PARAMS', 'Falta el usuario.');
  let id = workspaceId ? String(workspaceId) : '';
  if (!id) id = lastByUserChat.get(userChatKey(uid, chatId || '')) || '';
  if (!id) {
    return publicError(
      'E_PARAMS',
      'No hay un repo abierto en este chat. Pide primero «abre owner/repo» o usa github_open_repo.',
    );
  }
  const session = sessions.get(id);
  if (!session || session.userId !== uid) {
    return publicError('E_PARAMS', 'Workspace no encontrado o no te pertenece.');
  }
  return { ok: true, session };
}

function changedFiles(session) {
  const current = session.sandbox.snapshot();
  const originals = session.originals || {};
  const changed = {};
  for (const [rel, content] of Object.entries(current)) {
    if (originals[rel] !== content) changed[rel] = content;
  }
  return changed;
}

function clearSessions() {
  sessions.clear();
  lastByUserChat.clear();
}

function sessionPublicView(session) {
  const snap = session.sandbox.snapshot();
  return {
    workspaceId: session.id,
    owner: session.owner,
    repo: session.repo,
    fullName: session.fullName,
    defaultBranch: session.defaultBranch,
    fileCount: Object.keys(snap).length,
    files: Object.keys(snap).sort().slice(0, 80),
    htmlUrl: session.htmlUrl,
    brandLabel: session.brandLabel,
    truncated: session.truncated,
    flagRequired: false,
  };
}

module.exports = {
  WORKSPACE_ROOT,
  MAX_FILE_BYTES,
  MAX_FILES,
  SESSION_TTL_MS,
  jailRelPath,
  createMemorySandbox,
  sanitizedExecEnv,
  createSession,
  getSession,
  changedFiles,
  clearSessions,
  sessionPublicView,
  userChatKey,
  publicError,
};
