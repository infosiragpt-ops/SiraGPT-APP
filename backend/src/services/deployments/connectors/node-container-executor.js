'use strict';

/**
 * deployments/connectors/node-container-executor — REAL full-stack Node app
 * deploy as a Docker container behind Caddy, for a Deployments-module
 * deployment running on the SiraGPT VPS (Docker + Caddy).
 *
 * Each app runs in its OWN container `app-<slug>` on the SiraGPT Docker
 * network; Caddy reverse-proxies `<domain> → app-<slug>:PORT` via a per-app
 * snippet. Database is HYBRID: if the user supplied DATABASE_URL in secrets we
 * use it; otherwise we provision a dedicated Postgres DB+role on the VPS `db`
 * container and inject the generated DATABASE_URL.
 *
 * Everything runs over SSH (reuses hosting/ssh-exec + sftp-transport), exactly
 * like hostinger-vps-executor. NEVER throws — a failure is a failed publish
 * with helpful logs. Secrets (DATABASE_URL, passwords) are passed via base64
 * files / --env-file and are NEVER written to the log buffer.
 *
 * Contract: `{ promoted, logs[], url, failedPhase, failureMessage,
 *              databaseConnected?, databaseProvider?, databaseUrl? }`.
 * All deps injectable so unit tests run offline (no fs/net).
 */

const crypto = require('node:crypto');

const RESERVED_SLUGS = new Set(['db', 'backend', 'frontend', 'caddy', 'redis', 'postgres']);

function cfg(env, key, fallback) {
  const v = env && env[key];
  return (typeof v === 'string' && v.trim()) ? v.trim() : fallback;
}

function b64(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

/** Single-quote a value for a POSIX shell. */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Derive a safe slug — the ONLY user-influenced token that flows into shell /
 * docker / psql / caddy commands. Restricted to [a-z0-9-], ≤40 chars, and
 * never a reserved SiraGPT container name.
 */
function safeSlug(deployment) {
  const raw = String((deployment && (deployment.subdomain || deployment.name || deployment.id)) || 'app');
  let slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  if (!slug) {
    const idPart = String((deployment && deployment.id) || '').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12);
    slug = `app-${idPart || 'x'}`;
  }
  if (RESERVED_SLUGS.has(slug) || /^siragpt/.test(slug)) slug = `app-${slug}`;
  return slug;
}

/** Postgres identifier from a slug (hyphens → underscores). */
function dbIdent(slug) {
  return `app_${slug.replace(/-/g, '_')}`;
}

/** Idempotent provisioning SQL — re-running never rotates an existing password. */
function buildProvisionSql(dbName, dbUser, dbPass) {
  return [
    'DO $$ BEGIN',
    `  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${pgLit(dbUser)}) THEN`,
    `    CREATE ROLE "${dbUser}" LOGIN PASSWORD ${pgLit(dbPass)};`,
    '  END IF;',
    'END $$;',
    `SELECT 'CREATE DATABASE "${dbName}" OWNER "${dbUser}"'`,
    `  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = ${pgLit(dbName)})\\gexec`,
    `GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${dbUser}";`,
    // Postgres 15+ stopped granting CREATE on the `public` schema to non-schema
    // owners. The role owns the DATABASE but not the public SCHEMA, so without
    // this a `prisma migrate deploy` fails with "permission denied for schema
    // public". Switch into the new DB and hand the public schema to the role.
    `\\connect "${dbName}"`,
    `GRANT ALL ON SCHEMA public TO "${dbUser}";`,
    `ALTER SCHEMA public OWNER TO "${dbUser}";`,
    '',
  ].join('\n');
}

/** Postgres string literal (single-quote escaped). dbName/user are [a-z0-9_]; pass is hex. */
function pgLit(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** A Caddy site block proxying a domain to the app container. */
function buildCaddySnippet(domain, containerName, port) {
  return `${domain} {\n\treverse_proxy ${containerName}:${port}\n}\n`;
}

/** Generic Node Dockerfile (works for Next.js + plain Node; keeps devDeps for build). */
function generateDockerfile(port) {
  return [
    'FROM node:20-alpine',
    'WORKDIR /app',
    'COPY package*.json ./',
    'RUN npm ci || npm install',
    'COPY . .',
    'RUN npm run build || true',
    `ENV PORT=${port}`,
    `EXPOSE ${port}`,
    'CMD ["npm", "run", "start"]',
    '',
  ].join('\n');
}

/** Build an env-file body (KEY=value per line; newlines in values stripped). */
function buildEnvFile(envObj) {
  return Object.entries(envObj)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, ' ')}`)
    .join('\n') + '\n';
}

/**
 * Deploy `deployment` as a Docker container behind Caddy.
 * Caller (deployHostingerVps) provides the resolved deps + ssh conn + workspace.
 */
async function deployNodeContainer({ d, conn, localPath, buildEnv, slug, hostname, deployment, env, push, logs }) {
  const fail = (failedPhase, failureMessage) => {
    push(`[error] ${failureMessage}`);
    return { promoted: false, logs, url: null, failedPhase, failureMessage };
  };

  const dockerNet = cfg(env, 'SIRAGPT_DOCKER_NETWORK', 'siragpt_default');
  const dbContainer = cfg(env, 'SIRAGPT_DB_CONTAINER', 'siragpt-db');
  const caddyContainer = cfg(env, 'SIRAGPT_CADDY_CONTAINER', 'siragpt-caddy');
  const appsDir = cfg(env, 'PUBLISHED_APPS_DIR', '/opt/siragpt/apps');
  const snippetsDir = cfg(env, 'CADDY_SNIPPETS_DIR', '/etc/caddy/apps');
  const appDir = `${appsDir}/${slug}`;
  const containerName = `app-${slug}`;
  const image = `siragpt-app-${slug}:latest`;
  const port = Number(deployment.externalPort) || 8080;
  const mem = deployment.memoryMb ? `${deployment.memoryMb}m` : '512m';
  const cpus = deployment.cpu ? String(deployment.cpu) : '1';

  // ── 1. Database (hybrid) ──────────────────────────────────────────
  let databaseUrl = String(buildEnv.DATABASE_URL || '').trim();
  let databaseProvider = 'external';
  let provisioned = false;
  if (databaseUrl) {
    push('[db] usando DATABASE_URL provisto en los secretos (sin provisión)');
  } else {
    push('[db] provisionando base de datos Postgres dedicada…');
    const ident = dbIdent(slug);
    // Deterministic per-app password (HMAC of a server secret + ident): a
    // redeploy derives the SAME password, so the idempotent CREATE ROLE (which
    // never rotates an existing password) and the injected DATABASE_URL always
    // agree — no persistence needed.
    const secret = cfg(env, 'SIRAGPT_DB_PASSWORD_SECRET', cfg(env, 'ENCRYPTION_KEY', cfg(env, 'JWT_SECRET', 'siragpt-db-seed')));
    const dbPass = crypto.createHmac('sha256', secret).update(`db:${ident}`).digest('hex').slice(0, 32);
    const superUser = cfg(env, 'SIRAGPT_DB_SUPERUSER', 'postgres');
    const superPass = cfg(env, 'SIRAGPT_DB_SUPERUSER_PASSWORD', cfg(env, 'POSTGRES_PASSWORD', ''));
    const sql = buildProvisionSql(ident, ident, dbPass);
    const provisionCmd =
      `printf %s ${shQuote(b64(sql))} | base64 -d | ` +
      `PGPASSWORD=${shQuote(superPass)} docker exec -i -e PGPASSWORD ${dbContainer} ` +
      `psql -v ON_ERROR_STOP=1 -U ${shQuote(superUser)} -d postgres`;
    // Redact the random password if it ever shows up in psql output.
    const redacted = (l) => push(String(l).split(dbPass).join('***'));
    try {
      const { code } = await d.sshExec.exec(conn, provisionCmd, { onLog: redacted });
      if (code !== 0) return fail('provision', 'no se pudo provisionar la base de datos');
    } catch (err) {
      return fail('provision', d.friendlyError(err));
    }
    databaseUrl = `postgres://${ident}:${dbPass}@db:5432/${ident}`;
    databaseProvider = 'sira-postgres';
    provisioned = true;
    push(`[db] ✓ base de datos "${ident}" lista`);
  }

  // ── 2. Upload source ──────────────────────────────────────────────
  push(`[build] subiendo código fuente → ${appDir}`);
  try {
    await d.sftp.uploadDir({
      ...conn,
      localDir: localPath,
      remoteDir: appDir,
      cleanSlate: true,
      exclude: ['node_modules', '.git', 'dist', '.next', 'build', '.env'],
      onLog: push,
    });
  } catch (err) {
    return fail('build', d.friendlyError(err));
  }

  // ── 3. Build image (generate Dockerfile if the repo lacks one) ────
  const dockerfile = generateDockerfile(port);
  const buildCmd =
    `cd ${appDir} && ([ -f Dockerfile ] || (printf %s ${shQuote(b64(dockerfile))} | base64 -d > Dockerfile)) && ` +
    `docker build -t ${image} .`;
  push('[build] construyendo imagen Docker…');
  try {
    const { code } = await d.sshExec.exec(conn, buildCmd, { onLog: push });
    if (code !== 0) return fail('build', `docker build terminó con código ${code}`);
  } catch (err) {
    return fail('build', d.friendlyError(err));
  }

  // ── 4. Run container (replace-on-redeploy) ────────────────────────
  const containerEnv = { NODE_ENV: 'production', ...buildEnv, DATABASE_URL: databaseUrl, PORT: String(port) };
  const envFileB64 = b64(buildEnvFile(containerEnv));
  const runCmd = [
    `cd ${appDir} || exit 1`,
    `printf %s ${shQuote(envFileB64)} | base64 -d > .deploy.env && chmod 600 .deploy.env`,
    `docker rm -f ${containerName} >/dev/null 2>&1 || true`,
    `docker run -d --name ${containerName} --restart unless-stopped --network ${dockerNet} ` +
      `--env-file .deploy.env -e PORT=${port} --memory ${mem} --cpus ${cpus} ` +
      `--log-opt max-size=10m --log-opt max-file=3 ` +
      `--health-cmd ${shQuote(`wget -qO- http://localhost:${port}/ || exit 1`)} --health-interval=10s ` +
      `--label siragpt.app=${slug} ${image}; RUN_CODE=$?`,
    `rm -f .deploy.env`,
    `exit $RUN_CODE`,
  ].join('\n');
  push('[bundle] arrancando contenedor…');
  try {
    const { code } = await d.sshExec.exec(conn, runCmd, { onLog: push });
    if (code !== 0) return fail('bundle', `docker run terminó con código ${code}`);
  } catch (err) {
    return fail('bundle', d.friendlyError(err));
  }

  // ── 5. Migrations (best-effort, configurable) ─────────────────────
  const migrate = String(buildEnv.MIGRATE_COMMAND || '').trim() || (d.hasPrismaSchema ? 'npx prisma migrate deploy' : '');
  if (migrate) {
    push(`[bundle] migraciones: ${migrate}`);
    try {
      const { code } = await d.sshExec.exec(conn, `docker exec ${containerName} sh -lc ${shQuote(migrate)}`, { onLog: push });
      if (code !== 0) push(`[bundle] ⚠ migraciones terminaron con código ${code} (continuando)`);
    } catch (err) {
      push(`[bundle] ⚠ migraciones fallaron: ${d.friendlyError(err)}`);
    }
  }

  // ── 6. Caddy reverse-proxy (validate before reload) ───────────────
  let url = null;
  if (hostname) {
    push(`[promote] registrando ${hostname} en Caddy → ${containerName}:${port}…`);
    const snippet = buildCaddySnippet(hostname, containerName, port);
    const snippetPath = `${snippetsDir}/${hostname}.caddy`;
    const caddyCmd = [
      `mkdir -p ${snippetsDir}`,
      `printf %s ${shQuote(b64(snippet))} | base64 -d > ${shQuote(snippetPath)}`,
      `docker exec ${caddyContainer} caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && ` +
        `docker exec ${caddyContainer} caddy reload --config /etc/caddy/Caddyfile || ` +
        `{ rm -f ${shQuote(snippetPath)}; echo "[caddy] config inválida — snippet revertido"; exit 1; }`,
    ].join('\n');
    try {
      const { code } = await d.sshExec.exec(conn, caddyCmd, { onLog: push });
      if (code !== 0) return fail('promote', 'no se pudo configurar Caddy (config revertida — SiraGPT intacto)');
      url = `https://${hostname}`;
      push(`[promote] ✓ Caddy sirviendo ${hostname}`);
    } catch (err) {
      return fail('promote', d.friendlyError(err));
    }
  } else {
    push('[promote] sin dominio — el contenedor corre en la red, añade un dominio para exponerlo');
  }

  // ── 7. Health check ───────────────────────────────────────────────
  // A crashed container fails the deploy; a container that is up but whose `/`
  // doesn't return 200 (common for an API) passes with a note — we don't want a
  // false failure for apps that only expose /api routes.
  push('[promote] comprobando salud del contenedor…');
  const healthCmd =
    `sleep 3; ok=0; ` +
    `for i in $(seq 1 20); do ` +
    `running=$(docker inspect -f '{{.State.Running}}' ${containerName} 2>/dev/null || echo false); ` +
    `if [ "$running" != "true" ]; then echo "[health] el contenedor se detuvo (crash):"; docker logs --tail 50 ${containerName} 2>&1 || true; exit 1; fi; ` +
    `if docker exec ${containerName} wget -q -T 3 -O /dev/null http://localhost:${port}/ 2>/dev/null; then ok=1; break; fi; ` +
    `sleep 2; done; ` +
    `if [ "$ok" = "1" ]; then echo "[health] ✓ responde HTTP en :${port}"; else echo "[health] ⚠ contenedor activo pero / no devolvió 200 (normal para una API)"; fi; exit 0`;
  try {
    const { code } = await d.sshExec.exec(conn, healthCmd, { onLog: push });
    if (code !== 0) return fail('promote', 'el contenedor se detuvo (crash) — revisa los logs arriba');
  } catch (err) {
    return fail('promote', d.friendlyError(err));
  }

  push('[promote] ✓ deploy completado');
  return {
    promoted: true,
    logs,
    url,
    failedPhase: null,
    failureMessage: null,
    databaseConnected: true,
    databaseProvider,
    // Plaintext only on first provision so the caller can seal + reuse it.
    databaseUrl: provisioned ? databaseUrl : undefined,
  };
}

module.exports = {
  deployNodeContainer,
  safeSlug,
  dbIdent,
  buildProvisionSql,
  buildCaddySnippet,
  generateDockerfile,
  buildEnvFile,
};
