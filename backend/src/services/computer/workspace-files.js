'use strict';

/**
 * Read/write/list/edit files on THIS chat's live computer.
 * All paths resolve under /workspace. Content never interpolates into bash.
 */

const path = require('path');
const { spawn } = require('child_process');

const WORKSPACE = '/workspace';
const MAX_BYTES = 256 * 1024;
const LIST_MAX = 200;

function assertWorkspacePath(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s.includes('\0')) {
    const err = new Error('Ruta de archivo inválida.');
    err.code = 'invalid_path';
    throw err;
  }
  const asAbs = s.startsWith('/') ? path.posix.normalize(s) : path.posix.normalize(path.posix.join(WORKSPACE, s));
  if (asAbs !== WORKSPACE && !asAbs.startsWith(`${WORKSPACE}/`)) {
    const err = new Error('Solo se puede editar dentro de /workspace.');
    err.code = 'path_escape';
    throw err;
  }
  if (asAbs.includes('/.') && /\/\.(?!\/|$)/.test(asAbs.replace(/\/\.$/, ''))) {
    /* allow .hidden files; still block .. which normalize already collapsed */
  }
  return asAbs;
}

function dockerTee(session, absPath, buf, { signal, timeoutMs = 20_000, spawnImpl, containerName } = {}) {
  const spawnFn = spawnImpl || spawn;
  const nameFn = containerName;
  const container = typeof nameFn === 'function' ? nameFn(session) : session.container || session.sessionId;
  const payload = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8');
  return new Promise((resolve, reject) => {
    const child = spawnFn(
      'docker',
      ['exec', '-i', '-u', 'compuser', String(container), 'tee', absPath],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      reject(Object.assign(new Error('timeout writing file'), { code: 'timeout' }));
    }, timeoutMs);
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { code: 'aborted' }));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve({ ok: true, bytes: payload.length, path: absPath });
      else reject(Object.assign(new Error(stderr.trim() || `tee exit ${code}`), { code: 'write_failed' }));
    });
    child.stdin.on('error', () => { /* EPIPE after kill */ });
    child.stdin.end(payload);
  });
}

function createWorkspaceFileApi({ persistent } = {}) {
  const api = persistent || require('./persistent');

  async function sessionFor(opts) {
    if (opts.session && api.containerName(opts.session)) return opts.session;
    return api.ensureSession({
      userId: opts.userId,
      conversationId: opts.conversationId,
      env: opts.env,
    });
  }

  async function listFiles({ path: rel = '', userId, conversationId, env, session, signal } = {}) {
    const sess = await sessionFor({ userId, conversationId, env, session });
    const root = rel ? assertWorkspacePath(rel) : WORKSPACE;
    const cmd = `find ${JSON.stringify(root)} -maxdepth 4 \\( -type f -o -type d \\) ! -path ${JSON.stringify(`${WORKSPACE}/.chrome*`)} ! -path ${JSON.stringify(`${WORKSPACE}/.cache*`)} -printf '%y %P\\n' | head -n ${LIST_MAX}`;
    const out = await api.dockerExec(sess, cmd, { signal, timeoutMs: 15_000 });
    const entries = String(out.stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const kind = line[0] === 'd' ? 'dir' : 'file';
        const name = line.slice(2).trim();
        return { kind, path: name || '.' };
      });
    return { ok: true, root: WORKSPACE, entries };
  }

  async function readFile({ path: rel, userId, conversationId, env, session, signal } = {}) {
    const abs = assertWorkspacePath(rel);
    const sess = await sessionFor({ userId, conversationId, env, session });
    const cmd = `python3 -c "import pathlib,sys; p=pathlib.Path(sys.argv[1]); data=p.read_bytes(); sys.stdout.buffer.write(data[:${MAX_BYTES}])" ${JSON.stringify(abs)}`;
    const out = await api.dockerExec(sess, cmd, { signal, timeoutMs: 15_000 });
    const text = String(out.stdout || '');
    return {
      ok: true,
      path: abs,
      truncated: Buffer.byteLength(text, 'utf8') >= MAX_BYTES,
      content: text,
    };
  }

  async function writeFile({ path: rel, content, userId, conversationId, env, session, signal, spawnImpl } = {}) {
    const abs = assertWorkspacePath(rel);
    const buf = Buffer.from(String(content ?? ''), 'utf8');
    if (buf.length > MAX_BYTES) {
      const err = new Error(`El archivo supera ${MAX_BYTES} bytes.`);
      err.code = 'too_large';
      throw err;
    }
    const sess = await sessionFor({ userId, conversationId, env, session });
    const dir = path.posix.dirname(abs);
    await api.dockerExec(sess, `mkdir -p ${JSON.stringify(dir)}`, { signal, timeoutMs: 10_000 });
    if (typeof api.dockerTee === 'function') {
      await api.dockerTee(sess, abs, buf, { signal });
    } else {
      await dockerTee(sess, abs, buf, { signal, spawnImpl, containerName: api.containerName });
    }
    try {
      await api.dockerExec(
        sess,
        `(command -v mousepad >/dev/null && mousepad ${JSON.stringify(abs)} || thunar ${JSON.stringify(dir)}) >/dev/null 2>&1 & echo opened`,
        { signal, timeoutMs: 5_000 },
      );
    } catch (_) { /* editor is best-effort; the write already succeeded */ }
    return { ok: true, path: abs, bytes: buf.length };
  }

  async function editFile({ path: rel, old_string: oldStr, new_string: newStr, userId, conversationId, env, session, signal, spawnImpl } = {}) {
    const needle = String(oldStr ?? '');
    if (!needle) {
      const err = new Error('computer_edit_file requiere old_string.');
      err.code = 'invalid_args';
      throw err;
    }
    const current = await readFile({ path: rel, userId, conversationId, env, session, signal });
    if (!current.content.includes(needle)) {
      const err = new Error('No encontré ese texto en el archivo.');
      err.code = 'not_found';
      throw err;
    }
    const next = current.content.replace(needle, String(newStr ?? ''));
    return writeFile({ path: rel, content: next, userId, conversationId, env, session, signal, spawnImpl });
  }

  return { assertWorkspacePath, listFiles, readFile, writeFile, editFile, WORKSPACE, MAX_BYTES };
}

module.exports = {
  WORKSPACE,
  MAX_BYTES,
  assertWorkspacePath,
  dockerTee,
  createWorkspaceFileApi,
};
