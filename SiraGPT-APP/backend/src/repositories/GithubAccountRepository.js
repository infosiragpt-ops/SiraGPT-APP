'use strict';

/**
 * GithubAccountRepository — thin persistence layer over the `github_accounts`
 * table. Keeps Prisma calls out of the route/service code so the OAuth flow
 * stays testable and the storage shape can evolve in one place.
 */

const prisma = require('../config/database');

function findByUserId(userId) {
  return prisma.githubAccount.findUnique({ where: { userId } });
}

function findByGithubUserId(githubUserId) {
  return prisma.githubAccount.findUnique({ where: { githubUserId } });
}

/**
 * Create or update the user's single GitHub account row.
 *
 * @param {string} userId
 * @param {object} data { githubUserId, login, name, avatarUrl, scope, tokenType, encryptedTokens }
 */
function upsertForUser(userId, data) {
  return prisma.githubAccount.upsert({
    where: { userId },
    create: { userId, ...data },
    update: { ...data },
  });
}

/** Remove the user's GitHub account (cascades to repos + workspaces via FK). */
function deleteForUser(userId) {
  return prisma.githubAccount.deleteMany({ where: { userId } });
}

module.exports = {
  findByUserId,
  findByGithubUserId,
  upsertForUser,
  deleteForUser,
};
