'use strict';

/**
 * deployments/deployment-service — Deployment / DeploymentVersion / domain CRUD
 * + the publish & rollback lifecycle. The Prisma client is injectable (default:
 * shared client) so the route stays thin and the tests stay offline. All reads
 * and writes are scoped by userId (ownership) — never trust a deployment id
 * alone.
 */

const pipeline = require('./pipeline');
const providers = require('./provider-connectors');
const { deployHostingerVps } = require('./connectors/hostinger-vps-executor');
const crypto = require('node:crypto');
const { redactPayloadDeep } = require('../../utils/log-redaction');
const { logger } = require('../../utils/logger');

const defaultPrisma = (() => {
  try { return require('../../config/database'); } catch { return null; }
})();

class DeploymentError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function requireDb(db) {
  if (!db || !db.deployment) throw new DeploymentError(500, 'db_unavailable', 'database unavailable');
  return db;
}

/**
 * Run `fn` inside an interactive Prisma transaction when the client supports it,
 * otherwise fall back to running it directly against the client. Keeps the
 * create+demote version flip atomic on real Postgres while staying compatible
 * with thin in-memory test doubles that don't implement `$transaction`.
 */
function runInTransaction(db, fn) {
  return typeof db.$transaction === 'function' ? db.$transaction((tx) => fn(tx)) : fn(db);
}

function clampStr(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : v;
}

const LOG_SOURCES = new Set(['User', 'System', 'Runtime']);
const LOG_LEVELS = new Set(['info', 'warn', 'error']);
const MAX_LOG_MESSAGE_CHARS = 8000;

function deploymentLogSecret(env = process.env) {
  return env.DEPLOYMENT_LOG_TOKEN_SECRET || env.JWT_SECRET || env.SESSION_SECRET || env.NEXTAUTH_SECRET || 'siragpt-development-deployment-log-token';
}

function deploymentLogToken(row, env = process.env) {
  const h = crypto.createHmac('sha256', deploymentLogSecret(env));
  h.update(`${row.userId}:${row.id}`);
  return h.digest('hex');
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyDeploymentLogToken(row, token, env = process.env) {
  return constantTimeEqual(token, deploymentLogToken(row, env));
}

function normalizeLogSource(source) {
  return LOG_SOURCES.has(source) ? source : 'Runtime';
}

function normalizeLogLevel(level, message = '') {
  if (LOG_LEVELS.has(level)) return level;
  return /\b(error|failed|fail|exception|rejection|crash|timeout)\b/i.test(String(message)) ? 'error' : 'info';
}

function redactLogText(value) {
  return String(value || '')
    .replace(/\b(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b((?:access|refresh|id)[_-]?token\s*[:=]\s*)["']?[^"',\s&]+/gi, '$1[REDACTED]')
    .replace(/\b((?:api[_-]?key|secret|password|passwd|pwd|token)\s*[:=]\s*)["']?[^"',\s&]+/gi, '$1[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
    .replace(/\b([A-Za-z0-9_]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g, '[REDACTED]');
}

function normalizeRuntimeLogPayload(input = {}) {
  const redacted = redactPayloadDeep(input);
  const parts = [];
  if (redacted.message) parts.push(String(redacted.message));
  if (redacted.url) parts.push(`url=${redacted.url}`);
  if (redacted.line || redacted.column) parts.push(`at=${redacted.line || '?'}:${redacted.column || '?'}`);
  if (redacted.stack) parts.push(String(redacted.stack));
  if (parts.length === 0) parts.push(JSON.stringify(redacted));
  const message = clampStr(redactLogText(parts.join(' | ')), MAX_LOG_MESSAGE_CHARS);
  return {
    source: normalizeLogSource(redacted.source),
    level: normalizeLogLevel(redacted.level, message),
    message,
  };
}

function publicLogEntry(row, versionHash = null, index = undefined) {
  if (!row) return null;
  return {
    id: row.id,
    ts: row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt || Date.now()).toISOString(),
    source: normalizeLogSource(row.source),
    level: normalizeLogLevel(row.level, row.message),
    message: String(row.message || ''),
    deployment: versionHash,
    ...(Number.isFinite(index) ? { index } : {}),
  };
}

async function persistDeploymentLogs(prisma, rows) {
  if (!prisma.deploymentLog || !Array.isArray(rows) || rows.length === 0) return;
  const data = rows.map((row) => ({
    deploymentId: row.deploymentId,
    versionId: row.versionId || null,
    source: normalizeLogSource(row.source),
    level: normalizeLogLevel(row.level, row.message),
    message: clampStr(redactLogText(row.message), MAX_LOG_MESSAGE_CHARS),
    createdAt: row.createdAt || new Date(),
  }));
  if (typeof prisma.deploymentLog.createMany === 'function') {
    await prisma.deploymentLog.createMany({ data });
    return;
  }
  for (const entry of data) await prisma.deploymentLog.create({ data: entry });
}

async function seedVersionLogs(prisma, version, buildLog) {
  if (!prisma.deploymentLog || !version) return;
  const baseMs = version.createdAt ? new Date(version.createdAt).getTime() : Date.now();
  const parsed = pipeline.parseLogEntries(buildLog, baseMs);
  await persistDeploymentLogs(prisma, parsed.map((entry) => ({
    deploymentId: version.deploymentId,
    versionId: version.id,
    source: entry.source,
    level: entry.level,
    message: entry.message,
    createdAt: new Date(entry.ts),
  })));
}

function publicDeployment(row) {
  if (!row) return null;
  const spec = pipeline.machineSpec(row.deploymentType, row.machineTier);
  const subdomain = row.subdomain || pipeline.slugifySubdomain(row.name, row.id);
  const logIngestToken = deploymentLogToken(row);
  return {
    id: row.id,
    name: row.name,
    projectId: row.projectId,
    deploymentType: row.deploymentType,
    typeLabel: pipeline.DEPLOYMENT_TYPE_LABELS[row.deploymentType] || row.deploymentType,
    status: row.status,
    suspendedReason: row.suspendedReason,
    visibility: row.visibility,
    geography: row.geography,
    geographyLabel: pipeline.GEOGRAPHY_LABELS[row.geography] || row.geography,
    machineTier: row.machineTier,
    machineLabel: spec.label,
    monthlyUsd: spec.monthlyUsd,
    cpu: row.cpu,
    memoryMb: row.memoryMb,
    subdomain,
    defaultDomain: pipeline.defaultDomain(subdomain),
    logIngestPath: `/api/deployments/${row.id}/logs/ingest`,
    logIngestToken,
    runtimeMonitorScriptPath: `/api/deployments/${row.id}/logs/client.js?token=${logIngestToken}`,
    buildCommand: row.buildCommand,
    runCommand: row.runCommand,
    publicDir: row.publicDir,
    externalPort: row.externalPort,
    databaseConnected: row.databaseConnected,
    databaseProvider: row.databaseProvider,
    currentVersionId: row.currentVersionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function publicVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    deploymentId: row.deploymentId,
    shortHash: row.shortHash,
    status: row.status,
    isLive: row.isLive,
    isRollback: row.isRollback,
    rolledBackFromId: row.rolledBackFromId,
    publishedById: row.publishedById,
    securityScan: row.securityScan,
    createdAt: row.createdAt,
  };
}

function publicDomain(row) {
  if (!row) return null;
  return {
    id: row.id,
    deploymentId: row.deploymentId,
    hostname: row.hostname,
    kind: row.kind,
    isPrimary: row.isPrimary,
    verificationStatus: row.verificationStatus,
    tlsStatus: row.tlsStatus,
    dnsRecords: row.dnsRecords,
    createdAt: row.createdAt,
  };
}

async function loadOwned(prisma, userId, id) {
  const row = await prisma.deployment.findFirst({ where: { id, userId, deletedAt: null } });
  if (!row) throw new DeploymentError(404, 'deployment_not_found', 'deployment not found');
  return row;
}

function normalizedTierFor(deploymentType, machineTier) {
  if (deploymentType === 'reserved_vm') return machineTier && pipeline.RESERVED_TIERS[machineTier] ? machineTier : '1vcpu_4gb';
  return deploymentType;
}

async function createDeployment({ userId, name, projectId = null, connectedRepositoryId = null, deploymentType = 'autoscale', visibility = 'public', geography = 'na', machineTier, db = defaultPrisma }) {
  const prisma = requireDb(db);
  if (!pipeline.DEPLOYMENT_TYPES.includes(deploymentType)) throw new DeploymentError(400, 'invalid_type', 'invalid deployment type');
  if (!pipeline.VISIBILITIES.includes(visibility)) throw new DeploymentError(400, 'invalid_visibility', 'invalid visibility');
  if (!pipeline.GEOGRAPHIES.includes(geography)) throw new DeploymentError(400, 'invalid_geography', 'invalid geography');
  const tier = normalizedTierFor(deploymentType, machineTier);
  const spec = pipeline.machineSpec(deploymentType, tier);

  const row = await prisma.deployment.create({
    data: {
      userId,
      projectId,
      connectedRepositoryId: connectedRepositoryId || null,
      name: clampStr(String(name).trim(), 80),
      deploymentType,
      visibility,
      geography,
      machineTier: tier,
      status: 'building',
      cpu: spec.cpu,
      memoryMb: spec.memoryMb,
      buildCommand: deploymentType === 'static' ? null : 'npm run build',
      runCommand: deploymentType === 'static' ? null : 'npm run start',
      publicDir: deploymentType === 'static' ? 'dist' : null,
      databaseConnected: false,
    },
  });
  // Stamp the default subdomain now that we have the row id (deterministic).
  const subdomain = pipeline.slugifySubdomain(row.name, row.id);
  const withDomain = await prisma.deployment.update({ where: { id: row.id }, data: { subdomain } });
  return publicDeployment(withDomain);
}

async function listDeployments({ userId, db = defaultPrisma }) {
  const prisma = requireDb(db);
  const rows = await prisma.deployment.findMany({
    where: { userId, deletedAt: null },
    orderBy: { updatedAt: 'desc' },
    take: 50,
  });
  return rows.map(publicDeployment);
}

async function getDeployment({ userId, id, db = defaultPrisma }) {
  const prisma = requireDb(db);
  const row = await prisma.deployment.findFirst({ where: { id, userId, deletedAt: null } });
  if (!row) return null;
  const [versions, domains] = await Promise.all([
    prisma.deploymentVersion.findMany({ where: { deploymentId: id }, orderBy: { createdAt: 'desc' }, take: 30 }),
    prisma.deploymentDomain.findMany({ where: { deploymentId: id }, orderBy: { createdAt: 'asc' } }),
  ]);
  return {
    deployment: publicDeployment(row),
    versions: versions.map(publicVersion),
    domains: domains.map(publicDomain),
  };
}

/** Map a real-executor result onto the UI's 5-phase shape (done | failed). */
function realDeployPhases(result) {
  const order = pipeline.PUBLISH_PHASES;
  if (result.promoted) return order.map((name) => ({ name, status: 'done', logs: [] }));
  const failIdx = order.indexOf(result.failedPhase);
  return order.map((name, i) => ({
    name,
    status: failIdx === -1 ? (i === 0 ? 'failed' : 'done') : i < failIdx ? 'done' : 'failed',
    logs: [],
  }));
}

/**
 * Publish via the REAL Hostinger VPS executor (build + SFTP/ssh2 + nginx) and
 * persist the resulting version + logs + status, mirroring the synthetic path's
 * transactional version flip so the live version is never ambiguous.
 */
async function publishViaExecutor({ prisma, row, userId, env, executor }) {
  const id = row.id;
  let hostname = null;
  try {
    const domains = await prisma.deploymentDomain.findMany({ where: { deploymentId: id }, orderBy: { createdAt: 'asc' } });
    const primary = domains.find((dm) => dm.isPrimary) || domains[0];
    hostname = primary ? primary.hostname : null;
  } catch { /* domains optional */ }

  const result = await executor({ deployment: row, userId, env, hostname });
  const buildLog = (result.logs || []).join('\n');
  const seq = await prisma.deploymentVersion.count({ where: { deploymentId: id } });
  const shortHash = pipeline.generateShortHash(id, seq);
  const scan = { ...pipeline.securityScanReport(`${id}:scan:${seq}`), scannedAt: new Date().toISOString() };

  const version = await runInTransaction(prisma, async (tx) => {
    const created = await tx.deploymentVersion.create({
      data: {
        deploymentId: id,
        shortHash,
        status: result.promoted ? 'promoted' : 'failed',
        isLive: result.promoted,
        publishedById: userId,
        buildLog,
        securityScan: scan,
      },
    });
    if (result.promoted) {
      await tx.deploymentVersion.updateMany({
        where: { deploymentId: id, isLive: true, id: { not: created.id } },
        data: { isLive: false },
      });
    }
    await seedVersionLogs(tx, created, buildLog);
    return created;
  });

  const spec = pipeline.machineSpec(row.deploymentType, row.machineTier);
  const updated = await prisma.deployment.update({
    where: { id },
    data: {
      status: result.promoted ? 'running' : 'failed',
      suspendedReason: null,
      currentVersionId: result.promoted ? version.id : row.currentVersionId,
      subdomain: row.subdomain || pipeline.slugifySubdomain(row.name, id),
      cpu: spec.cpu,
      memoryMb: spec.memoryMb,
    },
  });

  return {
    deployment: publicDeployment(updated),
    version: publicVersion(version),
    phases: realDeployPhases(result),
    failedPhase: result.failedPhase || null,
    failureMessage: result.failureMessage || null,
    url: result.url || null,
  };
}

/** Publish a new immutable version, running the 5-phase pipeline. */
async function publishDeployment({ userId, id, hasFiles = true, db = defaultPrisma, env = process.env, executor = deployHostingerVps }) {
  const prisma = requireDb(db);
  // Load INCLUDING soft-deleted rows: shutdown sets deletedAt, so loadOwned
  // (which filters deletedAt:null) used to 404 here, making the shut_down 409
  // below unreachable. Surface the clearer 409 for a shut-down deployment and a
  // plain 404 for any other soft-deleted/absent row.
  const row = await prisma.deployment.findFirst({ where: { id, userId } });
  if (!row) throw new DeploymentError(404, 'deployment_not_found', 'deployment not found');
  if (row.status === 'shut_down') throw new DeploymentError(409, 'deployment_shut_down', 'deployment was shut down');
  if (row.deletedAt) throw new DeploymentError(404, 'deployment_not_found', 'deployment not found');
  // Publishing promotes the new version and flips status to 'running' — which
  // would silently clear a 'suspended' (payment_failure) state. Block it so a
  // suspended deployment can't be un-suspended by publishing (billing bypass).
  if (row.status === 'suspended') throw new DeploymentError(409, 'deployment_suspended', 'resolve the suspension before publishing');

  // Real path: a Hostinger VPS deployment with the provider configured runs the
  // actual build + upload + nginx via the hosting engine. Otherwise (managed
  // types, or VPS not configured) fall back to the deterministic synthetic
  // pipeline so the UX stays consistent and offline tests stay green.
  if (row.deploymentType === 'hostinger_vps' && providers.providerReadiness('hostinger_vps', env).configured) {
    return publishViaExecutor({ prisma, row, userId, env, executor });
  }

  const seq = await prisma.deploymentVersion.count({ where: { deploymentId: id } });
  const result = pipeline.runPublishPipeline({
    deployment: row,
    seq,
    hasFiles,
    failPhase: env.SIRAGPT_DEPLOYMENT_FAIL_PHASE || env.SIRAGPT_PUBLISH_FAIL_PHASE,
  });
  const scan = { ...result.securityScan, scannedAt: new Date().toISOString() };
  const buildLog = result.logs.join('\n');

  // Create the new version and demote the previously-live one as one unit so a
  // failure between the two can never leave two versions marked isLive.
  const version = await runInTransaction(prisma, async (tx) => {
    const created = await tx.deploymentVersion.create({
      data: {
        deploymentId: id,
        shortHash: result.shortHash,
        status: result.promoted ? 'promoted' : 'failed',
        isLive: result.promoted,
        publishedById: userId,
        buildLog,
        securityScan: scan,
      },
    });
    if (result.promoted) {
      await tx.deploymentVersion.updateMany({
        where: { deploymentId: id, isLive: true, id: { not: created.id } },
        data: { isLive: false },
      });
    }
    await seedVersionLogs(tx, created, buildLog);
    return created;
  });

  const spec = pipeline.machineSpec(row.deploymentType, row.machineTier);
  const updated = await prisma.deployment.update({
    where: { id },
    data: {
      status: result.promoted ? 'running' : 'failed',
      suspendedReason: null,
      currentVersionId: result.promoted ? version.id : row.currentVersionId,
      subdomain: row.subdomain || result.subdomain,
      cpu: spec.cpu,
      memoryMb: spec.memoryMb,
      databaseConnected: result.promoted ? true : row.databaseConnected,
      databaseProvider: result.promoted ? 'sira-postgres' : row.databaseProvider,
    },
  });

  return {
    deployment: publicDeployment(updated),
    version: publicVersion(version),
    phases: result.phases,
    failedPhase: result.failedPhase || null,
    failureMessage: result.failureMessage || null,
  };
}

/** Roll back to a prior promoted version (re-promote it as a new rollback build). */
async function rollbackDeployment({ userId, id, versionId, db = defaultPrisma }) {
  const prisma = requireDb(db);
  const row = await loadOwned(prisma, userId, id);
  // Don't let a rollback silently un-suspend a payment-failure deployment.
  if (row.status === 'suspended') throw new DeploymentError(409, 'deployment_suspended', 'resolve the suspension before rolling back');
  const target = await prisma.deploymentVersion.findFirst({ where: { id: versionId, deploymentId: id } });
  if (!target) throw new DeploymentError(404, 'version_not_found', 'version not found');
  if (target.status !== 'promoted') throw new DeploymentError(409, 'version_not_promotable', 'only successfully promoted builds can be rolled back to');

  const seq = await prisma.deploymentVersion.count({ where: { deploymentId: id } });
  const shortHash = pipeline.generateShortHash(id, seq);
  const version = await runInTransaction(prisma, async (tx) => {
    const created = await tx.deploymentVersion.create({
      data: {
        deploymentId: id,
        shortHash,
        status: 'promoted',
        isLive: true,
        isRollback: true,
        rolledBackFromId: target.id,
        publishedById: userId,
        buildLog: target.buildLog,
        securityScan: target.securityScan,
      },
    });
    await tx.deploymentVersion.updateMany({
      where: { deploymentId: id, isLive: true, id: { not: created.id } },
      data: { isLive: false },
    });
    // Seed a SINGLE synthetic line, not the target version's whole build log —
    // re-persisting the historical lines duplicated them in the Logs tab (getLogs
    // aggregates rows across every version with no de-dup).
    await seedVersionLogs(tx, created, `[promote] Rolled back to ${target.shortHash}`);
    return created;
  });
  const updated = await prisma.deployment.update({
    where: { id },
    data: { status: 'running', suspendedReason: null, currentVersionId: version.id },
  });
  return { deployment: publicDeployment(updated), version: publicVersion(version) };
}

const SETTABLE = ['buildCommand', 'runCommand', 'publicDir', 'visibility', 'deploymentType', 'machineTier', 'externalPort'];

async function updateDeployment({ userId, id, patch = {}, db = defaultPrisma }) {
  const prisma = requireDb(db);
  await loadOwned(prisma, userId, id);
  const data = {};
  for (const key of SETTABLE) {
    if (patch[key] === undefined) continue;
    if (key === 'visibility' && !pipeline.VISIBILITIES.includes(patch[key])) throw new DeploymentError(400, 'invalid_visibility', 'invalid visibility');
    if (key === 'deploymentType' && !pipeline.DEPLOYMENT_TYPES.includes(patch[key])) throw new DeploymentError(400, 'invalid_type', 'invalid deployment type');
    if (key === 'externalPort') {
      const port = Number(patch[key]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new DeploymentError(400, 'invalid_port', 'externalPort must be an integer in 1-65535');
      }
      data.externalPort = port;
      continue;
    }
    data[key] = typeof patch[key] === 'string' ? clampStr(patch[key], 400) : patch[key];
  }
  // Geography is immutable after creation (Replit parity) — silently ignored.
  if (data.deploymentType || data.machineTier) {
    const cur = await prisma.deployment.findUnique({ where: { id } });
    const nextType = data.deploymentType || cur.deploymentType;
    const nextTier = normalizedTierFor(nextType, data.machineTier || cur.machineTier);
    data.machineTier = nextTier;
    const spec = pipeline.machineSpec(nextType, nextTier);
    data.cpu = spec.cpu;
    data.memoryMb = spec.memoryMb;
  }
  const updated = await prisma.deployment.update({ where: { id }, data });
  return publicDeployment(updated);
}

async function setStatus({ userId, id, status, suspendedReason = null, db = defaultPrisma }) {
  const prisma = requireDb(db);
  await loadOwned(prisma, userId, id);
  const data = { status };
  if (status === 'shut_down') data.deletedAt = new Date();
  if (status === 'suspended') data.suspendedReason = suspendedReason || 'payment_failure';
  if (status === 'running' || status === 'paused') data.suspendedReason = null;
  const updated = await prisma.deployment.update({ where: { id }, data });
  return publicDeployment(updated);
}

async function runSecurityScan({ userId, id, db = defaultPrisma }) {
  const prisma = requireDb(db);
  const row = await loadOwned(prisma, userId, id);
  const seq = await prisma.deploymentVersion.count({ where: { deploymentId: id } });
  const scan = { ...pipeline.securityScanReport(`${id}:scan:${seq}`), scannedAt: new Date().toISOString() };
  if (row.currentVersionId) {
    // Persist best-effort, but surface a failure: silently dropping it loses
    // the (expensive) scan result with zero signal on a DB/permission/conflict
    // error. The scan is still returned to the caller either way.
    await prisma.deploymentVersion
      .update({ where: { id: row.currentVersionId }, data: { securityScan: scan } })
      .catch((err) => logger.warn(
        { deploymentId: id, versionId: row.currentVersionId, err: err && err.message },
        'security-scan-persist-failed',
      ));
  }
  return scan;
}

function listProviders({ env = process.env } = {}) {
  return providers.listProviders(env);
}

async function connectProvider({ userId, id, providerId, connectedRepositoryId = null, db = defaultPrisma, env = process.env }) {
  const prisma = requireDb(db);
  const row = await loadOwned(prisma, userId, id);
  if (!['hostinger_vps', 'aws'].includes(providerId)) {
    throw new DeploymentError(400, 'unsupported_provider', 'unsupported deployment provider');
  }
  const plan = providers.buildConnectionPlan({ providerId, deployment: publicDeployment(row), env });
  if (!plan.ready) {
    throw new DeploymentError(409, 'provider_not_configured', `missing provider env: ${plan.provider.missingRequired.join(', ')}`);
  }
  const tier = normalizedTierFor(providerId, providerId);
  const spec = pipeline.machineSpec(providerId, tier);
  const updated = await prisma.deployment.update({
    where: { id },
    data: {
      deploymentType: providerId,
      machineTier: tier,
      cpu: spec.cpu,
      memoryMb: spec.memoryMb,
      buildCommand: row.buildCommand || 'npm run build',
      runCommand: row.runCommand || 'npm run start',
      externalPort: row.externalPort || 3000,
      // Model A: bind the git repo whose workspace the executor will deploy.
      ...(connectedRepositoryId ? { connectedRepositoryId } : {}),
    },
  });
  return {
    deployment: publicDeployment(updated),
    provider: plan.provider,
    plan: providers.buildConnectionPlan({ providerId, deployment: publicDeployment(updated), env }),
  };
}

// RFC-1123-ish hostname validation: ≥2 dot-separated labels, each 1–63 chars
// with alphanumeric start/end and only interior hyphens; the TLD is letters or
// a punycode `xn--` label. Replaces a loose `[a-z0-9.-]+\.[a-z]{2,}` that
// accepted malformed labels (-foo, foo-, a..b.com) and rejected valid IDN/
// punycode TLDs (xn--p1ai for .рф).
function isValidHostname(h) {
  if (typeof h !== 'string' || h.length === 0 || h.length > 253) return false;
  const labels = h.split('.');
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1];
  if (!/^(?:[a-z]{2,}|xn--[a-z0-9]+)$/.test(tld)) return false;
  return labels.every((l) => l.length >= 1 && l.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(l));
}

async function addDomain({ userId, id, hostname, providerId = null, db = defaultPrisma, env = process.env }) {
  const prisma = requireDb(db);
  await loadOwned(prisma, userId, id);
  const clean = String(hostname || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!isValidHostname(clean)) throw new DeploymentError(400, 'invalid_hostname', 'invalid hostname');
  // A hostname may only be attached to one deployment — otherwise two
  // deployments claim the same custom domain and DNS verification is ambiguous.
  const existingDomain = await prisma.deploymentDomain.findFirst({ where: { hostname: clean } });
  if (existingDomain) {
    // Only block if the claiming deployment is still LIVE. A shut-down
    // (soft-deleted) deployment must not permanently squat the hostname.
    const owner = await prisma.deployment.findFirst({ where: { id: existingDomain.deploymentId, deletedAt: null } });
    if (owner) throw new DeploymentError(409, 'domain_taken', 'hostname already attached to a deployment');
  }
  const dnsRecords = pipeline.dnsRecordsFor(clean, id);
  let providerResult = null;
  if (providerId === 'godaddy_dns') {
    providerResult = await providers.applyGoDaddyDnsRecords({ hostname: clean, records: dnsRecords, env });
  } else if (providerId != null) {
    throw new DeploymentError(400, 'unsupported_provider', 'unsupported domain provider');
  }
  const domain = await prisma.deploymentDomain.create({
    data: {
      deploymentId: id,
      hostname: clean,
      kind: 'custom',
      verificationStatus: 'pending',
      tlsStatus: 'provisioning',
      dnsRecords,
    },
  });
  return providerId === 'godaddy_dns' ? { domain: publicDomain(domain), providerResult } : publicDomain(domain);
}

async function removeDomain({ userId, id, domainId, db = defaultPrisma }) {
  const prisma = requireDb(db);
  await loadOwned(prisma, userId, id);
  const domain = await prisma.deploymentDomain.findFirst({ where: { id: domainId, deploymentId: id } });
  if (!domain) throw new DeploymentError(404, 'domain_not_found', 'domain not found');
  await prisma.deploymentDomain.delete({ where: { id: domainId } });
  return { ok: true };
}

async function liveOrLatestVersion(prisma, row, id) {
  let version = null;
  if (row.currentVersionId) version = await prisma.deploymentVersion.findUnique({ where: { id: row.currentVersionId } });
  if (!version) version = await prisma.deploymentVersion.findFirst({ where: { deploymentId: id }, orderBy: { createdAt: 'desc' } });
  return version;
}

async function versionHashMap(prisma, id) {
  const versions = await prisma.deploymentVersion.findMany({ where: { deploymentId: id }, orderBy: { createdAt: 'desc' }, take: 200 });
  return new Map(versions.map((v) => [v.id, v.shortHash]));
}

async function createRuntimeLog(prisma, row, payload) {
  if (!prisma.deploymentLog) throw new DeploymentError(500, 'deployment_logs_unavailable', 'deployment logs are unavailable');
  const version = await liveOrLatestVersion(prisma, row, row.id);
  const entry = normalizeRuntimeLogPayload(payload);
  const created = await prisma.deploymentLog.create({
    data: {
      deploymentId: row.id,
      versionId: version ? version.id : null,
      source: entry.source,
      level: entry.level,
      message: entry.message,
    },
  });
  return publicLogEntry(created, version ? version.shortHash : null);
}

async function recordRuntimeLog({ userId, id, payload = {}, db = defaultPrisma }) {
  const prisma = requireDb(db);
  const row = await loadOwned(prisma, userId, id);
  return createRuntimeLog(prisma, row, payload);
}

async function recordRuntimeLogByToken({ id, token, payload = {}, db = defaultPrisma, env = process.env }) {
  const prisma = requireDb(db);
  const row = await prisma.deployment.findFirst({ where: { id, deletedAt: null } });
  if (!row) throw new DeploymentError(404, 'deployment_not_found', 'deployment not found');
  if (!verifyDeploymentLogToken(row, token, env)) throw new DeploymentError(401, 'invalid_log_token', 'invalid deployment log token');
  return createRuntimeLog(prisma, row, payload);
}

/** Recent build/runtime logs as both raw lines and structured entries for the
 * Logs table. New deployments store rows in deployment_logs; older versions
 * still fall back to parsing DeploymentVersion.buildLog. */
async function getLogs({ userId, id, db = defaultPrisma }) {
  const prisma = requireDb(db);
  const row = await loadOwned(prisma, userId, id);
  const version = await liveOrLatestVersion(prisma, row, id);
  if (prisma.deploymentLog) {
    const [logs, hashes] = await Promise.all([
      prisma.deploymentLog.findMany({ where: { deploymentId: id }, orderBy: { createdAt: 'desc' }, take: 1000 }),
      versionHashMap(prisma, id),
    ]);
    if (logs.length > 0) {
      const entries = logs.reverse().map((log, index) => publicLogEntry(log, hashes.get(log.versionId) || (version ? version.shortHash : null), index));
      return { lines: entries.map((entry) => entry.message), entries, versionHash: version ? version.shortHash : null };
    }
  }
  const lines = version && version.buildLog ? version.buildLog.split('\n').filter((l) => l.length > 0) : [];
  const baseMs = version && version.createdAt ? new Date(version.createdAt).getTime() : 0;
  const entries = pipeline.parseLogEntries(version ? version.buildLog : '', baseMs).map((e) => ({
    ...e,
    deployment: version ? version.shortHash : null,
  }));
  return { lines, entries, versionHash: version ? version.shortHash : null };
}

module.exports = {
  DeploymentError,
  publicDeployment,
  publicVersion,
  publicDomain,
  listProviders,
  createDeployment,
  listDeployments,
  getDeployment,
  connectProvider,
  publishDeployment,
  rollbackDeployment,
  updateDeployment,
  setStatus,
  runSecurityScan,
  addDomain,
  removeDomain,
  deploymentLogToken,
  recordRuntimeLog,
  recordRuntimeLogByToken,
  getLogs,
};
