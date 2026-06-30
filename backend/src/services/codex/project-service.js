'use strict';

/**
 * codex/project-service — CodexProject CRUD + provisioning. The DB client and
 * runner are injectable (defaults: shared Prisma + real runner client) so the
 * route stays thin and the tests stay offline.
 */

const defaultPrisma = (() => {
  try { return require('../../config/database'); } catch { return null; }
})();
const { createRunnerClient } = require('./runner-client');
const { provisionWorkspace } = require('./workspace');
const { classifyText } = require('./error-patterns');

/** Enrich a provisioning failure message with a remediation hint when the
 *  error matches a known blocking pattern (e.g. runner unreachable). */
function describeProvisionError(raw) {
  const cls = classifyText(raw);
  if (cls && cls.severity === 'blocking') {
    const rem = cls.pattern.remediationUrl ? ` (${cls.pattern.remediationUrl})` : '';
    return `${raw}\n[${cls.pattern.title}] ${cls.pattern.explanation}${rem}`.slice(0, 2000);
  }
  return String(raw).slice(0, 2000);
}

function publicProject(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    workspacePath: row.workspacePath,
    previewUrl: row.previewUrl,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requireDb(db) {
  if (!db || !db.codexProject) throw new Error('database unavailable');
  return db;
}

async function createProject({ userId, name, brief = null, runner, db = defaultPrisma, env = process.env }) {
  const prisma = requireDb(db);
  const runnerClient = runner || createRunnerClient();
  const row = await prisma.codexProject.create({
    data: { userId, name, brief, status: 'provisioning' },
  });
  try {
    const { workspacePath } = await provisionWorkspace({ project: row.id, projectName: name, runner: runnerClient });
    const ready = await prisma.codexProject.update({
      where: { id: row.id },
      // The browser must never receive the runner's private localhost URL in
      // production. Preview URLs are minted per session by /preview/start via
      // the same-origin tokenized proxy.
      data: { status: 'ready', workspacePath, previewUrl: null },
    });
    return publicProject(ready);
  } catch (err) {
    const failed = await prisma.codexProject.update({
      where: { id: row.id },
      data: { status: 'error', error: describeProvisionError((err && err.message) || err) },
    });
    return publicProject(failed);
  }
}

async function listProjects({ userId, db = defaultPrisma }) {
  const prisma = requireDb(db);
  const rows = await prisma.codexProject.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    take: 50,
  });
  return rows.map(publicProject);
}

async function getProject({ userId, id, db = defaultPrisma }) {
  const prisma = requireDb(db);
  const row = await prisma.codexProject.findFirst({ where: { id, userId } });
  return row ? publicProject(row) : null;
}

module.exports = { createProject, listProjects, getProject, publicProject };
