'use strict';

/**
 * DeploymentRepository — build/upload history rows for a connected repo.
 */

const prisma = require('../config/database');

function create(data) {
  return prisma.hostingDeployment.create({ data });
}

function update(id, patch) {
  return prisma.hostingDeployment.update({ where: { id }, data: patch });
}

function findByIdForUser(id, userId) {
  return prisma.hostingDeployment.findFirst({ where: { id, userId } });
}

function listForConnection(connectedRepositoryId, userId, limit = 20) {
  return prisma.hostingDeployment.findMany({
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
