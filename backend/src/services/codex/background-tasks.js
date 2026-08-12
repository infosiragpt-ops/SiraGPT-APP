'use strict';

const crypto = require('node:crypto');

const TASK_ID_RE = /^task_[a-f0-9]{24}$/;
const ALLOWED_BINS = new Set(['git', 'bun', 'bunx', 'node', 'npm', 'ls', 'cat', 'wc']);
const INTERACTIVE_SCAFFOLD_RE = /^(?:create-next-app|create-vite|create-react-app|create-remix)(?:@.*)?$/i;
const DEFAULT_MAX_TASKS = 4;
const MAX_TASKS_HARD_CAP = 16;
const DEFAULT_TASK_TIMEOUT_MS = 2 * 60 * 60_000;
const MAX_TASK_TIMEOUT_MS = 24 * 60 * 60_000;
const DEFAULT_RETENTION_MS = 60 * 60_000;
const MAX_COMMAND_ARGS = 128;
const MAX_COMMAND_CHARS = 32_000;

const SUPERVISOR_SOURCE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const payload = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
const taskId = String(payload.taskId || '');
if (!/^task_[a-f0-9]{24}$/.test(taskId)) process.exit(64);
const root = path.join(process.cwd(), '.sira', 'tasks');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const metaPath = path.join(root, taskId + '.json');
const logPath = path.join(root, taskId + '.log');
function processStart(pid) {
  try {
    const row = fs.readFileSync('/proc/' + Number(pid) + '/stat', 'utf8');
    const rest = row.slice(row.lastIndexOf(')') + 2).trim().split(/\s+/);
    return rest[19] || null;
  } catch { return null; }
}
function controlProof(pid, start) {
  return crypto.createHmac('sha256', String(payload.controlToken || ''))
    .update([taskId, Number(pid), payload.startedAt, String(start || '')].join('|'))
    .digest('hex');
}
function writeMeta(patch) {
  let current = {};
  try { current = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
  const start = processStart(process.pid);
  const next = {
    ...current,
    ...patch,
    taskId,
    pid: process.pid,
    processStart: start,
    controlProof: controlProof(process.pid, start),
    updatedAt: new Date().toISOString(),
  };
  const temp = metaPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(temp, metaPath);
}
const logFd = fs.openSync(logPath, 'a', 0o600);
let child = null;
let stopReason = null;
let settled = false;
let killTimer = null;
function requestStop(reason) {
  if (settled || stopReason) return;
  stopReason = reason;
  writeMeta({ status: reason === 'timeout' ? 'timing_out' : 'stopping' });
  try { if (child && child.pid) child.kill('SIGTERM'); } catch {}
  killTimer = setTimeout(() => {
    try { if (child && child.pid) child.kill('SIGKILL'); } catch {}
  }, 4000);
  if (killTimer.unref) killTimer.unref();
}
process.on('SIGTERM', () => requestStop('stopped'));
process.on('SIGINT', () => requestStop('stopped'));
writeMeta({
  status: 'running',
  startedAt: payload.startedAt,
  timeoutMs: payload.timeoutMs,
  command: payload.cmd,
  logPath: '.sira/tasks/' + taskId + '.log',
});
try {
  child = spawn(payload.cmd[0], payload.cmd.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    detached: false,
    stdio: ['ignore', logFd, logFd],
  });
} catch (error) {
  settled = true;
  writeMeta({ status: 'failed', error: String(error.message || error).slice(0, 500), finishedAt: new Date().toISOString() });
  fs.closeSync(logFd);
  process.exit(1);
}
const timeout = setTimeout(() => requestStop('timeout'), payload.timeoutMs);
if (timeout.unref) timeout.unref();
child.on('error', (error) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);
  writeMeta({ status: 'failed', error: String(error.message || error).slice(0, 500), finishedAt: new Date().toISOString() });
  try { fs.closeSync(logFd); } catch {}
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);
  const status = stopReason === 'timeout'
    ? 'timed_out'
    : (stopReason ? 'stopped' : (code === 0 ? 'completed' : 'failed'));
  writeMeta({ status, exitCode: code, signal: signal || null, finishedAt: new Date().toISOString() });
  try { fs.closeSync(logFd); } catch {}
  process.exit(0);
});
`;

const LAUNCHER_SOURCE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const payload = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
const supervisorSource = Buffer.from(payload.supervisorSource, 'base64').toString('utf8');
const taskPayload = Buffer.from(JSON.stringify(payload.task), 'utf8').toString('base64');
const root = path.join(process.cwd(), '.sira', 'tasks');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const proc = spawn(process.execPath, ['-e', supervisorSource, taskPayload], {
  cwd: process.cwd(),
  env: process.env,
  detached: true,
  stdio: 'ignore',
});
proc.unref();
function processStart(pid) {
  try {
    const row = fs.readFileSync('/proc/' + Number(pid) + '/stat', 'utf8');
    const rest = row.slice(row.lastIndexOf(')') + 2).trim().split(/\s+/);
    return rest[19] || null;
  } catch { return null; }
}
const procStart = processStart(proc.pid);
const controlProof = crypto.createHmac('sha256', String(payload.task.controlToken || ''))
  .update([payload.task.taskId, Number(proc.pid), payload.task.startedAt, String(procStart || '')].join('|'))
  .digest('hex');
const meta = {
  taskId: payload.task.taskId,
  pid: proc.pid,
  processStart: procStart,
  controlProof,
  status: 'starting',
  startedAt: payload.task.startedAt,
  updatedAt: new Date().toISOString(),
  timeoutMs: payload.task.timeoutMs,
  command: payload.task.cmd,
  logPath: '.sira/tasks/' + payload.task.taskId + '.log',
};
const metaPath = path.join(root, payload.task.taskId + '.json');
const temp = metaPath + '.' + process.pid + '.tmp';
fs.writeFileSync(temp, JSON.stringify(meta), { mode: 0o600 });
fs.renameSync(temp, metaPath);
process.stdout.write(JSON.stringify(meta));
`;

const CONTROL_SOURCE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const payload = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
const root = path.join(process.cwd(), '.sira', 'tasks');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const terminal = new Set(['completed', 'failed', 'stopped', 'timed_out', 'lost']);
function safeId(value) {
  const id = String(value || '');
  if (!/^task_[a-f0-9]{24}$/.test(id)) throw new Error('invalid_task_id');
  return id;
}
function pathsFor(id) {
  return { meta: path.join(root, id + '.json'), log: path.join(root, id + '.log') };
}
function atomicWrite(file, value) {
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function isAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
function processStart(pid) {
  try {
    const row = fs.readFileSync('/proc/' + Number(pid) + '/stat', 'utf8');
    const rest = row.slice(row.lastIndexOf(')') + 2).trim().split(/\s+/);
    return rest[19] || null;
  } catch { return null; }
}
function verifyControl(meta) {
  if (!payload.controlToken || Number(meta.pid) !== Number(payload.expectedPid)) throw new Error('untrusted_task_metadata');
  if (String(meta.startedAt || '') !== String(payload.expectedStartedAt || '')) throw new Error('untrusted_task_metadata');
  if (String(meta.processStart || '') !== String(payload.expectedProcessStart || '')) throw new Error('untrusted_task_metadata');
  const liveStart = processStart(meta.pid);
  if (String(liveStart || '') !== String(payload.expectedProcessStart || '')) throw new Error('task_process_identity_changed');
  const expected = crypto.createHmac('sha256', String(payload.controlToken))
    .update([meta.taskId, Number(meta.pid), meta.startedAt, String(meta.processStart || '')].join('|'))
    .digest('hex');
  const actual = String(meta.controlProof || '');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
    throw new Error('untrusted_task_metadata');
  }
}
function load(id) {
  const files = pathsFor(id);
  const meta = JSON.parse(fs.readFileSync(files.meta, 'utf8'));
  if (!terminal.has(meta.status) && !isAlive(meta.pid)) {
    meta.status = 'lost';
    meta.finishedAt = new Date().toISOString();
    meta.updatedAt = meta.finishedAt;
    atomicWrite(files.meta, meta);
  }
  return { meta, files };
}
function listAndClean() {
  const now = Date.now();
  const tasks = [];
  for (const entry of fs.readdirSync(root)) {
    if (!/^task_[a-f0-9]{24}\.json$/.test(entry)) continue;
    const id = entry.slice(0, -5);
    try {
      const loaded = load(id);
      const stamp = Date.parse(loaded.meta.finishedAt || loaded.meta.updatedAt || loaded.meta.startedAt || 0);
      if (terminal.has(loaded.meta.status) && Number.isFinite(stamp) && now - stamp > payload.retentionMs) {
        try { fs.unlinkSync(loaded.files.meta); } catch {}
        try { fs.unlinkSync(loaded.files.log); } catch {}
        continue;
      }
      tasks.push(loaded.meta);
    } catch {}
  }
  tasks.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  return tasks;
}
let result;
if (payload.op === 'list' || payload.op === 'cleanup') {
  const tasks = listAndClean();
  result = { tasks, active: tasks.filter((task) => !terminal.has(task.status)).length };
} else if (payload.op === 'logs') {
  const id = safeId(payload.taskId);
  const loaded = load(id);
  let log = '';
  try {
    const stat = fs.statSync(loaded.files.log);
    const size = Math.min(stat.size, payload.tailBytes);
    const fd = fs.openSync(loaded.files.log, 'r');
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size));
    fs.closeSync(fd);
    log = buffer.toString('utf8');
  } catch {}
  result = { task: loaded.meta, log };
} else if (payload.op === 'stop') {
  const id = safeId(payload.taskId);
  const loaded = load(id);
  if (!terminal.has(loaded.meta.status)) {
    verifyControl(loaded.meta);
    // Persist the control-plane intent before signalling. The supervisor can
    // finish very quickly after SIGTERM and atomically write "stopped"; writing
    // "stopping" afterwards would resurrect that terminal task. A later list
    // would then see a dead PID and incorrectly downgrade it to "lost".
    loaded.meta.status = 'stopping';
    loaded.meta.updatedAt = new Date().toISOString();
    atomicWrite(loaded.files.meta, loaded.meta);
    try { process.kill(-Number(loaded.meta.pid), 'SIGTERM'); } catch {
      try { process.kill(Number(loaded.meta.pid), 'SIGTERM'); } catch {}
    }
  }
  result = { task: loaded.meta };
} else {
  throw new Error('invalid_operation');
}
process.stdout.write(JSON.stringify(result));
`;

function boundedInteger(value, fallback, min, max) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function validateBackgroundCommand(cmd) {
  if (!Array.isArray(cmd) || !cmd.length || !cmd.every((part) => typeof part === 'string')) {
    return { ok: false, error: 'cmd debe ser un array no vacío de strings' };
  }
  if (cmd.length > MAX_COMMAND_ARGS || cmd.reduce((total, part) => total + part.length, 0) > MAX_COMMAND_CHARS) {
    return { ok: false, error: 'cmd excede el límite seguro de argumentos' };
  }
  if (!ALLOWED_BINS.has(cmd[0])) {
    return { ok: false, error: `comando no permitido: ${cmd[0] || '(vacío)'}` };
  }
  if (
    (cmd[0] === 'bunx' && INTERACTIVE_SCAFFOLD_RE.test(cmd[1] || ''))
    || (cmd[0] === 'bun' && cmd[1] === 'create')
  ) {
    return { ok: false, error: 'los scaffolds interactivos no se ejecutan en background' };
  }
  return { ok: true, cmd: [...cmd] };
}

function encodePayload(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function parseJsonOutput(out, label) {
  if (!out || out.exitCode !== 0) {
    throw new Error(`${label} falló: ${String(out?.stderr || out?.stdout || `exit ${out?.exitCode}`).slice(0, 800)}`);
  }
  try {
    return JSON.parse(String(out.stdout || '').trim());
  } catch {
    throw new Error(`${label} devolvió una respuesta inválida`);
  }
}

async function launchWithRunner({ runner, project, task }) {
  const payload = {
    supervisorSource: Buffer.from(SUPERVISOR_SOURCE, 'utf8').toString('base64'),
    task,
  };
  const out = await runner.exec(project, ['node', '-e', LAUNCHER_SOURCE, encodePayload(payload)], { timeoutMs: 10_000 });
  return parseJsonOutput(out, 'inicio de tarea');
}

async function controlWithRunner({
  runner,
  project,
  op,
  taskId,
  tailBytes = 20_000,
  retentionMs = DEFAULT_RETENTION_MS,
  controlToken = null,
  expectedPid = null,
  expectedStartedAt = null,
  expectedProcessStart = null,
}) {
  const payload = {
    op,
    ...(taskId ? { taskId } : {}),
    tailBytes: boundedInteger(tailBytes, 20_000, 1_000, 30_000),
    retentionMs: boundedInteger(retentionMs, DEFAULT_RETENTION_MS, 60_000, 24 * 60 * 60_000),
    ...(controlToken ? {
      controlToken,
      expectedPid,
      expectedStartedAt,
      expectedProcessStart,
    } : {}),
  };
  const out = await runner.exec(project, ['node', '-e', CONTROL_SOURCE, encodePayload(payload)], { timeoutMs: 10_000 });
  return parseJsonOutput(out, `control de tarea (${op})`);
}

function createBackgroundTaskService({
  launchImpl = launchWithRunner,
  controlImpl = controlWithRunner,
} = {}) {
  const workspaceLocks = new Map();
  const taskRegistry = new Map();
  const taskKey = (project, taskId) => `${String(project || '')}:${String(taskId || '')}`;

  async function withWorkspaceLock(project, operation) {
    const key = String(project || '');
    const previous = workspaceLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queued = previous.catch(() => {}).then(() => gate);
    workspaceLocks.set(key, queued);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (workspaceLocks.get(key) === queued) workspaceLocks.delete(key);
    }
  }

  return {
    async start({ runner, project, cmd, timeoutMs, env = process.env }) {
      const checked = validateBackgroundCommand(cmd);
      if (!checked.ok) throw new Error(checked.error);
      return withWorkspaceLock(project, async () => {
        const maxTasks = boundedInteger(
          env.CODEX_BACKGROUND_TASKS_PER_WORKSPACE,
          DEFAULT_MAX_TASKS,
          1,
          MAX_TASKS_HARD_CAP,
        );
        const current = await controlImpl({ runner, project, op: 'list' });
        if (Number(current.active) >= maxTasks) {
          const error = new Error(`límite de tareas background alcanzado (${maxTasks})`);
          error.code = 'BACKGROUND_TASK_LIMIT';
          throw error;
        }
        const task = {
          taskId: `task_${crypto.randomBytes(12).toString('hex')}`,
          cmd: checked.cmd,
          startedAt: new Date().toISOString(),
          timeoutMs: boundedInteger(timeoutMs, DEFAULT_TASK_TIMEOUT_MS, 1_000, MAX_TASK_TIMEOUT_MS),
          controlToken: crypto.randomBytes(32).toString('hex'),
        };
        const launched = await launchImpl({ runner, project, task });
        if (
          !TASK_ID_RE.test(String(launched?.taskId || ''))
          || !Number.isSafeInteger(Number(launched?.pid))
          || Number(launched.pid) <= 1
        ) {
          throw new Error('background launcher returned invalid process identity');
        }
        taskRegistry.set(taskKey(project, task.taskId), {
          taskId: task.taskId,
          project: String(project || ''),
          pid: Number(launched.pid),
          startedAt: String(launched.startedAt || task.startedAt),
          processStart: launched.processStart == null ? null : String(launched.processStart),
          controlToken: task.controlToken,
        });
        const { controlProof: _controlProof, controlToken: _controlToken, ...publicTask } = launched;
        return publicTask;
      });
    },

    logs({ runner, project, taskId, tailBytes }) {
      if (!TASK_ID_RE.test(String(taskId || ''))) throw new Error('taskId inválido');
      return controlImpl({ runner, project, op: 'logs', taskId, tailBytes });
    },

    async watch({
      runner,
      project,
      taskId,
      onComplete,
      pollMs = 1_000,
      signal = null,
    }) {
      if (!TASK_ID_RE.test(String(taskId || ''))) throw new Error('taskId inválido');
      if (!taskRegistry.has(taskKey(project, taskId))) {
        const error = new Error('tarea background no confiable o perteneciente a otro proceso');
        error.code = 'BACKGROUND_TASK_UNTRUSTED';
        throw error;
      }
      const terminal = new Set(['completed', 'failed', 'stopped', 'timed_out', 'lost']);
      const interval = boundedInteger(pollMs, 1_000, 250, 10_000);
      let failures = 0;
      while (!signal?.aborted) {
        try {
          const current = await controlImpl({
            runner,
            project,
            op: 'logs',
            taskId,
            tailBytes: 8_000,
          });
          failures = 0;
          if (terminal.has(current?.task?.status)) {
            taskRegistry.delete(taskKey(project, taskId));
            if (typeof onComplete === 'function') {
              await Promise.resolve(onComplete(current)).catch(() => {});
            }
            return current;
          }
        } catch (error) {
          failures += 1;
          if (failures >= 5) {
            const current = {
              task: { taskId, status: 'lost' },
              log: '',
              error: String(error?.message || error).slice(0, 500),
            };
            if (typeof onComplete === 'function') {
              await Promise.resolve(onComplete(current)).catch(() => {});
            }
            return current;
          }
        }
        await new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, interval);
          if (typeof timer.unref === 'function') timer.unref();
          if (signal) signal.addEventListener('abort', finish, { once: true });
        });
      }
      return { task: { taskId, status: 'stopped' }, log: '' };
    },

    stop({ runner, project, taskId }) {
      if (!TASK_ID_RE.test(String(taskId || ''))) throw new Error('taskId inválido');
      const identity = taskRegistry.get(taskKey(project, taskId));
      if (!identity) {
        const error = new Error('tarea background no confiable o perteneciente a otro proceso');
        error.code = 'BACKGROUND_TASK_UNTRUSTED';
        throw error;
      }
      return controlImpl({
        runner,
        project,
        op: 'stop',
        taskId,
        controlToken: identity.controlToken,
        expectedPid: identity.pid,
        expectedStartedAt: identity.startedAt,
        expectedProcessStart: identity.processStart,
      });
    },

    async cleanup({ runner, project }) {
      const result = await controlImpl({ runner, project, op: 'cleanup' });
      const terminal = new Set(['completed', 'failed', 'stopped', 'timed_out', 'lost']);
      for (const task of result?.tasks || []) {
        if (terminal.has(task?.status)) taskRegistry.delete(taskKey(project, task.taskId));
      }
      return result;
    },

    async quiesce({ runner, project, waitMs = 2_500 } = {}) {
      const terminal = new Set(['completed', 'failed', 'stopped', 'timed_out', 'lost']);
      const listed = await controlImpl({ runner, project, op: 'list' });
      const active = (listed?.tasks || []).filter((task) => !terminal.has(task?.status));
      for (const task of active) {
        const identity = taskRegistry.get(taskKey(project, task.taskId));
        if (!identity) {
          return { ok: false, code: 'untrusted_background_task', taskId: task.taskId, active: active.length };
        }
        await controlImpl({
          runner,
          project,
          op: 'stop',
          taskId: task.taskId,
          controlToken: identity.controlToken,
          expectedPid: identity.pid,
          expectedStartedAt: identity.startedAt,
          expectedProcessStart: identity.processStart,
        });
      }
      const deadline = Date.now() + Math.max(100, Number(waitMs) || 2_500);
      while (Date.now() < deadline) {
        const current = await controlImpl({ runner, project, op: 'list' });
        const remaining = (current?.tasks || []).filter((task) => !terminal.has(task?.status));
        if (!remaining.length) return { ok: true, stopped: active.length };
        await new Promise((resolve) => { setTimeout(resolve, 50); });
      }
      return { ok: false, code: 'background_tasks_still_active', active: active.length };
    },
  };
}

const backgroundTaskService = createBackgroundTaskService();

module.exports = {
  backgroundTaskService,
  createBackgroundTaskService,
  validateBackgroundCommand,
  launchWithRunner,
  controlWithRunner,
  TASK_ID_RE,
  ALLOWED_BINS,
  DEFAULT_MAX_TASKS,
  MAX_TASKS_HARD_CAP,
  DEFAULT_TASK_TIMEOUT_MS,
  MAX_TASK_TIMEOUT_MS,
};
