'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const archiver = require('archiver');
const objectStorage = require('../object-storage');

const MAX_FILE_BYTES = Math.max(
  1024,
  Number.parseInt(process.env.SIRAGPT_COWORK_MAX_FILE_BYTES || `${25 * 1024 * 1024}`, 10),
);
const MAX_TEXT_READ_CHARS = Math.max(
  1_000,
  Number.parseInt(process.env.SIRAGPT_COWORK_MAX_TEXT_READ_CHARS || '500000', 10),
);
const MAX_EXPORT_BYTES = Math.max(
  MAX_FILE_BYTES,
  Number.parseInt(process.env.SIRAGPT_COWORK_MAX_EXPORT_BYTES || `${250 * 1024 * 1024}`, 10),
);
const LOCAL_CONTENT_DIR = process.env.COWORK_CONTENT_DIR
  || path.join(process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'), 'cowork-content');

const MIME_BY_EXT = Object.freeze({
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.py': 'text/x-python',
  '.svg': 'image/svg+xml',
  '.ts': 'text/typescript',
  '.tsx': 'text/tsx',
  '.txt': 'text/plain',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
});

class CoworkWorkspaceError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'CoworkWorkspaceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function normalizeWorkspacePath(rawPath) {
  const value = String(rawPath || '').replaceAll('\\', '/').trim();
  if (!value) {
    throw new CoworkWorkspaceError('workspace_path_required', 'A workspace path is required.');
  }
  if (value.includes('\0')) {
    throw new CoworkWorkspaceError('workspace_path_invalid', 'Workspace paths cannot contain null bytes.');
  }
  if (value.startsWith('/') || value.split('/').includes('..')) {
    throw new CoworkWorkspaceError('workspace_path_invalid', 'The workspace path must stay inside the workspace.');
  }
  const normalized = path.posix.normalize(`/${value}`).replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new CoworkWorkspaceError('workspace_path_invalid', 'The workspace path must stay inside the workspace.');
  }
  if (normalized.length > 500) {
    throw new CoworkWorkspaceError('workspace_path_too_long', 'Workspace paths are limited to 500 characters.');
  }
  return normalized;
}

function inferMime(filePath, provided = null) {
  const explicit = String(provided || '').trim();
  if (explicit) return explicit.slice(0, 200);
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function contentBuffer(content, encoding = 'utf8') {
  if (Buffer.isBuffer(content)) return content;
  if (encoding === 'base64') {
    const encoded = String(content || '').replace(/\s+/g, '');
    if (
      encoded.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    ) {
      throw new CoworkWorkspaceError('workspace_content_invalid', 'Invalid base64 content.');
    }
    return Buffer.from(encoded, 'base64');
  }
  return Buffer.from(String(content ?? ''), 'utf8');
}

function assertSize(buffer) {
  if (buffer.length > MAX_FILE_BYTES) {
    throw new CoworkWorkspaceError(
      'workspace_file_too_large',
      `Workspace files are limited to ${MAX_FILE_BYTES} bytes.`,
      413,
      { maxBytes: MAX_FILE_BYTES, sizeBytes: buffer.length },
    );
  }
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function contentKey(userId, hash) {
  const user = objectStorage.sanitizeSegment(userId, 'anonymous');
  return `cowork-content/${user}/${hash.slice(0, 2)}/${hash}`;
}

async function persistContent({ userId, buffer, mime }) {
  const hash = hashBuffer(buffer);
  const key = contentKey(userId, hash);
  if (objectStorage.enabled()) {
    const stored = await objectStorage.putBuffer({
      key,
      buffer,
      contentType: mime,
      metadata: { sha256: hash, kind: 'cowork-file-version' },
    });
    return { hash, storageRef: stored.ref };
  }

  const localPath = path.join(LOCAL_CONTENT_DIR, hash.slice(0, 2), hash);
  await fsp.mkdir(path.dirname(localPath), { recursive: true });
  try {
    await fsp.writeFile(localPath, buffer, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return { hash, storageRef: localPath };
}

async function streamToBuffer(stream, limit = MAX_FILE_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new CoworkWorkspaceError('workspace_file_too_large', 'Stored workspace content exceeds the read limit.', 413);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readStorageBuffer(storageRef) {
  if (objectStorage.isRemote(storageRef)) {
    const stored = await objectStorage.readStream(storageRef);
    return streamToBuffer(stored.stream);
  }
  return fsp.readFile(storageRef);
}

function assertWorkspaceOwner(workspace, userId) {
  if (!workspace || workspace.userId !== String(userId)) {
    throw new CoworkWorkspaceError('workspace_not_found', 'Workspace not found.', 404);
  }
}

async function getWorkspace(prisma, { workspaceId, userId }) {
  const workspace = await prisma.coworkWorkspace.findFirst({
    where: { id: String(workspaceId), userId: String(userId) },
  });
  assertWorkspaceOwner(workspace, userId);
  return workspace;
}

async function createWorkspace(prisma, { userId, name = 'Workspace' }) {
  return prisma.coworkWorkspace.create({
    data: {
      userId: String(userId),
      name: String(name || 'Workspace').trim().slice(0, 160) || 'Workspace',
    },
  });
}

async function ensureWorkspaceForChat(prisma, { userId, chatId, name = null }) {
  const chat = await prisma.chat.findFirst({
    where: { id: String(chatId), userId: String(userId) },
    select: { id: true, title: true, coworkWorkspaceId: true },
  });
  if (!chat) {
    throw new CoworkWorkspaceError('chat_not_found', 'Chat not found.', 404);
  }
  if (chat.coworkWorkspaceId) {
    const existing = await prisma.coworkWorkspace.findFirst({
      where: { id: chat.coworkWorkspaceId, userId: String(userId) },
    });
    if (existing) return existing;
  }

  return prisma.$transaction(async (tx) => {
    const fresh = await tx.chat.findFirst({
      where: { id: chat.id, userId: String(userId) },
      select: { coworkWorkspaceId: true, title: true },
    });
    if (fresh?.coworkWorkspaceId) {
      const existing = await tx.coworkWorkspace.findFirst({
        where: { id: fresh.coworkWorkspaceId, userId: String(userId) },
      });
      if (existing) return existing;
    }
    const workspace = await tx.coworkWorkspace.create({
      data: {
        userId: String(userId),
        name: String(name || fresh?.title || chat.title || 'Chat workspace').trim().slice(0, 160),
      },
    });
    const claimed = await tx.chat.updateMany({
      where: {
        id: chat.id,
        userId: String(userId),
        coworkWorkspaceId: fresh?.coworkWorkspaceId || null,
      },
      data: { coworkWorkspaceId: workspace.id },
    });
    if (claimed.count === 1) return workspace;

    // Another transaction mounted a workspace while this one was creating its
    // candidate. Keep the winner and remove the unreferenced candidate.
    const winner = await tx.chat.findFirst({
      where: { id: chat.id, userId: String(userId) },
      select: { coworkWorkspaceId: true },
    });
    await tx.coworkWorkspace.delete({ where: { id: workspace.id } });
    if (!winner?.coworkWorkspaceId) {
      throw new CoworkWorkspaceError(
        'workspace_mount_conflict',
        'The chat workspace changed concurrently. Retry the request.',
        409,
      );
    }
    const existing = await tx.coworkWorkspace.findFirst({
      where: { id: winner.coworkWorkspaceId, userId: String(userId) },
    });
    if (!existing) {
      throw new CoworkWorkspaceError(
        'workspace_mount_conflict',
        'The mounted workspace is no longer available. Retry the request.',
        409,
      );
    }
    return existing;
  });
}

async function listWorkspaces(prisma, { userId, limit = 50 }) {
  return prisma.coworkWorkspace.findMany({
    where: { userId: String(userId) },
    orderBy: { updatedAt: 'desc' },
    take: Math.min(Math.max(Number(limit) || 50, 1), 100),
    include: {
      _count: { select: { files: true, runs: true } },
    },
  });
}

async function listFiles(prisma, { workspaceId, userId }) {
  await getWorkspace(prisma, { workspaceId, userId });
  return prisma.coworkFile.findMany({
    where: { workspaceId: String(workspaceId) },
    orderBy: { path: 'asc' },
    select: {
      id: true,
      path: true,
      contentHash: true,
      artifactId: true,
      size: true,
      mime: true,
      updatedBy: true,
      currentVersion: true,
      createdAt: true,
      updatedAt: true,
      versions: {
        orderBy: { version: 'desc' },
        take: 50,
        select: {
          id: true,
          version: true,
          contentHash: true,
          size: true,
          mime: true,
          authorRunId: true,
          createdAt: true,
        },
      },
    },
  });
}

async function findFile(prisma, { workspaceId, userId, filePath }) {
  await getWorkspace(prisma, { workspaceId, userId });
  const normalizedPath = normalizeWorkspacePath(filePath);
  const file = await prisma.coworkFile.findUnique({
    where: { workspaceId_path: { workspaceId: String(workspaceId), path: normalizedPath } },
  });
  if (!file) {
    throw new CoworkWorkspaceError('workspace_file_not_found', `File not found: ${normalizedPath}`, 404);
  }
  return file;
}

function isTextMime(mime, filePath) {
  return /^text\//.test(mime)
    || /(?:json|javascript|typescript|xml|yaml|svg)/i.test(mime)
    || /\.(?:md|txt|json|js|jsx|ts|tsx|css|html|xml|yaml|yml|csv|py|sql|sh)$/i.test(filePath);
}

async function readFile(prisma, { workspaceId, userId, filePath, version = null }) {
  const resolved = await readFileBuffer(prisma, { workspaceId, userId, filePath, version });
  const { file, source, buffer } = resolved;
  const text = isTextMime(source.mime, file.path);
  const decoded = text ? buffer.toString('utf8') : null;
  return {
    id: file.id,
    path: file.path,
    version: source.version || file.currentVersion,
    currentVersion: file.currentVersion,
    contentHash: source.contentHash,
    mime: source.mime,
    size: source.size,
    artifactId: source.artifactId || null,
    encoding: text ? 'utf8' : 'base64',
    content: text
      ? decoded.slice(0, MAX_TEXT_READ_CHARS)
      : buffer.toString('base64'),
    truncated: text && decoded.length > MAX_TEXT_READ_CHARS,
  };
}

async function readFileBuffer(prisma, { workspaceId, userId, filePath, version = null }) {
  const file = await findFile(prisma, { workspaceId, userId, filePath });
  let source = file;
  if (version != null && Number(version) !== file.currentVersion) {
    source = await prisma.coworkFileVersion.findUnique({
      where: { fileId_version: { fileId: file.id, version: Number(version) } },
    });
    if (!source) {
      throw new CoworkWorkspaceError('workspace_version_not_found', 'File version not found.', 404);
    }
  }
  const buffer = await readStorageBuffer(source.storageRef);
  return {
    file,
    source,
    buffer,
  };
}

function versionConflict(file, expectedVersion) {
  return new CoworkWorkspaceError(
    'workspace_version_conflict',
    `File changed after it was read. Expected version ${expectedVersion}; current version is ${file.currentVersion}.`,
    409,
    {
      path: file.path,
      expectedVersion,
      currentVersion: file.currentVersion,
      currentHash: file.contentHash,
    },
  );
}

async function writeFile(prisma, {
  workspaceId,
  userId,
  filePath,
  content,
  encoding = 'utf8',
  mime = null,
  expectedVersion = null,
  artifactId = null,
  authorRunId = null,
  updatedBy = 'agent',
}) {
  await getWorkspace(prisma, { workspaceId, userId });
  const normalizedPath = normalizeWorkspacePath(filePath);
  const buffer = contentBuffer(content, encoding);
  assertSize(buffer);
  const resolvedMime = inferMime(normalizedPath, mime);
  const stored = await persistContent({ userId, buffer, mime: resolvedMime });

  return prisma.$transaction(async (tx) => {
    const existing = await tx.coworkFile.findUnique({
      where: { workspaceId_path: { workspaceId: String(workspaceId), path: normalizedPath } },
    });

    if (!existing) {
      if (expectedVersion != null && Number(expectedVersion) !== 0) {
        throw new CoworkWorkspaceError(
          'workspace_version_conflict',
          `File does not exist; expected version ${expectedVersion}.`,
          409,
        );
      }
      return tx.coworkFile.create({
        data: {
          workspaceId: String(workspaceId),
          path: normalizedPath,
          contentHash: stored.hash,
          storageRef: stored.storageRef,
          artifactId,
          size: buffer.length,
          mime: resolvedMime,
          updatedBy,
          currentVersion: 1,
          versions: {
            create: {
              version: 1,
              contentHash: stored.hash,
              storageRef: stored.storageRef,
              artifactId,
              size: buffer.length,
              mime: resolvedMime,
              authorRunId,
            },
          },
        },
        include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      });
    }

    if (expectedVersion == null) {
      throw new CoworkWorkspaceError(
        'workspace_read_required',
        `Read ${normalizedPath} before overwriting it and provide its current version.`,
        409,
        { path: normalizedPath, currentVersion: existing.currentVersion },
      );
    }
    if (Number(expectedVersion) !== existing.currentVersion) {
      throw versionConflict(existing, Number(expectedVersion));
    }
    if (existing.contentHash === stored.hash) {
      return { ...existing, unchanged: true };
    }

    const nextVersion = existing.currentVersion + 1;
    const updated = await tx.coworkFile.updateMany({
      where: { id: existing.id, currentVersion: existing.currentVersion },
      data: {
        contentHash: stored.hash,
        storageRef: stored.storageRef,
        artifactId,
        size: buffer.length,
        mime: resolvedMime,
        updatedBy,
        currentVersion: nextVersion,
      },
    });
    if (updated.count !== 1) {
      const current = await tx.coworkFile.findUnique({ where: { id: existing.id } });
      throw versionConflict(current || existing, Number(expectedVersion));
    }
    await tx.coworkFileVersion.create({
      data: {
        fileId: existing.id,
        version: nextVersion,
        contentHash: stored.hash,
        storageRef: stored.storageRef,
        artifactId,
        size: buffer.length,
        mime: resolvedMime,
        authorRunId,
      },
    });
    return tx.coworkFile.findUnique({
      where: { id: existing.id },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
  });
}

async function deleteFile(prisma, { workspaceId, userId, filePath, expectedVersion }) {
  const file = await findFile(prisma, { workspaceId, userId, filePath });
  if (expectedVersion == null || Number(expectedVersion) !== file.currentVersion) {
    throw versionConflict(file, expectedVersion == null ? 'missing' : Number(expectedVersion));
  }
  await prisma.coworkFile.delete({ where: { id: file.id } });
  return { deleted: true, path: file.path, version: file.currentVersion };
}

async function moveFile(prisma, {
  workspaceId,
  userId,
  fromPath,
  toPath,
  expectedVersion,
}) {
  const file = await findFile(prisma, { workspaceId, userId, filePath: fromPath });
  if (expectedVersion == null || Number(expectedVersion) !== file.currentVersion) {
    throw versionConflict(file, expectedVersion == null ? 'missing' : Number(expectedVersion));
  }
  const target = normalizeWorkspacePath(toPath);
  const collision = await prisma.coworkFile.findUnique({
    where: { workspaceId_path: { workspaceId: String(workspaceId), path: target } },
  });
  if (collision) {
    throw new CoworkWorkspaceError('workspace_path_exists', `A file already exists at ${target}.`, 409);
  }
  return prisma.coworkFile.update({
    where: { id: file.id },
    data: { path: target, updatedBy: 'agent' },
  });
}

function globToRegExp(pattern) {
  let out = '^';
  const normalized = String(pattern || '**/*').replaceAll('\\', '/');
  if (normalized === '**' || normalized === '**/*') return /^.*$/i;
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const next = normalized[i + 1];
    if (char === '*' && next === '*') {
      if (normalized[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (char === '*') {
      out += '[^/]*';
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`, 'i');
}

async function globFiles(prisma, { workspaceId, userId, pattern = '**/*', limit = 500 }) {
  const files = await listFiles(prisma, { workspaceId, userId });
  const matcher = globToRegExp(pattern);
  return files.filter((file) => matcher.test(file.path)).slice(0, Math.min(Math.max(Number(limit) || 500, 1), 1000));
}

async function grepFiles(prisma, {
  workspaceId,
  userId,
  query,
  pattern = '**/*',
  ignoreCase = true,
  limit = 100,
}) {
  const needle = String(query || '');
  if (!needle) throw new CoworkWorkspaceError('workspace_query_required', 'A grep query is required.');
  const files = await globFiles(prisma, { workspaceId, userId, pattern, limit: 1000 });
  const matches = [];
  const wanted = ignoreCase ? needle.toLowerCase() : needle;
  for (const file of files) {
    if (!isTextMime(file.mime, file.path)) continue;
    const read = await readFile(prisma, { workspaceId, userId, filePath: file.path });
    const lines = read.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const haystack = ignoreCase ? lines[index].toLowerCase() : lines[index];
      if (!haystack.includes(wanted)) continue;
      matches.push({
        path: file.path,
        version: file.currentVersion,
        line: index + 1,
        text: lines[index].slice(0, 500),
      });
      if (matches.length >= Math.min(Math.max(Number(limit) || 100, 1), 500)) return matches;
    }
  }
  return matches;
}

function lineDiff(beforeText, afterText) {
  const before = String(beforeText || '').split(/\r?\n/);
  const after = String(afterText || '').split(/\r?\n/);
  if (before.length * after.length > 1_000_000) {
    return [
      `--- version A (${before.length} lines)`,
      `+++ version B (${after.length} lines)`,
      '[Diff omitted because the files are too large for an inline comparison.]',
    ].join('\n');
  }
  const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i][j] = before[i] === after[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push(` ${before[i]}`);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push(`-${before[i++]}`);
    } else {
      lines.push(`+${after[j++]}`);
    }
  }
  while (i < before.length) lines.push(`-${before[i++]}`);
  while (j < after.length) lines.push(`+${after[j++]}`);
  return lines.join('\n');
}

async function diffVersions(prisma, { workspaceId, userId, filePath, fromVersion, toVersion = null }) {
  const file = await findFile(prisma, { workspaceId, userId, filePath });
  const from = await readFile(prisma, {
    workspaceId,
    userId,
    filePath: file.path,
    version: Number(fromVersion),
  });
  const to = await readFile(prisma, {
    workspaceId,
    userId,
    filePath: file.path,
    version: toVersion == null ? file.currentVersion : Number(toVersion),
  });
  if (from.encoding !== 'utf8' || to.encoding !== 'utf8') {
    return {
      path: file.path,
      fromVersion: from.version,
      toVersion: to.version,
      binary: true,
      changed: from.contentHash !== to.contentHash,
    };
  }
  return {
    path: file.path,
    fromVersion: from.version,
    toVersion: to.version,
    binary: false,
    diff: lineDiff(from.content, to.content),
  };
}

async function exportWorkspaceZip(prisma, { workspaceId, userId }) {
  const workspace = await getWorkspace(prisma, { workspaceId, userId });
  const files = await prisma.coworkFile.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { path: 'asc' },
  });
  const totalBytes = files.reduce((sum, file) => sum + Math.max(0, Number(file.size) || 0), 0);
  if (totalBytes > MAX_EXPORT_BYTES) {
    throw new CoworkWorkspaceError(
      'workspace_export_too_large',
      `Workspace export exceeds the ${MAX_EXPORT_BYTES} byte limit.`,
      413,
      { maxBytes: MAX_EXPORT_BYTES, sizeBytes: totalBytes },
    );
  }
  const chunks = [];
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const complete = new Promise((resolve, reject) => {
    archive.once('end', resolve);
    archive.once('error', reject);
    archive.once('warning', (error) => {
      if (error.code !== 'ENOENT') reject(error);
    });
  });
  for (const file of files) {
    const buffer = await readStorageBuffer(file.storageRef);
    archive.append(buffer, { name: file.path, date: file.updatedAt });
  }
  await archive.finalize();
  await complete;
  return {
    filename: `${workspace.name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'workspace'}.zip`,
    buffer: Buffer.concat(chunks),
  };
}

async function importAgentArtifact(prisma, {
  workspaceId,
  userId,
  artifactId,
  targetPath = null,
  authorRunId = null,
}) {
  const { ARTIFACT_DIR } = require('../agents/task-tools');
  const id = String(artifactId || '').trim();
  if (!/^[a-f0-9]{8,64}$/i.test(id)) {
    throw new CoworkWorkspaceError('artifact_id_invalid', 'Invalid artifact id.');
  }
  let metadata;
  try {
    metadata = JSON.parse(await fsp.readFile(path.join(ARTIFACT_DIR, `${id}.json`), 'utf8'));
  } catch {
    throw new CoworkWorkspaceError('artifact_not_found', 'Artifact not found.', 404);
  }
  if (String(metadata.ownerUserId || '') !== String(userId)) {
    throw new CoworkWorkspaceError('artifact_not_found', 'Artifact not found.', 404);
  }
  let buffer = null;
  if (metadata.storageRef) {
    try { buffer = await readStorageBuffer(metadata.storageRef); } catch (_) { /* try local */ }
  }
  if (!buffer && metadata.storedRelPath) {
    const root = path.resolve(ARTIFACT_DIR);
    const local = path.resolve(root, metadata.storedRelPath);
    if (local.startsWith(`${root}${path.sep}`)) {
      try { buffer = await fsp.readFile(local); } catch (_) { /* missing after R2 mirror */ }
    }
  }
  if (!buffer) throw new CoworkWorkspaceError('artifact_content_unavailable', 'Artifact content is not available.', 404);
  const resolvedPath = normalizeWorkspacePath(targetPath || `deliverables/${metadata.filename || `${id}.bin`}`);
  const existing = await prisma.coworkFile.findUnique({
    where: { workspaceId_path: { workspaceId: String(workspaceId), path: resolvedPath } },
    select: { currentVersion: true },
  });
  return writeFile(prisma, {
    workspaceId,
    userId,
    filePath: resolvedPath,
    content: buffer,
    encoding: 'base64',
    mime: metadata.mime,
    expectedVersion: existing?.currentVersion || 0,
    artifactId: id,
    authorRunId,
    updatedBy: 'agent',
  });
}

module.exports = {
  CoworkWorkspaceError,
  MAX_FILE_BYTES,
  MAX_EXPORT_BYTES,
  normalizeWorkspacePath,
  inferMime,
  hashBuffer,
  readStorageBuffer,
  getWorkspace,
  createWorkspace,
  ensureWorkspaceForChat,
  listWorkspaces,
  listFiles,
  findFile,
  readFile,
  readFileBuffer,
  writeFile,
  deleteFile,
  moveFile,
  globFiles,
  grepFiles,
  diffVersions,
  exportWorkspaceZip,
  importAgentArtifact,
  lineDiff,
};
