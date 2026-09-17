'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  RunSummaryAudioError,
  ensureRunSummaryAudio,
} = require('../src/services/codex/run-summary-audio');

test('run audio is generated from deterministic executive audioText and persisted once', async () => {
  const appended = [];
  let generated = 0;
  const eventStore = {
    listEvents: async () => [{
      type: 'executive_summary',
      data: { audioText: 'La misión terminó y todas las pruebas pasaron.' },
    }],
    appendEvent: async (_runId, type, data) => {
      appended.push({ type, data });
    },
  };
  const result = await ensureRunSummaryAudio({
    runId: 'run-1',
    userId: 'user-1',
    prisma: {},
    runService: { getRun: async () => ({ id: 'run-1' }) },
    eventStore,
    tts: {
      isElevenLabsConfigured: () => true,
      generateSpeechFile: async ({ text }) => {
        generated += 1;
        assert.match(text, /pruebas pasaron/);
        return {
          audioUrl: '/api/elevenlabs/audio/run.mp3',
          sizeBytes: 200,
          characters: text.length,
          voiceId: 'voice',
          modelId: 'model',
        };
      },
    },
  });
  assert.equal(result.cached, false);
  assert.equal(generated, 1);
  assert.equal(appended[0].type, 'run_audio');
  assert.equal(appended[0].data.mime, 'audio/mpeg');
});

test('run audio reuses the durable event and does not call the provider twice', async () => {
  const cached = {
    audioUrl: '/api/elevenlabs/audio/cached.mp3',
    mime: 'audio/mpeg',
    sizeBytes: 12,
    characters: 5,
    voiceId: null,
    modelId: null,
  };
  const result = await ensureRunSummaryAudio({
    runId: 'run-1',
    userId: 'user-1',
    prisma: {},
    runService: { getRun: async () => ({ id: 'run-1' }) },
    eventStore: {
      listEvents: async () => [{ type: 'run_audio', data: cached }],
      appendEvent: async () => {
        throw new Error('must not append');
      },
    },
    tts: {
      isElevenLabsConfigured: () => true,
      generateSpeechFile: async () => {
        throw new Error('must not generate');
      },
    },
  });
  assert.equal(result.cached, true);
  assert.deepEqual(result.audio, cached);
});

test('run audio fails cleanly before a summary exists', async () => {
  await assert.rejects(
    () => ensureRunSummaryAudio({
      runId: 'run-1',
      userId: 'user-1',
      prisma: {},
      runService: { getRun: async () => ({ id: 'run-1' }) },
      eventStore: { listEvents: async () => [] },
      tts: { isElevenLabsConfigured: () => false },
    }),
    (error) => error instanceof RunSummaryAudioError && error.code === 'run_summary_unavailable',
  );
});

test('run summary audio route keeps the existing paid voice-generation gate', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/routes/codex.js'),
    'utf8',
  );
  const route = source.slice(
    source.indexOf("'/runs/:id/summary-audio'"),
    source.indexOf("'/runs/:id/tool-permission'"),
  );
  assert.match(route, /requirePaidPlan\(\{\s*feature:\s*'voice_generation'\s*\}\)/);
  assert.match(route, /authenticateToken[\s\S]*requireCodexAgentAccess/);
});
