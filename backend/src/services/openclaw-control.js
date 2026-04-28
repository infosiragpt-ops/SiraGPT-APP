const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const RELEASE_TAG = 'v2026.4.26';
const RELEASE_URL = `https://github.com/openclaw/openclaw/releases/tag/${RELEASE_TAG}`;
const INSTALL_SCRIPT_URL = 'https://openclaw.ai/install.sh';
const DEFAULT_BIN = process.env.OPENCLAW_BIN || 'openclaw';
const DEFAULT_WORKSPACES_DIR =
  process.env.OPENCLAW_WORKSPACES_DIR || path.join(os.homedir(), '.siragpt', 'openclaw-workspaces');
const DEFAULT_BASE_PORT = Number(process.env.OPENCLAW_GATEWAY_BASE_PORT || 19100);
const NATIVE_GATEWAY_PORT = Number(process.env.OPENCLAW_NATIVE_GATEWAY_PORT || process.env.OPENCLAW_GATEWAY_PORT || 18789);
const OPENCLAW_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), '.openclaw', 'openclaw.json');

const runningInstances = new Map();

const MODEL_POLICY = Object.freeze({
  FREE: {
    monthlyTokens: 1000,
    concurrentInstances: 0,
    models: ['deepseek-v4-flash'],
    features: ['Exploracion del panel', 'Configuracion de workspace'],
  },
  BASIC: {
    monthlyTokens: 10000,
    concurrentInstances: 1,
    models: ['deepseek-v4-flash', 'gpt-4o-mini'],
    features: ['Workspace aislado', 'Modelos rapidos', 'Historial basico'],
  },
  STANDARD: {
    monthlyTokens: 30000,
    concurrentInstances: 1,
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-4o-mini', 'gemini-2.5-flash'],
    features: ['Herramientas agenticas', 'Modelos profesionales', 'Mayor contexto'],
  },
  PRO: {
    monthlyTokens: 500000,
    concurrentInstances: 1,
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-4o-mini', 'gpt-4o', 'gemini-2.5-flash'],
    features: ['Workspace aislado', 'Modelos Pro', 'Control de tokens', 'Herramientas OpenClaw'],
  },
  PRO_MAX: {
    monthlyTokens: 1000000,
    concurrentInstances: 2,
    models: [
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'gpt-4o-mini',
      'gpt-4o',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'anthropic/claude-3.5-sonnet',
      'moonshotai/kimi-k2.6',
    ],
    features: ['Dos instancias', 'Modelos avanzados', 'Contexto largo', 'Automatizacion completa'],
  },
  ENTERPRISE: {
    monthlyTokens: 10000000,
    concurrentInstances: 5,
    models: [
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-chat',
      'deepseek-reasoner',
      'gpt-4o-mini',
      'gpt-4o',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'anthropic/claude-3.5-sonnet',
      'moonshotai/kimi-k2.6',
      'x-ai/grok-4',
    ],
    features: ['Instancias multiples', 'Todos los modelos', 'Auditoria', 'Aislamiento por usuario'],
  },
});

function normalizePlan(plan) {
  const value = String(plan || 'FREE').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return MODEL_POLICY[value] ? value : 'FREE';
}

function buildUserProfile(userId) {
  const digest = crypto.createHash('sha256').update(String(userId)).digest('hex');
  return {
    profile: `siragpt-${digest.slice(0, 10)}`,
    workspacePath: path.join(DEFAULT_WORKSPACES_DIR, digest.slice(0, 2), digest.slice(2, 18)),
    gatewayPort: DEFAULT_BASE_PORT + (parseInt(digest.slice(0, 4), 16) % 1000),
  };
}

function getPlanPolicy(user) {
  const plan = normalizePlan(user?.plan);
  const policy = MODEL_POLICY[plan];
  const monthlyLimit = Number(user?.monthlyLimit || 0);
  return {
    plan,
    monthlyTokens: monthlyLimit > 0 ? Math.max(monthlyLimit, policy.monthlyTokens) : policy.monthlyTokens,
    usedTokens: Number(user?.apiUsage || 0),
    concurrentInstances: policy.concurrentInstances,
    allowedModels: policy.models,
    features: policy.features,
    openClawEnabled: policy.concurrentInstances > 0,
  };
}

function execFileSafe(file, args = [], options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 2500, ...options }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, error: error.message, stdout: String(stdout || ''), stderr: String(stderr || '') });
        return;
      }
      resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function detectRuntime() {
  const result = await execFileSafe(DEFAULT_BIN, ['--version']);
  return {
    installed: result.ok,
    bin: DEFAULT_BIN,
    version: result.ok ? result.stdout.trim() || result.stderr.trim() || 'installed' : null,
    error: result.ok ? null : result.error,
  };
}

async function ensureWorkspaceForUser(user) {
  const profile = buildUserProfile(user.id);
  await fs.promises.mkdir(profile.workspacePath, { recursive: true });
  const metadataPath = path.join(profile.workspacePath, '.siragpt-openclaw.json');
  const metadata = {
    userId: user.id,
    profile: profile.profile,
    plan: normalizePlan(user.plan),
    releaseTag: RELEASE_TAG,
    createdBy: 'siraGPT',
    updatedAt: new Date().toISOString(),
  };
  await fs.promises.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  return profile;
}

function buildInstallCommand(profile) {
  return [
    `npm install -g openclaw@${RELEASE_TAG.replace(/^v/, '')}`,
    `openclaw gateway install --force --port ${shellQuote(String(NATIVE_GATEWAY_PORT))}`,
    `openclaw doctor --fix --yes --generate-gateway-token`,
    `openclaw gateway restart`,
  ].join(' && ');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function getOpenClawStatus(user) {
  const profile = buildUserProfile(user.id);
  const policy = getPlanPolicy(user);
  const runtime = await detectRuntime();
  const gateway = await detectNativeGateway(runtime.installed);
  const instance = runningInstances.get(user.id);
  const managedInstanceRunning = instance?.process?.exitCode == null && instance?.process?.pid;
  const nativeGatewayRunning = gateway.status === 'running';
  const gatewayUrl = nativeGatewayRunning
    ? gateway.gatewayUrl
    : managedInstanceRunning
      ? `http://127.0.0.1:${profile.gatewayPort}`
      : gateway.gatewayUrl;

  return {
    release: {
      tag: RELEASE_TAG,
      url: RELEASE_URL,
      installScriptUrl: INSTALL_SCRIPT_URL,
    },
    userWorkspace: {
      profile: profile.profile,
      workspacePath: profile.workspacePath,
      gatewayPort: profile.gatewayPort,
      isolated: true,
    },
    policy,
    runtime: {
      ...runtime,
      enabledByEnv: process.env.OPENCLAW_RUNTIME_ENABLED === 'true' || nativeGatewayRunning,
    },
    instance: {
      status: nativeGatewayRunning || managedInstanceRunning ? 'running' : 'stopped',
      pid: gateway.pid || instance?.process?.pid || null,
      startedAt: instance?.startedAt || null,
      gatewayUrl,
    },
    installCommand: buildInstallCommand(profile),
  };
}

async function detectNativeGateway(runtimeInstalled) {
  const gatewayUrl = `http://127.0.0.1:${NATIVE_GATEWAY_PORT}`;
  if (!runtimeInstalled) {
    return { status: 'stopped', pid: null, gatewayUrl, error: 'OpenClaw no esta instalado' };
  }

  const [healthResult, portOpen, pid] = await Promise.all([
    execFileSafe(DEFAULT_BIN, ['gateway', 'health'], { timeout: 2500 }),
    isPortOpen('127.0.0.1', NATIVE_GATEWAY_PORT, 350),
    detectPortPid(NATIVE_GATEWAY_PORT),
  ]);
  const healthOutput = `${healthResult.stdout}\n${healthResult.stderr}`;
  const healthOk = healthResult.ok && /\bOK\b/i.test(healthOutput);
  const running = healthOk || portOpen;

  return {
    status: running ? 'running' : 'stopped',
    pid,
    gatewayUrl,
    error: running ? null : healthResult.error || healthOutput.trim(),
  };
}

function isPortOpen(host, port, timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function detectPortPid(port) {
  const result = await execFileSafe('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeout: 1200 });
  if (!result.ok) return null;
  const line = result.stdout
    .split('\n')
    .slice(1)
    .find((entry) => entry.trim());
  if (!line) return null;
  const [, pid] = line.trim().split(/\s+/);
  return Number(pid) || null;
}

async function readGatewayToken() {
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_NATIVE_GATEWAY_TOKEN;
  if (envToken && String(envToken).trim()) return String(envToken).trim();

  try {
    const raw = await fs.promises.readFile(OPENCLAW_CONFIG_PATH, 'utf8');
    const config = JSON.parse(raw);
    const token =
      config?.gateway?.auth?.token ||
      config?.gatewayToken ||
      config?.auth?.token ||
      config?.token;
    return token && String(token).trim() ? String(token).trim() : null;
  } catch {
    return null;
  }
}

function toWebSocketGatewayUrl(gatewayUrl) {
  const url = new URL(gatewayUrl || `http://127.0.0.1:${NATIVE_GATEWAY_PORT}`);
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const pathname = url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/$/, '') : '';
  return `${protocol}//${url.host}${pathname}`;
}

async function getOpenClawNativeSession(user) {
  assertOpenClawAllowed(user);

  const [status, token] = await Promise.all([
    getOpenClawStatus(user),
    readGatewayToken(),
  ]);

  if (!token) {
    const err = new Error('No se encontro el token del gateway OpenClaw.');
    err.code = 'openclaw_token_missing';
    err.statusCode = 503;
    throw err;
  }

  const gatewayUrl = status.instance.gatewayUrl || `http://127.0.0.1:${NATIVE_GATEWAY_PORT}`;
  const gatewayWsUrl = toWebSocketGatewayUrl(gatewayUrl);
  const nativeParams = new URLSearchParams({
    gatewayUrl: gatewayWsUrl,
    token,
    session: status.userWorkspace.profile || 'main',
  }).toString();

  return {
    status,
    gatewayUrl,
    gatewayWsUrl,
    frameUrl: `/openclaw/native?${nativeParams}`,
    directUrl: `${gatewayUrl}/#${new URLSearchParams({ token }).toString()}`,
    connected: status.instance.status === 'running',
  };
}

async function bootstrapOpenClawWorkspace(user) {
  // Plan-aware guard. We deliberately fail fast here (instead of inside
  // the route) so any other internal caller that wires `bootstrap` for
  // background reconciliation gets the same enforcement and we have a
  // single source of truth for the policy decision. Errors carry a
  // stable `code` so the frontend can switch states without parsing
  // free-form text.
  const policy = getPlanPolicy(user);
  if (!policy.openClawEnabled) {
    const err = new Error('Tu plan actual no incluye OpenClaw.');
    err.code = 'plan_locked';
    err.statusCode = 403;
    err.policy = policy;
    throw err;
  }
  const profile = await ensureWorkspaceForUser(user);
  return getOpenClawStatus({
    ...user,
    id: user.id,
    plan: user.plan,
    apiUsage: user.apiUsage,
    monthlyLimit: user.monthlyLimit,
    _profile: profile,
  });
}

/**
 * Throws a structured error when the active user can not use OpenClaw.
 * Returns the resolved policy when the user is allowed, so callers
 * can pipe it straight into a response without recomputing it.
 */
function assertOpenClawAllowed(user) {
  const policy = getPlanPolicy(user);
  if (!policy.openClawEnabled) {
    const err = new Error('Tu plan actual no incluye OpenClaw.');
    err.code = 'plan_locked';
    err.statusCode = 403;
    err.policy = policy;
    throw err;
  }
  return policy;
}

module.exports = {
  getOpenClawStatus,
  getOpenClawNativeSession,
  bootstrapOpenClawWorkspace,
  getPlanPolicy,
  assertOpenClawAllowed,
};
