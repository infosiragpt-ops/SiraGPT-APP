/**
 * file-processing-status — single writer for the File row's processing
 * state machine. Every stage transition flows through `setStage` so:
 *   - the DB row reflects the latest stage with a timestamp
 *   - a structured pino log is emitted (file_id, user_id, stage, error)
 *     so the audit trail is the same regardless of who called it
 *   - failures never poison the pipeline (write errors are logged but
 *     don't throw; the upload route will keep its existing semantics
 *     even if the state column is unwritable)
 *
 * Stages (linear, terminal at 'ready' or 'failed'):
 *   uploaded   — multer accepted the bytes
 *   validating — magic-byte / allowlist check
 *   extracting — fileProcessor pulling text/HTML
 *   chunking   — RAG splitting extracted text
 *   embedding  — OpenAI embeddings call
 *   indexing   — vector store write
 *   ready      — file is queryable end-to-end
 *   failed     — terminal failure; processingError carries the reason
 */

const STAGES = Object.freeze([
  'uploaded',
  'validating',
  'extracting',
  'chunking',
  'embedding',
  'indexing',
  'ready',
  'failed',
]);

const TERMINAL_STAGES = new Set(['ready', 'failed']);

function isValidStage(stage) {
  return STAGES.includes(stage);
}

/**
 * Write a stage transition for `fileId`. Returns true on success,
 * false on persistence failure — caller doesn't need to branch but
 * may want to surface a degraded-status warning if it cares.
 *
 * Options:
 *   userId — included in the structured log for auditability.
 *   error  — required when stage === 'failed'; carries human-readable
 *            reason (e.g. "extract_docx: file is corrupt"). Cleared
 *            on any non-failed transition.
 */
async function setStage(prisma, fileId, stage, opts = {}) {
  if (!fileId) return false;
  if (!isValidStage(stage)) {
    // Invalid stage is a programmer error — log loudly so the bad
    // call site is obvious in dev, but don't throw and abort the
    // pipeline.
    console.error('[file-status] invalid stage', { fileId, stage });
    return false;
  }
  const now = new Date();
  const data = {
    processingStage: stage,
    processingStageAt: now,
  };
  if (stage === 'failed') {
    data.processingError = String(opts.error || 'unknown_error').slice(0, 1000);
  } else {
    data.processingError = null;
  }
  let written = false;
  try {
    await prisma.file.update({ where: { id: fileId }, data });
    written = true;
  } catch (err) {
    // Don't crash the pipeline if the row vanished or the column is
    // missing in a partially-migrated environment.
    console.warn('[file-status] write failed', {
      fileId,
      stage,
      message: err && err.message ? err.message : String(err),
    });
  }
  // Structured log mirrors the DB write so it's queryable in pino
  // even if the row could not be updated.
  console.log('[file-status]', JSON.stringify({
    event: 'file_processing_stage',
    file_id: fileId,
    user_id: opts.userId || null,
    stage,
    error: stage === 'failed' ? data.processingError : null,
    written,
    ts: now.toISOString(),
  }));
  return written;
}

/**
 * Read the current stage for an external consumer. Returns null when
 * the file row doesn't exist (the route will turn that into a 404).
 */
async function getStatus(prisma, fileId) {
  if (!fileId) return null;
  const row = await prisma.file.findUnique({
    where: { id: fileId },
    select: {
      id: true,
      userId: true,
      originalName: true,
      mimeType: true,
      size: true,
      processingStage: true,
      processingError: true,
      processingStageAt: true,
      createdAt: true,
    },
  });
  if (!row) return null;
  return {
    fileId: row.id,
    userId: row.userId,
    name: row.originalName,
    mimeType: row.mimeType,
    size: row.size,
    stage: row.processingStage || 'uploaded',
    error: row.processingError || null,
    stageAt: row.processingStageAt || row.createdAt,
    isTerminal: TERMINAL_STAGES.has(row.processingStage || ''),
    createdAt: row.createdAt,
  };
}

module.exports = {
  STAGES,
  TERMINAL_STAGES,
  isValidStage,
  setStage,
  getStatus,
};
