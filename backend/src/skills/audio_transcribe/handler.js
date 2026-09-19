'use strict';

const path = require('path');
const { saveBufferArtifact } = require('../../services/agents/media-skill-artifacts');
const realTranscriber = require('../../services/audio-transcriber');

// Hour-long videos welcome: the engine segments cloud uploads and runs local
// Whisper without a size cap, so the source limit is disk/time, aligned with
// the media upload ceiling — not the 25 MB cloud request cap.
const DEFAULT_TRANSCRIBE_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const TRANSCRIPT_FORMATS = new Set(['txt', 'srt', 'vtt', 'json']);

function resolveMaxSourceBytes(ctx = {}) {
  const env = ctx.env || process.env;
  const raw = Number(ctx.maxSourceBytes ?? env.TRANSCRIBE_MAX_SOURCE_BYTES ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TRANSCRIBE_SOURCE_BYTES;
}

function transcriptBasename(filename) {
  return path.basename(String(filename || 'audio'), path.extname(String(filename || '')))
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80) || 'audio';
}

function transcriptFilename(filename, ext) {
  return `${transcriptBasename(filename)}-transcript.${ext}`;
}

function buildersFor(transcriber) {
  return {
    buildSrt: transcriber.buildSrt || realTranscriber.buildSrt,
    buildVtt: transcriber.buildVtt || realTranscriber.buildVtt,
  };
}

/**
 * Render the professional transcript pack for the requested format.
 * SRT/VTT need timestamped segments; when none exist we fall back to TXT so
 * a good transcript is never lost for missing timestamps.
 */
function renderTranscript({ format, transcript, segments, model, language, source }, builders) {
  if (format === 'srt') {
    const srt = builders.buildSrt(segments);
    if (srt) return { ext: 'srt', mime: 'application/x-subrip', content: srt, fallback: null };
  } else if (format === 'vtt') {
    const vtt = builders.buildVtt(segments);
    if (vtt) return { ext: 'vtt', mime: 'text/vtt', content: vtt, fallback: null };
  } else if (format === 'json') {
    return {
      ext: 'json',
      mime: 'application/json',
      content: JSON.stringify({
        file: source?.filename || null,
        language: language || null,
        model: model || null,
        text: transcript,
        segments: Array.isArray(segments) ? segments : [],
      }, null, 2) + '\n',
      fallback: null,
    };
  }
  if (format === 'srt' || format === 'vtt') {
    return { ext: 'txt', mime: 'text/plain', content: transcript, fallback: 'txt' };
  }
  return { ext: 'txt', mime: 'text/plain', content: transcript, fallback: null };
}

function savePack({ rendered, srtFallback, filename, ctx, source }) {
  const primary = saveBufferArtifact({
    item: {
      filename: transcriptFilename(filename, rendered.ext),
      mime: rendered.mime,
      buffer: Buffer.from(rendered.content, 'utf8'),
    },
    ctx,
    kind: 'transcript',
    extra: { sourceFileId: source?.fileId, format: rendered.ext },
  });
  let supplement = null;
  if (srtFallback) {
    supplement = saveBufferArtifact({
      item: {
        filename: transcriptFilename(filename, 'srt'),
        mime: 'application/x-subrip',
        buffer: Buffer.from(srtFallback, 'utf8'),
      },
      ctx,
      kind: 'transcript',
      extra: { sourceFileId: source?.fileId, format: 'srt' },
    });
  }
  return { primary, supplement };
}

async function execute(args = {}, ctx = {}) {
  const runtime = ctx.mediaRuntime || require('../../services/agents/media-inspection-runtime');
  const transcriber = ctx.audioTranscriber || realTranscriber;
  const format = TRANSCRIPT_FORMATS.has(String(args.format || '').toLowerCase())
    ? String(args.format).toLowerCase()
    : 'txt';
  const source = await runtime.resolveOwnedMediaSource({
    fileId: args.fileId,
    allowedKinds: ['audio', 'video'],
    maxSourceBytes: resolveMaxSourceBytes(ctx),
  }, ctx);

  let result;
  try {
    const audioProvider = ctx.openai?.audio?.transcriptions?.create ? ctx.openai : undefined;
    const transcribeOptions = {
      openai: audioProvider,
      language: args.language,
      prompt: args.prompt,
      signal: ctx.signal,
    };
    if (typeof ctx.onProgress === 'function') transcribeOptions.onProgress = ctx.onProgress;
    result = await transcriber.transcribe(
      source.localPath,
      source.source.mimeType,
      source.source.filename,
      transcribeOptions,
    );
  } finally {
    await source.cleanup();
  }

  const transcript = String(result?.transcript || '').trim();
  const success = result?.method === 'whisper' || result?.method === 'local-whisper';
  if (!success || !transcript) {
    const error = new Error(`audio transcription unavailable: ${result?.reasonCode || 'empty_result'}`);
    error.code = 'AUDIO_TRANSCRIPTION_UNAVAILABLE';
    throw error;
  }
  const segments = Array.isArray(result.segments) ? result.segments : [];
  const builders = buildersFor(transcriber);
  const rendered = renderTranscript({
    format,
    transcript,
    segments,
    model: result.model || null,
    language: result.language || null,
    source: source.source,
  }, builders);

  let artifact = null;
  let srtArtifact = null;
  if (args.saveTranscript === true) {
    // Professional pack: the requested format plus always SRT when
    // timestamped segments exist (editors and players ingest it directly).
    let supplementSrt = null;
    if (rendered.ext !== 'srt') {
      const srt = builders.buildSrt(segments);
      if (srt) supplementSrt = srt;
    }
    const saved = savePack({
      rendered,
      srtFallback: supplementSrt,
      filename: source.source.filename,
      ctx,
      source: source.source,
    });
    artifact = saved.primary;
    srtArtifact = saved.supplement;
  }

  return {
    ok: true,
    source: source.source,
    transcript,
    segments,
    srt: builders.buildSrt(segments) || null,
    vtt: builders.buildVtt(segments) || null,
    format: rendered.ext,
    formatFallback: rendered.fallback,
    model: result.model || null,
    language: result.language || null,
    artifact,
    srtArtifact,
  };
}

module.exports = {
  execute,
  transcriptFilename,
  transcriptBasename,
  renderTranscript,
  resolveMaxSourceBytes,
  DEFAULT_TRANSCRIBE_SOURCE_BYTES,
};
