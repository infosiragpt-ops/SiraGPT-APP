'use strict';

const { spawnSync } = require('node:child_process');

const WINDOWS_COMMAND_TIMEOUT_MS = 1000;
const PROCESS_LIST_SCRIPT = [
  '$ErrorActionPreference = "Stop";',
  'Get-CimInstance Win32_Process | ForEach-Object {',
  '  "{0}:{1}" -f $_.ProcessId, $_.ParentProcessId',
  '}',
].join(' ');

function readWindowsProcessList({ spawnSyncImpl = spawnSync } = {}) {
  try {
    const result = spawnSyncImpl(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PROCESS_LIST_SCRIPT],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: WINDOWS_COMMAND_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    if (result?.error || result?.status !== 0) return null;
    return String(result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim().match(/^(\d+):(\d+)$/))
      .filter(Boolean)
      .map((match) => ({ pid: Number(match[1]), parentPid: Number(match[2]) }));
  } catch {
    return null;
  }
}

function collectWindowsDescendants(rootPid, processList) {
  const root = Number(rootPid);
  if (!Number.isInteger(root) || root <= 0 || !Array.isArray(processList)) return [];
  const byParent = new Map();
  for (const processInfo of processList) {
    const pid = Number(processInfo?.pid);
    const parentPid = Number(processInfo?.parentPid);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid)) continue;
    const children = byParent.get(parentPid) || [];
    children.push(pid);
    byParent.set(parentPid, children);
  }
  const descendants = [];
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const parentPid = queue.shift();
    for (const pid of byParent.get(parentPid) || []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      descendants.push(pid);
      queue.push(pid);
    }
  }
  return descendants;
}

module.exports = {
  WINDOWS_COMMAND_TIMEOUT_MS,
  readWindowsProcessList,
  collectWindowsDescendants,
};
