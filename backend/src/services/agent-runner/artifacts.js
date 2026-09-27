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

// Match the exact workspace basename used by runAgentRunner. A prior output
// and a reattached upload with this same name occupy the same sandbox path.
function sanitizeUploadName(name, index) {
  const base = String(name || `file-${index + 1}`).split(/[\\/]/).pop();
  const clean = base.replace(/[^\w.\-() À-ɏ]/g, '_').slice(0, 180);
  return clean || `file-${index + 1}`;
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
  // Quoted replacement/title values are CONTENT, not source selectors:
  // "Excel avanzado" must not redirect a PPTX edit to an older workbook.
  const referenceText = require('../document-editing/presentation-title-intent').documentReferenceText(instruction);
  const named = rows.filter((row) => {
    if (!row.filename) return false;
    const filename = String(row.filename).split(/[\\/]/).pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}_.-])${filename}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`, 'iu').test(referenceText);
  });
  if (named.length === 1) return named[0];
  const text = referenceText.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
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

// object-storage has no readFile: an R2 ref is materialised with toLocalTemp
// (as readSourceBuffer does). Without this, every follow-up on a runner
// artifact whose local copy was gone ran WITHOUT the latest version. A store
// that offers readFile (tests / adapters) is still used as is.
async function readStoredObject(objectStore, fs, ref) {
  if (!ref) return null;
  if (typeof objectStore.readFile === 'function') return objectStore.readFile(ref);
  if (typeof objectStore.isRemote === 'function' && objectStore.isRemote(ref) && typeof objectStore.toLocalTemp === 'function') {
    const local = await objectStore.toLocalTemp(ref);
    try {
      return await fs.readFile(local.path);
    } finally {
      try { await local.cleanup(); } catch (_) { /* best effort */ }
    }
  }
  return null;
}

async function loadArtifactBuffer(row, { objectStorage, fsImpl, artifactDir } = {}) {
  if (!row) return null;
  const objectStore = objectStorage || require('../object-storage');
  const fs = fsImpl || require('fs/promises');
  if (row.path) {
    try {
      const buf = await readStoredObject(objectStore, fs, row.path);
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
      if (meta.storageRef) {
        try { const buffer = await readStoredObject(objectStore, fs, meta.storageRef); if (Buffer.isBuffer(buffer) && buffer.length) return buffer; } catch { /* local copy below */ }
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
  // The last edited artifact owns its workspace name. Reattached originals
  // can include that exact filename (especially PDF outputs which keep their
  // original name). Staging them after the artifact overwrote the edited bytes
  // before the agent saw the file. Keep the other attached documents available.
  const priorName = prior.length ? sanitizeUploadName(prior[0].name, 0).toLowerCase() : null;
  const sourceFileId = String(latest?.validation?.documentEdit?.sourceFileId || '');
  const otherAttachments = priorName
    ? attached.filter((file, index) => {
      if (sanitizeUploadName(file.name, index).toLowerCase() !== priorName) return true;
      // When stored lineage exists, a different upload with the same name is
      // not the source of this version. Let the staging collision gate report
      // the ambiguity instead of silently discarding that user's attachment.
      return Boolean(sourceFileId && file.fileId && String(file.fileId) !== sourceFileId);
    })
    : attached;
  return { files: [...prior, ...otherAttachments], priorArtifacts: prior, latest };
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
  sanitizeUploadName,
};
