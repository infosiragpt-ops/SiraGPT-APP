'use strict';

const path = require('path');
const { saveBufferArtifact } = require('../../services/agents/media-skill-artifacts');

function transcriptFilename(filename) {
  const base = path.basename(String(filename || 'audio'), path.extname(String(filename || '')))
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80) || 'audio';
  return `${base}-transcript.txt`;
}

async function execute(args = {}, ctx = {}) {
  const runtime = ctx.mediaRuntime || require('../../services/agents/media-inspection-runtime');
  const transcriber = ctx.audioTranscriber || require('../../services/audio-transcriber');
  const source = await runtime.resolveOwnedMediaSource({
    fileId: args.fileId,
    allowedKinds: ['audio', 'video'],
    maxSourceBytes: transcriber.AUDIO_MAX_FILE_BYTES || 25 * 1024 * 1024,
  }, ctx);

  let result;
  try {
    const audioProvider = ctx.openai?.audio?.transcriptions?.create ? ctx.openai : undefined;
    result = await transcriber.transcribe(
      source.localPath,
      source.source.mimeType,
      source.source.filename,
      {
        openai: audioProvider,
        language: args.language,
        prompt: args.prompt,
        signal: ctx.signal,
      },
    );
  } finally {
    await source.cleanup();
  }

  const transcript = String(result?.transcript || '').trim();
  if (result?.method !== 'whisper' || !transcript) {
    const error = new Error(`audio transcription unavailable: ${result?.reasonCode || 'empty_result'}`);
    error.code = 'AUDIO_TRANSCRIPTION_UNAVAILABLE';
    throw error;
  }

  let artifact = null;
  if (args.saveTranscript === true) {
    artifact = saveBufferArtifact({
      item: {
        filename: transcriptFilename(source.source.filename),
        mime: 'text/plain',
        buffer: Buffer.from(transcript, 'utf8'),
      },
      ctx,
      kind: 'transcript',
      extra: { sourceFileId: source.source.fileId },
    });
  }

  return {
    ok: true,
    source: source.source,
    transcript,
    segments: Array.isArray(result.segments) ? result.segments : [],
    model: result.model || null,
    language: result.language || null,
    artifact,
  };
}

module.exports = { execute, transcriptFilename };
