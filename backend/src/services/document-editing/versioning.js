'use strict';

// Version history for the DocumentEditingService. Each successful surgical
// edit records a FileVersion pointing at the immutable artifact holding the
// edited bytes. The ORIGINAL upload is never mutated, so "restore" is simply
// re-serving an earlier artifact. Best-effort by contract: a versioning
// failure must NEVER fail the edit itself (the user already has the file).

// Record a new version. Returns the created row, or null on any failure
// (missing prisma / model / write error) — the caller ignores null.
async function recordFileVersion(prisma, {
  fileId,
  userId,
  artifactId,
  filename,
  summary = '',
  editPlan = null,
  validationPassed = true,
  createdByChatId = null,
} = {}) {
  if (!prisma?.fileVersion || !fileId || !userId) return null;
  try {
    // Next monotonic version for this file. A unique([fileId, version])
    // constraint guards against races; on collision we retry once.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const last = await prisma.fileVersion.findFirst({
        where: { fileId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const version = (last?.version || 0) + 1;
      try {
        return await prisma.fileVersion.create({
          data: {
            fileId,
            userId,
            version,
            artifactId: artifactId || null,
            filename: String(filename || 'documento').slice(0, 255),
            summary: summary ? String(summary).slice(0, 2000) : null,
            editPlan: editPlan || undefined,
            validationPassed: Boolean(validationPassed),
            createdByChatId: createdByChatId || null,
          },
        });
      } catch (err) {
        // Unique-constraint race → recompute the next version and retry.
        if (String(err?.code) === 'P2002') continue;
        throw err;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// List versions for a file, newest first, scoped to the owner.
async function listFileVersions(prisma, { fileId, userId } = {}) {
  if (!prisma?.fileVersion || !fileId || !userId) return [];
  try {
    return await prisma.fileVersion.findMany({
      where: { fileId, userId },
      orderBy: { version: 'desc' },
      select: {
        id: true, version: true, artifactId: true, filename: true,
        summary: true, validationPassed: true, createdByChatId: true, createdAt: true,
      },
    });
  } catch {
    return [];
  }
}

// Resolve a single version by id, ownership-checked. Returns the row or null.
async function getFileVersion(prisma, { versionId, userId } = {}) {
  if (!prisma?.fileVersion || !versionId || !userId) return null;
  try {
    const row = await prisma.fileVersion.findFirst({ where: { id: versionId, userId } });
    return row || null;
  } catch {
    return null;
  }
}

// Restore is non-destructive: it creates a new head that points to the exact
// immutable artifact from an earlier version. The original upload and every
// intermediate edit remain available in the history.
async function restoreFileVersion(prisma, { fileId, versionId, userId, createdByChatId = null } = {}) {
  if (!prisma?.fileVersion || !fileId || !versionId || !userId) return null;
  const source = await prisma.fileVersion.findFirst({
    where: { id: versionId, fileId, userId },
  }).catch(() => null);
  if (!source?.artifactId) return null;
  const restored = await recordFileVersion(prisma, {
    fileId,
    userId,
    artifactId: source.artifactId,
    filename: source.filename,
    summary: `Restaurada desde la versión ${source.version}${source.summary ? `: ${source.summary}` : ''}`,
    editPlan: {
      type: 'restore',
      sourceVersionId: source.id,
      sourceVersion: source.version,
    },
    validationPassed: source.validationPassed,
    createdByChatId,
  });
  return restored ? { source, restored } : null;
}

module.exports = {
  getFileVersion,
  listFileVersions,
  recordFileVersion,
  restoreFileVersion,
};
