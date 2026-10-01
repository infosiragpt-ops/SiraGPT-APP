'use strict';

/**
 * transcription-document-fast-path — «transcribir en un documento word» with a
 * readable attachment is not an open task: the deliverable IS the attachment's
 * text in the requested format. Prod 2026-09-27 (verified turn): the agent
 * loop spent 342 s on document_analysis tool calls before generating a 3.6 KB
 * Word from text it already had.
 *
 * The document is built VERBATIM from the extracted text with the local
 * document service (docx / pdf). Routing the text through the authored
 * document pipeline (PR #880) produced a 30-word «Resumen ejecutivo» template
 * that ignored the transcript — a transcription must never be rewritten.
 *
 * Scope: document attachments only. Media (audio/video) transcription keeps
 * the media-batch path; a surgical edit keeps the source-preserving editor; an
 * attachment without usable text, or a format this path cannot render
 * verbatim, falls through to the agent loop. Every dependency is injected so
 * the decision, the markdown and the delivery text are unit-testable.
 */

const path = require('path');

const FORMAT_LABELS = Object.freeze({ docx: 'Word', pdf: 'PDF', xlsx: 'Excel', pptx: 'PowerPoint' });
const VERBATIM_FORMATS = new Set(['docx', 'pdf']);
const MIME_BY_FORMAT = Object.freeze({
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
});
const MIN_SOURCE_WORDS = 20;
const STOPPED_REASON = 'transcription_document';

/**
 * Every extractor in fileProcessor prepends a technical header such as
 * «HTML document — 176 words, 1165 chars» + «---» (PDF/Word/RTF/LaTeX too).
 * It is context for the model, never part of the transcript (seen in the
 * prod Word of 2026-09-27).
 */
const EXTRACTOR_HEADER_RE = /^[A-Za-z][A-Za-z ]{1,30} document — [^\n]*\n(?:---\n?)?/gm;
function stripExtractorHeaders(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(EXTRACTOR_HEADER_RE, '');
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function shouldUseTranscriptionDocumentFastPath({
  transcriptionToFileRequest = false,
  hasAttachedFiles = false,
  mediaBatchRows = null,
  wantsSourcePreservingEdit = false,
  documentPolicy = null,
  artifactsCount = 0,
} = {}) {
  return Boolean(transcriptionToFileRequest)
    && Boolean(hasAttachedFiles)
    && !mediaBatchRows
    && !wantsSourcePreservingEdit
    && Boolean(documentPolicy && documentPolicy.autoGenerate)
    && VERBATIM_FORMATS.has(String(documentPolicy.format || 'docx').toLowerCase())
    && artifactsCount === 0;
}

/** Strip the extension and anything unsafe; keep accents readable. */
function sourceStem(name) {
  // Sanitise before basename: «Acta 12/05.md» is a name, not a path.
  const raw = String(name || '').trim().replace(/[\\/:*?"<>|]+/g, ' ');
  const clean = raw.replace(/\.[A-Za-z0-9]{1,6}$/, '').replace(/\s+/g, ' ').trim();
  return clean.slice(0, 80) || 'transcripcion';
}

function transcriptionFilename(sourceNames = [], format = 'docx') {
  const ext = String(format || 'docx').toLowerCase();
  const first = Array.isArray(sourceNames) ? sourceNames.find(Boolean) : null;
  const stem = first ? sourceStem(first) : 'transcripcion';
  const suffix = /transcrip/i.test(stem) ? '' : ' (transcripción)';
  return `${stem}${suffix}.${ext}`;
}

/**
 * The document body: a title, the provenance line and the transcript exactly
 * as extracted. Single line breaks become paragraphs so timestamped lines do
 * not collapse into one block when rendered from markdown.
 */
function transcriptionDocumentMarkdown({ sourceNames = [], text = '', now = new Date() } = {}) {
  const names = (Array.isArray(sourceNames) ? sourceNames : []).filter(Boolean);
  const title = names.length === 1 ? `Transcripción — ${sourceStem(names[0])}` : 'Transcripción';
  const date = now.toLocaleDateString('es-PE', { year: 'numeric', month: 'long', day: 'numeric' });
  const provenance = names.length
    ? `Transcripción literal de ${names.length === 1 ? 'el archivo' : 'los archivos'} ${names.map((n) => `«${path.basename(n)}»`).join(', ')} · ${date}`
    : `Transcripción literal · ${date}`;
  const body = stripExtractorHeaders(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return `# ${title}\n\n_${provenance}_\n\n${body}\n`;
}

function buildTranscriptionDeliveryMarkdown({ fileCount = 1, format = '', artifact = {} } = {}) {
  const label = FORMAT_LABELS[String(format || '').toLowerCase()] || '';
  const what = fileCount === 1 ? 'el archivo adjunto' : `los ${fileCount} archivos adjuntos`;
  return [
    `Listo. Transcribí ${what} en un documento${label ? ` ${label}` : ''}, sin resumir ni alterar el contenido.`,
    '',
    `**Archivo:** [${artifact.filename || 'documento'}](${artifact.downloadUrl || ''})`,
  ].join('\n');
}

/**
 * Default document builder: local document service (no model), artifact
 * store, preview and persistence — the same delivery contract as
 * generateAutoDocument, minus the authoring pipeline.
 */
async function buildVerbatimTranscriptionDocument({ task, filename, markdown, format, emit }) {
  const fs = require('fs');
  const { createDocument } = require('../document-service');
  const { saveVerifiedArtifact: saveArtifact, EXTENSION_TO_MIME } = require('./task-tools');
  const persistence = require('./agent-task-persistence');
  const { filePath } = await createDocument(task.userId, filename, markdown);
  const buffer = await fs.promises.readFile(filePath);
  const mime = MIME_BY_FORMAT[format] || EXTENSION_TO_MIME[format] || 'application/octet-stream';
  const artifact = await saveArtifact({
    filename,
    base64: buffer.toString('base64'),
    mime,
    ownerUserId: task.userId,
    chatId: task.chatId,
    validation: { passed: true, checks: { verbatim: true } },
  });
  let previewHtml = null;
  if (format === 'docx') {
    try {
      const { renderPreview } = require('../doc-preview');
      const preview = await renderPreview(format, buffer.toString('base64'));
      previewHtml = preview?.html || null;
    } catch (_) { /* preview is optional */ }
  }
  const validation = { passed: true, overallScore: 1, checks: { verbatim: true } };
  if (typeof emit === 'function') {
    emit({
      type: 'quality_gate',
      gate: 'artifact_validation',
      label: `Validación ${format.toUpperCase()}`,
      passed: true,
      score: 1,
      summary: 'Transcripción copiada literalmente del archivo adjunto.',
      payload: { format, sizeBytes: artifact.sizeBytes, verbatim: true },
    });
    emit({
      type: 'file_artifact',
      artifact: {
        id: artifact.id,
        filename: artifact.filename,
        format: artifact.format || format,
        mime: artifact.mime,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: artifact.downloadUrl,
        previewHtml,
        validation,
      },
    });
  }
  await persistence.persistGeneratedArtifact({ artifact: { ...artifact, validation }, task, previewHtml, validation });
  return { artifact, previewHtml, validation };
}

/**
 * @returns {{handled:boolean, reason?:string, sourceWords?:number, artifact?:object, finalMarkdown?:string}}
 * `onStart` fires once the source qualifies, right before the document is
 * built, so the caller can open a visible step only when the path really runs.
 */
async function runTranscriptionDocumentFastPath({
  prisma,
  userId,
  fileIds = [],
  task,
  documentPolicy,
  signal = null,
  emit = null,
  onStart = null,
  buildTranscriptionTextFromFiles,
  loadSourceNames = null,
  buildDocument = buildVerbatimTranscriptionDocument,
  logger = console,
  now = new Date(),
} = {}) {
  const format = String((documentPolicy && documentPolicy.format) || 'docx').toLowerCase();
  if (!VERBATIM_FORMATS.has(format)) return { handled: false, reason: 'format_not_verbatim' };

  let source = '';
  try {
    source = await buildTranscriptionTextFromFiles(prisma, { userId, fileIds });
  } catch (err) {
    if (signal && signal.aborted) throw err;
    logger.warn('[agent-task] transcription source unavailable:', (err && err.message) || err);
    return { handled: false, reason: 'source_unavailable' };
  }
  const sourceWords = countWords(source);
  if (sourceWords < MIN_SOURCE_WORDS) return { handled: false, reason: 'source_too_short', sourceWords };

  let sourceNames = [];
  try {
    if (typeof loadSourceNames === 'function') {
      sourceNames = await loadSourceNames();
    } else if (prisma && prisma.file && typeof prisma.file.findMany === 'function') {
      const rows = await prisma.file.findMany({ where: { id: { in: fileIds }, userId }, select: { originalName: true, filename: true } });
      sourceNames = rows.map((row) => row.originalName || row.filename).filter(Boolean);
    }
  } catch (_) { sourceNames = []; }

  if (typeof onStart === 'function') onStart({ sourceWords });
  if (typeof emit === 'function') {
    emit({ type: 'checkpoint', label: 'Transcripción tomada del archivo adjunto', status: 'saved', payload: { textLength: source.length, words: sourceWords } });
  }
  const filename = transcriptionFilename(sourceNames, format);
  const markdown = transcriptionDocumentMarkdown({ sourceNames, text: source, now });
  let built = null;
  try {
    built = await buildDocument({ task, filename, markdown, format, emit, signal });
  } catch (err) {
    if (signal && signal.aborted) throw err;
    logger.warn('[agent-task] transcription document fast path failed — falling back to the agent loop:', (err && err.message) || err);
    return { handled: false, reason: 'generation_failed', sourceWords };
  }
  const raw = built && built.artifact;
  if (!raw || !raw.downloadUrl) return { handled: false, reason: 'no_artifact', sourceWords };
  const artifact = {
    id: raw.id,
    filename: raw.filename,
    format: raw.format || format,
    mime: raw.mime,
    sizeBytes: raw.sizeBytes,
    downloadUrl: raw.downloadUrl,
  };
  return {
    handled: true,
    sourceWords,
    artifact,
    finalMarkdown: buildTranscriptionDeliveryMarkdown({
      fileCount: Array.isArray(fileIds) ? fileIds.length : 1,
      format,
      artifact,
    }),
  };
}

module.exports = {
  shouldUseTranscriptionDocumentFastPath,
  runTranscriptionDocumentFastPath,
  buildVerbatimTranscriptionDocument,
  buildTranscriptionDeliveryMarkdown,
  transcriptionDocumentMarkdown,
  transcriptionFilename,
  stripExtractorHeaders,
  countWords,
  MIN_SOURCE_WORDS,
  STOPPED_REASON,
  FORMAT_LABELS,
  VERBATIM_FORMATS,
};
