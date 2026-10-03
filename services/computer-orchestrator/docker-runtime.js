'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const { createHash } = require('crypto');

const DEFAULT_SOCKET = '/var/run/docker.sock';
const DEFAULT_API = 'v1.44';
const NOVNC_PORT = 6080;
const NOVNC_WAIT_INTERVAL_MS = 250;
const NOVNC_WAIT_TIMEOUT_MS = 45_000;


// The orchestrator image has Node and the Docker socket, not a Docker CLI.
// Execute through Engine HTTP, like the CDP bridge. The helper lives in the
// already-owned desktop and terminates its process group on timeout/disconnect.
const EXEC_HELPER = String.raw`
const { spawn } = require('node:child_process');
const timeoutMs = Number(process.argv[1]);
const command = process.argv[2];
if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || typeof command !== 'string') process.exit(125);
let timedOut = false, cancelled = false, killTimer, finished = false;
const child = spawn('bash', ['-lc', command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
const killGroup = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch {} } };
const terminate = timeout => {
  if (finished) return;
  if (timeout) timedOut = true; else cancelled = true;
  killGroup('SIGTERM');
  if (!killTimer) killTimer = setTimeout(() => killGroup('SIGKILL'), 250);
};
const timer = setTimeout(() => terminate(true), timeoutMs);
process.stdin.resume();
process.stdin.once('end', () => terminate(false));
process.stdin.once('error', () => terminate(false));
process.stdout.on('error', () => terminate(false));
process.stderr.on('error', () => terminate(false));
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
child.once('error', () => { finished = true; clearTimeout(timer); clearTimeout(killTimer); process.exit(125); });
child.once('close', code => {
  finished = true; clearTimeout(timer); clearTimeout(killTimer);
  // Cancelled commands lose their descendants; a successful launch may
  // intentionally leave a detached app alive with its output redirected.
  if (timedOut || cancelled) killGroup('SIGKILL');
  process.stdin.destroy();
  const exitCode = timedOut ? 124 : cancelled ? 125 : Number.isInteger(code) ? code : 125;
  process.stdout.end(() => process.stderr.end(() => process.exit(exitCode)));
});
`;
const EXEC_OUTPUT_LIMIT = 16 * 1024 * 1024;

function execError(code = 'DOCKER_EXEC_UNAVAILABLE', status = 502, exitCode) {
  const error = new Error(code === 'DOCKER_EXEC_TIMEOUT' ? 'Desktop command timed out'
    : code === 'DOCKER_EXEC_CANCELLED' ? 'Desktop command cancelled' : 'Desktop command failed');
  error.code = code;
  error.status = status;
  if (Number.isInteger(exitCode)) error.exitCode = exitCode;
  // Never include the command, daemon response, stdout or stderr in an error.
  return error;
}

function execJson(socketPath, apiVersion, method, route, body, signal) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ socketPath, path: `/${apiVersion}${route}`, method, signal,
      headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': payload.length } : {}) },
    }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) res.destroy(execError()); else chunks.push(chunk);
      });
      res.once('error', () => reject(execError()));
      res.once('end', () => {
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) throw execError();
          resolve(JSON.parse(Buffer.concat(chunks)));
        } catch { reject(execError()); }
      });
    });
    req.once('error', () => reject(execError()));
    req.end(payload);
  });
}

// Non-TTY Engine output uses eight-byte stdout/stderr frame headers. Consume
// incrementally, with one shared output cap and no daemon diagnostics in errors.
function execOutput(socketPath, apiVersion, id, signal) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
    let socket, settled = false, header = Buffer.alloc(0), remaining = 0, channel = 0, size = 0;
    const stdout = [], stderr = [];
    const req = http.request({ socketPath, path: `/${apiVersion}/exec/${id}/start`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, Connection: 'Upgrade', Upgrade: 'tcp' },
    });
    const finish = error => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      req.destroy(); socket?.destroy();
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    const abort = () => finish(execError());
    const consume = bytes => {
      let offset = 0;
      while (offset < bytes.length && !settled) {
        if (remaining === 0) {
          const take = Math.min(8 - header.length, bytes.length - offset);
          header = Buffer.concat([header, bytes.subarray(offset, offset + take)]); offset += take;
          if (header.length < 8) return;
          channel = header[0]; remaining = header.readUInt32BE(4);
          if (![1, 2].includes(channel) || header[1] || header[2] || header[3] || remaining > EXEC_OUTPUT_LIMIT) {
            finish(execError('DOCKER_EXEC_OUTPUT_INVALID')); return;
          }
          header = Buffer.alloc(0);
          if (!remaining) continue;
        }
        const take = Math.min(remaining, bytes.length - offset);
        size += take;
        if (size > EXEC_OUTPUT_LIMIT) { finish(execError('DOCKER_EXEC_OUTPUT_LIMIT')); return; }
        (channel === 1 ? stdout : stderr).push(bytes.subarray(offset, offset + take));
        remaining -= take; offset += take;
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    req.once('upgrade', (res, stream, head) => {
      socket = stream;
      if (settled || signal.aborted || res.statusCode !== 101) { stream.destroy(); finish(execError()); return; }
      stream.on('data', consume);
      stream.once('end', () => finish(remaining || header.length ? execError('DOCKER_EXEC_OUTPUT_INVALID') : null));
      stream.once('error', () => finish(execError()));
      stream.once('close', () => { if (!settled) finish(execError()); });
      if (head.length) consume(head);
    });
    req.once('response', res => { res.destroy(); finish(execError()); });
    req.once('error', () => finish(execError()));
    if (signal.aborted) abort(); else req.end(payload);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tcpConnectOnce(port, host, { connectImpl, connectTimeoutMs = 1500 } = {}) {
  if (typeof connectImpl === 'function') {
    return new Promise((resolve, reject) => {
      connectImpl(port, host, (err) => (err ? reject(err) : resolve()));
    });
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host });
    const finish = (err) => {
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(connectTimeoutMs, () => {
      const err = new Error('connect timeout');
      err.code = 'ETIMEDOUT';
      finish(err);
    });
    socket.once('connect', () => finish());
    socket.once('error', finish);
  });
}

async function waitForTcpPort(host, port, opts = {}) {
  const intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : NOVNC_WAIT_INTERVAL_MS;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : NOVNC_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() <= deadline) {
    try {
      await tcpConnectOnce(port, host, opts);
      return { host, port, ready: true };
    } catch (err) {
      lastErr = err;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(intervalMs, remaining));
    }
  }
  const err = new Error(`novnc not reachable on ${host}:${port} after ${timeoutMs}ms`);
  err.status = 503;
  err.code = 'NOVNC_NOT_READY';
  err.cause = lastErr;
  throw err;
}

function memoryBytes(mb) {
  const n = Number(mb);
  return (Number.isFinite(n) && n > 0 ? n : 1024) * 1024 * 1024;
}

function nanoCpus(cpus) {
  const n = Number(cpus);
  return Math.round((Number.isFinite(n) && n > 0 ? n : 1) * 1e9);
}

// CPU quota limits time, not the CPU count seen by Mesa/Chromium. Bound the
// affinity too, so thread pools are not sized for every CPU on the host.
function readCpuAffinity() {
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  return (status.match(/^Cpus_allowed_list:\s*(.+)$/m) || [])[1] || '';
}

function parseCpuAffinity(raw) {
  const ids = new Set();
  for (const part of String(raw).trim().split(',')) {
    const match = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error('invalid CPU affinity');
    const first = Number(match[1]);
    const last = Number(match[2] || match[1]);
    if (!Number.isSafeInteger(last) || last > 1048575 || last < first || last - first >= 16384) {
      throw new Error('invalid CPU affinity range');
    }
    for (let id = first; id <= last; id += 1) ids.add(id);
    if (ids.size > 16384) throw new Error('CPU affinity is too large');
  }
  return [...ids].sort((a, b) => a - b);
}

function quotaCpuCount(hostConfig = {}) {
  if (Number(hostConfig.NanoCpus) > 0) return Number(hostConfig.NanoCpus) / 1e9;
  if (Number(hostConfig.CpuQuota) > 0 && Number(hostConfig.CpuPeriod) > 0) {
    return Number(hostConfig.CpuQuota) / Number(hostConfig.CpuPeriod);
  }
  return 0;
}

function createDockerRuntime(opts = {}) {
  const socketPath = opts.socketPath || process.env.DOCKER_HOST_SOCKET || DEFAULT_SOCKET;
  const rawApi = opts.apiVersion || process.env.DOCKER_API_VERSION || DEFAULT_API;
  const apiVersion = String(rawApi).startsWith('v') ? String(rawApi) : `v${rawApi}`;
  const image = opts.image || process.env.AGENT_COMPUTER_DESKTOP_IMAGE || 'siragpt-computer-orchestrator:latest';
  const memoryMb = opts.memoryMb || process.env.AGENT_COMPUTER_DESKTOP_MEMORY_MB || 1024;
  const cpus = opts.cpus || process.env.AGENT_COMPUTER_DESKTOP_CPUS || '1';
  const requestImpl = opts.requestImpl || dockerRequest;
  const readCpuAffinityImpl = opts.readCpuAffinityImpl || readCpuAffinity;

  function desktopCpuAffinity(containerName, quota) {
    try {
      const allowed = parseCpuAffinity(readCpuAffinityImpl());
      const count = Math.min(allowed.length, Math.max(1, Math.ceil(quota)));
      // A stable offset avoids assigning every member to CPU zero. CPU IDs
      // come from the kernel's allowed mask, not a guessed contiguous range.
      const offset = createHash('sha256').update(containerName).digest().readUInt32BE(0) % allowed.length;
      return Array.from({ length: count }, (_, i) => allowed[(offset + i) % allowed.length])
        .sort((a, b) => a - b).join(',');
    } catch (cause) {
      const err = new Error('desktop CPU affinity unavailable');
      err.code = 'DESKTOP_CPU_AFFINITY_UNAVAILABLE';
      err.status = 503;
      err.cause = cause;
      throw err;
    }
  }

  async function alignExistingCpuAffinity(containerName, info) {
    const config = (info && info.HostConfig) || {};
    const quota = quotaCpuCount(config);
    // An explicit placement belongs to the operator. Unknown/unlimited legacy
    // quotas also stay untouched rather than adopting today's defaults.
    if (String(config.CpusetCpus || '').trim() || !Number.isFinite(quota) || quota <= 0) return;
    const CpusetCpus = desktopCpuAffinity(containerName, quota);
    await requestImpl('POST', `/containers/${encodeURIComponent(containerName)}/update`, { CpusetCpus });
    // Docker applies affinity in place. Never restart the desktop or its apps:
    // existing pools can be recovered separately without losing the profile.
  }
  const novncPort = Number(opts.novncPort) > 0 ? Number(opts.novncPort) : NOVNC_PORT;
  const novncWaitIntervalMs = Number(opts.novncWaitIntervalMs || process.env.AGENT_COMPUTER_NOVNC_WAIT_INTERVAL_MS) > 0
    ? Number(opts.novncWaitIntervalMs || process.env.AGENT_COMPUTER_NOVNC_WAIT_INTERVAL_MS)
    : NOVNC_WAIT_INTERVAL_MS;
  const novncWaitTimeoutMs = Number(opts.novncWaitTimeoutMs || process.env.AGENT_COMPUTER_NOVNC_WAIT_TIMEOUT_MS) > 0
    ? Number(opts.novncWaitTimeoutMs || process.env.AGENT_COMPUTER_NOVNC_WAIT_TIMEOUT_MS)
    : NOVNC_WAIT_TIMEOUT_MS;

  function dockerRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = body == null ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({
        socketPath,
        path: `/${apiVersion}${path}`,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': payload.length } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = {};
          if (raw) {
            try { data = JSON.parse(raw); } catch (_) { data = { message: raw.slice(0, 240) }; }
          }
          if (res.statusCode >= 400) {
            const err = new Error(data.message || `docker HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            err.body = data;
            reject(err);
            return;
          }
          resolve({ status: res.statusCode, data });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function inspectContainer(name) {
    try {
      const out = await requestImpl('GET', `/containers/${encodeURIComponent(name)}/json`);
      return out.data;
    } catch (err) {
      if (err && (err.status === 404 || /no such container/i.test(String(err.message || '')))) return null;
      throw err;
    }
  }

  function isRunning(info) {
    return Boolean(info && info.State && info.State.Running);
  }

  async function resolveNetwork() {
    if (opts.network || process.env.AGENT_COMPUTER_DOCKER_NETWORK) {
      return String(opts.network || process.env.AGENT_COMPUTER_DOCKER_NETWORK);
    }
    const hostname = require('os').hostname();
    try {
      const self = await requestImpl('GET', `/containers/${encodeURIComponent(hostname)}/json`);
      const nets = Object.keys((self.data && self.data.NetworkSettings && self.data.NetworkSettings.Networks) || {});
      if (nets.length) return nets[0];
    } catch (_) { /* host / test */ }
    return 'bridge';
  }

  async function createAndStart(containerName) {
    const network = await resolveNetwork();
    const body = {
      Image: image,
      Hostname: containerName,
      Env: ['DISPLAY=:1', 'HOME=/home/compuser'],
      Cmd: ['/usr/local/bin/start-desktop.sh'],
      ExposedPorts: { '6080/tcp': {}, '9222/tcp': {}, '5901/tcp': {} },
      Labels: { 'siragpt.computer': '1', 'siragpt.computer.container': containerName },
      Healthcheck: { Test: ['NONE'] },
      HostConfig: {
        Memory: memoryBytes(memoryMb),
        NanoCpus: nanoCpus(cpus),
        CpusetCpus: desktopCpuAffinity(containerName, nanoCpus(cpus) / 1e9),
        MemorySwap: memoryBytes(memoryMb),
        PidsLimit: 256,
        ShmSize: 256 * 1024 * 1024,
        NetworkMode: network,
        RestartPolicy: { Name: 'unless-stopped' },
        SecurityOpt: ['seccomp=unconfined'],
        CapAdd: ['SYS_ADMIN'],
      },
    };
    try {
      await requestImpl('POST', `/containers/create?name=${encodeURIComponent(containerName)}`, body);
    } catch (err) {
      if (!(err && err.status === 409)) throw err;
    }
    await requestImpl('POST', `/containers/${encodeURIComponent(containerName)}/start`);
    return afterStart(containerName);
  }

  async function afterStart(containerName) {
    const info = await inspectContainer(containerName);
    const host = containerIp(info) || containerName;
    await waitForTcpPort(host, novncPort, {
      intervalMs: novncWaitIntervalMs,
      timeoutMs: novncWaitTimeoutMs,
      connectImpl: opts.connectImpl,
    });
    return info;
  }

  async function ensureContainer(containerName) {
    const existing = await inspectContainer(containerName);
    if (existing) await alignExistingCpuAffinity(containerName, existing);
    if (existing && isRunning(existing)) {
      const info = await afterStart(containerName);
      return { info, reused: true, created: false };
    }
    if (existing && !isRunning(existing)) {
      await requestImpl('POST', `/containers/${encodeURIComponent(containerName)}/start`);
      const info = await afterStart(containerName);
      return { info, reused: true, created: false };
    }
    const info = await createAndStart(containerName);
    return { info, reused: false, created: true };
  }

  /**
   * List SiraGPT desktop containers (label siragpt.computer=1) across any
   * state. Used by boot reconciliation: after an orchestrator restart the
   * in-memory session store is empty while the desktops (unless-stopped)
   * are still there — this lets the server re-register them instead of
   * orphaning live computers. Best-effort: never throws.
   */
  async function listComputers() {
    try {
      const out = await requestImpl(
        'GET',
        `/containers/json?filters=${encodeURIComponent(JSON.stringify({ label: ['siragpt.computer=1'] }))}`,
      );
      const list = Array.isArray(out && out.data) ? out.data : [];
      return list
        .map((c) => {
          const names = (c && c.Names) || [];
          const raw = names.length ? names[0] : (c && (c.Name || c.Id)) || '';
          const name = String(raw || '').replace(/^\//, '');
          return { name, running: String((c && c.State) || '').toLowerCase() === 'running' };
        })
        .filter((c) => Boolean(c.name));
    } catch (_) {
      return [];
    }
  }

  function containerIp(info) {
    const nets = (info && info.NetworkSettings && info.NetworkSettings.Networks) || {};
    for (const net of Object.values(nets)) {
      if (net && net.IPAddress) return net.IPAddress;
    }
    return (info && info.NetworkSettings && info.NetworkSettings.IPAddress) || containerNameOf(info);
  }

  function containerNameOf(info) {
    const name = info && (info.Name || (info.Names && info.Names[0]));
    return String(name || '').replace(/^\//, '');
  }

  async function execIn(containerName, command, { timeoutMs = 20_000, user = 'compuser', signal } = {}) {
    if (typeof opts.execImpl === 'function') return opts.execImpl(containerName, command, { timeoutMs, user, signal });
    if (!/^sira-ac-user-[a-z0-9_-]+$/i.test(String(containerName || ''))
      || !/^[a-z0-9_-]{1,64}$/i.test(String(user || ''))
      || typeof command !== 'string' || command.length > 65536
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw execError('DOCKER_EXEC_INVALID', 400);
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      bounded.throwIfAborted();
      const created = await execJson(socketPath, apiVersion, 'POST', `/containers/${encodeURIComponent(containerName)}/exec`, {
        AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false,
        User: user, Env: ['DISPLAY=:1'], Cmd: ['node', '-e', EXEC_HELPER, String(timeoutMs), command],
      }, bounded);
      if (!/^[a-f0-9]{64}$/i.test(created?.Id || '')) throw execError();
      const output = await execOutput(socketPath, apiVersion, created.Id, bounded);
      const state = await execJson(socketPath, apiVersion, 'GET', `/exec/${created.Id}/json`, null, bounded);
      if (state?.Running !== false || !Number.isInteger(state.ExitCode) || state.ExitCode < 0 || state.ExitCode > 255) {
        throw execError('DOCKER_EXEC_INCOMPLETE');
      }
      if (state.ExitCode !== 0) {
        throw execError(state.ExitCode === 124 ? 'DOCKER_EXEC_TIMEOUT' : 'DOCKER_EXEC_FAILED', state.ExitCode === 124 ? 504 : 502, state.ExitCode);
      }
      return { ok: true, ...output };
    } catch (error) {
      if (bounded.aborted) throw execError(signal?.aborted ? 'DOCKER_EXEC_CANCELLED' : 'DOCKER_EXEC_TIMEOUT', signal?.aborted ? 499 : 504);
      throw error?.code?.startsWith('DOCKER_EXEC_') ? error : execError();
    }
  }

  return {
    inspectContainer,
    ensureContainer,
    isRunning,
    containerIp,
    execIn,
    image,
    listComputers,
  };
}

module.exports = {
  createDockerRuntime,
  waitForTcpPort,
  memoryBytes,
  nanoCpus,
  NOVNC_PORT,
  NOVNC_WAIT_INTERVAL_MS,
  NOVNC_WAIT_TIMEOUT_MS,
  DEFAULT_API,
};
