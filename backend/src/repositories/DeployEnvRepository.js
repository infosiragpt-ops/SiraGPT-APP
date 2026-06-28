'use strict';

/**
 * DeployEnvRepository — one sealed env blob per connected repo.
 */

const prisma = require('../config/database');

function findForConnection(connectedRepositoryId, userId) {
  return prisma.deployEnv.findFirst({ where: { connectedRepositoryId, userId } });
}

function upsert(userId, connectedRepositoryId, encryptedEnv) {
  return prisma.deployEnv.upsert({
    where: { connectedRepositoryId },
    create: { userId, connectedRepositoryId, encryptedEnv },
    update: { encryptedEnv },
  });
}

module.exports = { findForConnection, upsert };
