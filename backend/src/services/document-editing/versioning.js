'use strict';

// Version history for the DocumentEditingService. Each successful surgical
// edit records a FileVersion pointing at the immutable artifact holding the
// edited bytes. The ORIGINAL upload is never mutated, so "restore" is simply
// re-serving an earlier artifact. Best-effort by contract: a versioning
// failure must NEVER fail the edit itself (the user already has the file).

// Record a new version. Returns the created row, or null on any failure
// (missing prisma / model / write error) — the caller ignores null.
// `content` (optional, MVP): the edited Markdown for human manual edits. Kept
// optional so existing background-editor callers stay untouched.
async function recordFileVersion(prisma, {
  fileId,
  userId,
  artifactId,
  filename,
  summary = '',
  editPlan = null,
  validationPassed = true,
  createdByChatId = null,
  content = null,
} = {}) {
  // Invalid candidates are never versions. This defensive guard protects
  // callers beyond the source-preserving editor as well as legacy code paths.
  if (!prisma?.fileVersion || !fileId || !userId || validationPassed !== true) return null;
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
            content: content !== null && content !== undefined
              ? String(content).slice(0, 2_000_000)
              : undefined,
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
      where: { fileId, userId, validationPassed: true },
      orderBy: { version: 'desc' },
      select: {
        id: true, version: true, artifactId: true, filename: true,
        summary: true, validationPassed: true, createdByChatId: true, createdAt: true, content: true,
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
    const row = await prisma.fileVersion.findFirst({ where: { id: versionId, userId, validationPassed: true } });
    return row || null;
  } catch {
    return null;
  }
}

// Restore is non-destructive: it creates a new head that points to the exact
// immutable artifact from an earlier version. The original upload and every
// intermediate edit remain available in the history.
//
// Two version shapes are restorable:
//   - artifact-backed (background surgical edits): the new head points at the
//     same immutable artifact.
//   - content-backed (manual /chat editor edits, `content` Markdown on the
//     row, no artifact): the new head carries the same Markdown. Without this
//     branch every manual edit would be unrestorable — its rows have
//     artifactId === null by design (see POST /files/:id/edit).
async function restoreFileVersion(prisma, { fileId, versionId, userId, createdByChatId = null } = {}) {
  if (!prisma?.fileVersion || !fileId || !versionId || !userId) return null;
  const source = await prisma.fileVersion.findFirst({
    where: { id: versionId, fileId, userId, validationPassed: true },
  }).catch(() => null);
  if (!source || source.validationPassed !== true) return null;
  const hasArtifact = typeof source.artifactId === 'string' && source.artifactId.length > 0;
  const hasContent = typeof source.content === 'string' && source.content.trim().length > 0;
  // Exactly one payload shape must be present; otherwise there is nothing to
  // restore (original-upload placeholder rows carry neither).
  if (!hasArtifact && !hasContent) return null;
  const restored = await recordFileVersion(prisma, {
    fileId,
    userId,
    artifactId: hasArtifact ? source.artifactId : null,
    filename: source.filename,
    summary: `Restaurada desde la versión ${source.version}${source.summary ? `: ${source.summary}` : ''}`,
    editPlan: {
      type: 'restore',
      sourceVersionId: source.id,
      sourceVersion: source.version,
    },
    validationPassed: source.validationPassed,
    createdByChatId,
    content: hasContent ? source.content : null,
  });
  return restored ? { source, restored } : null;
}

module.exports = {
  getFileVersion,
  listFileVersions,
  recordFileVersion,
  restoreFileVersion,
};
