'use strict';

/**
 * Per-member persistent Linux desktop (Xfce + Chromium + Thunar + terminal).
 *
 * One Docker container per SiraGPT user. The VNC/noVNC server only listens
 * inside the container; the Node API reverse-proxies it over an authenticated
 * same-origin path so the /code preview can iframe it.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');

const DEFAULT_IMAGE = 'siragpt-member-desktop:latest';
const CONTAINER_PREFIX = 'siragpt-desktop-';
const PORT_RANGE_START = 16080;
const PORT_RANGE_END = 16999;
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

function safeUserKey(userId) {
  const raw = String(userId || '').trim();
  const slug = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
  if (slug.length >= 8) return slug.toLowerCase();
  return crypto.createHash('sha256').update(raw || 'anonymous').digest('hex').slice(0, 24);
}

function containerName(userId) {
  return `${CONTAINER_PREFIX}${safeUserKey(userId)}`;
}

function volumeName(userId, kind) {
  return `siragpt-desktop-${kind}-${safeUserKey(userId)}`;
}

function tokenSecret(env = process.env) {
  const secret = String(env.JWT_SECRET || env.CODE_RUNNER_PREVIEW_TOKEN_SECRET || '').trim();
  if (secret) return secret;
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') return '';
  return 'siragpt-member-desktop-dev-secret';
}

function signDesktopToken(userId, env = process.env) {
  const secret = tokenSecret(env);
  if (!secret) {
    const err = new Error('desktop_token_secret_required');
    err.code = 'desktop_token_secret_required';
    throw err;
  }
  const exp = Date.now() + TOKEN_TTL_MS;
  const body = Buffer.from(JSON.stringify({ sub: String(userId), exp })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyDesktopToken(token, env = process.env) {
  const secret = tokenSecret(env);
  if (!secret) return null;
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const actualBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object') return null;
    if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) <= Date.now()) return null;
    if (!claims.sub) return null;
    return claims;
  } catch {
    return null;
  }
}

function runDocker(args, { timeoutMs = 45_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code || 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: '', stderr: error.message || 'docker_unavailable' });
    });
  });
}

function dockerAvailable() {
  return runDocker(['info'], { timeoutMs: 8_000 }).then((result) => result.code === 0);
}

function inspectHostPort(name) {
  return runDocker([
    'inspect',
    '-f',
    '{{(index (index .NetworkSettings.Ports "6080/tcp") 0).HostPort}}',
    name,
  ]).then((result) => {
    const port = Number.parseInt(result.stdout, 10);
    if (result.code !== 0 || !Number.isFinite(port)) return null;
    return port;
  });
}

function containerRunning(name) {
  return runDocker(['inspect', '-f', '{{.State.Running}}', name]).then((result) => (
    result.code === 0 && result.stdout.trim() === 'true'
  ));
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

function buildDockerRunArgs({
  userId,
  hostPort,
  image = process.env.SIRAGPT_MEMBER_DESKTOP_IMAGE || DEFAULT_IMAGE,
} = {}) {
  const name = containerName(userId);
  const homeVol = volumeName(userId, 'home');
  const wsVol = volumeName(userId, 'ws');
  return [
    'run', '-d',
    '--name', name,
    '--restart', 'unless-stopped',
    '--memory', process.env.SIRAGPT_MEMBER_DESKTOP_MEMORY || '1536m',
    '--cpus', process.env.SIRAGPT_MEMBER_DESKTOP_CPUS || '1',
    '--pids-limit', process.env.SIRAGPT_MEMBER_DESKTOP_PIDS || '256',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '-p', `127.0.0.1:${hostPort}:6080`,
    '-v', `${homeVol}:/home/agent`,
    '-v', `${wsVol}:/workspace`,
    '-e', 'HOME=/home/agent',
    image,
  ];
}

async function ensureDesktop({ userId, env = process.env } = {}) {
  if (!userId) {
    const err = new Error('user_required');
    err.code = 'user_required';
    throw err;
  }
  const available = await dockerAvailable();
  if (!available) {
    const err = new Error('El motor Docker de escritorios no está disponible en este servidor.');
    err.code = 'desktop_unavailable';
    throw err;
  }
  const name = containerName(userId);
  if (await containerRunning(name)) {
    const hostPort = await inspectHostPort(name);
    if (hostPort) {
      const token = signDesktopToken(userId, env);
      return {
        resumed: true,
        container: name,
        hostPort,
        token,
        vncPath: `/api/member-desktop/vnc/${token}/vnc.html?autoconnect=1&resize=remote&path=${encodeURIComponent(`api/member-desktop/vnc/${token}/websockify`)}`,
      };
    }
  }
  await runDocker(['rm', '-f', name], { timeoutMs: 15_000 });
  const hostPort = await pickFreePort();
  const args = buildDockerRunArgs({ userId, hostPort, image: env.SIRAGPT_MEMBER_DESKTOP_IMAGE || DEFAULT_IMAGE });
  const started = await runDocker(args, { timeoutMs: 90_000 });
  if (started.code !== 0) {
    const err = new Error(started.stderr || 'No se pudo arrancar el escritorio Linux.');
    err.code = 'desktop_start_failed';
    throw err;
  }
  const token = signDesktopToken(userId, env);
  return {
    resumed: false,
    container: name,
    hostPort,
    token,
    vncPath: `/api/member-desktop/vnc/${token}/vnc.html?autoconnect=1&resize=remote&path=${encodeURIComponent(`api/member-desktop/vnc/${token}/websockify`)}`,
  };
}

async function resolveDesktopTarget(token, env = process.env) {
  const claims = verifyDesktopToken(token, env);
  if (!claims?.sub) return null;
  const name = containerName(claims.sub);
  if (!(await containerRunning(name))) return null;
  const hostPort = await inspectHostPort(name);
  if (!hostPort) return null;
  return { userId: claims.sub, host: '127.0.0.1', port: hostPort };
}

module.exports = {
  TOKEN_TTL_MS,
  buildDockerRunArgs,
  containerName,
  ensureDesktop,
  resolveDesktopTarget,
  safeUserKey,
  signDesktopToken,
  verifyDesktopToken,
  volumeName,
};
