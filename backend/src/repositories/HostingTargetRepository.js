'use strict';

/**
 * HostingTargetRepository — persistence for a user's deploy targets
 * (Hostinger / generic SFTP/FTP). `encryptedCreds` is AES-256 sealed and is
 * NEVER returned to the client (the route strips it to `hasCreds`).
 */

const prisma = require('../config/database');

function listForUser(userId) {
  return prisma.hostingTarget.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
}

function findByIdForUser(id, userId) {
  return prisma.hostingTarget.findFirst({ where: { id, userId } });
}

function create(userId, data) {
  return prisma.hostingTarget.create({ data: { userId, ...data } });
}

function update(id, userId, data) {
  return prisma.hostingTarget.updateMany({ where: { id, userId }, data });
}

function deleteForUser(id, userId) {
  return prisma.hostingTarget.deleteMany({ where: { id, userId } });
}

module.exports = {
  listForUser,
  findByIdForUser,
  create,
  update,
  deleteForUser,
};
