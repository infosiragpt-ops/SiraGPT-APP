'use strict';

class RunSummaryAudioError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RunSummaryAudioError';
    this.code = code;
    this.status = status;
  }
}

async function ensureRunSummaryAudio({
  runId,
  userId,
  prisma,
  runService,
  eventStore,
  tts,
}) {
  const run = await runService.getRun({ userId, runId, db: prisma });
  if (!run) throw new RunSummaryAudioError('run_not_found', 'run not found', 404);
  const events = await eventStore.listEvents(runId, { prisma });
  const cached = [...events].reverse().find((event) => event.type === 'run_audio');
  if (cached) return { audio: cached.data, cached: true };
  const summary = [...events].reverse().find((event) => event.type === 'executive_summary');
  const text = String(summary?.data?.audioText || '').trim();
  if (!text) {
    throw new RunSummaryAudioError(
      'run_summary_unavailable',
      'The run has no executive audio summary yet.',
      409,
    );
  }
  if (!tts?.isElevenLabsConfigured?.()) {
    throw new RunSummaryAudioError(
      'speech_provider_unavailable',
      'Speech generation is not configured.',
      503,
    );
  }
  const generated = await tts.generateSpeechFile({ text });
  const audio = {
    audioUrl: generated.audioUrl,
    mime: 'audio/mpeg',
    sizeBytes: Number(generated.sizeBytes) || 0,
    characters: Number(generated.characters) || text.length,
    voiceId: generated.voiceId || null,
    modelId: generated.modelId || null,
  };
  await eventStore.appendEvent(runId, 'run_audio', audio, { prisma });
  return { audio, cached: false };
}

module.exports = {
  RunSummaryAudioError,
  ensureRunSummaryAudio,
};
