'use strict';

/**
 * transcription-document-fast-path — «transcribir en un documento word» with a
 * readable attachment is not an open task: the deliverable IS the attachment's
 * text in the requested format. Prod 2026-09-27 (verified turn): the agent
 * loop spent 342 s on document_analysis tool calls before generating a 3.6 KB
 * Word from text it already had. This path builds the document straight from
 * the extracted text and answers in seconds.
 *
 * Scope: document attachments only. Media (audio/video) transcription keeps
 * the media-batch path; a surgical edit keeps the source-preserving editor; an
 * attachment without usable text falls through to the agent loop. Every
 * dependency is injected so the decision and the delivery text are unit-testable.
 */

const FORMAT_LABELS = Object.freeze({ docx: 'Word', pdf: 'PDF', xlsx: 'Excel', pptx: 'PowerPoint' });
const MIN_SOURCE_WORDS = 20;
const STOPPED_REASON = 'transcription_document';

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
    && artifactsCount === 0;
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
 * @returns {{handled:boolean, reason?:string, sourceWords?:number, artifact?:object, finalMarkdown?:string}}
 * `onStart` fires once the source qualifies, right before generation, so the
 * caller can open a visible step only when the path really runs.
 */
async function runTranscriptionDocumentFastPath({
  prisma,
  userId,
  fileIds = [],
  task,
  goal = '',
  documentPolicy,
  signal = null,
  emit = null,
  onStart = null,
  buildTranscriptionTextFromFiles,
  generateAutoDocument,
  logger = console,
} = {}) {
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

  if (typeof onStart === 'function') onStart({ sourceWords });
  if (typeof emit === 'function') {
    emit({ type: 'checkpoint', label: 'Transcripción tomada del archivo adjunto', status: 'saved', payload: { textLength: source.length, words: sourceWords } });
  }
  let generated = null;
  try {
    generated = await generateAutoDocument({ task, goal, finalText: source, policy: documentPolicy, signal, emit });
  } catch (err) {
    if (signal && signal.aborted) throw err;
    logger.warn('[agent-task] transcription document fast path failed — falling back to the agent loop:', (err && err.message) || err);
    return { handled: false, reason: 'generation_failed', sourceWords };
  }
  const raw = generated && generated.artifact;
  if (!raw || !raw.downloadUrl) return { handled: false, reason: 'no_artifact', sourceWords };
  const artifact = {
    id: raw.id,
    filename: raw.filename,
    format: raw.format,
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
      format: documentPolicy && documentPolicy.format,
      artifact,
    }),
  };
}

module.exports = {
  shouldUseTranscriptionDocumentFastPath,
  runTranscriptionDocumentFastPath,
  buildTranscriptionDeliveryMarkdown,
  countWords,
  MIN_SOURCE_WORDS,
  STOPPED_REASON,
  FORMAT_LABELS,
};
