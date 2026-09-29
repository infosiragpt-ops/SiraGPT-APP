'use strict';

const { randomUUID } = require('node:crypto');

const localLeases = new Map();
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function leaseTtlMs(env = process.env) {
  const parsed = Number.parseInt(env.CODEX_PROACTIVE_LEASE_TTL_MS ?? '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TTL_MS;
  return Math.max(60_000, Math.min(24 * 60 * 60 * 1000, parsed));
}

async function acquireProactiveLease({
  prisma,
  projectId,
  now = new Date(),
  env = process.env,
}) {
  const token = randomUUID();
  const expiresAt = new Date(now.getTime() + leaseTtlMs(env));
  const model = prisma?.codexProactiveLease;

  if (!model?.create || !model?.updateMany) {
    const existing = localLeases.get(projectId);
    if (existing && existing.expiresAt > now) return null;
    localLeases.set(projectId, { token, expiresAt });
    return { projectId, token, expiresAt, local: true };
  }

  const reclaimed = await model.updateMany({
    where: { projectId, expiresAt: { lte: now } },
    data: { token, expiresAt },
  });
  if (reclaimed?.count) return { projectId, token, expiresAt, local: false };

  // A live lease held by another sweep is the normal contended case, not an
  // error: INSERT … ON CONFLICT DO NOTHING (createMany + skipDuplicates)
  // reports it as count 0. A create() that loses the race throws P2002, and
  // Prisma's error log prints «prisma:error … Unique constraint failed on
  // the fields: (`projectId`)» to the Logs panel before any catch runs.
  if (typeof model.createMany === 'function') {
    const inserted = await model.createMany({
      data: [{ projectId, token, expiresAt }],
      skipDuplicates: true,
    });
    return inserted?.count ? { projectId, token, expiresAt, local: false } : null;
  }

  try {
    await model.create({ data: { projectId, token, expiresAt } });
    return { projectId, token, expiresAt, local: false };
  } catch (error) {
    if (error?.code === 'P2002') return null;
    throw error;
  }
}

async function releaseProactiveLease({ prisma, lease }) {
  if (!lease) return;
  if (lease.local || !prisma?.codexProactiveLease?.deleteMany) {
    if (localLeases.get(lease.projectId)?.token === lease.token) {
      localLeases.delete(lease.projectId);
    }
    return;
  }
  await prisma.codexProactiveLease.deleteMany({
    where: { projectId: lease.projectId, token: lease.token },
  });
}

module.exports = {
  DEFAULT_TTL_MS,
  acquireProactiveLease,
  leaseTtlMs,
  releaseProactiveLease,
};
