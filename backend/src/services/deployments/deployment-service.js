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

function clampStr(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : v;
}

function publicDeployment(row) {
  if (!row) return null;
  const spec = pipeline.machineSpec(row.deploymentType, row.machineTier);
  const subdomain = row.subdomain || pipeline.slugifySubdomain(row.name, row.id);
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

async function createDeployment({ userId, name, projectId = null, deploymentType = 'autoscale', visibility = 'public', geography = 'na', machineTier, db = defaultPrisma }) {
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

/** Publish a new immutable version, running the 5-phase pipeline. */
async function publishDeployment({ userId, id, hasFiles = true, db = defaultPrisma }) {
  const prisma = requireDb(db);
  const row = await loadOwned(prisma, userId, id);
  if (row.status === 'shut_down') throw new DeploymentError(409, 'deployment_shut_down', 'deployment was shut down');

  const seq = await prisma.deploymentVersion.count({ where: { deploymentId: id } });
  const result = pipeline.runPublishPipeline({ deployment: row, seq, hasFiles });
  const scan = { ...result.securityScan, scannedAt: new Date().toISOString() };

  const version = await prisma.deploymentVersion.create({
    data: {
      deploymentId: id,
      shortHash: result.shortHash,
      status: result.promoted ? 'promoted' : 'failed',
      isLive: result.promoted,
      publishedById: userId,
      buildLog: result.logs.join('\n'),
      securityScan: scan,
    },
  });

  if (result.promoted) {
    // Demote the previously-live version, if any.
    await prisma.deploymentVersion.updateMany({
      where: { deploymentId: id, isLive: true, id: { not: version.id } },
      data: { isLive: false },
    });
  }

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

  return { deployment: publicDeployment(updated), version: publicVersion(version), phases: result.phases };
}

/** Roll back to a prior promoted version (re-promote it as a new rollback build). */
async function rollbackDeployment({ userId, id, versionId, db = defaultPrisma }) {
  const prisma = requireDb(db);
  const row = await loadOwned(prisma, userId, id);
  const target = await prisma.deploymentVersion.findFirst({ where: { id: versionId, deploymentId: id } });
  if (!target) throw new DeploymentError(404, 'version_not_found', 'version not found');
  if (target.status !== 'promoted') throw new DeploymentError(409, 'version_not_promotable', 'only successfully promoted builds can be rolled back to');

  const seq = await prisma.deploymentVersion.count({ where: { deploymentId: id } });
  const shortHash = pipeline.generateShortHash(id, seq);
  const version = await prisma.deploymentVersion.create({
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
  await prisma.deploymentVersion.updateMany({
    where: { deploymentId: id, isLive: true, id: { not: version.id } },
    data: { isLive: false },
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
    if (key === 'externalPort') { data.externalPort = Number(patch[key]) || 80; continue; }
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
    await prisma.deploymentVersion.update({ where: { id: row.currentVersionId }, data: { securityScan: scan } }).catch(() => {});
  }
  return scan;
}

function listProviders({ env = process.env } = {}) {
  return providers.listProviders(env);
}

async function connectProvider({ userId, id, providerId, db = defaultPrisma, env = process.env }) {
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
    },
  });
  return {
    deployment: publicDeployment(updated),
    provider: plan.provider,
    plan: providers.buildConnectionPlan({ providerId, deployment: publicDeployment(updated), env }),
  };
}

async function addDomain({ userId, id, hostname, providerId = null, db = defaultPrisma, env = process.env }) {
  const prisma = requireDb(db);
  await loadOwned(prisma, userId, id);
  const clean = String(hostname || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(clean)) throw new DeploymentError(400, 'invalid_hostname', 'invalid hostname');
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

/** Recent runtime logs (from the live version's stored build/run log) as both
 *  raw lines and structured entries for the Logs table. */
async function getLogs({ userId, id, db = defaultPrisma }) {
  const prisma = requireDb(db);
  const row = await loadOwned(prisma, userId, id);
  let version = null;
  if (row.currentVersionId) version = await prisma.deploymentVersion.findUnique({ where: { id: row.currentVersionId } });
  if (!version) version = await prisma.deploymentVersion.findFirst({ where: { deploymentId: id }, orderBy: { createdAt: 'desc' } });
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
  getLogs,
};
