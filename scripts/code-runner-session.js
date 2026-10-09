'use strict';

const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { existsSync, realpathSync, statSync } = require('node:fs');
const path = require('node:path');

const root = realpathSync(process.env.SIRA_SESSION_ROOT || process.cwd());
const allowedBins = new Set(['git', 'bun', 'bunx', 'node', 'npm', 'ls', 'cat', 'wc']);
const sensitiveEnvKey = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|(?:^|[_-])KEY(?:$|[_-])|CREDENTIAL|AUTHORIZATION|OAUTH|COOKIE|SESSION|DATABASE[_-]?URL|REDIS[_-]?URL|SSH[_-]?)/i;
const envKey = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const explicitEnv = new Set();
const relativePath = (candidate, cwd) => {
  const resolved = path.resolve(cwd, String(candidate || '.'));
  const rel = path.relative(root, resolved);
  if (rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))) return resolved;
  return null;
};

let cwd = root;
const env = { ...process.env };

function output(stream, cap = 30_000) {
  return new Promise((resolve) => {
    let value = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      if (value.length < cap) value += chunk.slice(0, cap - value.length);
    });
    stream.on('end', () => resolve(value.slice(0, cap)));
  });
}

function killTree(child) {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  const timer = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }, 500);
  timer.unref?.();
}

async function execute(message) {
  const cmd = message.cmd;
  if (!Array.isArray(cmd) || !cmd.length || !cmd.every((part) => typeof part === 'string')) {
    return { ok: false, error: 'invalid_command' };
  }
  if (cmd[0] === 'cd') {
    if (cmd.length !== 2) return { ok: false, error: 'invalid_cd' };
    const next = relativePath(cmd[1], cwd);
    if (!next || !existsSync(next) || !statSync(next).isDirectory()) return { ok: false, error: 'directory_not_found' };
    cwd = realpathSync(next);
  return { ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', cwd, envKeys: [...explicitEnv].sort() };
  }
  if (cmd[0] === 'export') {
    const assignment = String(cmd[1] || '');
    const split = assignment.indexOf('=');
    const key = split > 0 ? assignment.slice(0, split) : '';
    if (cmd.length !== 2 || !envKey.test(key) || sensitiveEnvKey.test(key) || (!key.startsWith('SIRA_') && !key.startsWith('VIRTUAL_ENV'))) return { ok: false, error: 'invalid_env' };
    env[key] = assignment.slice(split + 1);
    explicitEnv.add(key);
  return { ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', cwd, envKeys: [...explicitEnv].sort() };
  }
  if (!allowedBins.has(cmd[0])) return { ok: false, error: 'invalid_command' };

  const child = spawn(cmd[0], cmd.slice(1), { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdoutPromise = output(child.stdout);
  const stderrPromise = output(child.stderr);
  let timedOut = false;
  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) { timedOut = true; killTree(child); }
  }, Math.max(1_000, Number(message.timeoutMs) || 30_000));
  const exitCode = await new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve(typeof code === 'number' ? code : signal ? 1 : 0));
    child.once('error', () => resolve(1));
  });
  settled = true;
  clearTimeout(timer);
  return { ok: !timedOut && exitCode === 0, exitCode, timedOut, stdout: await stdoutPromise, stderr: await stderrPromise, cwd, envKeys: [...explicitEnv].sort() };
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdout.write(JSON.stringify({ type: 'ready', cwd }) + '\n');
let chain = Promise.resolve();
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  chain = chain.then(async () => {
    const result = await execute(message);
    process.stdout.write(JSON.stringify({ id: message.id, ...result }) + '\n');
  }).catch((error) => {
    process.stdout.write(JSON.stringify({ id: message.id, ok: false, error: 'session_failed', detail: String(error.message || error).slice(0, 200) }) + '\n');
  });
});
