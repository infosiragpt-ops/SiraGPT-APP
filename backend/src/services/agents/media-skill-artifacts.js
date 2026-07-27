'use strict';

function artifactEvent(artifact, extra = {}) {
  return {
    id: artifact.id,
    filename: artifact.filename,
    format: artifact.format,
    mime: artifact.mime,
    sizeBytes: artifact.sizeBytes,
    downloadUrl: artifact.downloadUrl,
    category: artifact.category || extra.category || null,
    kind: extra.kind || artifact.category || extra.category || null,
    ...extra,
  };
}

function saveBufferArtifact({ item, ctx = {}, category = null, kind = null, extra = {} }) {
  if (!Buffer.isBuffer(item?.buffer) || item.buffer.length === 0) {
    throw new Error('media artifact buffer is empty');
  }
  const saveArtifact = typeof ctx.saveArtifact === 'function'
    ? ctx.saveArtifact
    : require('./task-tools').saveArtifact;
  const artifact = saveArtifact({
    filename: item.filename,
    base64: item.buffer.toString('base64'),
    mime: item.mime,
    ownerUserId: ctx.userId,
    chatId: ctx.chatId,
    category,
  });
  const eventArtifact = artifactEvent(artifact, { category, kind, ...extra });
  try { ctx.onEvent?.({ type: 'file_artifact', artifact: eventArtifact }); } catch { /* best effort */ }
  return eventArtifact;
}

module.exports = { artifactEvent, saveBufferArtifact };
