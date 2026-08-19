'use strict';

/**
 * Conversation artifact registry.
 * Follow-ups ("ahora ponlas rosadas") must always operate on the LAST edited
 * file for the chat, never the original upload.
 *
 * Persistence: GeneratedArtifact rows (chatId + userId) plus the bytes
 * already stored by saveArtifact. No extra Prisma model required.
 */

function mimeToExt(mime, filename) {
  const fromName = String(filename || '').split('.').pop();
  if (fromName && fromName.length <= 5) return fromName.toLowerCase();
  const m = String(mime || '').toLowerCase();
  if (m.includes('presentation') || m.includes('pptx')) return 'pptx';
  if (m.includes('word') || m.includes('docx')) return 'docx';
  if (m.includes('sheet') || m.includes('xlsx')) return 'xlsx';
  if (m.includes('pdf')) return 'pdf';
  return 'bin';
}

async function listConversationArtifacts(prisma, { userId, chatId, take = 8 } = {}) {
  const limit = Math.max(1, Math.min(20, Number(take) || 8));
  if (prisma?.generatedArtifact && userId && chatId) {
    try {
      const rows = await prisma.generatedArtifact.findMany({
        where: { userId: String(userId), chatId: String(chatId) },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      if (rows.length) return rows;
    } catch (_) { /* fall through to disk metadata */ }
  }
  if (!userId || !chatId) return [];
  try {
    const { listArtifactsByOwner } = require('../agents/task-tools');
    return listArtifactsByOwner(userId, { max: 200 })
      .filter((item) => String(item.chatId || '') === String(chatId))
      .slice(0, limit)
      .map((item) => ({
        id: item.id,
        filename: item.filename,
        mime: item.mime,
        path: null,
        chatId: item.chatId,
        userId,
        createdAt: item.timestamp,
      }));
  } catch (_) {
    return [];
  }
}

async function getLatestConversationArtifact(prisma, { userId, chatId } = {}) {
  const rows = await listConversationArtifacts(prisma, { userId, chatId, take: 1 });
  return rows[0] || null;
}

async function hasConversationArtifacts(prisma, { userId, chatId } = {}) {
  const latest = await getLatestConversationArtifact(prisma, { userId, chatId });
  return Boolean(latest);
}

async function loadArtifactBuffer(row, { objectStorage, fsImpl } = {}) {
  if (!row) return null;
  const objectStore = objectStorage || require('../object-storage');
  const fs = fsImpl || require('fs/promises');
  if (row.path && typeof objectStore.readFile === 'function') {
    try {
      const buf = await objectStore.readFile(row.path);
      if (Buffer.isBuffer(buf) && buf.length) return buf;
    } catch (_) { /* fall through */ }
  }
  if (row.path) {
    try {
      const buf = await fs.readFile(row.path);
      if (Buffer.isBuffer(buf) && buf.length) return buf;
    } catch (_) { /* fall through */ }
  }
  return null;
}

/**
 * Seed files for a follow-up: prefer the latest edited artifact, then any
 * newly attached uploads. Artifact bytes are tagged so the prompt can tell
 * the model to edit THIS version.
 */
async function resolveTurnFiles({
  prisma,
  userId,
  chatId,
  attachedFiles = [],
  objectStorage,
} = {}) {
  const attached = Array.isArray(attachedFiles) ? attachedFiles.filter((f) => f && f.buffer) : [];
  const latest = await getLatestConversationArtifact(prisma, { userId, chatId });
  const prior = [];
  if (latest) {
    const buffer = await loadArtifactBuffer(latest, { objectStorage });
    if (buffer) {
      prior.push({
        name: latest.filename || `artifact.${mimeToExt(latest.mime, latest.filename)}`,
        buffer,
        mime: latest.mime,
        artifactId: latest.id,
        isPriorArtifact: true,
      });
    }
  }
  // If the user re-attached the original, still put the prior artifact FIRST
  // so the agent edits the last version.
  return { files: [...prior, ...attached], priorArtifacts: prior, latest };
}

async function persistOutputs({
  outputs = [],
  userId,
  chatId,
  saveArtifact,
  prisma,
  onEvent = () => {},
} = {}) {
  const save = saveArtifact || require('../agents/task-tools').saveArtifact;
  const artifacts = [];
  for (const out of outputs) {
    if (!out || !Buffer.isBuffer(out.buffer) || !out.buffer.length) continue;
    if (out.valid === false) continue;
    const ext = String(out.name || 'file.bin').split('.').pop().toLowerCase();
    const mime = (
      ext === 'pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      : ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : ext === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : ext === 'pdf' ? 'application/pdf'
      : 'application/octet-stream'
    );
    let saved;
    try {
      saved = save({
        filename: out.name,
        base64: out.buffer.toString('base64'),
        mime,
        ownerUserId: userId || null,
        chatId: chatId || null,
        category: 'agent_artifact',
        validation: { ok: true, passed: true, engine: 'agent_runner' },
      });
    } catch (err) {
      artifacts.push({ filename: out.name, error: String(err && err.message || err).slice(0, 200) });
      continue;
    }
    const artifact = {
      id: saved.id,
      filename: saved.filename,
      mime: saved.mime,
      format: saved.format || ext,
      sizeBytes: saved.sizeBytes,
      path: saved.path || null,
      downloadUrl: saved.downloadUrl,
      previewHtml: null,
      validation: { ok: true, passed: true, engine: 'agent_runner' },
    };
    if (prisma?.generatedArtifact && userId && saved.id) {
      try {
        await prisma.generatedArtifact.upsert({
          where: { id: String(saved.id) },
          create: {
            id: String(saved.id),
            userId: String(userId),
            chatId: chatId ? String(chatId) : null,
            filename: saved.filename,
            mime: saved.mime || mime,
            format: saved.format || ext,
            path: saved.path || null,
            sizeBytes: Number(saved.sizeBytes) || 0,
            validation: { ok: true, passed: true, engine: 'agent_runner' },
          },
          update: {
            filename: saved.filename,
            path: saved.path || undefined,
            sizeBytes: Number(saved.sizeBytes) || 0,
            validation: { ok: true, passed: true, engine: 'agent_runner' },
          },
        });
      } catch (_) { /* follow-ups can still use disk metadata */ }
    }
    try { onEvent({ type: 'file_artifact', artifact }); } catch (_) { /* UI must never fail the run */ }
    artifacts.push(artifact);
  }
  return artifacts;
}

module.exports = {
  listConversationArtifacts,
  getLatestConversationArtifact,
  hasConversationArtifacts,
  loadArtifactBuffer,
  resolveTurnFiles,
  persistOutputs,
  mimeToExt,
};
