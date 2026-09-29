'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { hasVerifiedSavBytes } = require('./sav-validation');

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

/**
 * Format ('pptx', 'docx', 'html', 'png'…) of the artifact a follow-up edits:
 * the latest one, or the one the request names. null when the chat has none.
 * Routing uses it to tell an Office edit (runner, honest errors) from a
 * follow-up on an html page, a script or an image (chat loop).
 */
async function getConversationArtifactFormat(prisma, { userId, chatId, instruction = '' } = {}) {
  const latest = await getLatestConversationArtifact(prisma, { userId, chatId, instruction });
  if (!latest) return null;
  const ext = mimeToExt(latest.mime, latest.filename);
  return ext && ext !== 'bin' ? ext : null;
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
  artifactDir,
} = {}) {
  const attached = Array.isArray(attachedFiles) ? attachedFiles.filter((f) => f && f.buffer) : [];
  const generatedFollowup = require('../agents/generated-artifact-followup');
  const pairEdit = generatedFollowup.isSavXlsxPairEditRequest(instruction);
  // A newly uploaded pair is the complete source for this turn. Do not seed
  // an unrelated third file from the chat's earlier generated artifacts.
  if (pairEdit && attached.length) {
    if (attached.length === 2
      && new Set(attached.map((file) => mimeToExt(file.mime, file.name))).size === 2
      && attached.some((file) => mimeToExt(file.mime, file.name) === 'sav')
      && attached.some((file) => mimeToExt(file.mime, file.name) === 'xlsx')) {
      return { files: attached, priorArtifacts: [], latest: null };
    }
    throw new Error('La edición conjunta requiere los dos originales SAV y Excel legibles. No usé archivos anteriores ni entregué una edición parcial.');
  }
  if (pairEdit && generatedFollowup.isGeneratedSavXlsxEditFollowup(instruction)) {
    const refs = await generatedFollowup.resolveChatGeneratedArtifactFollowup(prisma, {
      userId,
      chatId,
      goal: instruction,
      allowGeneratedPairEdit: true,
      ...(artifactDir ? { artifactDir } : {}),
    });
    // A pair is one delivery. Never edit only the newest workbook or borrow a
    // SAV from an older task when the last delivery is incomplete/corrupt.
    const byFormat = new Map(refs.map((ref) => [ref.format, ref]));
    if (refs.length !== 2 || byFormat.size !== 2 || !byFormat.has('sav') || !byFormat.has('xlsx')) {
      throw new Error('No pude recuperar juntos el SAV y el Excel de la última entrega. No edité ninguno; vuelve a adjuntar ambos archivos.');
    }
    const prior = [];
    for (const format of ['sav', 'xlsx']) {
      const ref = byFormat.get(format);
      const buffer = await loadArtifactBuffer({
        id: ref.id,
        filename: ref.filename,
        userId,
        chatId,
        path: null,
      }, { objectStorage, artifactDir });
      if (!buffer) {
        throw new Error('No pude abrir ambos archivos de la última entrega. No edité ninguno; vuelve a adjuntar el SAV y el Excel.');
      }
      prior.push({
        name: ref.filename,
        buffer,
        mime: format === 'sav' ? 'application/x-spss-sav' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        artifactId: ref.id,
        isPriorArtifact: true,
      });
    }
    return { files: prior, priorArtifacts: prior, latest: { id: prior[0].artifactId } };
  }
  if (pairEdit) {
    throw new Error('Adjunta ambos originales SAV y Excel para esta edición conjunta. No se usó un archivo anterior ni se inició una edición parcial.');
  }
  const latest = await getLatestConversationArtifact(prisma, { userId, chatId, instruction });
  const prior = [];
  if (latest) {
    const buffer = await loadArtifactBuffer({ ...latest, userId, chatId }, { objectStorage, artifactDir });
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

/** An explicit selection must not silently become a previous chat delivery. */
function assertSelectedSavXlsxInputs({ instruction = '', fileIds = [], loadedFiles = [] } = {}) {
  if (!require('../agents/generated-artifact-followup').isSavXlsxPairEditRequest(instruction)) return;
  const selected = [...new Set((Array.isArray(fileIds) ? fileIds : []).map(String).filter(Boolean))];
  if (!selected.length) return;
  const loaded = new Set((Array.isArray(loadedFiles) ? loadedFiles : []).map((file) => String(file?.fileId || '')).filter(Boolean));
  if (selected.length !== 2 || loaded.size !== 2 || selected.some((id) => !loaded.has(id))) {
    throw new Error('No pude abrir los dos archivos SAV y Excel seleccionados. No usé versiones anteriores; vuelve a adjuntar ambos originales.');
  }
}

async function persistOutputs({
  outputs = [],
  userId,
  chatId,
  saveArtifact,
  prisma,
  onEvent = () => {},
  atomicSavXlsxPair = false,
} = {}) {
  const taskTools = require('../agents/task-tools');
  const save = saveArtifact || taskTools.saveArtifact;
  const artifacts = [];
  const eligible = [];
  for (const out of outputs) {
    if (!out || !Buffer.isBuffer(out.buffer) || !out.buffer.length) continue;
    if (out.valid === false) continue;
    const ext = String(out.name || 'file.bin').split('.').pop().toLowerCase();
    if (ext === 'sav' && !hasVerifiedSavBytes(out)) {
      // No .sav card may become "Validado" merely because it has bytes or a
      // caller supplied validation.passed. The exact persisted bytes must
      // have passed read_sav in this AgentRunner turn.
      try { onEvent({ type: 'output_invalid', name: out.name, reason: 'sav_unverified' }); } catch { /* trace only */ }
      continue;
    }
    eligible.push({ out, ext });
  }
  if (atomicSavXlsxPair && (eligible.length !== 2
    || new Set(eligible.map((item) => item.ext)).size !== 2
    || !eligible.some((item) => item.ext === 'sav')
    || !eligible.some((item) => item.ext === 'xlsx'))) {
    try { onEvent({ type: 'output_invalid', name: 'SAV/Excel', reason: 'artifact_pair_incomplete' }); } catch { /* trace only */ }
    return [];
  }

  // saveArtifact writes the binary and its listing metadata synchronously.
  // Record the deterministic paths before saving so a failed second save can
  // remove only files created by this pair, preserving an earlier identical
  // artifact with the same content-derived id.
  const rollback = [];
  if (atomicSavXlsxPair) {
    const scope = `${userId || 'anonymous'}:${chatId || 'no-chat'}:`;
    for (const { out } of eligible) {
      const clean = taskTools.INTERNAL.sanitizeArtifactFilename(out.name);
      const id = taskTools.INTERNAL.artifactIdFor(Buffer.concat([Buffer.from(clean), out.buffer]), scope);
      const metadataPath = taskTools.INTERNAL.metadataPathFor(id);
      const binaryPath = path.join(taskTools.ARTIFACT_DIR, `${id}-${clean}`);
      const readIfPresent = async (file) => {
        try { return await fs.readFile(file); }
        catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
      };
      const previousMetadata = await readIfPresent(metadataPath);
      const binaryExisted = await fs.stat(binaryPath).then(() => true, (error) => {
        if (error?.code === 'ENOENT') return false;
        throw error;
      });
      rollback.push({ id, metadataPath, binaryPath, previousMetadata, binaryExisted });
    }
  }

  const rollbackPair = async () => {
    for (const item of rollback) {
      let remoteRef = null;
      if (item.previousMetadata === null) {
        try {
          const metadata = JSON.parse(await fs.readFile(item.metadataPath, 'utf8'));
          remoteRef = metadata?.storageRef || null;
        } catch { /* metadata may not have been written */ }
        try { await fs.unlink(item.metadataPath); } catch (error) {
          if (error?.code !== 'ENOENT') console.warn('[agent-runner] artifact metadata rollback failed:', error?.message);
        }
      } else {
        try { await fs.writeFile(item.metadataPath, item.previousMetadata); } catch (error) {
          console.warn('[agent-runner] artifact metadata restore failed:', error?.message);
        }
      }
      if (!item.binaryExisted) {
        try { await fs.unlink(item.binaryPath); } catch (error) {
          if (error?.code !== 'ENOENT') console.warn('[agent-runner] artifact binary rollback failed:', error?.message);
        }
      }
      if (remoteRef) {
        // The mirror starts asynchronously inside saveArtifact. Removal is
        // best effort: an upload still in flight can finish after this call.
        try { await require('../object-storage').remove(remoteRef); } catch { /* best effort */ }
      }
    }
  };

  for (const { out, ext } of eligible) {
    const mime = (
      ext === 'pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      : ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : ext === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : ext === 'sav' ? 'application/x-spss-sav'
      : ext === 'pdf' ? 'application/pdf'
      : 'application/octet-stream'
    );
    let saved;
    const validation = out.validation || { ok: true, passed: true, engine: 'agent_runner', scope: 'file_structure_only' };
    try {
      saved = await save({
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
      if (atomicSavXlsxPair) {
        await rollbackPair();
        return [];
      }
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
    if (!atomicSavXlsxPair && prisma?.generatedArtifact && userId && saved.id) {
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
    if (!atomicSavXlsxPair) {
      try { onEvent({ type: 'file_artifact', artifact }); } catch (_) { /* UI must never fail the run */ }
    }
    artifacts.push(artifact);
  }

  if (atomicSavXlsxPair) {
    if (prisma?.generatedArtifact && userId) {
      const upsertPair = async (database) => {
        for (const artifact of artifacts) {
          await database.generatedArtifact.upsert({
            where: { id: String(artifact.id) },
            create: {
              id: String(artifact.id), userId: String(userId), chatId: chatId ? String(chatId) : null,
              filename: artifact.filename, mime: artifact.mime, format: artifact.format,
              path: artifact.path, sizeBytes: Number(artifact.sizeBytes) || 0,
              validation: artifact.validation,
            },
            update: {
              filename: artifact.filename, path: artifact.path || undefined,
              sizeBytes: Number(artifact.sizeBytes) || 0, validation: artifact.validation,
            },
          });
        }
      };
      try {
        // PostgreSQL rows appear together. The on-disk metadata is already
        // staged, and neither download card is emitted until this commits.
        if (typeof prisma.$transaction === 'function') await prisma.$transaction(upsertPair);
        else await upsertPair(prisma);
      } catch (error) {
        if (typeof prisma.$transaction !== 'function' && typeof prisma.generatedArtifact.deleteMany === 'function') {
          const newIds = rollback.filter((item) => item.previousMetadata === null).map((item) => item.id);
          if (newIds.length) {
            try { await prisma.generatedArtifact.deleteMany({ where: { id: { in: newIds } } }); }
            catch (rollbackError) { console.warn('[agent-runner] artifact database rollback failed:', rollbackError?.message); }
          }
        }
        await rollbackPair();
        try { onEvent({ type: 'output_invalid', name: 'SAV/Excel', reason: 'artifact_persistence_failed' }); } catch { /* trace only */ }
        return [];
      }
    }
    for (const artifact of artifacts) {
      try { onEvent({ type: 'file_artifact', artifact }); } catch (_) { /* UI must never fail the run */ }
    }
  }
  return artifacts;
}

module.exports = {
  listConversationArtifacts,
  getLatestConversationArtifact,
  hasConversationArtifacts,
  getConversationArtifactFormat,
  loadArtifactBuffer,
  resolveTurnFiles,
  assertSelectedSavXlsxInputs,
  persistOutputs,
  mimeToExt,
  sanitizeUploadName,
};
