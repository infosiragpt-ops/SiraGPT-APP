'use strict';

/**
 * Thin injectable git runner (argv-only, no shell string).
 *
 * Never interpolates a command line. Writes stay inside the session
 * jail. MIT pattern only.
 *
 * See docs/agentes-coding-git.md
 */

const { fail } = require('../coding-sandbox/errors');
const { jailRelPath } = require('../coding-sandbox/path-jail');

const DEFAULT_TIMEOUT_MS = 15_000;
const ALLOWED_OPS = Object.freeze([
  'init',
  'status',
  'diff',
  'add',
  'commit',
  'rev-parse',
  'log',
  'show',
]);

const UNSAFE_ARG = /[;&|`$<>\\\n\r\0]/;
const BRANCH_RE = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
const MAX_MESSAGE_CHARS = 200;

function assertSafeArg(value, detail) {
  const s = String(value ?? '');
  if (!s || UNSAFE_ARG.test(s)) {
    fail('E_PARAMS', detail || 'Argumento git inválido.');
  }
  return s;
}

function validateBranch(raw) {
  const branch = String(raw || 'main').trim() || 'main';
  if (!BRANCH_RE.test(branch) || branch.startsWith('-') || branch.startsWith('/')) {
    fail('E_PARAMS', 'Nombre de rama inválido.');
  }
  return branch;
}

function validateMessage(raw) {
  const message = String(raw ?? '').trim();
  if (!message) fail('E_PARAMS', 'Falta el mensaje del punto de control.');
  if (message.length > MAX_MESSAGE_CHARS) {
    fail('E_PARAMS', `El mensaje supera ${MAX_MESSAGE_CHARS} caracteres.`);
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(message)) {
    fail('E_PARAMS', 'El mensaje contiene caracteres de control.');
  }
  if (UNSAFE_ARG.test(message)) {
    fail('E_PARAMS', 'El mensaje contiene caracteres no permitidos.');
  }
  return message;
}

function validateSha(raw, { required = true } = {}) {
  const sha = String(raw || '').trim().toLowerCase();
  if (!sha) {
    if (required) fail('E_PARAMS', 'Falta el SHA del punto de control.');
    return null;
  }
  if (!SHA_RE.test(sha)) fail('E_PARAMS', 'SHA de punto de control inválido.');
  return sha;
}

function buildGitArgv(op, opts = {}) {
  const name = String(op || '').trim();
  if (!ALLOWED_OPS.includes(name)) {
    fail('E_PARAMS', 'Operación git no permitida.');
  }
  if (name === 'init') {
    return ['init', '-b', validateBranch(opts.branch)];
  }
  if (name === 'status') {
    return ['status', '--porcelain=v1', '-uall'];
  }
  if (name === 'diff') {
    const argv = ['diff', '--no-color', '--no-ext-diff'];
    if (opts.from) argv.push(validateSha(opts.from));
    if (opts.to) argv.push(validateSha(opts.to));
    argv.push('--');
    if (opts.path) argv.push(jailRelPath(opts.path));
    return argv;
  }
  if (name === 'add') {
    return ['add', '-A'];
  }
  if (name === 'commit') {
    return [
      '-c', 'user.name=SiraGPT',
      '-c', 'user.email=coding@siragpt.local',
      'commit',
      '-m',
      validateMessage(opts.message),
      '--no-gpg-sign',
    ];
  }
  if (name === 'rev-parse') {
    return ['rev-parse', 'HEAD'];
  }
  if (name === 'log') {
    const limit = Number.isFinite(Number(opts.limit)) ? Math.max(1, Math.min(50, Number(opts.limit))) : 50;
    return ['log', '--format=%H%x00%s%x00%ct', '-n', String(limit)];
  }
  if (name === 'show') {
    return ['show', '--no-color', '--format=%H%x00%s%x00%ct', validateSha(opts.sha), '--'];
  }
  fail('E_PARAMS', 'Operación git no permitida.');
  return [];
}

function parsePorcelain(stdout) {
  const files = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line) continue;
    const match = line.match(/^(..)\s+(.*)$/);
    if (!match) continue;
    let rel;
    try {
      rel = jailRelPath(match[2]);
    } catch {
      continue;
    }
    const xy = match[1];
    const status = xy === '??' ? '??' : (xy.trim() || xy[1] || xy[0]);
    files.push({ path: rel, status });
  }
  return files;
}

function parseLog(stdout) {
  const out = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split('\u0000');
    if (parts.length < 2) continue;
    const sha = String(parts[0] || '').trim().toLowerCase();
    if (!SHA_RE.test(sha)) continue;
    const createdAt = Number(parts[2]) > 1e12
      ? Number(parts[2])
      : (Number(parts[2]) > 0 ? Number(parts[2]) * 1000 : Date.now());
    out.push({
      sha,
      message: String(parts[1] || '').trim(),
      createdAt,
    });
  }
  return out;
}

function parseSha(stdout) {
  const sha = String(stdout || '').trim().split(/\s/)[0].toLowerCase();
  if (!SHA_RE.test(sha)) fail('E_GIT_FAILED', 'La salida de git no trajo un SHA válido.');
  return sha;
}

function createGitRunner(opts = {}) {
  const exec = typeof opts.exec === 'function' ? opts.exec : null;
  if (typeof exec !== 'function' && typeof opts.runner === 'function') {
    return opts.runner;
  }

  return async function run(input = {}) {
    const argv = Array.isArray(input.argv) && input.argv.length
      ? input.argv.map((a) => assertSafeArg(a, 'Argumento git inválido.'))
      : buildGitArgv(input.op, input);
    if (!exec) {
      fail('E_GIT_FAILED', 'No hay un ejecutor git inyectable.');
    }
    let out;
    try {
      out = await exec({
        argv,
        cwd: input.cwd || '/workspace',
        timeoutMs: Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : DEFAULT_TIMEOUT_MS,
      });
    } catch (err) {
      if (err && err.code === 'E_TIMEOUT') fail('E_TIMEOUT');
      if (err && (err.code === 'ENOENT' || /ENOENT/.test(String(err.message || '')))) {
        fail('E_GIT_FAILED', 'No está disponible git en el sandbox.');
      }
      fail('E_GIT_FAILED', err && err.message ? String(err.message).slice(0, 160) : undefined);
    }
    if (!out) fail('E_GIT_FAILED');
    if (out.timedOut) fail('E_TIMEOUT');
    if ((out.exitCode ?? 0) !== 0 && !out.ok) {
      const detail = String(out.stderr || out.stdout || '').trim().slice(0, 160);
      fail('E_GIT_FAILED', detail || undefined);
    }
    return {
      ok: (out.exitCode ?? 0) === 0,
      exitCode: out.exitCode ?? 0,
      stdout: String(out.stdout || ''),
      stderr: String(out.stderr || ''),
      argv,
    };
  };
}

async function invokeRunner(run, op, opts = {}) {
  const argv = buildGitArgv(op, opts);
  let out;
  try {
    out = await run({ argv, op, ...opts });
  } catch (err) {
    if (err && err.code === 'E_TIMEOUT') fail('E_TIMEOUT');
    if (err && (err.code === 'ENOENT' || /ENOENT/.test(String(err.message || '')))) {
      fail('E_GIT_FAILED', 'No está disponible git en el sandbox.');
    }
    if (err && err.name === 'CodingSandboxError') throw err;
    fail('E_GIT_FAILED', err && err.message ? String(err.message).slice(0, 160) : undefined);
  }
  if (!out) fail('E_GIT_FAILED');
  if (out.timedOut || out.code === 'E_TIMEOUT') fail('E_TIMEOUT');
  return {
    ok: (out.exitCode ?? 0) === 0,
    exitCode: out.exitCode ?? 0,
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || ''),
    argv: out.argv || argv,
  };
}

module.exports = {
  ALLOWED_OPS,
  DEFAULT_TIMEOUT_MS,
  MAX_MESSAGE_CHARS,
  SHA_RE,
  buildGitArgv,
  parsePorcelain,
  parseLog,
  parseSha,
  validateBranch,
  validateMessage,
  validateSha,
  createGitRunner,
  invokeRunner,
};
