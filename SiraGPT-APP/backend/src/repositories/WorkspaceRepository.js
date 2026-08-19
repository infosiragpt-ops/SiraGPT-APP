'use strict';

/**
 * WorkspaceRepository — persistence for the on-disk checkout state of a
 * connected repository. One Workspace row per ConnectedRepository
 * (1:1 via the unique repositoryId).
 */

const prisma = require('../config/database');

function findByRepositoryId(repositoryId) {
  return prisma.workspace.findUnique({ where: { repositoryId } });
}

/** Strip undefined keys so an upsert update never nulls fields we didn't pass. */
function defined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Create or update the workspace row for a repository.
 * `localPath` + `userId` are required on first create.
 */
function upsertForRepo({ repositoryId, userId, localPath, status, currentBranch, lastError, lastSyncAt }) {
  const update = defined({ status, currentBranch, lastError, lastSyncAt, localPath });
  return prisma.workspace.upsert({
    where: { repositoryId },
    create: {
      repositoryId,
      userId,
      localPath,
      status: status || 'pending',
      currentBranch: currentBranch ?? null,
      lastError: lastError ?? null,
      lastSyncAt: lastSyncAt ?? null,
    },
    update,
  });
}

function deleteByRepositoryId(repositoryId) {
  return prisma.workspace.deleteMany({ where: { repositoryId } });
}

module.exports = {
  findByRepositoryId,
  upsertForRepo,
  deleteByRepositoryId,
};
