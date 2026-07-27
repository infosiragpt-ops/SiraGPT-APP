'use strict';

const { saveBufferArtifact } = require('../../services/agents/media-skill-artifacts');

async function execute(args = {}, ctx = {}) {
  const runtime = ctx.mediaRuntime || require('../../services/agents/media-inspection-runtime');
  const result = await runtime.createAudioSpectrogram(args, ctx);
  const artifact = saveBufferArtifact({
    item: result.spectrogram,
    ctx,
    category: 'image',
    kind: 'audio_spectrogram',
    extra: {
      sourceFileId: result.source.fileId,
      startSeconds: result.spectrogram.startSeconds,
      durationSeconds: result.spectrogram.durationSeconds,
      style: result.spectrogram.style,
    },
  });

  return {
    ok: true,
    source: result.source,
    media: result.media,
    spectrogram: artifact,
  };
}

module.exports = { execute };
