'use strict';

const { saveBufferArtifact } = require('../../services/agents/media-skill-artifacts');

async function execute(args = {}, ctx = {}) {
  const runtime = ctx.mediaRuntime || require('../../services/agents/media-inspection-runtime');
  const result = await runtime.extractVideoFrames(args, ctx);
  const artifacts = result.frames.map((frame) => saveBufferArtifact({
    item: frame,
    ctx,
    category: 'image',
    kind: 'video_frame',
    extra: {
      sourceFileId: result.source.fileId,
      timestampSeconds: frame.timestampSeconds,
    },
  }));

  return {
    ok: true,
    source: result.source,
    media: result.media,
    count: artifacts.length,
    frames: artifacts,
  };
}

module.exports = { execute };
