'use strict';

/**
 * DeploymentRepository — build/upload history rows for a connected repo.
 */

const prisma = require('../config/database');

function create(data) {
  return prisma.deployment.create({ data });
}

function update(id, patch) {
  return prisma.deployment.update({ where: { id }, data: patch });
}

function findByIdForUser(id, userId) {
  return prisma.deployment.findFirst({ where: { id, userId } });
}

function listForConnection(connectedRepositoryId, userId, limit = 20) {
  return prisma.deployment.findMany({
    where: { connectedRepositoryId, userId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(100, Math.max(1, limit)),
  });
}

module.exports = {
  create,
  update,
  findByIdForUser,
  listForConnection,
};
