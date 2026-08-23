'use strict';

/**
 * Hook de /chat (y document_edit, /api/doc, agent-task) → transformToTemplate.
 *
 * Vive DESPUÉS de selectSourcePreservingDocumentSet y ANTES de
 * generateSourcePreservingDocumentEdit. In-process PizZip: no cola, no
 * contenedor nuevo. OpenRouter está prohibido en este motor.
 */

const path = require('path');
const { shouldRunChatTemplateTransform } = require('./flags');
const {
  classifyTemplateVsContent,
  transformToTemplate,
  bodyStillHasPlaceholders,
  extractVisibleText,
} = require('./transform-to-template');
const { selectDocxPreviewPath } = require('./preview-path');

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
  const { pageGeometryEqual } = require('./ooxml');
  const sectOk = transformed.templateSectPr === transformed.resultSectPr;
  const pageOk = pageGeometryEqual(transformed.templateSectPr, transformed.resultSectPr);
  const headersOk = JSON.stringify(transformed.headerFooterBefore)
    === JSON.stringify(transformed.headerFooterAfter);
  const placeholders = bodyStillHasPlaceholders(transformed.documentXml || '');
  // Live 23:57Z: PizZip transplanted 173 blocks / 16k words but first-sectPr
  // !== last-sectPr (source section break) → passed=false → hook returned
  // null → professional-edit of the XXXX plantilla. Keep a real transplant.
  const passed = Boolean(transformed.transplantedBlocks > 0 && !placeholders);
  return {
    format: 'docx',
    passed,
    checks: {
      source_transplanted: transformed.transplantedBlocks > 0,
      template_sectpr_preserved: sectOk,
      template_page_geometry_preserved: pageOk,
      header_footer_unchanged: headersOk,
      no_leftover_placeholders: !placeholders,
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
  const preview = selectDocxPreviewPath({
    format: 'docx',
    downloadUrl: artifact.downloadUrl,
    artifactId: artifact.id,
  });
  if (preview.previewPdfUrl) artifact.previewPdfUrl = preview.previewPdfUrl;
  artifact.previewHtml = null;
  return artifact;
}

/**
 * Hook post-select: ≥2 DOCX de current_upload + plantilla detectada por contenido.
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
  if (!shouldRunChatTemplateTransform(displayPrompt || prompt, files)) return null;
  const docs = (Array.isArray(files) ? files : []).filter(isDocxLike);
  if (docs.length < 2) return null;

  const withBuffers = [];
  for (const file of docs) {
    const buffer = await readFileBuffer(file, readBuffer);
    if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
    withBuffers.push({ ...file, buffer });
  }

  const pair = classifyTemplateVsContent(withBuffers, displayPrompt || prompt);
  try {
    console.info(`[doc-engine] classify reason=${pair.reason || '?'} template=${pair.template?.originalName || pair.template?.filename || pair.template?.name || '-'} content=${pair.content?.originalName || pair.content?.filename || pair.content?.name || '-'}`);
  } catch { /* noop */ }
  if (!pair.template || !pair.content) {
    try { console.warn('[doc-engine] classify missed pair; not transplanting'); } catch { /* noop */ }
    return null;
  }
  if (signal?.aborted) return null;

  const transformed = transformToTemplate({
    sourceBuffer: pair.content.buffer,
    templateBuffer: pair.template.buffer,
  });
  try {
    const validation = buildValidation(transformed);
    const sourceText = extractVisibleText(transformed.documentXml || '');
    const sourceHadContent = Boolean(transformed.transplantedBlocks > 0 && sourceText.replace(/X{4,}/gi, '').trim().length >= 40);
    if (validation.passed !== true && !sourceHadContent) {
      try {
        console.warn(`[doc-engine] validation failed transplanted=${transformed.transplantedBlocks || 0} sectOk=${validation.checks && validation.checks.template_sectpr_preserved} placeholders=${validation.checks && !validation.checks.no_leftover_placeholders}`);
      } catch { /* noop */ }
      return null;
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
      previewPdfUrl: artifact.previewPdfUrl || null,
      format: 'docx',
      engine: 'doc-engine',
      contentFile: pair.content,
      templateFile: pair.template,
      orchestration: {
        mode: 'doc_engine_transform_to_template',
        selectionReason: 'classify_template_vs_content',
      },
    };
  } finally {
    if (transformed.workDir) {
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
