'use strict';

/**
 * ConnectedRepositoryRepository — persistence for repos a user has chosen to
 * connect to the app. One row per (user, GitHub repo); the optional related
 * `workspace` row (Step 4) carries the on-disk checkout state.
 */

const prisma = require('../config/database');

function listForUser(userId) {
  return prisma.connectedRepository.findMany({
    where: { userId },
    orderBy: { connectedAt: 'desc' },
    include: { workspace: true },
  });
}

function findByIdForUser(id, userId) {
  return prisma.connectedRepository.findFirst({
    where: { id, userId },
    include: { workspace: true },
  });
}

/**
 * Create or update a connection for the user. Idempotent on (userId, repoId)
 * so re-connecting the same repo refreshes its metadata instead of erroring.
 *
 * @param {string} userId
 * @param {string} githubAccountId
 * @param {object} repo  normalised repo DTO (see github-api.service.toRepoDTO)
 */
function upsertForUser(userId, githubAccountId, repo) {
  const data = {
    fullName: repo.fullName,
    owner: repo.owner,
    name: repo.name,
    private: Boolean(repo.private),
    defaultBranch: repo.defaultBranch || 'main',
    cloneUrl: repo.cloneUrl,
    htmlUrl: repo.htmlUrl || null,
  };
  return prisma.connectedRepository.upsert({
    where: { userId_repoId: { userId, repoId: String(repo.repoId) } },
    create: { userId, githubAccountId, repoId: String(repo.repoId), ...data },
    update: { githubAccountId, ...data },
    include: { workspace: true },
  });
}

function deleteForUser(id, userId) {
  return prisma.connectedRepository.deleteMany({ where: { id, userId } });
}

module.exports = {
  listForUser,
  findByIdForUser,
  upsertForUser,
  deleteForUser,
};
