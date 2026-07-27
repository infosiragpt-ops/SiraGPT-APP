'use strict';

const { spawnSync } = require('node:child_process');
const {
  WINDOWS_COMMAND_TIMEOUT_MS,
  readWindowsProcessList,
  collectWindowsDescendants,
} = require('../backend/src/utils/windows-process-tree');

const DEFAULT_PARENT_SHUTDOWN_TIMEOUT_MS = 50_000;
const MIN_PARENT_SHUTDOWN_TIMEOUT_MS = 40_000;
const MAX_PARENT_SHUTDOWN_TIMEOUT_MS = 120_000;
const SHUTDOWN_MESSAGE_TYPE = 'siragpt:shutdown';

function resolveParentShutdownTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PARENT_SHUTDOWN_TIMEOUT_MS;
  return Math.min(
    MAX_PARENT_SHUTDOWN_TIMEOUT_MS,
    Math.max(MIN_PARENT_SHUTDOWN_TIMEOUT_MS, Math.floor(parsed)),
  );
}

function isChildSettled(child) {
  return !child || child.exitCode !== null || child.signalCode != null;
}

function crashExitCode(code) {
  if (Number.isInteger(code) && code > 0) return Math.min(code, 255);
  return 1;
}

function desiredExitCode(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return 1;
  return Math.min(parsed, 255);
}

function createShutdownCoordinator({
  platform = process.platform,
  timeoutMs = DEFAULT_PARENT_SHUTDOWN_TIMEOUT_MS,
  resolveTimeoutMs = resolveParentShutdownTimeoutMs,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setTreePollTimeoutFn = setTimeout,
  clearTreePollTimeoutFn = clearTimeout,
  treePollIntervalMs = 100,
  isProcessTreeAlive: injectedTreeLiveness,
  windowsProcessListImpl = readWindowsProcessList,
  processKill = process.kill.bind(process),
  spawnImpl = spawnSync,
  hardExit = (code) => process.exit(code),
  onShutdownStart = () => {},
  onSettled = ({ exitCode }) => { process.exitCode = exitCode; },
  log = () => {},
} = {}) {
  const children = new Map();
  let shutdownState = null;
  let deadlineTimer = null;
  let finished = false;
  let resolveCompletion;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });

  function removeChildListeners(entry) {
    entry.child.removeListener?.('exit', entry.onExit);
    entry.child.removeListener?.('close', entry.onClose);
    entry.child.removeListener?.('error', entry.onError);
  }

  function sendGraceful(entry) {
    if (!shutdownState || entry.settled || isChildSettled(entry.child)) return;
    const child = entry.child;
    const message = {
      type: SHUTDOWN_MESSAGE_TYPE,
      reason: shutdownState.reason,
      signal: shutdownState.signal,
      desiredExitCode: shutdownState.desiredExitCode,
    };
    let sentIpc = false;

    if (entry.ipc && child.connected && typeof child.send === 'function') {
      try {
        child.send(message, () => {});
        sentIpc = true;
      } catch {
        sentIpc = false;
      }
    }

    if (!sentIpc) {
      try { child.kill?.(shutdownState.signal); } catch { /* already gone */ }
    }
  }

  function getWindowsProcessList() {
    try {
      const result = windowsProcessListImpl();
      return Array.isArray(result) ? result : null;
    } catch (error) {
      log('windows_tree_snapshot_error', { error: error?.message });
      return null;
    }
  }

  function captureWindowsTrees(entries, processList = getWindowsProcessList()) {
    if (platform !== 'win32' || injectedTreeLiveness) return;
    if (!Array.isArray(processList)) {
      for (const entry of entries) entry.windowsTreeUncertain = true;
      return;
    }
    for (const entry of entries) {
      const roots = [entry.child.pid, ...entry.knownTreePids];
      for (const rootPid of roots) {
        for (const pid of collectWindowsDescendants(rootPid, processList)) {
          entry.knownTreePids.add(pid);
        }
      }
    }
  }

  function forceKill(entry) {
    if (entry.treeQuiescent) return;
    const child = entry.child;
    try {
      if (platform === 'win32' && child.pid) {
        const pids = new Set([child.pid, ...entry.knownTreePids]);
        for (const pid of pids) {
          const result = spawnImpl('taskkill', ['/pid', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
            timeout: WINDOWS_COMMAND_TIMEOUT_MS,
            killSignal: 'SIGKILL',
          });
          if (result?.error || (Number.isInteger(result?.status) && result.status !== 0)) {
            try { child.kill?.('SIGKILL'); } catch { /* already gone */ }
          }
        }
        return;
      }
      if (platform !== 'win32' && entry.processGroup && child.pid) {
        processKill(-child.pid, 'SIGKILL');
        return;
      }
      child.kill?.('SIGKILL');
    } catch {
      try { child.kill?.('SIGKILL'); } catch { /* already gone */ }
    }
  }

  function defaultTreeLiveness(entry) {
    if (platform === 'win32' && entry.child.pid) {
      const processList = getWindowsProcessList();
      if (!processList) return true;
      captureWindowsTrees([entry], processList);
      if (!entry.settled && !isChildSettled(entry.child)) return true;
      if (entry.windowsTreeUncertain) return true;
      const livePids = new Set(processList.map((processInfo) => Number(processInfo?.pid)));
      return Array.from(entry.knownTreePids).some((pid) => livePids.has(pid));
    }
    if (!entry.settled && !isChildSettled(entry.child)) return true;
    if (platform !== 'win32' && entry.processGroup && entry.child.pid) {
      try {
        processKill(-entry.child.pid, 0);
        return true;
      } catch (error) {
        return error?.code !== 'ESRCH';
      }
    }
    return false;
  }

  function clearTreePoll(entry) {
    if (!entry.treePollTimer) return;
    clearTreePollTimeoutFn(entry.treePollTimer);
    entry.treePollTimer = null;
  }

  function scheduleTreePoll(entry) {
    if (finished || entry.treeQuiescent || entry.treePollTimer) return;
    entry.treePollTimer = setTreePollTimeoutFn(() => {
      entry.treePollTimer = null;
      refreshTreeLiveness(entry);
    }, Math.max(10, Number(treePollIntervalMs) || 100));
  }

  function applyTreeLiveness(entry, alive) {
    entry.treeCheckPending = false;
    if (finished || entry.treeQuiescent || !shutdownState?.pending.has(entry)) return;
    if (alive) {
      scheduleTreePoll(entry);
      return;
    }
    entry.treeQuiescent = true;
    clearTreePoll(entry);
    shutdownState.pending.delete(entry);
    log('child_tree_quiescent', { name: entry.name });
    maybeFinish();
  }

  function refreshTreeLiveness(entry) {
    if (
      finished
      || entry.treeQuiescent
      || entry.treeCheckPending
      || !shutdownState?.pending.has(entry)
    ) return;
    entry.treeCheckPending = true;
    let result;
    try {
      result = injectedTreeLiveness
        ? injectedTreeLiveness(entry)
        : defaultTreeLiveness(entry);
    } catch (error) {
      log('child_tree_liveness_error', { name: entry.name, error: error?.message });
      applyTreeLiveness(entry, true);
      return;
    }
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).then(
        (alive) => applyTreeLiveness(entry, Boolean(alive)),
        (error) => {
          log('child_tree_liveness_error', { name: entry.name, error: error?.message });
          applyTreeLiveness(entry, true);
        },
      );
      return;
    }
    applyTreeLiveness(entry, Boolean(result));
  }

  function finish(timedOut) {
    if (finished || !shutdownState) return;
    finished = true;
    if (deadlineTimer) clearTimeoutFn(deadlineTimer);
    deadlineTimer = null;
    for (const entry of children.values()) {
      removeChildListeners(entry);
      clearTreePoll(entry);
    }

    const exitCode = timedOut && shutdownState.desiredExitCode === 0
      ? 1
      : shutdownState.desiredExitCode;
    const result = {
      reason: shutdownState.reason,
      signal: shutdownState.signal,
      exitCode,
      timedOut,
    };
    try { onSettled(result); } catch { /* shutdown must continue */ }
    resolveCompletion(result);
    if (timedOut) hardExit(exitCode || 1);
  }

  function maybeFinish() {
    if (shutdownState && shutdownState.pending.size === 0) finish(false);
  }

  function markChildSettled(entry, code, signal) {
    if (entry.settled) return;
    entry.settled = true;
    entry.code = code;
    entry.signal = signal;
    removeChildListeners(entry);

    if (!shutdownState) {
      shutdown({
        reason: `child:${entry.name}`,
        signal: 'SIGTERM',
        desiredExitCode: crashExitCode(code),
      });
      return;
    }
    log('child_leader_settled', { name: entry.name, code, signal });
    refreshTreeLiveness(entry);
  }

  function handleChildError(entry, error) {
    log('child_error', { name: entry.name, error: error?.message });
    if (!shutdownState) {
      shutdown({
        reason: `child:${entry.name}`,
        signal: 'SIGTERM',
        desiredExitCode: 1,
      });
    }
    if (isChildSettled(entry.child)) {
      markChildSettled(entry, entry.child.exitCode ?? 1, entry.child.signalCode);
    }
  }

  function registerChild(name, child, options = {}) {
    if (!child || typeof child.once !== 'function') {
      throw new TypeError('shutdown coordinator child must be an EventEmitter');
    }
    const previous = children.get(name);
    if (previous) removeChildListeners(previous);
    const entry = {
      name,
      child,
      ipc: options.ipc === true,
      processGroup: options.processGroup === true,
      settled: isChildSettled(child),
      treeQuiescent: false,
      treeCheckPending: false,
      treePollTimer: null,
      knownTreePids: new Set(),
      windowsTreeUncertain: false,
      code: child.exitCode,
      signal: child.signalCode,
      onExit: null,
      onClose: null,
      onError: null,
    };
    entry.onExit = (code, signal) => markChildSettled(entry, code, signal);
    entry.onClose = (code, signal) => markChildSettled(entry, code, signal);
    entry.onError = (error) => handleChildError(entry, error);
    if (!entry.settled) {
      child.once('exit', entry.onExit);
      child.once('close', entry.onClose);
      child.once('error', entry.onError);
    }
    children.set(name, entry);

    if (entry.settled && !shutdownState) {
      shutdown({
        reason: `child:${entry.name}`,
        signal: 'SIGTERM',
        desiredExitCode: crashExitCode(entry.code),
      });
    } else if (shutdownState && !finished) {
      captureWindowsTrees([entry]);
      shutdownState.pending.add(entry);
      if (entry.settled) refreshTreeLiveness(entry);
      else {
        sendGraceful(entry);
        if (platform === 'win32' && !injectedTreeLiveness) refreshTreeLiveness(entry);
      }
    } else if (finished && !entry.settled) {
      sendGraceful(entry);
    }
    return child;
  }

  function shutdown({
    reason = 'manual',
    signal = 'SIGTERM',
    desiredExitCode: requestedExitCode = 0,
  } = {}) {
    if (shutdownState) return completion;
    shutdownState = {
      reason: String(reason),
      signal: signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM',
      desiredExitCode: desiredExitCode(requestedExitCode),
      pending: new Set(),
    };
    try { onShutdownStart({ ...shutdownState, pending: undefined }); } catch { /* continue */ }

    captureWindowsTrees(children.values());
    for (const entry of children.values()) {
      if (!entry.treeQuiescent) shutdownState.pending.add(entry);
    }
    if (shutdownState.pending.size === 0) {
      finish(false);
      return completion;
    }

    deadlineTimer = setTimeoutFn(() => {
      if (finished) return;
      for (const entry of shutdownState.pending) forceKill(entry);
      finish(true);
    }, resolveTimeoutMs(timeoutMs));
    for (const entry of Array.from(shutdownState.pending)) {
      if (entry.settled || isChildSettled(entry.child)) refreshTreeLiveness(entry);
      else {
        sendGraceful(entry);
        if (platform === 'win32' && !injectedTreeLiveness) refreshTreeLiveness(entry);
      }
    }
    return completion;
  }

  return {
    registerChild,
    shutdown,
    waitForShutdown: () => completion,
    isShuttingDown: () => shutdownState !== null,
  };
}

module.exports = {
  DEFAULT_PARENT_SHUTDOWN_TIMEOUT_MS,
  MIN_PARENT_SHUTDOWN_TIMEOUT_MS,
  MAX_PARENT_SHUTDOWN_TIMEOUT_MS,
  SHUTDOWN_MESSAGE_TYPE,
  resolveParentShutdownTimeoutMs,
  createShutdownCoordinator,
};
