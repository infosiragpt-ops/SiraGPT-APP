'use strict';

/**
 * deployments/connectors/hostinger-vps-executor — REAL Hostinger VPS deploy for
 * a Deployments-module deployment whose `deploymentType === 'hostinger_vps'`.
 *
 * Bridges the Deployments module (UX, versions, runtime logs) to the hosting
 * engine (build + SFTP/ssh2 + nginx). This is the executor that makes the
 * provider-connectors `hostinger_vps` plan ACTUALLY run, instead of the
 * synthetic publish pipeline.
 *
 *   File source  (Model A, git-backed): the deployment carries
 *                `connectedRepositoryId` → its cloned workspace `localPath` is
 *                the build/source dir.
 *   Credentials  (provider-connectors design): server-wide env
 *                `HOSTINGER_VPS_*` (host/user/key/port/app-path).
 *   Build secrets: per-connection sealed `deploy_envs` (DATABASE_URL, …),
 *                injected into install/build/runtime.
 *
 * Contract: resolves `{ promoted, logs[], url, failedPhase, failureMessage }`.
 * NEVER throws — a failure is a failed publish with helpful logs. All deps are
 * injectable so the unit tests run offline (no fs/net).
 */

const path = require('path');
const fs = require('node:fs');
const { deployNodeContainer, safeSlug } = require('./node-container-executor');

function defaultDeps() {
  return {
    connectedRepos: require('../../../repositories/ConnectedRepositoryRepository'),
    workspaces: require('../../../repositories/WorkspaceRepository'),
    workspaceManager: require('../../github/workspace-manager'),
    buildService: require('../../hosting/build.service'),
    sftp: require('../../hosting/sftp-transport'),
    sshExec: require('../../hosting/ssh-exec'),
    nginx: require('../../hosting/nginx.service'),
    creds: require('../../hosting/credentials'),
    deployEnvs: require('../../../repositories/DeployEnvRepository'),
    providers: require('../provider-connectors'),
    friendlyError: require('../../hosting/deploy.service').friendlyError,
  };
}

function envValue(env, key) {
  const v = env && env[key];
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

function makeLogger(onLog) {
  const logs = [];
  const push = (line) => {
    for (const part of String(line).split('\n')) {
      const t = part.replace(/\s+$/, '');
      if (!t) continue;
      logs.push(t);
      try { onLog(t); } catch { /* ignore */ }
    }
  };
  return { logs, push };
}

/** Connection config for sftp/ssh from the server-wide HOSTINGER_VPS_* env. */
function sshConfigFromEnv(target, env) {
  return {
    host: target.host,
    port: Number(target.sshPort) || 22,
    username: target.user || 'root',
    privateKey: envValue(env, 'HOSTINGER_VPS_SSH_PRIVATE_KEY') || undefined,
    passphrase: envValue(env, 'HOSTINGER_VPS_SSH_PASSPHRASE') || undefined,
    password: envValue(env, 'HOSTINGER_VPS_PASSWORD') || undefined,
  };
}

/** Node app deploy: upload source → ssh install/build/pm2 → nginx proxy. */
async function deployNode({ d, conn, target, localPath, buildEnv, appName, hostname, push, logs }) {
  const appPath = target.appPath;
  const appPort = Number(target.appPort) || 3000;

  push(`[build] subiendo código fuente → ${appPath}`);
  try {
    await d.sftp.uploadDir({
      ...conn,
      localDir: localPath,
      remoteDir: appPath,
      cleanSlate: false,
      exclude: ['node_modules', '.git', 'dist', '.next', 'build'],
      onLog: push,
    });
  } catch (err) {
    return { promoted: false, logs, url: null, failedPhase: 'build', failureMessage: d.friendlyError(err) };
  }

  const env = { ...buildEnv, PORT: String(appPort) };
  const envPrefix = Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join(' ');
  const prefix = envPrefix ? `${envPrefix} ` : '';
  const cmd =
    `cd ${appPath} && command -v pm2 >/dev/null 2>&1 || npm install -g pm2; ${prefix}npm install && (npm run build || true) && ` +
    `(pm2 delete ${appName} >/dev/null 2>&1; ${prefix}pm2 start npm --name ${appName} -- run start) && pm2 save`;
  push('[bundle] instalando dependencias + build + arranque (pm2)…');
  try {
    const { code } = await d.sshExec.exec(conn, cmd, { onLog: push });
    if (code !== 0) return { promoted: false, logs, url: null, failedPhase: 'bundle', failureMessage: `el comando remoto terminó con código ${code}` };
  } catch (err) {
    return { promoted: false, logs, url: null, failedPhase: 'bundle', failureMessage: d.friendlyError(err) };
  }

  let url = null;
  if (hostname) {
    push(`[promote] configurando nginx (reverse proxy → :${appPort}) para ${hostname}…`);
    try {
      const ncmd = d.nginx.proxySetupCommand({ domain: hostname, port: appPort });
      const { code } = await d.sshExec.exec(conn, ncmd, { onLog: push });
      if (code === 0) { url = `http://${hostname}`; push(`[promote] ✓ nginx sirviendo ${hostname}`); }
      else push(`[promote] ⚠ nginx terminó con código ${code} — la app sigue corriendo en :${appPort}`);
    } catch (err) {
      push(`[promote] ⚠ no se pudo configurar nginx: ${d.friendlyError(err)}`);
    }
  } else if (target.publicIp) {
    url = `http://${target.publicIp}:${appPort}`;
    push(`[promote] sin dominio — la app responde en ${url} (añade un dominio en Domains)`);
  }
  push('[promote] ✓ deploy completado');
  return { promoted: true, logs, url, failedPhase: null, failureMessage: null };
}

/** Static app deploy: build locally → upload output → nginx static. */
async function deployStatic({ d, conn, target, localPath, buildPlan, buildEnv, deployment, hostname, push, logs }) {
  push('[build] build local del proyecto…');
  d.buildService.ensureViteEntry(localPath, push);
  const buildCommand = deployment.buildCommand != null ? deployment.buildCommand : buildPlan.buildCommand;
  try {
    await d.buildService.runBuild(localPath, { buildCommand, onLog: push, env: buildEnv });
  } catch (err) {
    return { promoted: false, logs, url: null, failedPhase: 'build', failureMessage: (err && err.message) || 'build fallido' };
  }
  const outDir = d.buildService.resolveOutputDir(localPath, deployment.publicDir || buildPlan.outputDir);
  const localDir = path.resolve(localPath, outDir);
  if (outDir !== '.' && !d.buildService.dirHasFiles(localDir)) {
    return { promoted: false, logs, url: null, failedPhase: 'bundle', failureMessage: `el directorio de salida "${outDir}" está vacío` };
  }
  if (d.buildService.ensureSpaHtaccess(localDir)) push('[bundle] añadido .htaccess (SPA routing)');

  const webroot = `${String(target.appPath).replace(/\/$/, '')}/public`;
  push(`[bundle] subiendo build → ${webroot}`);
  try {
    await d.sftp.uploadDir({ ...conn, localDir, remoteDir: webroot, cleanSlate: true, onLog: push });
  } catch (err) {
    return { promoted: false, logs, url: null, failedPhase: 'bundle', failureMessage: d.friendlyError(err) };
  }

  let url = null;
  if (hostname) {
    push(`[promote] configurando nginx (static) para ${hostname}…`);
    try {
      const ncmd = d.nginx.staticSetupCommand({ domain: hostname, webroot });
      const { code } = await d.sshExec.exec(conn, ncmd, { onLog: push });
      if (code === 0) { url = `http://${hostname}`; push(`[promote] ✓ nginx sirviendo ${hostname}`); }
      else push(`[promote] ⚠ nginx terminó con código ${code}`);
    } catch (err) {
      push(`[promote] ⚠ no se pudo configurar nginx: ${d.friendlyError(err)}`);
    }
  }
  push('[promote] ✓ deploy completado');
  return { promoted: true, logs, url, failedPhase: null, failureMessage: null };
}

/**
 * Run a real Hostinger VPS deploy for `deployment`.
 * @param {object}  opts
 * @param {object}  opts.deployment           public deployment row (needs connectedRepositoryId, externalPort, …)
 * @param {string}  opts.userId               owner (ownership-checks the repo)
 * @param {object}  [opts.env]                process.env (HOSTINGER_VPS_* config)
 * @param {string}  [opts.hostname]           primary custom domain for nginx (optional)
 * @param {Function}[opts.onLog]              streaming log sink
 * @param {object}  [opts.deps]               injectable deps (tests)
 */
async function deployHostingerVps({ deployment, userId, env = process.env, hostname = null, onLog = () => {}, deps } = {}) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const { logs, push } = makeLogger(onLog);
  const fail = (failedPhase, failureMessage) => {
    push(`[error] ${failureMessage}`);
    return { promoted: false, logs, url: null, failedPhase, failureMessage };
  };

  try {
    // 1. Provider readiness + target (server-wide HOSTINGER_VPS_* env).
    const plan = d.providers.buildConnectionPlan({ providerId: 'hostinger_vps', deployment, env });
    if (!plan.ready) {
      return fail('provision', `Hostinger VPS no configurado: faltan ${plan.provider.missingRequired.join(', ')}`);
    }
    const target = plan.target;
    const conn = sshConfigFromEnv(target, env);
    if (!conn.privateKey && !conn.password) {
      return fail('provision', 'Falta la clave SSH (HOSTINGER_VPS_SSH_PRIVATE_KEY) para conectar al VPS');
    }
    push(`[provision] VPS ${conn.username}@${conn.host}:${conn.port} → ${target.appPath}`);

    // 2. Resolve the git-backed workspace (Model A).
    const connectedRepositoryId = deployment.connectedRepositoryId;
    if (!connectedRepositoryId) {
      return fail('provision', 'Este deployment no tiene un repo de GitHub vinculado. Conecta un repo en la pestaña Git y vuelve a publicar.');
    }
    const connection = await d.connectedRepos.findByIdForUser(connectedRepositoryId, userId);
    if (!connection) return fail('provision', 'Repositorio conectado no encontrado para este usuario.');
    const workspace = await d.workspaces.findByRepositoryId(connection.id);
    if (!workspace || !d.workspaceManager.isGitRepo(workspace.localPath)) {
      return fail('provision', 'El repositorio aún no está clonado en el servidor — clónalo primero.');
    }
    const localPath = workspace.localPath;
    try { d.workspaceManager.ensureLocalExcludes(localPath); } catch { /* non-fatal */ }

    // 3. Build-time secrets for this connection (DATABASE_URL, VITE_*, …).
    const envRow = await d.deployEnvs.findForConnection(connection.id, userId);
    const buildEnv = envRow ? d.creds.openJson(envRow.encryptedEnv) : {};
    push(`[provision] ${Object.keys(buildEnv).length} secreto(s) de build cargados`);

    // 4. Static vs Node (full-stack) — decide from the build plan.
    const buildPlan = d.buildService.detectBuildPlan(localPath);
    const appName = String(deployment.subdomain || deployment.name || 'app').replace(/[^A-Za-z0-9_-]/g, '') || 'app';
    const mode = String(buildEnv.DEPLOY_MODE || '').toLowerCase();
    const isStatic = mode === 'static' || (mode !== 'container' && mode !== 'node' && (buildPlan.kind === 'static' || buildPlan.framework === 'static'));
    if (isStatic) {
      return await deployStatic({ d, conn, target, localPath, buildPlan, buildEnv, deployment, hostname, push, logs });
    }
    // Full-stack Node: container-per-app behind Caddy (opt-in for Docker/Caddy
    // VPS) vs legacy pm2+nginx. Container mode is enabled when the VPS runtime
    // is declared (SIRAGPT_DEPLOY_RUNTIME=container|docker or SIRAGPT_DOCKER_NETWORK set).
    const runtimeIsContainer =
      /^(container|docker)$/i.test(String(env.SIRAGPT_DEPLOY_RUNTIME || '')) ||
      Boolean(String(env.SIRAGPT_DOCKER_NETWORK || '').trim());
    if (runtimeIsContainer) {
      const slug = safeSlug(deployment);
      let hasPrismaSchema = false;
      try { hasPrismaSchema = fs.existsSync(path.join(localPath, 'prisma', 'schema.prisma')); } catch { /* ignore */ }
      return await deployNodeContainer({ d: { ...d, hasPrismaSchema }, conn, localPath, buildEnv, slug, hostname, deployment, env, push, logs });
    }
    return await deployNode({ d, conn, target, localPath, buildEnv, appName, hostname, push, logs });
  } catch (err) {
    return fail('promote', d.friendlyError ? d.friendlyError(err) : (err && err.message) || 'deploy fallido');
  }
}

module.exports = { deployHostingerVps, envValue, sshConfigFromEnv };
