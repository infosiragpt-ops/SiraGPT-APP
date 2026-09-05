'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pipelines = require('../src/services/voice-studio/pipelines');
const translate = require('../src/services/voice-studio/translate');
const chatPersistence = require('../src/services/voice-studio/chat-persistence');
const { createJobQueue, JOB_STATUS } = require('../src/services/voice-studio/jobs');

test('buildDubSegments clones each original speaker unless the user picked a voice', () => {
  const segments = [
    { id: 's1', start: 0, end: 1.2, text: 'Hello', speaker_id: 'speaker_0' },
    { id: 's2', start: 1.2, end: 2.0, text: 'Bye', speaker_id: 'speaker_1' },
    { id: 's3', start: 2.0, end: 2.1, text: 'Solo' },
    { id: 's4', start: 2.1, end: 2.5, text: '   ' },
  ];
  const translated = [{ id: 's1', text: 'Hola' }, { id: 's2', text: 'Adiós' }, { id: 's3', text: 'Solo' }, { id: 's4', text: '' }];
  const auto = pipelines.buildDubSegments(segments, translated);
  assert.equal(auto.length, 3);
  assert.deepEqual(auto.map((s) => s.profile_id), ['auto:speaker_0', 'auto:speaker_1', 'auto-seg:s3']);
  assert.equal(auto[0].text, 'Hola');
  assert.ok(auto[2].end - auto[2].start >= 0.2, 'tiny slots get a minimum duration');
  const pinned = pipelines.buildDubSegments(segments, translated, { voiceProfileId: 'p9' });
  assert.ok(pinned.every((s) => s.profile_id === 'p9'));
});

test('segmentsToSrt formats timestamps and skips empty lines', () => {
  const srt = pipelines.segmentsToSrt([{ start: 0, end: 1.5, text: 'Hola' }, { start: 61.25, end: 3661.001, text: 'Fin' }, { start: 2, end: 3, text: ' ' }]);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,500\nHola\n/);
  assert.match(srt, /2\n00:01:01,250 --> 01:01:01,001\nFin/);
  assert.doesNotMatch(srt, /\n3\n/);
});

test('prepStageLabel maps VoiceStudio prep events to Spanish stages with increasing progress', () => {
  const order = ['download_start', 'extract_start', 'extract_done', 'demucs_start', 'demucs_done', 'scene_start', 'scene_done'];
  let last = -1;
  for (const type of order) {
    const mapped = pipelines.prepStageLabel({ type });
    assert.ok(mapped && mapped.stage && mapped.progress > last, type);
    last = mapped.progress;
  }
  assert.equal(pipelines.prepStageLabel({ type: 'ping' }), null);
});

test('translate.parseLines accepts JSON object, fenced JSON and numbered fallback', () => {
  const asJson = translate.parseLines('{"lines":[{"n":1,"text":"Hola"},{"n":2,"text":"Adiós"}]}', 2);
  assert.equal(asJson.get(1), 'Hola');
  assert.equal(asJson.get(2), 'Adiós');
  const fenced = translate.parseLines('Claro:\n```json\n{"lines":[{"n":1,"text":"Hola"}]}\n```', 1);
  assert.equal(fenced.get(1), 'Hola');
  const numbered = translate.parseLines('1. Hola\n2) Adiós', 2);
  assert.equal(numbered.get(2), 'Adiós');
  assert.equal(translate.parseLines('{"lines":[{"n":9,"text":"x"}]}', 2).size, 0);
});

test('translation defaults to the local NLLB engine only (zero cost) and the provider list is env-configurable', () => {
  assert.deepEqual(translate.DEFAULT_PROVIDERS, ['nllb']);
  assert.deepEqual(translate.translateProviders({ env: {} }), ['nllb']);
  assert.deepEqual(translate.translateProviders({ env: { VOICESTUDIO_TRANSLATE_PROVIDERS: 'nllb,llm' } }), ['nllb', 'llm']);
  assert.deepEqual(translate.translateProviders({ env: { VOICESTUDIO_TRANSLATE_PROVIDERS: 'llm, NLLB, bogus' } }), ['llm', 'nllb']);
  assert.deepEqual(translate.translateProviders({ env: { VOICESTUDIO_TRANSLATE_PROVIDERS: 'bogus' } }), ['nllb']);
});

test('translateSegments uses VoiceStudio NLLB by default, never touching an LLM, and short-circuits same language', async () => {
  const segments = [{ id: 'a', text: 'Hello' }];
  let llmCalls = 0;
  const fetchImpl = async (url, init) => {
    assert.match(url, /\/dub\/translate$/);
    const payload = JSON.parse(init.body);
    assert.equal(payload.provider, 'nllb');
    assert.equal(payload.target_lang, 'es');
    return new Response(JSON.stringify([{ id: 'a', text: 'Hola' }]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const out = await translate.translateSegments(segments, { targetLanguage: 'Spanish', env: {}, clientFactory: () => { llmCalls += 1; return null; } }, { env: { VOICESTUDIO_URL: 'http://vs.test' }, fetchImpl });
  assert.equal(out.engine, 'nllb');
  assert.equal(out.segments[0].text, 'Hola');
  assert.equal(llmCalls, 0, 'the paid LLM ladder must not be consulted by default');
  const same = await translate.translateSegments(segments, { targetLanguage: 'en', sourceLanguage: 'English', env: {}, clientFactory: () => null });
  assert.equal(same.engine, 'same-language');
});

test('translateSegments can opt into the LLM ladder as a fallback and keeps original text for lines the model dropped', async () => {
  const segments = [{ id: 'a', text: 'Hello' }, { id: 'b', text: 'World' }, { id: 'c', text: '' }];
  const fakeClient = { chat: { completions: { create: async () => ({ choices: [{ message: { content: '{"lines":[{"n":1,"text":"Hola"}]}' } }] }) } } };
  const failingFetch = async () => new Response(JSON.stringify({ detail: 'nllb down' }), { status: 503, headers: { 'content-type': 'application/json' } });
  const out = await translate.translateSegments(segments, { targetLanguage: 'Spanish', sourceLanguage: 'en', env: { VOICESTUDIO_TRANSLATE_PROVIDERS: 'nllb,llm' }, clientFactory: () => fakeClient }, { env: { VOICESTUDIO_URL: 'http://vs.test' }, fetchImpl: failingFetch });
  assert.equal(out.engine, 'sira-llm');
  assert.match(out.warning, /nllb/);
  assert.deepEqual(out.segments, [{ id: 'a', text: 'Hola' }, { id: 'b', text: 'World' }, { id: 'c', text: '' }]);
  await assert.rejects(
    () => translate.translateSegments(segments, { targetLanguage: 'Spanish', env: {}, clientFactory: () => fakeClient }, { env: { VOICESTUDIO_URL: 'http://vs.test' }, fetchImpl: failingFetch }),
    (err) => err.code === 'TRANSLATE_FAILED' && /nllb down/.test(err.message),
  );
});

test('chat persistence builders produce renderable artifacts and video snapshots', () => {
  const artifact = chatPersistence.buildAudioArtifact({ id: 'x', filename: 'libro.m4b', mime: 'audio/mp4', format: 'm4b', sizeBytes: 10, downloadUrl: '/api/elevenlabs/audio/x.m4b', prompt: 'p', kind: 'audiobook' });
  assert.equal(artifact.category, 'audio');
  assert.equal(artifact.model, 'Sira Voz');
  const state = chatPersistence.buildAudioArtifactState({ goal: 'g', label: 'Audiolibro generado', artifact, tool: 'generate_audiobook', finalText: 'ok' });
  assert.equal(state.done, true);
  assert.equal(state.artifacts[0], artifact);
  assert.equal(state.steps[0].toolCalls[0].tool, 'generate_audiobook');
  const block = chatPersistence.agentTaskStateBlock(state);
  assert.match(block, /^```agent-task-state\n/);
  const snapshot = chatPersistence.buildVideoFileSnapshot({ filename: 'd.mp4', originalName: 'clip-es.mp4', sizeBytes: 5, url: '/api/video/watch/d.mp4', durationSeconds: 12 });
  assert.equal(snapshot.mimeType, 'video/mp4');
  assert.equal(snapshot.url, '/api/video/watch/d.mp4');
  assert.equal(snapshot.mediaMeta.durationSeconds, 12);
});

test('job queue runs one job at a time, persists progress and hides private paths', async () => {
  const rows = new Map();
  let seq = 0;
  const client = {
    voiceStudioJob: {
      async create({ data }) { const row = { id: `j${++seq}`, ...data, createdAt: new Date(), updatedAt: new Date() }; rows.set(row.id, row); return row; },
      async update({ where, data }) { const row = rows.get(where.id); Object.assign(row, data, { updatedAt: new Date() }); return row; },
      async findFirst({ where }) { const row = rows.get(where.id); return row && row.userId === where.userId ? row : null; },
      async findMany({ where }) { return [...rows.values()].filter((r) => r.userId === where.userId); },
      async count({ where }) { return [...rows.values()].filter((r) => r.userId === where.userId && where.status.in.includes(r.status)).length; },
      async updateMany() { return { count: 0 }; },
    },
  };
  const queue = createJobQueue({ client, env: { VOICESTUDIO_JOB_CONCURRENCY: '1' }, logger: { warn() {}, error() {} } });
  const order = [];
  let releaseFirst;
  const first = queue.enqueue({
    userId: 'u1', kind: 'dub', title: 'a',
    runner: async (ctx) => {
      order.push('first-start');
      await ctx.progress({ stage: 'transcribiendo', progress: 30 });
      await new Promise((resolve) => { releaseFirst = resolve; });
      return { kind: 'dub', filename: 'a.mp4', __private: { outputPath: '/srv/a.mp4' } };
    },
  });
  const second = queue.enqueue({ userId: 'u1', kind: 'audiobook', runner: async () => { order.push('second-start'); return { kind: 'audiobook' }; } });
  const [j1, j2] = await Promise.all([first, second]);
  assert.equal(j1.status, JOB_STATUS.QUEUED);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ['first-start']);
  const running = await queue.get('u1', j1.id);
  assert.equal(running.status, JOB_STATUS.RUNNING);
  assert.equal(running.stage, 'transcribiendo');
  assert.equal(running.progress, 30);
  assert.equal(await queue.activeCount('u1'), 2);
  releaseFirst();
  await new Promise((r) => setTimeout(r, 20));
  const done = await queue.get('u1', j1.id);
  assert.equal(done.status, JOB_STATUS.DONE);
  assert.equal(done.progress, 100);
  assert.equal(done.result.filename, 'a.mp4');
  assert.equal(done.result.__private, undefined, 'server paths never reach the browser');
  const raw = await queue.getRow('u1', j1.id);
  assert.equal(raw.result.__private.outputPath, '/srv/a.mp4');
  assert.deepEqual(order, ['first-start', 'second-start']);
  assert.equal((await queue.get('u1', j2.id)).status, JOB_STATUS.DONE);
  assert.equal(await queue.get('u2', j1.id), null, 'other users cannot read the job');
});

test('job queue marks a failing runner as failed and cancels queued jobs', async () => {
  const rows = new Map();
  let seq = 0;
  const client = {
    voiceStudioJob: {
      async create({ data }) { const row = { id: `k${++seq}`, ...data, createdAt: new Date(), updatedAt: new Date() }; rows.set(row.id, row); return row; },
      async update({ where, data }) { const row = rows.get(where.id); Object.assign(row, data); return row; },
      async findFirst({ where }) { const row = rows.get(where.id); return row && row.userId === where.userId ? row : null; },
      async findMany() { return [...rows.values()]; },
      async count() { return 0; },
    },
  };
  const queue = createJobQueue({ client, env: { VOICESTUDIO_JOB_CONCURRENCY: '1' }, logger: { warn() {}, error() {} } });
  let release;
  const blocker = await queue.enqueue({ userId: 'u', kind: 'dub', runner: () => new Promise((resolve) => { release = resolve; }) });
  const failing = await queue.enqueue({ userId: 'u', kind: 'dub', runner: async () => { throw new Error('boom'); } });
  const cancelled = await queue.enqueue({ userId: 'u', kind: 'dub', runner: async () => ({}) });
  const c = await queue.cancel('u', cancelled.id);
  assert.equal(c.status, JOB_STATUS.CANCELLED);
  release({});
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await queue.get('u', blocker.id)).status, JOB_STATUS.DONE);
  const f = await queue.get('u', failing.id);
  assert.equal(f.status, JOB_STATUS.FAILED);
  assert.equal(f.error, 'boom');
  assert.equal((await queue.get('u', cancelled.id)).status, JOB_STATUS.CANCELLED);
});
