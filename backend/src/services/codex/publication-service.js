'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createSandboxClient } = require('./sandbox-provider');

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const MAX_BUNDLE_FILES = 5_000;
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
const MAX_RELEASES = 20;

class PublicationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'PublicationError';
    this.status = status;
    this.code = code;
  }
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function slugify(value) {
  return String(value || 'app')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'app';
}

function appsBaseDomain(env = process.env) {
  const value = String(env.CODEX_APPS_BASE_DOMAIN || 'apps.siragpt.com')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.+$/, '');
  if (!DOMAIN_RE.test(value)) {
    throw new PublicationError(500, 'apps_domain_invalid', 'CODEX_APPS_BASE_DOMAIN is not a valid hostname');
  }
  return value;
}

function projectHostname(project, env = process.env) {
  const suffix = crypto.createHash('sha256').update(String(project.id)).digest('hex').slice(0, 6);
  return `${slugify(project.name)}-${suffix}.${appsBaseDomain(env)}`;
}

function publishedSitesDir(env = process.env) {
  return path.resolve(String(env.PUBLISHED_SITES_DIR || '/srv/sites'));
}

function exportedBuildDir(projectId, env = process.env) {
  if (!PROJECT_ID_RE.test(String(projectId || ''))) {
    throw new PublicationError(400, 'project_id_invalid', 'Invalid project id');
  }
  const root = path.resolve(String(env.CODEX_EXPORT_CONTAINER_DIR || '/codex-exports'));
  const dir = path.resolve(root, '.published', String(projectId));
  if (!dir.startsWith(`${root}${path.sep}`)) {
    throw new PublicationError(400, 'export_path_invalid', 'Invalid exported build path');
  }
  return dir;
}

function releaseDirFor(projectId, sha, env = process.env) {
  if (!PROJECT_ID_RE.test(String(projectId || '')) || !SHA_RE.test(String(sha || ''))) {
    throw new PublicationError(400, 'release_ref_invalid', 'Invalid release reference');
  }
  const root = publishedSitesDir(env);
  const dir = path.resolve(root, '.releases', String(projectId), String(sha));
  if (!dir.startsWith(`${root}${path.sep}`)) {
    throw new PublicationError(400, 'release_path_invalid', 'Invalid release path');
  }
  return dir;
}

function normalizePublication(project) {
  const publication = asRecord(asRecord(project?.brief).publication);
  const releases = Array.isArray(publication.releases)
    ? publication.releases.filter((item) => item && SHA_RE.test(String(item.commitSha || ''))).slice(0, MAX_RELEASES)
    : [];
  return {
    hostname: typeof publication.hostname === 'string' ? publication.hostname : null,
    url: typeof publication.url === 'string' ? publication.url : null,
    currentReleaseId: typeof publication.currentReleaseId === 'string' ? publication.currentReleaseId : null,
    publishedAt: typeof publication.publishedAt === 'string' ? publication.publishedAt : null,
    releases,
  };
}

async function copyBundle(source, destination, {
  fsImpl = fs,
  maxFiles = MAX_BUNDLE_FILES,
  maxBytes = MAX_BUNDLE_BYTES,
} = {}) {
  const fsp = fsImpl.promises;
  const sourceRoot = path.resolve(source);
  let files = 0;
  let bytes = 0;

  async function walk(relative = '') {
    const sourceDir = path.join(sourceRoot, relative);
    const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relative ? path.join(relative, entry.name) : entry.name;
      const from = path.resolve(sourceRoot, rel);
      const to = path.resolve(destination, rel);
      if (!from.startsWith(`${sourceRoot}${path.sep}`) || !to.startsWith(`${path.resolve(destination)}${path.sep}`)) {
        throw new PublicationError(422, 'bundle_path_invalid', 'Build bundle contains an unsafe path');
      }
      const stat = await fsp.lstat(from);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new PublicationError(422, 'bundle_entry_unsafe', `Build bundle contains an unsupported entry: ${rel}`);
      }
      if (stat.isDirectory()) {
        await fsp.mkdir(to, { recursive: true, mode: 0o755 });
        await walk(rel);
        continue;
      }
      if (stat.nlink > 1) {
        throw new PublicationError(422, 'bundle_hardlink_unsafe', `Build bundle contains a hard link: ${rel}`);
      }
      files += 1;
      bytes += stat.size;
      if (files > maxFiles || bytes > maxBytes) {
        throw new PublicationError(413, 'bundle_too_large', 'Build bundle exceeds the publication limit');
      }
      await fsp.mkdir(path.dirname(to), { recursive: true, mode: 0o755 });
      await fsp.copyFile(from, to, fsImpl.constants.COPYFILE_EXCL);
      await fsp.chmod(to, 0o644);
    }
  }

  await fsp.mkdir(destination, { recursive: true, mode: 0o755 });
  await walk();
  const index = path.join(destination, 'index.html');
  const indexStat = await fsp.lstat(index).catch(() => null);
  if (!indexStat?.isFile() || indexStat.isSymbolicLink()) {
    throw new PublicationError(422, 'bundle_index_missing', 'The static bundle has no safe index.html');
  }
  return { files, bytes };
}

async function ensureRelease({ projectId, commitSha, sourceDir, env, fsImpl = fs }) {
  const fsp = fsImpl.promises;
  const releaseDir = releaseDirFor(projectId, commitSha, env);
  const existing = await fsp.lstat(path.join(releaseDir, 'index.html')).catch(() => null);
  if (existing?.isFile() && !existing.isSymbolicLink()) return { releaseDir, reused: true };

  const parent = path.dirname(releaseDir);
  await fsp.mkdir(parent, { recursive: true, mode: 0o755 });
  const temp = path.join(parent, `.${commitSha}.tmp-${crypto.randomUUID()}`);
  try {
    const copied = await copyBundle(sourceDir, temp, { fsImpl });
    await fsp.rename(temp, releaseDir);
    return { releaseDir, reused: false, ...copied };
  } catch (error) {
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
    const raced = await fsp.lstat(path.join(releaseDir, 'index.html')).catch(() => null);
    if (raced?.isFile() && !raced.isSymbolicLink()) return { releaseDir, reused: true };
    throw error;
  }
}

async function promoteRelease({ hostname, releaseDir, env, fsImpl = fs }) {
  if (!DOMAIN_RE.test(String(hostname || ''))) {
    throw new PublicationError(400, 'publication_hostname_invalid', 'Invalid publication hostname');
  }
  const fsp = fsImpl.promises;
  const root = publishedSitesDir(env);
  await fsp.mkdir(root, { recursive: true, mode: 0o755 });
  const livePath = path.resolve(root, hostname);
  if (livePath !== path.join(root, hostname) || !livePath.startsWith(`${root}${path.sep}`)) {
    throw new PublicationError(400, 'publication_path_invalid', 'Invalid publication path');
  }
  const current = await fsp.lstat(livePath).catch(() => null);
  if (current && !current.isSymbolicLink()) {
    throw new PublicationError(409, 'publication_path_conflict', 'The live publication path is not managed by Codex releases');
  }
  const tempLink = path.join(root, `.${hostname}.link-${crypto.randomUUID()}`);
  const target = path.relative(root, releaseDir);
  await fsp.symlink(target, tempLink, 'dir');
  try {
    await fsp.rename(tempLink, livePath);
  } catch (error) {
    await fsp.unlink(tempLink).catch(() => {});
    throw error;
  }
  return livePath;
}

async function loadOwnedProject(prisma, userId, projectId) {
  const project = await prisma.codexProject.findFirst({ where: { id: projectId, userId, deletedAt: null } });
  if (!project) throw new PublicationError(404, 'project_not_found', 'Project not found');
  return project;
}

async function writePublication(prisma, project, publication) {
  const fresh = await prisma.codexProject.findUnique({ where: { id: project.id } }).catch(() => project);
  const brief = asRecord(fresh?.brief);
  await prisma.codexProject.update({
    where: { id: project.id },
    data: { brief: { ...brief, publication } },
  });
  return publication;
}

async function findCheckpoint(prisma, { projectId, userId, checkpointId }) {
  const where = checkpointId
    ? { id: checkpointId, projectId, project: { userId } }
    : { projectId, project: { userId } };
  const checkpoint = checkpointId
    ? await prisma.codexCheckpoint.findFirst({ where })
    : await prisma.codexCheckpoint.findFirst({ where, orderBy: { createdAt: 'desc' } });
  if (!checkpoint) throw new PublicationError(404, 'checkpoint_not_found', 'A verified checkpoint is required before publishing');
  if (!SHA_RE.test(String(checkpoint.commitSha || ''))) {
    throw new PublicationError(422, 'checkpoint_sha_invalid', 'Checkpoint commit SHA is invalid');
  }
  return checkpoint;
}

async function detectOutputDir(runner, projectId) {
  const candidates = ['dist', 'build', 'out', '.output/public'];
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const index = await runner.readFile(projectId, `${candidate}/index.html`);
      if (String(index?.content || '').trim()) return candidate;
    } catch { /* try next conventional static output */ }
  }
  throw new PublicationError(422, 'static_bundle_missing', 'Build finished but no static index.html was found in dist, build, out, or .output/public');
}

async function publishProject({
  prisma: explicitPrisma,
  userId,
  projectId,
  checkpointId = null,
  runner: explicitRunner,
  env = process.env,
  fsImpl = fs,
  now = () => new Date(),
} = {}) {
  const prisma = explicitPrisma || require('../../config/database');
  const project = await loadOwnedProject(prisma, userId, projectId);
  const checkpoint = await findCheckpoint(prisma, { projectId, userId, checkpointId });
  const runner = explicitRunner || createSandboxClient();

  const head = await runner.exec(projectId, ['git', 'rev-parse', 'HEAD'], { timeoutMs: 15_000 });
  const headSha = String(head?.stdout || '').trim();
  if (head?.exitCode !== 0 || headSha !== checkpoint.commitSha) {
    throw new PublicationError(409, 'checkpoint_not_current', 'The workspace HEAD must match the checkpoint selected for publication');
  }
  const install = await runner.exec(projectId, ['bun', 'install'], { timeoutMs: 180_000 });
  if (install?.exitCode !== 0) {
    throw new PublicationError(422, 'publish_install_failed', String(install?.stderr || install?.stdout || 'bun install failed').slice(0, 2_000));
  }
  const build = await runner.exec(projectId, ['bun', 'run', 'build'], { timeoutMs: 180_000 });
  if (build?.exitCode !== 0) {
    throw new PublicationError(422, 'publish_build_failed', String(build?.stderr || build?.stdout || 'bun run build failed').slice(0, 2_000));
  }
  const outDir = await detectOutputDir(runner, projectId);
  const exported = await runner.exportBuild(projectId, outDir);
  if (!exported?.ok) throw new PublicationError(502, 'publish_export_failed', 'The runner could not export the build bundle');

  const sourceDir = exportedBuildDir(projectId, env);
  const release = await ensureRelease({
    projectId,
    commitSha: checkpoint.commitSha,
    sourceDir,
    env,
    fsImpl,
  });
  const hostname = projectHostname(project, env);
  await promoteRelease({ hostname, releaseDir: release.releaseDir, env, fsImpl });

  const current = normalizePublication(project);
  const publishedAt = now().toISOString();
  const releaseId = checkpoint.commitSha;
  const record = {
    id: releaseId,
    checkpointId: checkpoint.id,
    commitSha: checkpoint.commitSha,
    outDir,
    files: Number(exported.files) || release.files || 0,
    bytes: Number(exported.bytes) || release.bytes || 0,
    publishedAt,
  };
  const releases = [
    record,
    ...current.releases.filter((item) => item.id !== releaseId),
  ].slice(0, MAX_RELEASES);
  const publication = {
    hostname,
    url: `https://${hostname}`,
    currentReleaseId: releaseId,
    publishedAt,
    releases,
  };
  await writePublication(prisma, project, publication);
  return { ok: true, publication, release: record, buildLog: String(build?.stdout || '').slice(-4_000) };
}

async function rollbackPublication({
  prisma: explicitPrisma,
  userId,
  projectId,
  releaseId,
  env = process.env,
  fsImpl = fs,
  now = () => new Date(),
} = {}) {
  const prisma = explicitPrisma || require('../../config/database');
  const project = await loadOwnedProject(prisma, userId, projectId);
  const current = normalizePublication(project);
  const target = current.releases.find((item) => item.id === releaseId || item.checkpointId === releaseId);
  if (!target) throw new PublicationError(404, 'publication_release_not_found', 'Published release not found');
  const releaseDir = releaseDirFor(project.id, target.commitSha, env);
  const index = await fsImpl.promises.lstat(path.join(releaseDir, 'index.html')).catch(() => null);
  if (!index?.isFile() || index.isSymbolicLink()) {
    throw new PublicationError(409, 'publication_release_missing', 'The immutable release bundle is missing');
  }
  const hostname = current.hostname || projectHostname(project, env);
  await promoteRelease({ hostname, releaseDir, env, fsImpl });
  const publication = {
    ...current,
    hostname,
    url: `https://${hostname}`,
    currentReleaseId: target.id,
    publishedAt: now().toISOString(),
  };
  await writePublication(prisma, project, publication);
  return { ok: true, publication, release: target };
}

async function getPublication({
  prisma: explicitPrisma,
  userId,
  projectId,
} = {}) {
  const prisma = explicitPrisma || require('../../config/database');
  const project = await loadOwnedProject(prisma, userId, projectId);
  return normalizePublication(project);
}

module.exports = {
  DOMAIN_RE,
  MAX_BUNDLE_BYTES,
  MAX_BUNDLE_FILES,
  PublicationError,
  appsBaseDomain,
  copyBundle,
  detectOutputDir,
  exportedBuildDir,
  getPublication,
  normalizePublication,
  projectHostname,
  promoteRelease,
  publishProject,
  publishedSitesDir,
  releaseDirFor,
  rollbackPublication,
  slugify,
};
