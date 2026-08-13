'use strict';

/**
 * codex/project-service — CodexProject CRUD + provisioning. The DB client and
 * runner are injectable (defaults: shared Prisma + real runner client) so the
 * route stays thin and the tests stay offline.
 */

const defaultPrisma = (() => {
  try { return require('../../config/database'); } catch { return null; }
})();
const { createSandboxClient } = require('./sandbox-provider');
const { provisionWorkspace } = require('./workspace');
const { classifyText } = require('./error-patterns');
const { publicProjectDatabase } = require('./project-database-serializer');
const {
  prepareSelfHostedProject,
  sourceBranchName,
  validateRepositoryUrl,
} = require('./self-hosting');

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
  const project = {
    id: row.id,
    name: row.name,
    status: row.status,
    organizationId: row.organizationId || null,
    workspacePath: row.workspacePath,
    previewUrl: row.previewUrl,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  // Existing queries do not include this relation. If a future query does,
  // keep the response allowlisted instead of serializing Prisma's nested
  // secret/lease records by accident.
  if (row.database) project.database = publicProjectDatabase(row.database);
  if (row.brief && typeof row.brief === 'object' && row.brief.kind === 'repo') {
    project.kind = 'repo';
    project.sourceControl = {
      repository: row.brief.repository?.url || null,
      sourceBranch: row.brief.repository?.sourceBranch || null,
    };
  }
  return project;
}

function requireDb(db) {
  if (!db || !db.codexProject) throw new Error('database unavailable');
  return db;
}

/**
 * Return whether a project brief asks for capabilities that need the
 * full-stack starter. Keep this classifier deterministic and dependency-free:
 * project creation must make the same provisioning decision in every worker.
 */
function hasFullStackIntent(brief) {
  if (typeof brief !== 'string') return false;

  const text = brief
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return false;

  return [
    // Persistent data / PostgreSQL, in Spanish and English.
    /\b(?:bases? de datos|data\s*bases?|postgres(?:ql)?|prisma|sql)\b/,
    // Server-side application surface.
    /\b(?:full ?stack|backend|back end|server side|servidor(?:es)?|servers?)\b/,
    /\b(?:apis?|endpoints?|restful)\b/,
    // Identity and access generally require a server and persistent storage.
    /\b(?:auth|authentication|authorization|autenticacion|autorizacion|login|sign in|inicio de sesion)\b/,
    // Shared products need server-owned state even if no database is named.
    /\b(?:multiusuarios?|multi users?|multiuser|multi tenants?|multitenant|multiple users?|varios usuarios)\b/,
    // Users often distinguish an operational product from a visual mockup.
    /\b(?:producto(?:s)?|aplicacion(?:es)?|app(?:s)?|software|sistema(?:s)?)\s+(?:100\s*%\s*)?(?:real(?:es)?|de verdad)\b/,
    /\b(?:real|production ready)\s+(?:products?|applications?|apps?|software|systems?)\b/,
    // Preserve the useful persistence phrases handled by the previous detector.
    /\b(?:que guarde|guardar datos|persistencia|persistente|persistir|store data|persist data)\b/,
    // APPS chat: "haz un CRM / software como ChatGPT / todas las capas"
    // must provision Express+SQLite, not the visual SPA starter.
    /\b(?:crm|erp|saas|pos|inventario|facturacion|nomina|rrhh)\b/,
    /\b(?:chatgpt|chat gpt|claude(?: code)?|todas las capas|multi capa|app completa|producto completo|fabrica de software)\b/,
    /\bcomo\s+(?:claude|chatgpt)\b/,
  ].some((pattern) => pattern.test(text));
}

function repositoryRequest({ brief, repository } = {}) {
  const candidate = repository
    || (
      brief
      && typeof brief === 'object'
      && brief.kind === 'repo'
      && brief.repository
    );
  if (!candidate) return null;
  if (typeof candidate === 'string') return { url: candidate, sourceBranch: 'main' };
  if (typeof candidate !== 'object') return null;
  return {
    url: candidate.url || candidate.gitUrl || null,
    sourceBranch: candidate.sourceBranch || candidate.branch || 'main',
  };
}

function safeRepositoryBrief({ brief, repository, sourceBranch }) {
  const instructions = typeof brief === 'string'
    ? brief.slice(0, 20_000)
    : (
      brief
      && typeof brief === 'object'
      && typeof brief.instructions === 'string'
        ? brief.instructions.slice(0, 20_000)
        : null
    );
  return {
    kind: 'repo',
    repository: {
      url: repository.url,
      sourceBranch,
    },
    ...(instructions ? { instructions } : {}),
  };
}

async function createProject({
  userId,
  name,
  brief = null,
  repository = null,
  organizationId = null,
  runner,
  db = defaultPrisma,
  env = process.env,
  selfHosting = { prepareSelfHostedProject },
  selfHostAllowedRepositories,
  selfHostAllowedHosts,
}) {
  const prisma = requireDb(db);
  const runnerClient = runner || createSandboxClient();
  const repoRequest = repositoryRequest({ brief, repository });
  let repositoryConfig = null;
  let repositoryError = null;
  if (repoRequest) {
    try {
      const validated = validateRepositoryUrl(repoRequest.url, {
        allowedRepositories: selfHostAllowedRepositories,
        allowedHosts: selfHostAllowedHosts,
        env,
      });
      const branch = sourceBranchName(repoRequest.sourceBranch);
      repositoryConfig = { repository: validated, sourceBranch: branch };
    } catch (error) {
      repositoryError = error;
    }
  }
  const persistedBrief = repositoryConfig
    ? safeRepositoryBrief({
      brief,
      repository: repositoryConfig.repository,
      sourceBranch: repositoryConfig.sourceBranch,
    })
    : (repoRequest ? { kind: 'repo', repository: { url: null, sourceBranch: null } } : brief);
  const row = await prisma.codexProject.create({
    data: {
      userId,
      organizationId: organizationId || null,
      name,
      brief: persistedBrief,
      status: 'provisioning',
    },
  });
  try {
    if (repositoryError) throw repositoryError;
    if (repositoryConfig) {
      const prepare = typeof selfHosting === 'function'
        ? selfHosting
        : selfHosting?.prepareSelfHostedProject;
      if (typeof prepare !== 'function') throw new Error('self-hosting service unavailable');
      const prepared = await prepare({
        runner: runnerClient,
        projectId: row.id,
        repositoryUrl: repositoryConfig.repository.url,
        sourceBranch: repositoryConfig.sourceBranch,
        allowedRepositories: selfHostAllowedRepositories,
        allowedHosts: selfHostAllowedHosts,
        env,
      });
      if (!prepared || prepared.ok !== true || !prepared.workspacePath || !prepared.pullRequest) {
        const error = new Error('self-hosting preparation did not produce a PR-ready workspace');
        error.code = 'self_hosting_not_ready';
        throw error;
      }
      const ready = await prisma.codexProject.update({
        where: { id: row.id },
        data: { status: 'ready', workspacePath: prepared.workspacePath, previewUrl: null, error: null },
      });
      return {
        ...publicProject(ready),
        sourceControl: {
          repository: prepared.repository,
          sourceBranch: prepared.sourceBranch,
          workBranch: prepared.workBranch,
          commitSha: prepared.commitSha,
        },
        pullRequest: prepared.pullRequest,
      };
    }

    // Detect full-stack intent from the original user brief so we provision
    // the server-backed starter instead of the SPA-only one.
    const { workspacePath } = await provisionWorkspace({
      project: row.id,
      projectName: name,
      runner: runnerClient,
      fullStack: hasFullStackIntent(brief),
    });
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

module.exports = {
  createProject,
  listProjects,
  getProject,
  publicProject,
  hasFullStackIntent,
  repositoryRequest,
  safeRepositoryBrief,
};
