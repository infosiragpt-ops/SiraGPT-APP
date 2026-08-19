'use strict';

/**
 * document_edit — Cowork-style document editing for the chat agent.
 *
 * Bridges the chat's agentic loop to the VERIFIED doc-agent pipeline
 * (services/doc-agent): the user's attached docx/xlsx/pptx/csv/pdf/txt files
 * are loaded from their own storage, edited inside an isolated sandbox (the
 * remote Docker microservice when SANDBOX_SERVICE_URL/SANDBOX_API_KEY are
 * set — production —, local fallback otherwise) and the edited files come
 * back as download cards through the SAME `saveArtifact` + `file_artifact`
 * event plumbing every other artifact-producing tool uses. Zero frontend
 * changes.
 *
 * Registered ONLY when the turn has attached files (see
 * run-agent-turn.js buildHarnessTools) — normal chat never sees it.
 *
 * Security: the model can only name file IDs that are attached to THIS turn
 * (ctx.fileIds, ownership-verified upstream by routes/ai.js loadUserFile),
 * and the Prisma lookup re-scopes by ctx.userId as defense in depth.
 */

const { z } = require('zod');
const { createTokenBulkhead } = require('../../ai-product-os/token-bulkhead');

const MAX_FILE_BYTES = 20 * 1024 * 1024; // whole-blob reads — keep RSS sane
const MAX_TOTAL_FILE_BYTES = Math.max(
  MAX_FILE_BYTES,
  Math.min(
    200 * 1024 * 1024,
    Number(process.env.DOCUMENT_EDIT_MAX_TOTAL_BYTES) || 60 * 1024 * 1024,
  ),
);
const DOCUMENT_EDIT_GLOBAL_BYTES = Math.max(
  MAX_TOTAL_FILE_BYTES,
  Math.min(
    1024 * 1024 * 1024,
    Number(process.env.DOCUMENT_EDIT_GLOBAL_BYTES_IN_FLIGHT) || 160 * 1024 * 1024,
  ),
);
const DOCUMENT_EDIT_MAX_CONCURRENT = Math.max(
  1,
  Math.min(12, Number(process.env.DOCUMENT_EDIT_MAX_CONCURRENT) || 3),
);
const MAX_CALLS_PER_TURN = 3;            // each call pays an inner LLM loop
const DOC_AGENT_MAX_ITERATIONS = 18;     // inner loop budget inside ONE tool call

const documentEditBulkhead = createTokenBulkhead({
  model: 'document-edit-bytes',
  maxConcurrent: DOCUMENT_EDIT_MAX_CONCURRENT,
  maxTokensInFlight: DOCUMENT_EDIT_GLOBAL_BYTES,
});

function declaredRowBytes(rows = []) {
  return rows.reduce((sum, row) => {
    const bytes = Number(row?.size);
    return sum + (Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0);
  }, 0);
}

function reservedRowBytes(rows = []) {
  const conservative = rows.reduce((sum, row) => {
    const bytes = Number(row?.size);
    return sum + (Number.isFinite(bytes) && bytes > 0
      ? Math.min(MAX_FILE_BYTES, Math.floor(bytes))
      : MAX_FILE_BYTES);
  }, 0);
  return Math.max(1, Math.min(MAX_TOTAL_FILE_BYTES, conservative));
}

async function inspectFileByteBudget(rows = [], { objectStorage, statSource } = {}) {
  let totalBytes = 0;
  for (const row of rows) {
    const declared = Number(row?.size);
    const declaredBytes = Number.isFinite(declared) && declared > 0 ? Math.floor(declared) : null;
    let measuredBytes = null;
    try {
      const measured = typeof statSource === 'function'
        ? await statSource(row)
        : (row?.path && typeof objectStorage?.stat === 'function'
          ? await objectStorage.stat(row.path)
          : null);
      const rawSize = typeof measured === 'number' ? measured : measured?.size;
      if (Number.isFinite(Number(rawSize)) && Number(rawSize) >= 0) {
        measuredBytes = Math.floor(Number(rawSize));
      }
    } catch {
      measuredBytes = null;
    }

    // A legacy row with neither a trustworthy DB size nor a storage stat is
    // rejected before the source-preserving editor can materialize an
    // unbounded object into memory.
    const actualBytes = measuredBytes ?? declaredBytes;
    if (actualBytes == null) {
      return {
        ok: false,
        error: 'file_size_unavailable',
        code: 'DOCUMENT_EDIT_FILE_SIZE_UNAVAILABLE',
        fileId: row?.id || null,
      };
    }
    if (actualBytes > MAX_FILE_BYTES) {
      return {
        ok: false,
        error: 'file_too_large',
        code: 'DOCUMENT_EDIT_FILE_BYTES_EXCEEDED',
        fileId: row?.id || null,
        totalBytes: actualBytes,
        maxBytes: MAX_FILE_BYTES,
      };
    }
    totalBytes += actualBytes;
    if (totalBytes > MAX_TOTAL_FILE_BYTES) {
      return {
        ok: false,
        error: 'total_files_too_large',
        code: 'DOCUMENT_EDIT_TOTAL_BYTES_EXCEEDED',
        totalBytes,
        maxBytes: MAX_TOTAL_FILE_BYTES,
      };
    }
  }
  return { ok: true, totalBytes: Math.max(1, totalBytes) };
}

const MIME_BY_EXT = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
};

const SOURCE_PRESERVING_NO_FALLBACK_CODES = new Set([
  'DELETE_TEXT_NOT_FOUND', 'DELETE_TEXT_UNSPECIFIED',
  'REPLACE_TEXT_NOT_FOUND', 'REPLACE_TEXT_UNSPECIFIED',
  'SOURCE_EDIT_INTENT_UNRESOLVED',
  'SECTION_TABLE_NOT_FOUND', 'CRONOGRAMA_TABLE_NOT_FOUND',
  'XLSX_REPLACE_TEXT_NOT_FOUND', 'XLSX_REPLACE_TEXT_UNSPECIFIED',
  'PPTX_REPLACE_TEXT_NOT_FOUND', 'PPTX_REPLACE_TEXT_UNSPECIFIED',
]);

function isSourcePreservingNoFallbackError(err) {
  return Boolean(err && SOURCE_PRESERVING_NO_FALLBACK_CODES.has(err.code));
}

function sourcePreservingNoFallbackResult(err) {
  return {
    ok: false,
    error: 'source_preserving_edit_failed',
    code: err?.code || null,
    message: String(err?.message || 'No se pudo ubicar con precisión el fragmento, sección o tabla solicitada.').slice(0, 800),
    hint: 'No generé un documento nuevo. Indica el texto exacto, página, encabezado, tabla o sección donde debo aplicar el cambio para conservar el archivo original.',
  };
}

function sourcePreservingValidation(item) {
  return item?.validation || item?.artifact?.validation || null;
}

function isValidatedSourcePreservingResult(item) {
  return Boolean(item?.artifact?.id && sourcePreservingValidation(item)?.passed === true);
}

function sourcePreservingValidationFailureResult(results = []) {
  const failed = results.map((item) => ({
    filename: item?.artifact?.filename || item?.file?.filename || 'documento',
    reason: sourcePreservingValidation(item)?.reason || 'validation_not_passed',
  }));
  return {
    ok: false,
    engine: 'in-process',
    error: 'source_preserving_validation_failed',
    code: 'SOURCE_PRESERVING_VALIDATION_FAILED',
    message: 'No entregué el documento editado porque ninguna copia generada superó la validación de integridad. Conservé el archivo original y no generé un documento sustituto.',
    hint: 'Reintenta o precisa el cambio solicitado; solo se entregan archivos cuya validación final tenga passed=true.',
    artifacts: [],
    edited: [],
    failures: failed,
  };
}

function isSourcePreservingValidationError(err) {
  return Boolean(
    err?.validationOnlyFailure
    || err?.code === 'DOCUMENT_BATCH_EDIT_FAILED'
    || err?.code === 'SOURCE_PRESERVING_VALIDATION_FAILED'
  );
}

const inputSchema = z.object({
  instruction: z.string().min(4).max(8000)
    .describe('Complete, self-contained editing instruction in the user\'s language (include EVERY requested change — the document agent sees only this text plus the files)'),
  fileIds: z.array(z.string().min(1)).max(10).optional()
    .describe('Attached file IDs to edit; omit (or pass []) to edit ALL files attached to this turn'),
}).strict();

// Per-turn call counter keyed by the turn's ctx object identity.
const turnCalls = new WeakMap();

/**
 * @param {object} [deps] injectable for offline tests:
 *   { runDocumentAgent, saveArtifact, fsImpl }
 */
function buildDocumentEditTool(deps = {}) {
  return {
    name: 'document_edit',
    description: [
      "Edit/transform the user's ATTACHED documents (docx, xlsx, pptx, csv, pdf, txt) inside an isolated sandbox and return the EDITED FILE(s) as download cards.",
      'WHEN TO USE: the user asks to edit, modify, fix, update, fill, reformat, reorganize, improve professionally, apply corrections, add/remove content, complete sections, or convert an attached document and expects the file back ("edita mi documento…", "corrige el excel…", "cambia el título del informe…", "aplica correcciones mínimas…").',
      'WHEN NOT TO USE: questions or summaries about the document (answer from the provided text), creating a NEW document from scratch (use create_document), or text-only answers.',
      'Pass ONE complete instruction with every requested change — the editor runs in a separate sandbox and only sees your instruction plus the files.',
      'ALWAYS RETURN A FILE for edit requests: do not finalize with only suggested edits, a checklist, or a summary when the user asked to apply changes to the attachment.',
    ].join(' '),
    inputSchema,
    permissionTier: 'auto',
    humanDescription: (args = {}) => `Editando documento: ${String(args.instruction || '').slice(0, 60)}`,
    execute: async (args, ctx = {}) => {
      const fsImpl = deps.fsImpl || require('fs/promises');
      const prisma = deps.prisma || ctx.prisma;

      const calls = (turnCalls.get(ctx) || 0) + 1;
      turnCalls.set(ctx, calls);
      if (calls > MAX_CALLS_PER_TURN) {
        return { ok: false, error: 'call_budget_exhausted', hint: `document_edit ya se usó ${MAX_CALLS_PER_TURN} veces en este turno; consolida TODOS los cambios en una sola instrucción.` };
      }

      // The model may only touch files attached to THIS turn. Models often
      // invent placeholder IDs ("1", the filename…) — anything not in the
      // allowed set falls back to ALL attached files (still confined), so an
      // obvious "edit the attachment" intent never fails on a made-up ID.
      const allowed = new Set((Array.isArray(ctx.fileIds) ? ctx.fileIds : []).map(String).filter(Boolean));
      if (!allowed.size) {
        return { ok: false, error: 'no_attached_files', hint: 'No hay documentos adjuntos en este turno. Pide al usuario adjuntar el archivo.' };
      }
      const requested = (Array.isArray(args.fileIds) ? args.fileIds : []).map(String);
      const matched = requested.filter((id) => allowed.has(id));
      const ids = matched.length ? matched : [...allowed];
      if (!prisma || !ctx.userId) {
        return { ok: false, error: 'context_unavailable' };
      }

      // Ownership re-check. The source-preserving editor below loads the
      // original file by id/path and can handle large DOCX structural edits
      // without the sandbox blob cap, so do not read the full bytes yet.
      let rows;
      try {
        rows = await prisma.file.findMany({ where: { id: { in: ids }, userId: ctx.userId } });
      } catch (err) {
        return { ok: false, error: 'file_lookup_failed', message: String(err && err.message || err).slice(0, 200) };
      }
      if (!rows.length) return { ok: false, error: 'file_not_found' };

      const declaredBytes = declaredRowBytes(rows);
      if (declaredBytes > MAX_TOTAL_FILE_BYTES) {
        return {
          ok: false,
          error: 'total_files_too_large',
          code: 'DOCUMENT_EDIT_TOTAL_BYTES_EXCEEDED',
          totalBytes: declaredBytes,
          maxBytes: MAX_TOTAL_FILE_BYTES,
          hint: 'Reduce el número o el tamaño de los archivos y vuelve a intentarlo.',
        };
      }

      const objectStorageForAdmission = deps.objectStorage || require('../../object-storage');
      const byteBudget = await inspectFileByteBudget(rows, {
        objectStorage: objectStorageForAdmission,
        statSource: deps.statSource,
      });
      if (!byteBudget.ok) {
        return {
          ...byteBudget,
          hint: byteBudget.error === 'file_size_unavailable'
            ? 'No pude verificar de forma segura el tamaño del archivo. Vuelve a subirlo e inténtalo otra vez.'
            : 'Reduce el número o el tamaño de los archivos y vuelve a intentarlo.',
        };
      }

      let releaseAdmission;
      try {
        releaseAdmission = await documentEditBulkhead.acquire({
          // Legacy rows without a stored size reserve the per-file maximum so
          // they cannot silently overcommit the global memory budget.
          tokens: byteBudget.totalBytes,
          signal: ctx.signal || null,
        });
      } catch (err) {
        return {
          ok: false,
          error: err?.code === 'CAPACITY_EXCEEDED' ? 'total_files_too_large' : 'document_edit_busy',
          code: err?.code || 'DOCUMENT_EDIT_ADMISSION_REJECTED',
          retryable: err?.code !== 'CAPACITY_EXCEEDED',
          retryAfterSeconds: err?.code === 'CAPACITY_EXCEEDED' ? undefined : 5,
          maxBytes: MAX_TOTAL_FILE_BYTES,
        };
      }

      try {

      // MERGE FAST PATH — deterministic Cowork-style "N docx → 1 docx". When
      // the instruction is a merge ("combina / fusiona / une … en un solo
      // word") and 2+ files are attached, merge them in-process (real OOXML
      // body merge preserving formatting; extracted-text rebuild as fallback)
      // instead of relying on the doc-agent's inner LLM to figure it out.
      // Falls through to the normal editors on any error.
      try {
        const merge = deps.documentMerge || require('../../agents/document-merge');
        if (rows.length >= 2 && merge.isDocumentMergeRequest(args.instruction, { fileCount: rows.length })) {
          // Keep the user's attachment order (ids array), not DB row order.
          const ordered = ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean);
          const isDocx = (row) => /\.docx$/i.test(String(row.originalName || row.filename || '')) ||
            String(row.mimeType || '') === merge.DOCX_MIME;
          let buffer = null;
          if (ordered.every(isDocx)) {
            try {
              const loaded = [];
              let loadedBytes = 0;
              const objectStorage = deps.objectStorage || require('../../object-storage');
              const readSourceBuffer = deps.readSourceBuffer
                || (deps.sourcePreservingEdit && deps.sourcePreservingEdit.readSourceBuffer)
                || require('../../source-preserving-document-edit').readSourceBuffer;
              for (const row of ordered) {
                let buffer;
                let cleanup = async () => {};
                try {
                  if (objectStorage.isRemote(row.path)) {
                    const read = await readSourceBuffer(row);
                    buffer = read.buffer;
                    cleanup = read.cleanup;
                  } else {
                    buffer = await fsImpl.readFile(row.path);
                  }
                  if (buffer.length > MAX_FILE_BYTES) throw new Error('file_too_large');
                  loadedBytes += buffer.length;
                  if (loadedBytes > MAX_TOTAL_FILE_BYTES) throw new Error('total_files_too_large');
                  loaded.push({ name: row.originalName || row.filename, buffer });
                } finally {
                  await cleanup().catch(() => {});
                }
              }
              buffer = merge.mergeDocxBuffers(loaded);
            } catch (mergeErr) {
              buffer = null; // structural merge failed → text rebuild below
            }
          }
          if (!buffer && ordered.every((row) => String(row.extractedText || '').trim())) {
            buffer = await merge.mergeFromExtractedText(
              ordered.map((row) => ({ name: row.originalName || row.filename, text: row.extractedText })),
            );
          }
          if (buffer) {
            const saveArtifact = deps.saveArtifact || require('../../agents/task-tools').saveArtifact;
            const saved = saveArtifact({
              filename: merge.mergedFilename(ordered.map((row) => ({ name: row.originalName || row.filename }))),
              base64: buffer.toString('base64'),
              mime: merge.DOCX_MIME,
              ownerUserId: ctx.userId || null,
              chatId: ctx.chatId || null,
              category: 'agent_artifact',
            });
            if (ctx && typeof ctx.onEvent === 'function') {
              try {
                ctx.onEvent({
                  type: 'file_artifact',
                  artifact: {
                    id: saved.id,
                    filename: saved.filename,
                    mime: saved.mime,
                    format: saved.format,
                    sizeBytes: saved.sizeBytes,
                    downloadUrl: saved.downloadUrl,
                    previewHtml: null,
                    validation: null,
                  },
                });
              } catch (_) { /* UI plumbing must never fail the tool */ }
            }
            return {
              ok: true,
              engine: 'merge-deterministic',
              edited: [{ filename: saved.filename, sizeBytes: saved.sizeBytes, downloadUrl: saved.downloadUrl, valid: true }],
              format: 'docx',
              summary: `Documentos fusionados en un solo Word (${ordered.length} archivos, en el orden adjuntado).`,
              note: 'El documento fusionado ya aparece como tarjeta de descarga en el chat. Menciónalo brevemente; NO pegues su contenido.',
            };
          }
        }
      } catch (_) {
        // Merge fast-path is best-effort — fall through to the normal editors.
      }

      // FAST PATH — in-process source-preserving editor (no sandbox, pure Node:
      // PizZip / ExcelJS / pdf-lib). Handles the common "edit these specific
      // parts" request on docx/xlsx/pptx/txt/md/html/csv in-process and
      // self-persists the edited artifact, so editing works even when no Linux
      // sandbox is installed. It returns null when it can't handle the request
      // (e.g. needs a different source format) — in that case we fall straight
      // through to the sandbox doc-agent below, so nothing is ever lost.
      try {
        const sp = deps.sourcePreservingEdit || require('../../source-preserving-document-edit');
        const inproc = await sp.tryGenerateSourcePreservingDocumentEdit({
          prisma,
          userId: ctx.userId || null,
          chatId: ctx.chatId || null,
          fileIds: ids,
          prompt: args.instruction,
          displayPrompt: args.instruction,
          signal: ctx.signal,
        });
        if (inproc && inproc.clarification) {
          // Image-edit ambiguity (varias imágenes candidatas, falta la imagen
          // nueva, formato no soportado): la pregunta ES la respuesta. Nunca
          // caer al doc-agent del sandbox — ese camino regenera el documento y
          // produce el volcado de texto ilegible que motivó este fix.
          return {
            ok: true,
            engine: 'in-process',
            clarification: true,
            edited: [],
            summary: String(inproc.content || '').slice(0, 1200),
            note: 'Transmite esta aclaración al usuario TAL CUAL y espera su respuesta; NO edites ni generes ningún archivo todavía.',
          };
        }
        const inprocResults = Array.isArray(inproc?.results) && inproc.results.length
          ? inproc.results
          : (inproc ? [inproc] : []);
        const artifactResults = inprocResults.filter((item) => item?.artifact?.id);
        const validatedResults = artifactResults.filter(isValidatedSourcePreservingResult);
        if (validatedResults.length) {
          const rejectedResults = artifactResults.filter((item) => !isValidatedSourcePreservingResult(item));
          const artifacts = validatedResults.map((item) => ({
            id: item.artifact.id,
            filename: item.artifact.filename,
            mime: item.artifact.mime,
            format: item.artifact.format,
            sizeBytes: item.artifact.sizeBytes,
            downloadUrl: item.artifact.downloadUrl,
            previewHtml: item.previewHtml || null,
            validation: sourcePreservingValidation(item),
            sourceFileId: item.sourceFileId || item.version?.sourceFileId || null,
            documentVersion: item.version || null,
          }));
          if (ctx && typeof ctx.onEvent === 'function') {
            for (const artifact of artifacts) {
              try {
                ctx.onEvent({ type: 'file_artifact', artifact });
              } catch (_) { /* UI plumbing must never fail the tool */ }
            }
          }
          return {
            ok: true,
            engine: 'in-process',
            batch: Boolean(inproc.batch || artifactResults.length > 1),
            partial: Boolean(inproc.partial || rejectedResults.length > 0),
            failures: [
              ...(Array.isArray(inproc.failures) ? inproc.failures : []),
              ...rejectedResults.map((item) => ({
                sourceFileId: item.sourceFileId || item.version?.sourceFileId || null,
                filename: item.artifact?.filename || 'documento',
                error: sourcePreservingValidation(item)?.reason || 'La validación del documento editado no pasó.',
              })),
            ],
            artifacts,
            edited: validatedResults.map((item) => ({
              id: item.artifact.id,
              filename: item.artifact.filename,
              mime: item.artifact.mime,
              format: item.artifact.format,
              sizeBytes: item.artifact.sizeBytes,
              downloadUrl: item.artifact.downloadUrl,
              valid: true,
              sourceFileId: item.sourceFileId || item.version?.sourceFileId || null,
            })),
            format: inproc.format,
            summary: rejectedResults.length
              ? `Entregué ${validatedResults.length} archivo(s) que superaron la validación. No entregué ${rejectedResults.length} archivo(s) inválido(s).`
              : String(inproc.content || '').slice(0, 1200),
            note: validatedResults.length > 1
              ? 'Los archivos editados (preservando los originales) ya aparecen como tarjetas de descarga en el chat. Menciónalos brevemente; NO pegues su contenido.'
              : 'El archivo editado (preservando el original) ya aparece como tarjeta de descarga en el chat. Menciónalo brevemente; NO pegues su contenido.',
          };
        }
        if (inprocResults.length) {
          // A non-null source-preserving result means that editor owned this
          // request. If it produced no strictly validated deliverable, fail
          // closed: the sandbox would rebuild a different document and hide
          // the validation failure behind a plausible-looking replacement.
          return sourcePreservingValidationFailureResult(inprocResults);
        }
        // inproc === null → not a source-preserving edit / unsupported source.
        // Fall through to the sandbox doc-agent below.
      } catch (err) {
        if (isSourcePreservingNoFallbackError(err)) {
          return sourcePreservingNoFallbackResult(err);
        }
        if (isSourcePreservingValidationError(err)) {
          const failure = sourcePreservingValidationFailureResult([]);
          return {
            ...failure,
            details: String(err?.message || '').slice(0, 800) || undefined,
          };
        }
        // The in-process editor can throw when it needs a different/compatible
        // source (e.g. a section edit on a non-DOCX). The sandbox doc-agent is
        // more capable for those cases. Known target-not-located failures above
        // fail closed so we never replace a same-document edit with a new file.
      }

      const files = [];
      let loadedBytes = 0;
      const objectStorage = deps.objectStorage || require('../../object-storage');
      const readSourceBuffer = deps.readSourceBuffer
        || (deps.sourcePreservingEdit && deps.sourcePreservingEdit.readSourceBuffer)
        || require('../../source-preserving-document-edit').readSourceBuffer;
      for (const row of rows) {
        let buffer;
        let cleanup = async () => {};
        try {
          if (objectStorage.isRemote(row.path)) {
            const read = await readSourceBuffer(row);
            buffer = read.buffer;
            cleanup = read.cleanup;
          } else {
            buffer = await fsImpl.readFile(row.path);
          }
        } catch (_) {
          await cleanup().catch(() => {});
          return { ok: false, error: 'file_blob_missing', fileId: row.id };
        }
        try {
          if (buffer.length > MAX_FILE_BYTES) {
            return { ok: false, error: 'file_too_large', fileId: row.id, maxBytes: MAX_FILE_BYTES };
          }
          loadedBytes += buffer.length;
          if (loadedBytes > MAX_TOTAL_FILE_BYTES) {
            return {
              ok: false,
              error: 'total_files_too_large',
              code: 'DOCUMENT_EDIT_TOTAL_BYTES_EXCEEDED',
              totalBytes: loadedBytes,
              maxBytes: MAX_TOTAL_FILE_BYTES,
            };
          }
          files.push({ name: row.originalName || row.filename, buffer });
        } finally {
          await cleanup().catch(() => {});
        }
      }

      // Run the verified pipeline (remote sandbox in prod, auto-fallback).
      let result;
      try {
        const runDocumentAgent = deps.runDocumentAgent || require('../../doc-agent').runDocumentAgent;
        result = await runDocumentAgent({
          files,
          instruction: args.instruction,
          signal: ctx.signal,
          maxIterations: DOC_AGENT_MAX_ITERATIONS,
          onEvent: () => {},
        });
      } catch (err) {
        return { ok: false, error: 'doc_agent_failed', message: String(err && err.message || err).slice(0, 300) };
      }

      const outputs = (result.outputs || []).filter((o) => o && o.buffer && o.buffer.length > 0);
      if (!outputs.length) {
        return { ok: false, error: 'no_output', summary: String(result.finalText || '').slice(0, 500), hint: 'El agente de documentos no produjo un archivo editado. Reintenta con una instrucción más específica.' };
      }

      // runDocumentAgent structurally validates every collected output. Treat
      // anything other than an explicit `valid: true` as untrusted and reject
      // it BEFORE saveArtifact: an invalid OOXML blob must never obtain a
      // download URL, emit a chat card, or make the tool report success.
      const validatedOutputs = outputs.filter((out) => out.valid === true);
      const rejectedOutputs = outputs
        .filter((out) => out.valid !== true)
        .map((out) => ({
          filename: String(out.name || 'documento'),
          error: 'validation_failed',
          reason: out.valid === false ? 'ooxml_structure' : 'validation_not_passed',
        }));
      if (!validatedOutputs.length) {
        return {
          ok: false,
          engine: 'sandbox',
          error: 'document_validation_failed',
          code: 'DOCUMENT_VALIDATION_FAILED',
          edited: [],
          failures: rejectedOutputs,
          iterations: result.iterations,
          driver: result.driver,
          summary: String(result.finalText || '').slice(0, 1200),
          hint: 'No entregué ningún archivo porque la validación final no pasó. El documento original permanece intacto.',
        };
      }

      // Persist + announce every deliverable through the existing card plumbing.
      const saveArtifact = deps.saveArtifact || require('../../agents/task-tools').saveArtifact;
      const edited = [];
      for (const out of validatedOutputs) {
        const ext = String(out.name).split('.').pop().toLowerCase();
        const validation = { ok: true, passed: true };
        let saved;
        try {
          saved = saveArtifact({
            filename: out.name,
            base64: out.buffer.toString('base64'),
            mime: MIME_BY_EXT[ext] || 'application/octet-stream',
            ownerUserId: ctx.userId || null,
            chatId: ctx.chatId || null,
            category: 'agent_artifact',
            validation,
          });
        } catch (err) {
          edited.push({ filename: out.name, error: 'persist_failed', message: String(err && err.message || err).slice(0, 160) });
          continue;
        }
        if (ctx && typeof ctx.onEvent === 'function') {
          try {
            ctx.onEvent({
              type: 'file_artifact',
              artifact: {
                id: saved.id,
                filename: saved.filename,
                mime: saved.mime,
                format: saved.format,
                sizeBytes: saved.sizeBytes,
                downloadUrl: saved.downloadUrl,
                previewHtml: null,
                validation,
              },
            });
          } catch (_) { /* UI plumbing must never fail the tool */ }
        }
        edited.push({ filename: saved.filename, sizeBytes: saved.sizeBytes, downloadUrl: saved.downloadUrl, valid: out.valid !== false });
      }

      return {
        ok: edited.some((e) => !e.error),
        partial: rejectedOutputs.length > 0 || edited.some((e) => e.error),
        edited,
        failures: rejectedOutputs,
        iterations: result.iterations,
        driver: result.driver,
        summary: String(result.finalText || '').slice(0, 1200),
        note: edited.some((e) => !e.error)
          ? 'Los archivos editados ya aparecen como tarjetas de descarga en el chat. Menciónalos brevemente en tu respuesta; NO pegues su contenido.'
          : undefined,
      };
      } finally {
        releaseAdmission();
      }
    },
  };
}

module.exports = {
  buildDocumentEditTool,
  MAX_FILE_BYTES,
  MAX_TOTAL_FILE_BYTES,
  DOCUMENT_EDIT_GLOBAL_BYTES,
  MAX_CALLS_PER_TURN,
  _documentEditBulkhead: documentEditBulkhead,
  _reservedRowBytes: reservedRowBytes,
  _inspectFileByteBudget: inspectFileByteBudget,
};
