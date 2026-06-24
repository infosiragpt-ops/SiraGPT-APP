'use strict';

/**
 * hosting/deploy.service — orchestrates a deployment job.
 *
 *   static mode: build the cloned workspace → upload the output dir (SFTP/FTP).
 *   node mode  : upload the source → run `npm install`/build/pm2 over SSH (VPS).
 *
 * Jobs run async in-memory (Map by deploymentId) with a log ring buffer + a
 * subscriber list (SSE). The route persists status/logTail via `onEvent`.
 * One concurrent deploy per project (connectionId). Cancellable. Disable with
 * SIRAGPT_DEPLOY_DISABLED=1.
 */

const path = require('path');
const { ensureLocalExcludes } = require('../github/workspace-manager');
const buildService = require('./build.service');
const sftp = require('./sftp-transport');
const ftp = require('./ftp-transport');
const sshExec = require('./ssh-exec');
const nginx = require('./nginx.service');
const { verifyUrl, normalizeDomain } = require('./domain');

const LOG_MAX = 400;
const jobs = new Map(); // deploymentId → job
const runningConnections = new Set(); // connectionId currently deploying

function isDisabled() {
  return /^(1|true|on)$/i.test(String(process.env.SIRAGPT_DEPLOY_DISABLED || ''));
}

function snapshot(job) {
  if (!job) return { status: 'unknown' };
  return {
    status: job.status,
    url: job.url || null,
    error: job.error || null,
    tail: job.log.slice(-50),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
  };
}

function status(deploymentId) {
  return snapshot(jobs.get(deploymentId));
}

function isRunningForConnection(connectionId) {
  return Boolean(connectionId) && runningConnections.has(connectionId);
}

function subscribe(deploymentId, cb) {
  const job = jobs.get(deploymentId);
  if (!job) return () => {};
  for (const line of job.log) cb({ type: 'log', line });
  cb({ type: 'status', ...snapshot(job) });
  job.subscribers.add(cb);
  return () => job.subscribers.delete(cb);
}

function emit(job, event) {
  for (const cb of job.subscribers) {
    try {
      cb(event);
    } catch {
      /* ignore */
    }
  }
}

function pushLog(job, line) {
  const text = String(line).replace(/\s+$/, '');
  if (!text) return;
  job.log.push(text);
  if (job.log.length > LOG_MAX) job.log.splice(0, job.log.length - LOG_MAX);
  emit(job, { type: 'log', line: text });
}

function setStatus(job, st, extra = {}) {
  job.status = st;
  Object.assign(job, extra);
  emit(job, { type: 'status', ...snapshot(job) });
  job.onEvent?.({ type: 'status', status: st, ...extra, tail: job.log.slice(-50).join('\n') });
}

function transportFor(protocol) {
  return protocol === 'ftp' || protocol === 'ftps' ? ftp : sftp;
}

/** Friendlier message for common SFTP/FTP/SSH failures. */
function friendlyError(err) {
  const m = String((err && err.message) || err || '').toLowerCase();
  if (/auth|password|denied|permission/.test(m)) return 'Autenticación fallida — revisa usuario/contraseña o la clave SSH';
  if (/timed out|timeout|etimedout|ehostunreach|enotfound|econnrefused/.test(m)) return 'No se pudo conectar al servidor — revisa host/puerto y que el firewall permita la conexión';
  if (/no such file|not found|enoent|directory/.test(m)) return 'Ruta remota no encontrada — revisa el directorio remoto';
  return (err && err.message) || 'Operación fallida';
}

function start(deploymentId, { localPath, target, config = {}, connectionId, onEvent } = {}) {
  if (isDisabled()) {
    const e = new Error('Deployments are disabled on this server');
    e.status = 503;
    e.code = 'deploy_disabled';
    throw e;
  }
  if (connectionId && runningConnections.has(connectionId)) {
    const e = new Error('Ya hay un despliegue en curso para este proyecto');
    e.status = 409;
    e.code = 'deploy_in_progress';
    throw e;
  }
  const job = {
    id: deploymentId,
    connectionId,
    status: 'queued',
    log: [],
    subscribers: new Set(),
    url: null,
    error: null,
    cancelled: false,
    abort: new AbortController(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    onEvent,
  };
  jobs.set(deploymentId, job);
  if (connectionId) runningConnections.add(connectionId);

  _run(job, { localPath, target, config })
    .catch((err) => {
      if (!job.cancelled) {
        setStatus(job, 'error', { error: friendlyError(err).slice(0, 500), finishedAt: new Date().toISOString() });
      }
    })
    .finally(() => {
      if (connectionId) runningConnections.delete(connectionId);
    });
  return snapshot(job);
}

function cancel(deploymentId) {
  const job = jobs.get(deploymentId);
  if (!job) return { cancelled: false };
  if (job.status === 'success' || job.status === 'error') return { cancelled: false };
  job.cancelled = true;
  try {
    job.abort.abort();
  } catch {
    /* ignore */
  }
  if (job.connectionId) runningConnections.delete(job.connectionId);
  setStatus(job, 'error', { error: 'Cancelado por el usuario', finishedAt: new Date().toISOString() });
  return { cancelled: true };
}

async function _run(job, { localPath, target, config }) {
  ensureLocalExcludes(localPath);
  const buildEnv = config.env || {};

  if (config.mode === 'node') return _runNode(job, { localPath, target, config, buildEnv });

  // ── Static: build locally → upload output ──
  setStatus(job, 'building');
  buildService.ensureViteEntry(localPath, (l) => pushLog(job, l));
  const plan = buildService.detectBuildPlan(localPath);
  const buildCommand = config.buildCommand !== undefined ? config.buildCommand : plan.buildCommand;
  await buildService.runBuild(localPath, { buildCommand, onLog: (l) => pushLog(job, l), signal: job.abort.signal, env: buildEnv });
  if (job.cancelled) return;

  const outDir = buildService.resolveOutputDir(localPath, config.outputDir || plan.outputDir);
  const localDir = path.resolve(localPath, outDir);
  if (!buildService.dirHasFiles(localDir) && outDir !== '.') {
    throw new Error(`El directorio de salida "${outDir}" está vacío o no existe`);
  }
  if (plan.framework === 'next' && outDir === 'out' && !buildService.dirHasFiles(localDir)) {
    pushLog(job, '[deploy] ⚠ Next.js sin "output: \'export\'" — para hosting estático añade export en next.config.');
  }
  if (plan.kind === 'node' && !buildService.hasJsBundle(localDir)) {
    pushLog(job, `[deploy] ⚠ no se encontró JS en "${outDir}" — la página puede salir en blanco (revisa index.html).`);
  }
  if (buildService.ensureSpaHtaccess(localDir)) pushLog(job, '[deploy] añadido .htaccess (SPA routing)');
  pushLog(job, `[deploy] output dir: ${outDir}`);

  setStatus(job, 'uploading');
  const remoteDir = config.remotePath || target.remoteBaseDir || '/public_html';
  const transport = transportFor(target.protocol);
  try {
    await transport.uploadDir({
      protocol: target.protocol,
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      privateKey: target.privateKey,
      passphrase: target.passphrase,
      localDir,
      remoteDir,
      cleanSlate: Boolean(config.cleanSlate),
      onLog: (l) => pushLog(job, l),
    });
  } catch (err) {
    throw new Error(friendlyError(err));
  }
  if (job.cancelled) return;

  // VPS: auto-configure nginx to serve this web root at the domain.
  if (config.configureNginx && config.domain) {
    await _configureNginx(job, target, { domain: config.domain, webroot: remoteDir, ssl: config.ssl, email: config.sslEmail });
  }

  await _finish(job, target);
}

async function _runNode(job, { localPath, target, config, buildEnv }) {
  // 1. Upload source (no node_modules / .git / build output) over SFTP.
  setStatus(job, 'uploading');
  const remoteDir = config.remotePath || target.remoteBaseDir || '/var/www/app';
  pushLog(job, `[node] subiendo código fuente → ${remoteDir}`);
  try {
    await sftp.uploadDir({
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      privateKey: target.privateKey,
      passphrase: target.passphrase,
      localDir: localPath,
      remoteDir,
      cleanSlate: false,
      exclude: ['node_modules', '.git', 'dist', '.next', 'build'],
      onLog: (l) => pushLog(job, l),
    });
  } catch (err) {
    throw new Error(friendlyError(err));
  }
  if (job.cancelled) return;

  // 2. Remote install + build + start (pm2). Inject build env + PORT.
  setStatus(job, 'building');
  const appName = (config.appName || 'app').replace(/[^A-Za-z0-9_-]/g, '');
  const appPort = Number(config.appPort) || 3000;
  const env = { ...buildEnv, PORT: String(appPort) };
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}=${JSON.stringify(String(v))}`)
    .join(' ');
  const defaultCmd =
    `cd ${remoteDir} && command -v pm2 >/dev/null 2>&1 || npm install -g pm2; ${envPrefix ? envPrefix + ' ' : ''}npm install && (npm run build || true) && ` +
    `(pm2 delete ${appName} >/dev/null 2>&1; ${envPrefix ? envPrefix + ' ' : ''}pm2 start npm --name ${appName} -- run start) && pm2 save`;
  const remoteCommand = config.remoteCommand || defaultCmd;
  pushLog(job, `[node] ejecutando: ${remoteCommand}`);
  try {
    const { code } = await sshExec.exec(
      {
        host: target.host,
        port: target.port,
        username: target.username,
        password: target.password,
        privateKey: target.privateKey,
        passphrase: target.passphrase,
      },
      remoteCommand,
      { onLog: (l) => pushLog(job, l) },
    );
    if (code !== 0) throw new Error(`El comando remoto terminó con código ${code}`);
  } catch (err) {
    throw new Error(friendlyError(err));
  }
  if (job.cancelled) return;

  // VPS: reverse-proxy the domain → the app port via nginx.
  if (config.configureNginx && config.domain) {
    await _configureNginx(job, target, { domain: config.domain, appPort, ssl: config.ssl, email: config.sslEmail });
  } else {
    pushLog(job, '[node] recuerda: configura nginx/proxy para servir la app en tu dominio.');
  }
  await _finish(job, target);
}

/** Configure nginx on the VPS (static web root OR reverse proxy) over SSH. */
async function _configureNginx(job, target, { domain, webroot, appPort, ssl, email }) {
  const dom = normalizeDomain(domain).host;
  pushLog(job, `[nginx] configurando ${dom} en el VPS…`);
  const command = appPort
    ? nginx.proxySetupCommand({ domain: dom, port: appPort, ssl, email })
    : nginx.staticSetupCommand({ domain: dom, webroot, ssl, email });
  try {
    const { code } = await sshExec.exec(
      {
        host: target.host,
        port: target.port,
        username: target.username,
        password: target.password,
        privateKey: target.privateKey,
        passphrase: target.passphrase,
      },
      command,
      { onLog: (l) => pushLog(job, l) },
    );
    if (code !== 0) throw new Error(`nginx terminó con código ${code}`);
    pushLog(job, `[nginx] ✓ ${dom} servido por nginx`);
  } catch (err) {
    // Don't fail the whole deploy if nginx config fails — files are uploaded.
    pushLog(job, `[nginx] ⚠ no se pudo configurar nginx: ${friendlyError(err)}`);
  }
}

async function _finish(job, target) {
  // Post-deploy verification — confirm the site actually responds.
  let url = target.siteUrl || null;
  if (url) {
    pushLog(job, `[verify] comprobando ${url} …`);
    const v = await verifyUrl(url);
    pushLog(job, v.reachable ? `[verify] ✓ en vivo (HTTP ${v.status}, ${v.ms}ms)` : `[verify] ⚠ no responde (${v.error || v.status})`);
  }
  setStatus(job, 'success', { url, finishedAt: new Date().toISOString() });
  pushLog(job, '[deploy] ✓ completado' + (url ? ` — ${url}` : ''));
}

process.once('exit', () => {
  for (const job of jobs.values()) {
    try {
      job.abort.abort();
    } catch {
      /* ignore */
    }
  }
});

module.exports = { start, cancel, status, subscribe, isDisabled, isRunningForConnection, transportFor, friendlyError, _jobs: jobs };
