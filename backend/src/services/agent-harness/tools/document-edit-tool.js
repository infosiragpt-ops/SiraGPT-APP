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

const MAX_FILE_BYTES = 20 * 1024 * 1024; // whole-blob reads — keep RSS sane
const MAX_CALLS_PER_TURN = 3;            // each call pays an inner LLM loop
const DOC_AGENT_MAX_ITERATIONS = 18;     // inner loop budget inside ONE tool call

const MIME_BY_EXT = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
};

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
      'WHEN TO USE: the user asks to edit, modify, fix, update, fill, reformat, reorganize or convert an attached document and expects the file back ("edita mi documento…", "corrige el excel…", "cambia el título del informe…").',
      'WHEN NOT TO USE: questions or summaries about the document (answer from the provided text), creating a NEW document from scratch (use create_document), or text-only answers.',
      'Pass ONE complete instruction with every requested change — the editor runs in a separate sandbox and only sees your instruction plus the files.',
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
        if (inproc && inproc.artifact && inproc.artifact.id) {
          if (ctx && typeof ctx.onEvent === 'function') {
            try {
              ctx.onEvent({
                type: 'file_artifact',
                artifact: {
                  id: inproc.artifact.id,
                  filename: inproc.artifact.filename,
                  mime: inproc.artifact.mime,
                  format: inproc.artifact.format,
                  sizeBytes: inproc.artifact.sizeBytes,
                  downloadUrl: inproc.artifact.downloadUrl,
                  previewHtml: inproc.previewHtml || null,
                  validation: inproc.validation || null,
                },
              });
            } catch (_) { /* UI plumbing must never fail the tool */ }
          }
          return {
            ok: true,
            engine: 'in-process',
            edited: [{
              filename: inproc.artifact.filename,
              sizeBytes: inproc.artifact.sizeBytes,
              downloadUrl: inproc.artifact.downloadUrl,
              valid: !(inproc.validation && inproc.validation.ok === false),
            }],
            format: inproc.format,
            summary: String(inproc.content || '').slice(0, 1200),
            note: 'El archivo editado (preservando el original) ya aparece como tarjeta de descarga en el chat. Menciónalo brevemente; NO pegues su contenido.',
          };
        }
        // inproc === null → not a source-preserving edit / unsupported source.
        // Fall through to the sandbox doc-agent below.
      } catch (_) {
        // The in-process editor throws when it needs a different/compatible
        // source (e.g. a section edit on a non-DOCX). The sandbox doc-agent is
        // more capable for those cases — fall through to it rather than failing.
      }

      const files = [];
      for (const row of rows) {
        let buffer;
        try {
          buffer = await fsImpl.readFile(row.path);
        } catch (_) {
          return { ok: false, error: 'file_blob_missing', fileId: row.id };
        }
        if (buffer.length > MAX_FILE_BYTES) {
          return { ok: false, error: 'file_too_large', fileId: row.id, maxBytes: MAX_FILE_BYTES };
        }
        files.push({ name: row.originalName || row.filename, buffer });
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

      // Persist + announce every deliverable through the existing card plumbing.
      const saveArtifact = deps.saveArtifact || require('../../agents/task-tools').saveArtifact;
      const edited = [];
      for (const out of outputs) {
        const ext = String(out.name).split('.').pop().toLowerCase();
        const validation = out.valid === false ? { ok: false, reason: 'ooxml_structure' } : null;
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
        edited,
        iterations: result.iterations,
        driver: result.driver,
        summary: String(result.finalText || '').slice(0, 1200),
        note: 'Los archivos editados ya aparecen como tarjetas de descarga en el chat. Menciónalos brevemente en tu respuesta; NO pegues su contenido.',
      };
    },
  };
}

module.exports = { buildDocumentEditTool, MAX_FILE_BYTES, MAX_CALLS_PER_TURN };
