'use strict';

/**
 * Thin injectable wrapper around the ast-grep (`sg`) CLI.
 *
 * Never dumps the ast-grep monorepo. Never passes `--update-all` —
 * the binary is search/preview only. Writes go through sandbox.writeFile.
 *
 * MIT: https://github.com/ast-grep/ast-grep
 */

const { spawn } = require('node:child_process');
const { fail } = require('../coding-sandbox/errors');
const { DEFAULT_TIMEOUT_MS, normalizeLang } = require('./patterns');

const DEFAULT_BINARIES = Object.freeze(['sg', 'ast-grep']);

function buildSgArgv({ pattern, rewrite, lang, paths } = {}) {
  const language = normalizeLang(lang, { required: true });
  const argv = ['--json', '--lang', language, '-p', String(pattern)];
  if (rewrite != null && rewrite !== '') {
    argv.push('-r', String(rewrite));
  }
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  for (const p of list) argv.push(String(p));
  if (argv.includes('--update-all') || argv.includes('--update') || argv.includes('-U')) {
    fail('E_STRUCT_EDIT_FAILED', 'La invocación intentó escribir fuera del camino explícito.');
  }
  return argv;
}

function parseSgJson(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return normalizeMatches(parsed);
  } catch {
    const matches = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        matches.push(...normalizeMatches(JSON.parse(trimmed)));
      } catch {
        fail('E_STRUCT_EDIT_FAILED', 'La salida de ast-grep no es JSON válido.');
      }
    }
    return matches;
  }
}

function normalizeMatches(parsed) {
  if (parsed == null) return [];
  if (Array.isArray(parsed)) return parsed.map(normalizeOneMatch).filter(Boolean);
  if (typeof parsed === 'object') {
    if (Array.isArray(parsed.matches)) return parsed.matches.map(normalizeOneMatch).filter(Boolean);
    const one = normalizeOneMatch(parsed);
    return one ? [one] : [];
  }
  return [];
}

function normalizeOneMatch(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const file = raw.file || raw.path || raw.filename;
  if (!file) return null;
  const range = raw.range || {};
  const byte = range.byteOffset || {};
  const start = Number.isInteger(raw.start)
    ? raw.start
    : Number.isInteger(byte.start)
      ? byte.start
      : undefined;
  const end = Number.isInteger(raw.end)
    ? raw.end
    : Number.isInteger(byte.end)
      ? byte.end
      : undefined;
  return {
    path: String(file),
    text: raw.text != null ? String(raw.text) : (raw.lines != null ? String(raw.lines) : ''),
    replacement: raw.replacement != null ? String(raw.replacement) : undefined,
    start,
    end,
    language: raw.language || raw.lang || undefined,
  };
}

function spawnExec(argv, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const cwd = opts.cwd || process.cwd();
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: { PATH: process.env.PATH || '', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      const err = new Error('timeout');
      err.code = 'E_TIMEOUT';
      reject(err);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 1_000_000) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code == null ? 1 : code,
      });
    });
  });
}

function resolveBinary(env = process.env, candidates = DEFAULT_BINARIES) {
  const pinned = String(env.AGENTES_CODING_SG_BIN || '').trim();
  if (pinned) return pinned;
  return candidates[0] || 'sg';
}

/**
 * @param {object} [opts]
 * @param {(argv: string[], spawnOpts: object) => Promise<{stdout:string,stderr:string,exitCode:number}>} [opts.exec]
 * @param {string} [opts.binary]
 * @param {NodeJS.ProcessEnv} [opts.env]
 */
function createSgRunner(opts = {}) {
  const env = opts.env || process.env;
  const exec = typeof opts.exec === 'function' ? opts.exec : spawnExec;
  const binary = opts.binary || resolveBinary(env);

  return async function run(input = {}) {
    const argv = buildSgArgv(input);
    const spawnArgv = [binary, ...argv];
    let out;
    try {
      out = await exec(spawnArgv, {
        cwd: input.cwd,
        timeoutMs: input.timeoutMs || DEFAULT_TIMEOUT_MS,
      });
    } catch (err) {
      if (err && err.code === 'E_TIMEOUT') fail('E_TIMEOUT');
      if (err && (err.code === 'ENOENT' || /ENOENT/.test(String(err.message || '')))) {
        fail('E_STRUCT_EDIT_FAILED', 'No está disponible ast-grep (sg) en el sandbox.');
      }
      fail('E_STRUCT_EDIT_FAILED', err && err.message ? String(err.message) : undefined);
    }
    if (!out) fail('E_STRUCT_EDIT_FAILED');
    if (out.timedOut) fail('E_TIMEOUT');
    let matches;
    try {
      matches = Array.isArray(out.matches) ? out.matches.map(normalizeOneMatch).filter(Boolean) : parseSgJson(out.stdout);
    } catch (err) {
      if (err && err.code === 'E_STRUCT_EDIT_FAILED') throw err;
      fail('E_STRUCT_EDIT_FAILED', 'La salida de ast-grep no es JSON válido.');
    }
    return {
      ok: (out.exitCode ?? 0) === 0 || matches.length >= 0,
      exitCode: out.exitCode ?? 0,
      stdout: String(out.stdout || ''),
      stderr: String(out.stderr || ''),
      matches,
      argv: spawnArgv,
    };
  };
}

module.exports = {
  DEFAULT_BINARIES,
  buildSgArgv,
  parseSgJson,
  normalizeMatches,
  resolveBinary,
  createSgRunner,
  spawnExec,
};
