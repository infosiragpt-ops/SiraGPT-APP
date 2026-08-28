'use strict';

const http = require('http');
const { spawn } = require('child_process');

const DEFAULT_SOCKET = '/var/run/docker.sock';
const DEFAULT_API = 'v1.43';

function memoryBytes(mb) {
  const n = Number(mb);
  return (Number.isFinite(n) && n > 0 ? n : 1024) * 1024 * 1024;
}

function nanoCpus(cpus) {
  const n = Number(cpus);
  return Math.round((Number.isFinite(n) && n > 0 ? n : 1) * 1e9);
}

function createDockerRuntime(opts = {}) {
  const socketPath = opts.socketPath || process.env.DOCKER_HOST_SOCKET || DEFAULT_SOCKET;
  const apiVersion = opts.apiVersion || DEFAULT_API;
  const image = opts.image || process.env.AGENT_COMPUTER_DESKTOP_IMAGE || 'siragpt-computer-orchestrator:latest';
  const memoryMb = opts.memoryMb || process.env.AGENT_COMPUTER_DESKTOP_MEMORY_MB || 1024;
  const cpus = opts.cpus || process.env.AGENT_COMPUTER_DESKTOP_CPUS || '1';
  const requestImpl = opts.requestImpl || dockerRequest;

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
    return inspectContainer(containerName);
  }

  async function ensureContainer(containerName) {
    const existing = await inspectContainer(containerName);
    if (existing && isRunning(existing)) {
      return { info: existing, reused: true, created: false };
    }
    if (existing && !isRunning(existing)) {
      await requestImpl('POST', `/containers/${encodeURIComponent(containerName)}/start`);
      const info = await inspectContainer(containerName);
      return { info, reused: true, created: false };
    }
    const info = await createAndStart(containerName);
    return { info, reused: false, created: true };
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

  async function execIn(containerName, command, { timeoutMs = 20_000, user = 'compuser' } = {}) {
    if (typeof opts.execImpl === 'function') {
      return opts.execImpl(containerName, command, { timeoutMs, user });
    }
    return new Promise((resolve, reject) => {
      const child = spawn(
        'docker',
        ['exec', '-u', user, '-e', 'DISPLAY=:1', containerName, 'bash', '-lc', String(command || '')],
        { timeout: timeoutMs },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          const err = new Error(stderr || stdout || `docker_exec_${code}`);
          err.status = 500;
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr, ok: true });
      });
    });
  }

  return {
    inspectContainer,
    ensureContainer,
    isRunning,
    containerIp,
    execIn,
    image,
  };
}

module.exports = {
  createDockerRuntime,
  memoryBytes,
  nanoCpus,
};
