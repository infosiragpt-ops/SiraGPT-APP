'use strict';

/**
 * rag-audio-placeholder-filter
 *
 * Failure blocks from audio-transcriber must never enter RAG. They are not
 * speech content, and older placeholders could contain provider error text.
 */

const FAILURE_MARKERS = [
  /Estado:\s*Transcripci[oó]n no disponible/i,
  /Status:\s*Transcription not available/i,
  /No se pudo transcribir\.?\s*Reintentando en local/i,
  /Set OPENAI_API_KEY in your environment/i,
];

const LEGACY_HOWTO = /To enable transcription:/i;

function isAudioTranscriptionPlaceholder(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  if (FAILURE_MARKERS.some((re) => re.test(value))) return true;
  if (LEGACY_HOWTO.test(value) && /Supported formats:/i.test(value)) return true;
  return false;
}

function filterAudioPlaceholders(docs = []) {
  return (Array.isArray(docs) ? docs : []).filter((doc) => {
    const text = typeof doc === 'string'
      ? doc
      : (doc && (doc.text || doc.extractedText || doc.content)) || '';
    return !isAudioTranscriptionPlaceholder(text);
  });
}

module.exports = {
  isAudioTranscriptionPlaceholder,
  filterAudioPlaceholders,
};
