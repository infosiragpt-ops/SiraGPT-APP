'use strict';

/**
 * Hook de /chat (y document_edit, /api/doc, agent-task) → transformToTemplate.
 *
 * Vive DESPUÉS de selectSourcePreservingDocumentSet y ANTES de
 * generateSourcePreservingDocumentEdit. In-process PizZip: no cola, no
 * contenedor nuevo. OpenRouter está prohibido en este motor.
 */

const path = require('path');
const { isDocEngineEnabled } = require('./flags');
const {
  classifyTemplateVsContent,
  transformToTemplate,
} = require('./transform-to-template');

function isDocxLike(file = {}) {
  const name = String(file?.originalName || file?.filename || file?.name || '');
  const mime = String(file?.mimeType || file?.mimetype || file?.type || '');
  return mime.includes('wordprocessingml') || /\.docx$/i.test(name);
}

async function readFileBuffer(file, readBuffer) {
  if (typeof readBuffer === 'function') return readBuffer(file);
  if (Buffer.isBuffer(file.buffer) && file.buffer.length) return file.buffer;
  const { readSourceBuffer } = require('../source-preserving-document-edit');
  const read = await readSourceBuffer(file);
  return read?.buffer || null;
}

function buildValidation(transformed) {
  const sectOk = transformed.templateSectPr === transformed.resultSectPr;
  const headersOk = JSON.stringify(transformed.headerFooterBefore)
    === JSON.stringify(transformed.headerFooterAfter);
  return {
    format: 'docx',
    passed: Boolean(sectOk && transformed.transplantedBlocks > 0),
    checks: {
      source_transplanted: transformed.transplantedBlocks > 0,
      template_sectpr_preserved: sectOk,
      header_footer_unchanged: headersOk,
    },
    details: {
      editMode: 'doc_engine_transform_to_template',
      styleMap: transformed.styleMap || {},
      transplantedBlocks: transformed.transplantedBlocks,
    },
  };
}

function persistOrWrap({ buffer, filename, userId, chatId, validation }) {
  let artifact = null;
  if (userId) {
    try {
      const { saveArtifact, EXTENSION_TO_MIME } = require('../agents/task-tools');
      artifact = saveArtifact({
        filename,
        base64: Buffer.from(buffer).toString('base64'),
        mime: EXTENSION_TO_MIME.docx,
        ownerUserId: userId,
        chatId,
        validation,
      });
    } catch {
      artifact = null;
    }
  }
  if (!artifact) {
    artifact = {
      id: `doc-engine:${filename}`,
      filename,
      format: 'docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: buffer.length,
      downloadUrl: null,
      validation,
    };
  } else if (!artifact.validation) {
    artifact.validation = validation;
  }
  return artifact;
}

const TRANSPLANT_FAIL_CODES = new Set([
  'empty_transplant',
  'template_body_unchanged',
  'empty_source_body',
]);

/**
 * Hook post-select: ≥2 DOCX (cualquier tag) + plantilla detectada por contenido.
 * force=true so chip order / weak scores still pick a pair when the prompt
 * already asked for formato/plantilla/UPN. Empty transplant refuses fallback.
 * @returns {Promise<object|null>} mismo contrato que generateSourcePreservingDocumentEdit
 */
async function tryDocEngineAfterSelection({
  files = [],
  prompt,
  displayPrompt,
  userId,
  chatId,
  signal,
  env = process.env,
  readBuffer,
} = {}) {
  if (!isDocEngineEnabled(env)) return null;
  const docs = (Array.isArray(files) ? files : []).filter(isDocxLike);
  if (docs.length < 2) return null;

  const withBuffers = [];
  for (const file of docs) {
    const buffer = await readFileBuffer(file, readBuffer);
    if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
    withBuffers.push({ ...file, buffer });
  }

  const pair = classifyTemplateVsContent(withBuffers, { force: true });
  if (!pair.template || !pair.content) return null;
  if (signal?.aborted) return null;

  let transformed;
  try {
    transformed = transformToTemplate({
      sourceBuffer: pair.content.buffer,
      templateBuffer: pair.template.buffer,
    });
  } catch (err) {
    const code = String(err?.code || '');
    if (TRANSPLANT_FAIL_CODES.has(code)) {
      return { refuseFallback: true, reason: code, engine: 'doc-engine' };
    }
    throw err;
  }
  try {
    const validation = buildValidation(transformed);
    if (validation.passed !== true) {
      return { refuseFallback: true, reason: 'validation_failed', engine: 'doc-engine' };
    }

    const contentName = pair.content.originalName || pair.content.filename || pair.content.name || 'documento.docx';
    const base = path.basename(contentName, path.extname(contentName)).replace(/[^\w.-]+/g, '_') || 'documento';
    const filename = `${base}_formato.docx`;
    const artifact = persistOrWrap({
      buffer: transformed.buffer,
      filename,
      userId,
      chatId,
      validation,
    });

    return {
      content: 'Documento transplantado a la plantilla (sectPr, headers y footers de la plantilla intactos). El contenido fuente reemplazó los placeholders XXXXXXXX.',
      file: {
        type: 'doc',
        format: 'docx',
        title: `${base} formato`,
        explanation: 'Se copió la plantilla como base y se transplantó el cuerpo fuente.',
        filename: artifact.filename,
        url: artifact.downloadUrl || null,
        mime: artifact.mime,
        size: artifact.sizeBytes,
        buffer: transformed.buffer,
      },
      artifact,
      validation,
      previewHtml: null,
      format: 'docx',
      engine: 'doc-engine',
      contentFile: pair.content,
      templateFile: pair.template,
      orchestration: {
        mode: 'doc_engine_transform_to_template',
        selectionReason: pair.reason || 'classify_template_vs_content',
      },
    };
  } finally {
    if (transformed?.workDir) {
      try {
        require('fs').rmSync(transformed.workDir, { recursive: true, force: true });
      } catch { /* cleanup best-effort */ }
    }
  }
}

/** @deprecated usar tryDocEngineAfterSelection desde el hook post-select */
async function tryDocEngineTransform(opts = {}) {
  return tryDocEngineAfterSelection(opts);
}

module.exports = {
  tryDocEngineAfterSelection,
  tryDocEngineTransform,
};
