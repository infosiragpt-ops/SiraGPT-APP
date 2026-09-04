'use strict';

const path = require('path');
const { saveBufferArtifact } = require('../../services/agents/media-skill-artifacts');

const FORMAT_ARTIFACTS = {
  txt: { ext: 'txt', mime: 'text/plain', suffix: 'transcript', kind: 'transcript' },
  srt: { ext: 'srt', mime: 'application/x-subrip', suffix: 'subtitles', kind: 'transcript_srt' },
  vtt: { ext: 'vtt', mime: 'text/vtt', suffix: 'subtitles', kind: 'transcript_vtt' },
  json: { ext: 'json', mime: 'application/json', suffix: 'transcript', kind: 'transcript_json' },
};

function transcriptFilename(filename, format) {
  const spec = FORMAT_ARTIFACTS[format] || FORMAT_ARTIFACTS.txt;
  const base = path.basename(String(filename || 'audio'), path.extname(String(filename || '')))
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80) || 'audio';
  return `${base}-${spec.suffix}.${spec.ext}`;
}

function normalizeFormat(input) {
  const raw = String(input || 'txt').trim().toLowerCase();
  if (['txt', 'text', 'transcript'].includes(raw)) return 'txt';
  if (['srt', 'subrip'].includes(raw)) return 'srt';
  if (['vtt', 'webvtt'].includes(raw)) return 'vtt';
  if (['json', 'verbose_json', 'verbose'].includes(raw)) return 'json';
  return 'txt';
}

function buildFormatPayload(result, format) {
  if (format === 'srt') return String(result.srt || '');
  if (format === 'vtt') return String(result.vtt || '');
  if (format === 'json') {
    return JSON.stringify({
      transcript: result.transcript || '',
      language: result.language || null,
      model: result.model || null,
      provider: result.provider || result.method || null,
      durationMs: result.durationMs || 0,
      speakers: result.speakers || [],
      speakerCount: result.speakerCount || 0,
      segments: result.segments || [],
      words: result.words || [],
    }, null, 2);
  }
  return String(result.transcript || '');
}

function isSuccessMethod(result) {
  const viaRegistry = (() => {
    try {
      // eslint-disable-next-line global-require
      const methods = require('../../services/audio-transcriber').SUCCESS_METHODS;
      return methods && typeof methods.has === 'function' ? methods.has(result?.method) : null;
    } catch {
      return null;
    }
  })();
  if (viaRegistry !== null) return viaRegistry;
  return result?.method === 'whisper' || result?.method === 'local-whisper' || result?.method === 'local-stt';
}

async function execute(args = {}, ctx = {}) {
  const runtime = ctx.mediaRuntime || require('../../services/agents/media-inspection-runtime');
  const transcriber = ctx.audioTranscriber || require('../../services/audio-transcriber');
  const source = await runtime.resolveOwnedMediaSource({
    fileId: args.fileId,
    allowedKinds: ['audio', 'video'],
    maxSourceBytes: transcriber.AUDIO_MAX_FILE_BYTES || 25 * 1024 * 1024,
  }, ctx);

  const format = normalizeFormat(args.format);
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
        diarize: args.diarize === true,
        signal: ctx.signal,
      },
    );
  } finally {
    await source.cleanup();
  }

  const transcript = String(result?.transcript || '').trim();
  if (!isSuccessMethod(result) || !transcript) {
    const error = new Error(`audio transcription unavailable: ${result?.reasonCode || 'empty_result'}`);
    error.code = 'AUDIO_TRANSCRIPTION_UNAVAILABLE';
    throw error;
  }

  let artifact = null;
  if (args.saveTranscript === true) {
    const spec = FORMAT_ARTIFACTS[format];
    // Los subtítulos de una transcripción sin segmentos saldrían vacíos
    // (saveBufferArtifact rechaza buffers vacíos): degradar al texto.
    const body = buildFormatPayload(result, format) || transcript;
    artifact = saveBufferArtifact({
      item: {
        filename: transcriptFilename(source.source.filename, format),
        mime: spec.mime,
        buffer: Buffer.from(body, 'utf8'),
      },
      ctx,
      kind: spec.kind,
      extra: { sourceFileId: source.source.fileId, format },
    });
  }

  return {
    ok: true,
    source: source.source,
    transcript,
    segments: Array.isArray(result.segments) ? result.segments : [],
    words: Array.isArray(result.words) ? result.words : [],
    srt: String(result.srt || ''),
    vtt: String(result.vtt || ''),
    speakers: Array.isArray(result.speakers) ? result.speakers : [],
    speakerCount: result.speakerCount || 0,
    durationMs: result.durationMs || 0,
    model: result.model || null,
    language: result.language || null,
    provider: result.provider || result.method || null,
    format,
    artifact,
  };
}

module.exports = { execute, transcriptFilename, normalizeFormat, buildFormatPayload, FORMAT_ARTIFACTS };
