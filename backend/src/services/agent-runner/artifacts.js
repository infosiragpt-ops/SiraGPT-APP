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

async function getLatestConversationArtifact(prisma, { userId, chatId, instruction = '' } = {}) {
  const rows = await listConversationArtifacts(prisma, { userId, chatId, take: 20 });
  const text = String(instruction).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const format = /\b(?:pptx?|powerpoint|presentacion|diapositiva\w*|lamina\w*|landin\w*|slide\w*)\b/.test(text) ? 'pptx'
    : /\b(?:docx|word)\b/.test(text) ? 'docx' : /\b(?:xlsx|excel|celda\w*|hoja\w*)\b/.test(text) ? 'xlsx'
      : /\bpdf\b/.test(text) ? 'pdf' : null;
  const eligible = rows.filter((row) => ['docx', 'xlsx', 'pptx', 'pdf', 'txt', 'csv'].includes(mimeToExt(row.mime, row.filename)));
  return (format ? eligible.find((row) => mimeToExt(row.mime, row.filename) === format) : rows[0]) || null;
}

async function hasConversationArtifacts(prisma, { userId, chatId } = {}) {
  const latest = await getLatestConversationArtifact(prisma, { userId, chatId });
  return Boolean(latest);
}

async function loadArtifactBuffer(row, { objectStorage, fsImpl, artifactDir } = {}) {
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
  // Disk fallback rows intentionally omit storage paths. Recover those only
  // from trusted metadata with matching owner AND conversation, never from a
  // client filename/path or an unscoped artifact id.
  if (/^[a-f0-9]{16}$/.test(String(row.id || '')) && row.userId && row.chatId) {
    try {
      const path = require('path');
      const root = path.resolve(artifactDir || require('../agents/task-tools').ARTIFACT_DIR);
      const meta = JSON.parse(await fs.readFile(path.join(root, `${row.id}.json`), 'utf8'));
      if (String(meta.ownerUserId) !== String(row.userId) || String(meta.chatId) !== String(row.chatId)) return null;
      if (meta.storageRef && typeof objectStore.readFile === 'function') {
        try { const buffer = await objectStore.readFile(meta.storageRef); if (Buffer.isBuffer(buffer) && buffer.length) return buffer; } catch { /* local copy below */ }
      }
      const full = path.resolve(root, String(meta.storedRelPath || `${row.id}-${meta.filename}`));
      if (!full.startsWith(root + path.sep)) return null;
      const buffer = await fs.readFile(full);
      if (Buffer.isBuffer(buffer) && buffer.length) return buffer;
    } catch { /* unavailable original is never fabricated */ }
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
  instruction = '',
} = {}) {
  const attached = Array.isArray(attachedFiles) ? attachedFiles.filter((f) => f && f.buffer) : [];
  const latest = await getLatestConversationArtifact(prisma, { userId, chatId, instruction });
  const prior = [];
  if (latest) {
    const buffer = await loadArtifactBuffer({ ...latest, userId, chatId }, { objectStorage });
    if (buffer) {
      prior.push({
        name: latest.filename || `artifact.${mimeToExt(latest.mime, latest.filename)}`,
        buffer,
        mime: latest.mime,
        artifactId: latest.id,
        isPriorArtifact: true,
      });
    }
    else if (require('../source-preserving-document-edit').isSourcePreservingEditRequest(instruction, [latest])) {
      throw new Error('No pude cargar la última versión del documento; adjúntala de nuevo. No usaré una versión anterior en su lugar.');
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
    const validation = out.validation || { ok: true, passed: true, engine: 'agent_runner', scope: 'file_structure_only' };
    try {
      saved = save({
        filename: out.name,
        base64: out.buffer.toString('base64'),
        mime,
        ownerUserId: userId || null,
        chatId: chatId || null,
        category: 'agent_artifact',
        validation,
      });
      if (!saved?.id || !saved?.filename || !saved?.downloadUrl) throw new Error('artifact_persistence_incomplete');
    } catch (err) {
      try { onEvent({ type: 'output_invalid', name: out.name, reason: 'artifact_persistence_failed' }); } catch { /* non-fatal UI event */ }
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
      validation,
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
            validation,
          },
          update: {
            filename: saved.filename,
            path: saved.path || undefined,
            sizeBytes: Number(saved.sizeBytes) || 0,
            validation,
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
