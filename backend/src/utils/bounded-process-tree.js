'use strict';

const { spawn } = require('node:child_process');

const DEFAULT_KILL_GRACE_MS = 250;
const DEFAULT_TREE_EXIT_TIMEOUT_MS = 2_000;
const DEFAULT_WINDOWS_KILL_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function boundedMilliseconds(value, fallback, maximum = 3_600_000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(parsed)));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processGroupAlive(pid, processKill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    processKill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function waitForProcessGroupExit(pid, timeoutMs, {
  processKill = process.kill.bind(process),
  pollMs = 20,
} = {}) {
  const deadline = Date.now() + boundedMilliseconds(
    timeoutMs,
    DEFAULT_TREE_EXIT_TIMEOUT_MS,
  );
  while (processGroupAlive(pid, processKill) && Date.now() < deadline) {
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  return !processGroupAlive(pid, processKill);
}

function signalProcessGroup(child, signal, processKill = process.kill.bind(process)) {
  if (!child?.pid) return false;
  try {
    processKill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return true;
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
}

async function runWindowsTreeKill(pid, {
  spawnImpl = spawn,
  timeoutMs = DEFAULT_WINDOWS_KILL_TIMEOUT_MS,
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timer;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };
    try {
      child = spawnImpl('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      finish(false);
      return;
    }
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0 || code === 128));
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(false);
    }, boundedMilliseconds(timeoutMs, DEFAULT_WINDOWS_KILL_TIMEOUT_MS));
  });
}

async function terminateProcessTree(child, {
  platform = process.platform,
  processKill = process.kill.bind(process),
  spawnImpl = spawn,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  treeExitTimeoutMs = DEFAULT_TREE_EXIT_TIMEOUT_MS,
  windowsKillTimeoutMs = DEFAULT_WINDOWS_KILL_TIMEOUT_MS,
} = {}) {
  if (!child?.pid) return true;
  if (platform === 'win32') {
    const killed = await runWindowsTreeKill(child.pid, {
      spawnImpl,
      timeoutMs: windowsKillTimeoutMs,
    });
    if (!killed) {
      try { child.kill('SIGKILL'); } catch {}
    }
    return killed;
  }

  signalProcessGroup(child, 'SIGTERM', processKill);
  const exitedGracefully = await waitForProcessGroupExit(child.pid, killGraceMs, {
    processKill,
  });
  if (exitedGracefully) return true;

  signalProcessGroup(child, 'SIGKILL', processKill);
  return waitForProcessGroupExit(child.pid, treeExitTimeoutMs, { processKill });
}

function abortedBeforeSpawnResult() {
  const error = new Error('Bounded process was aborted before spawn.');
  error.code = 'PROCESS_ABORTED';
  return {
    pid: null,
    status: null,
    signal: null,
    stdout: '',
    stderr: '',
    error,
    timedOut: false,
    aborted: true,
    outputLimitExceeded: false,
    treeTerminated: true,
  };
}

async function runBoundedProcessTree(command, args = [], options = {}) {
  const {
    cwd,
    env,
    input,
    signal,
    platform = process.platform,
    spawnImpl = spawn,
    processKill = process.kill.bind(process),
    timeoutMs,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    treeExitTimeoutMs = DEFAULT_TREE_EXIT_TIMEOUT_MS,
    windowsKillTimeoutMs = DEFAULT_WINDOWS_KILL_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    windowsHide = true,
  } = options;
  if (signal?.aborted) return abortedBeforeSpawnResult();

  const boundedTimeoutMs = boundedMilliseconds(timeoutMs, 30_000);
  const boundedMaxOutputBytes = Math.max(
    1,
    Math.min(Number(maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES, 64 * 1024 * 1024),
  );
  let child;
  try {
    child = spawnImpl(command, args, {
      cwd,
      env,
      detached: platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide,
    });
  } catch (error) {
    return {
      pid: null,
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error,
      timedOut: false,
      aborted: false,
      outputLimitExceeded: false,
      treeTerminated: true,
    };
  }

  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let outputLimitExceeded = false;
  let spawnError = null;
  let terminationReason = null;
  let terminationPromise = null;

  const requestTermination = (reason) => {
    if (terminationReason) return terminationPromise;
    terminationReason = reason;
    terminationPromise = terminateProcessTree(child, {
      platform,
      processKill,
      spawnImpl,
      killGraceMs,
      treeExitTimeoutMs,
      windowsKillTimeoutMs,
    }).catch(() => false);
    return terminationPromise;
  };

  const appendOutput = (target, chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const remaining = Math.max(0, boundedMaxOutputBytes - outputBytes);
    outputBytes += buffer.length;
    if (buffer.length > remaining) {
      outputLimitExceeded = true;
      requestTermination('output_limit');
    }
    return target + buffer.subarray(0, remaining).toString('utf8');
  };
  child.stdout?.on('data', (chunk) => {
    stdout = appendOutput(stdout, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = appendOutput(stderr, chunk);
  });

  const closePromise = new Promise((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code, childSignal) => {
      resolve({ code, childSignal });
    });
  });

  const timeout = setTimeout(
    () => requestTermination('timeout'),
    boundedTimeoutMs,
  );
  const onAbort = () => requestTermination('abort');
  signal?.addEventListener('abort', onAbort, { once: true });

  if (input === undefined || input === null) {
    child.stdin?.end();
  } else {
    child.stdin?.end(input);
  }

  const { code, childSignal } = await closePromise;
  clearTimeout(timeout);
  signal?.removeEventListener('abort', onAbort);
  const treeTerminated = terminationPromise ? await terminationPromise : true;

  return {
    pid: child.pid || null,
    status: Number.isInteger(code) && code >= 0 ? code : null,
    signal: childSignal || null,
    stdout,
    stderr,
    error: spawnError,
    timedOut: terminationReason === 'timeout',
    aborted: terminationReason === 'abort',
    outputLimitExceeded,
    treeTerminated,
  };
}

module.exports = {
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_TREE_EXIT_TIMEOUT_MS,
  DEFAULT_WINDOWS_KILL_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  boundedMilliseconds,
  processGroupAlive,
  waitForProcessGroupExit,
  terminateProcessTree,
  runBoundedProcessTree,
};
