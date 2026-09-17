'use strict';

/**
 * agentes-coding/git — per-session init / status / diff / checkpoint.
 *
 * Argv-only runner + in-process store. Injectable runner for tests.
 * No monorepo dump. Flag: AGENTES_CODING_V2 (default OFF).
 *
 * See docs/agentes-coding-git.md
 */

const { isAgentesCodingV2Enabled } = require('../flags');
const { fail, CodingSandboxError } = require('../coding-sandbox/errors');
const { jailRelPath } = require('../coding-sandbox/path-jail');
const {
  MAX_MESSAGE_CHARS,
  buildGitArgv,
  parsePorcelain,
  parseLog,
  parseSha,
  validateMessage,
  validateSha,
  createGitRunner,
  invokeRunner,
} = require('./runner');
const memory = require('./memory');

function requireEnabled(env = process.env) {
  if (!isAgentesCodingV2Enabled(env)) fail('E_FLAG_OFF');
}

async function requireSession(sandbox, sessionId) {
  if (!sandbox || typeof sandbox.listFiles !== 'function') {
    fail('E_PARAMS', 'Falta el sandbox de la sesión.');
  }
  await sandbox.listFiles(sessionId, '.');
  const raw = typeof sandbox._unsafeGetRaw === 'function'
    ? sandbox._unsafeGetRaw(sessionId)
    : null;
  if (!raw) fail('E_SESSION_NOT_FOUND');
  return raw;
}

function pickRunner(opts = {}) {
  if (typeof opts.runner === 'function') return opts.runner;
  if (opts.gitRunner && typeof opts.gitRunner === 'function') return opts.gitRunner;
  return null;
}

async function initSession(sandbox, sessionId, opts = {}) {
  const raw = await requireSession(sandbox, sessionId);
  const run = pickRunner(opts);
  if (run) {
    const out = await invokeRunner(run, 'init', opts);
    return {
      ok: true,
      initialized: true,
      already: false,
      branch: String(opts.branch || 'main'),
      argv: out.argv,
    };
  }
  return memory.initStore(memory.getStore(raw), opts);
}

async function statusSession(sandbox, sessionId, opts = {}) {
  const raw = await requireSession(sandbox, sessionId);
  const run = pickRunner(opts);
  if (run) {
    const out = await invokeRunner(run, 'status', opts);
    const files = parsePorcelain(out.stdout);
    return {
      ok: true,
      initialized: true,
      branch: String(opts.branch || 'main'),
      clean: files.length === 0,
      files,
    };
  }
  return memory.statusStore(sandbox, sessionId, memory.getStore(raw), opts);
}

async function diffSession(sandbox, sessionId, opts = {}) {
  if (opts.path) jailRelPath(opts.path);
  const raw = await requireSession(sandbox, sessionId);
  const run = pickRunner(opts);
  if (run) {
    const out = await invokeRunner(run, 'diff', opts);
    return {
      ok: true,
      initialized: true,
      patch: String(out.stdout || ''),
      files: parsePorcelain(out.stdout).length
        ? parsePorcelain(out.stdout)
        : guessFilesFromPatch(out.stdout),
    };
  }
  return memory.diffStore(sandbox, sessionId, memory.getStore(raw), opts);
}

function guessFilesFromPatch(patch) {
  const files = [];
  const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let m;
  while ((m = re.exec(String(patch || '')))) {
    try {
      files.push({ path: jailRelPath(m[2] || m[1]), status: 'M' });
    } catch {
      /* skip escaped */
    }
  }
  return files;
}

async function checkpointSession(sandbox, sessionId, opts = {}) {
  validateMessage(opts.message);
  const raw = await requireSession(sandbox, sessionId);
  const run = pickRunner(opts);
  if (run) {
    await invokeRunner(run, 'add', opts);
    await invokeRunner(run, 'commit', opts);
    const head = await invokeRunner(run, 'rev-parse', opts);
    const sha = parseSha(head.stdout);
    return {
      ok: true,
      checkpoint: {
        sha,
        message: String(opts.message).trim(),
        createdAt: Date.now(),
        filesChanged: null,
        parent: null,
      },
    };
  }
  return memory.checkpointStore(sandbox, sessionId, memory.getStore(raw), opts);
}

async function listCheckpoints(sandbox, sessionId, opts = {}) {
  const raw = await requireSession(sandbox, sessionId);
  const run = pickRunner(opts);
  if (run) {
    const out = await invokeRunner(run, 'log', opts);
    return { ok: true, initialized: true, checkpoints: parseLog(out.stdout) };
  }
  return memory.listStore(memory.getStore(raw));
}

async function getCheckpoint(sandbox, sessionId, sha, opts = {}) {
  const id = validateSha(sha);
  const raw = await requireSession(sandbox, sessionId);
  const run = pickRunner(opts);
  if (run) {
    try {
      const out = await invokeRunner(run, 'show', { ...opts, sha: id });
      const log = parseLog(out.stdout);
      if (!log.length) fail('E_CHECKPOINT_NOT_FOUND');
      return { ok: true, checkpoint: log[0], patch: String(out.stdout || '') };
    } catch (err) {
      if (err instanceof CodingSandboxError && err.code === 'E_GIT_FAILED') {
        fail('E_CHECKPOINT_NOT_FOUND');
      }
      throw err;
    }
  }
  return memory.getStoreCheckpoint(memory.getStore(raw), id);
}

function forget(sandbox, sessionId) {
  const raw = sandbox && typeof sandbox._unsafeGetRaw === 'function'
    ? sandbox._unsafeGetRaw(sessionId)
    : null;
  if (raw && raw.git) raw.git = memory.emptyStore();
}

async function initForRequest(sandbox, sessionId, opts, env, extras = {}) {
  requireEnabled(env);
  return initSession(sandbox, sessionId, { ...opts, env, runner: extras.runner || (opts && opts.runner) });
}

async function statusForRequest(sandbox, sessionId, opts, env, extras = {}) {
  requireEnabled(env);
  return statusSession(sandbox, sessionId, { ...opts, env, runner: extras.runner || (opts && opts.runner) });
}

async function diffForRequest(sandbox, sessionId, opts, env, extras = {}) {
  requireEnabled(env);
  return diffSession(sandbox, sessionId, { ...opts, env, runner: extras.runner || (opts && opts.runner) });
}

async function checkpointForRequest(sandbox, sessionId, opts, env, extras = {}) {
  requireEnabled(env);
  return checkpointSession(sandbox, sessionId, { ...opts, env, runner: extras.runner || (opts && opts.runner) });
}

async function listForRequest(sandbox, sessionId, opts, env, extras = {}) {
  requireEnabled(env);
  return listCheckpoints(sandbox, sessionId, { ...opts, env, runner: extras.runner || (opts && opts.runner) });
}

async function getForRequest(sandbox, sessionId, sha, opts, env, extras = {}) {
  requireEnabled(env);
  return getCheckpoint(sandbox, sessionId, sha, { ...opts, env, runner: extras.runner || (opts && opts.runner) });
}

module.exports = {
  MAX_MESSAGE_CHARS,
  requireEnabled,
  initSession,
  statusSession,
  diffSession,
  checkpointSession,
  listCheckpoints,
  getCheckpoint,
  forget,
  initForRequest,
  statusForRequest,
  diffForRequest,
  checkpointForRequest,
  listForRequest,
  getForRequest,
  createGitRunner,
  buildGitArgv,
  parsePorcelain,
  parseLog,
  CodingSandboxError,
};
