'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const client = require('../src/services/ai/voicestudio-client');

const env = { VOICESTUDIO_URL: 'http://voicestudio.test:3900/', VOICESTUDIO_API_KEY: 'k-test-not-a-secret' };

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function sseResponse(lines) {
  const body = lines.map((l) => (typeof l === 'string' ? l : `data: ${JSON.stringify(l)}`)).join('\n') + '\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function tmpFile(t, name, content = 'audio-bytes') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-vs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

test('configuration + Sira Voz model detection', () => {
  assert.equal(client.isConfigured({ env: {} }), false);
  assert.equal(client.isConfigured({ env }), true);
  assert.equal(client.baseUrl({ env }), 'http://voicestudio.test:3900');
  for (const name of ['sira-voz', 'Sira Voz', 'SIRA_VOZ', 'voicestudio-local', 'VoiceStudio', 'omnivoice']) {
    assert.equal(client.isSiraVozModel(name), true, name);
  }
  for (const name of ['gemini-2.5-flash-tts', 'ElevenLabs', 'eleven-multilingual-v2', '']) {
    assert.equal(client.isSiraVozModel(name), false, name);
  }
});

test('language helpers map composer names to VoiceStudio names and ISO codes', () => {
  assert.equal(client.languageCode('Spanish'), 'es');
  assert.equal(client.languageCode('es'), 'es');
  assert.equal(client.languageCode('en-US'), 'en');
  assert.equal(client.languageCode('Auto'), null);
  assert.equal(client.languageCode('Klingon'), null);
  assert.equal(client.languageName('es'), 'Spanish');
  assert.equal(client.languageName('spanish'), 'Spanish');
  assert.equal(client.languageName(''), 'Auto');
  assert.equal(client.languageName('Quechua'), 'Quechua');
});

test('chunkText keeps every chunk under the VoiceStudio cap and never splits a word', () => {
  const sentence = 'Esta es una frase de prueba con varias palabras para narrar. ';
  const text = sentence.repeat(120); // ~7.5k chars
  const chunks = client.chunkText(text, 3000);
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 3000, `chunk too long: ${chunk.length}`);
    assert.ok(!chunk.startsWith(' ') && !chunk.endsWith(' '));
  }
  assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), text.replace(/\s+/g, ' ').trim());
  assert.deepEqual(client.chunkText('   '), []);
  assert.deepEqual(client.chunkText('corto'), ['corto']);
  const longWordy = 'palabra'.repeat(700); // one 4900-char "word"
  for (const chunk of client.chunkText(longWordy, 3000)) assert.ok(chunk.length <= 3000);
});

test('synthesizeSpeech posts the OpenAI-compatible payload with Bearer auth and returns audio bytes', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(Buffer.from('RIFFwav'), { status: 200, headers: { 'content-type': 'audio/wav' } });
  };
  const out = await client.synthesizeSpeech({ text: 'Hola mundo', voice: 'abc12345', language: 'Spanish', speed: 1.1 }, { env, fetchImpl });
  assert.equal(out.mime, 'audio/wav');
  assert.equal(out.ext, 'wav');
  assert.equal(out.buffer.toString(), 'RIFFwav');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://voicestudio.test:3900/v1/audio/speech');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k-test-not-a-secret');
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.input, 'Hola mundo');
  assert.equal(payload.voice, 'abc12345');
  assert.equal(payload.language, 'Spanish');
  assert.equal(payload.response_format, 'wav');
  assert.equal(payload.model, 'tts-1');
  assert.equal(payload.speed, 1.1);
});

test('errors carry the upstream detail and a typed code; unreachable is retryable 503', async () => {
  const fetch503 = async () => jsonResponse({ detail: 'The voice engine is not ready yet' }, { status: 503 });
  await assert.rejects(
    () => client.synthesizeSpeech({ text: 'x' }, { env, fetchImpl: fetch503 }),
    (err) => err instanceof client.VoiceStudioError && err.status === 503 && err.code === 'VOICESTUDIO_BUSY' && /not ready/.test(err.message),
  );
  const fetchDown = async () => { throw new Error('connect ECONNREFUSED'); };
  await assert.rejects(
    () => client.health({ env, fetchImpl: fetchDown }).then((h) => { if (!h.ok) throw new client.VoiceStudioError(h.status, { code: 'x' }); }),
    (err) => err.message === 'unreachable',
  );
  await assert.rejects(
    () => client.listProfiles({ env: {} }),
    (err) => err.code === 'VOICESTUDIO_NOT_CONFIGURED' && err.status === 503,
  );
  const fetch401 = async () => jsonResponse({ detail: 'API key required' }, { status: 401 });
  await assert.rejects(
    () => client.listProfiles({ env, fetchImpl: fetch401 }),
    (err) => err.code === 'VOICESTUDIO_UNAUTHORIZED' && err.status === 401,
  );
});

test('health distinguishes ok / starting / unreachable / not configured', async () => {
  assert.deepEqual(await client.health({ env: {} }), { ok: false, configured: false, status: 'not_configured' });
  const ok = await client.health({ env, fetchImpl: async () => jsonResponse({ status: 'ok', device: 'cpu', version: '0.5.1' }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.device, 'cpu');
  assert.equal(ok.version, '0.5.1');
  const starting = await client.health({ env, fetchImpl: async () => jsonResponse({ status: 'starting', step: 'models', label: 'Loading' }, { status: 503 }) });
  assert.equal(starting.ok, false);
  assert.equal(starting.status, 'starting');
});

test('createCloneProfile sends multipart with the reference clip and language name', async (t) => {
  const audioPath = tmpFile(t, 'muestra.wav');
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return jsonResponse({ id: 'p1', name: 'Luis · 1234', kind: 'clone' });
  };
  const created = await client.createCloneProfile({ name: 'Luis · 1234', audioPath, filename: 'muestra.wav', mime: 'audio/wav', language: 'es', refText: 'hola' }, { env, fetchImpl });
  assert.equal(created.id, 'p1');
  assert.equal(seen.url, 'http://voicestudio.test:3900/profiles');
  assert.ok(seen.init.body instanceof FormData);
  assert.equal(seen.init.body.get('name'), 'Luis · 1234');
  assert.equal(seen.init.body.get('language'), 'Spanish');
  assert.equal(seen.init.body.get('kind'), 'clone');
  assert.equal(seen.init.body.get('ref_text'), 'hola');
  const file = seen.init.body.get('ref_audio');
  assert.ok(file && typeof file.arrayBuffer === 'function');
  assert.equal(file.name, 'muestra.wav');
  await assert.rejects(() => client.createCloneProfile({ name: '', audioPath }, { env, fetchImpl }), (err) => err.code === 'NAME_REQUIRED');
  await assert.rejects(() => client.createCloneProfile({ name: 'x', audioPath, filename: 'x.wav' }, { env, fetchImpl, maxBytes: 2 }), (err) => err.code === 'FILE_TOO_LARGE');
});

test('transcribe returns the verbose_json shape with normalized segments', async (t) => {
  const filePath = tmpFile(t, 'clip.mp3');
  let form = null;
  const fetchImpl = async (_url, init) => {
    form = init.body;
    return jsonResponse({ text: ' Hola, ¿qué tal? ', language: 'es', duration: 3.2, segments: [{ start: 0, end: 1.5, text: ' Hola, ' }, { start: 1.5, end: 3.2, text: '¿qué tal?' }] });
  };
  const out = await client.transcribe({ filePath, filename: 'clip.mp3', mime: 'audio/mpeg', language: 'Spanish' }, { env, fetchImpl });
  assert.equal(out.text, 'Hola, ¿qué tal?');
  assert.equal(out.language, 'es');
  assert.equal(out.duration, 3.2);
  assert.equal(out.segments.length, 2);
  assert.equal(out.segments[0].text, 'Hola,');
  assert.equal(form.get('language'), 'es');
  assert.equal(form.get('response_format'), 'verbose_json');
  assert.equal(form.get('model'), 'whisper-1');
});

test('readSse parses data lines, ignores comments and stops at the terminal event', async () => {
  const response = sseResponse([': keepalive', { type: 'extract_start' }, 'garbage line', { type: 'ready', job_id: 'j1' }, { type: 'never_read' }]);
  const seen = [];
  const events = await client.readSse(response, { onEvent: (e) => seen.push(e.type), until: (e) => e.type === 'ready' });
  assert.deepEqual(seen, ['extract_start', 'ready']);
  assert.equal(events.length, 2);
});

test('dub flow: upload → waitForDubReady → transcribe → generate → waitForDubDone → download', async (t) => {
  const videoPath = tmpFile(t, 'clip.mp4', 'mp4-bytes');
  const outPath = path.join(path.dirname(videoPath), 'out.mp4');
  const log = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    log.push(`${init.method || 'GET'} ${u.pathname}${u.search}`);
    if (u.pathname === '/dub/upload') return jsonResponse({ job_id: 'job1', task_id: 'prep_job1', filename: 'clip.mp4' }, { status: 202 });
    if (u.pathname === '/tasks/stream/prep_job1') return sseResponse([{ type: 'extract_start' }, { type: 'demucs_done' }, { type: 'ready', job_id: 'job1', duration: 12.5 }]);
    if (u.pathname === '/dub/transcribe/job1') return jsonResponse({ job_id: 'job1', segments: [{ id: 's1', start: 0, end: 2, text: 'Hello', speaker_id: 'speaker_0' }], full_transcript: 'Hello', source_lang: 'en' });
    if (u.pathname === '/dub/generate/job1') return jsonResponse({ task_id: 'dub_job1_1' });
    if (u.pathname === '/tasks/stream/dub_job1_1') return sseResponse([{ type: 'progress', current: 1, total: 1 }, { type: 'done', tracks: ['es'] }]);
    if (u.pathname === '/dub/download/job1') return new Response(Buffer.from('dubbed-mp4'), { status: 200, headers: { 'content-type': 'video/mp4' } });
    return jsonResponse({ detail: `unexpected ${u.pathname}` }, { status: 404 });
  };
  const opts = { env, fetchImpl };
  const upload = await client.dubUpload({ filePath: videoPath, filename: 'clip.mp4', mime: 'video/mp4', sourceLang: 'English' }, opts);
  assert.equal(upload.job_id, 'job1');
  const ready = await client.waitForDubReady(upload.task_id, {}, opts);
  assert.equal(ready.type, 'ready');
  const transcript = await client.dubTranscribe('job1', { numSpeakers: 2 }, opts);
  assert.equal(transcript.segments[0].speaker_id, 'speaker_0');
  assert.equal(transcript.sourceLang, 'en');
  const gen = await client.dubGenerate('job1', { segments: [], language: 'Spanish', language_code: 'es' }, {}, opts);
  assert.equal(gen.taskId, 'dub_job1_1');
  const progress = [];
  const done = await client.waitForDubDone(gen.taskId, { onEvent: (e) => progress.push(e.type) }, opts);
  assert.equal(done.type, 'done');
  assert.deepEqual(progress, ['progress', 'done']);
  const saved = await client.dubDownloadVideo({ jobId: 'job1', outPath, defaultTrack: 'es' }, opts);
  assert.equal(fs.readFileSync(outPath).toString(), 'dubbed-mp4');
  assert.equal(saved.mime, 'video/mp4');
  assert.ok(log.some((l) => l.startsWith('POST /dub/transcribe/job1?num_speakers=2')));
  assert.ok(log.some((l) => l.includes('/dub/download/job1?preserve_bg=true&default_track=es')));
});

test('waitForDubReady surfaces the pipeline error instead of hanging', async () => {
  const fetchImpl = async () => sseResponse([{ type: 'extract_start' }, { type: 'error', reason: 'ffmpeg missing', stage: 'extract' }]);
  await assert.rejects(
    () => client.waitForDubReady('prep_x', {}, { env, fetchImpl }),
    (err) => err.code === 'DUB_PREP_FAILED' && /ffmpeg missing/.test(err.message),
  );
});

test('audiobookRender streams SSE and resolves with the done event; downloadOutput rejects path tricks', async (t) => {
  const events = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/audiobook') {
      const payload = JSON.parse(init.body);
      assert.equal(payload.format, 'm4b');
      assert.equal(payload.language, 'Spanish');
      assert.equal(payload.default_voice, 'p1');
      return sseResponse([{ type: 'started', job_id: 'ab1', chapters: 2 }, { type: 'chapter', index: 0, total: 2 }, { type: 'chapter', index: 1, total: 2 }, { type: 'assembling' }, { type: 'done', output: 'audiobook_ab1.m4b', chapters: 2, duration_s: 61.2 }]);
    }
    if (u.pathname === '/audio/audiobook_ab1.m4b') return new Response(Buffer.from('m4b-bytes'), { status: 200, headers: { 'content-type': 'audio/mp4' } });
    return jsonResponse({ detail: 'nope' }, { status: 404 });
  };
  const done = await client.audiobookRender({ text: '# Cap 1\nHola', defaultVoice: 'p1', language: 'es', format: 'm4b', onEvent: (e) => events.push(e.type) }, { env, fetchImpl });
  assert.equal(done.output, 'audiobook_ab1.m4b');
  assert.deepEqual(events, ['started', 'chapter', 'chapter', 'assembling', 'done']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-ab-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outPath = path.join(dir, 'book.m4b');
  const saved = await client.downloadOutput('audiobook_ab1.m4b', outPath, {}, { env, fetchImpl });
  assert.equal(saved.sizeBytes, 9);
  await assert.rejects(() => client.downloadOutput('../etc/passwd', outPath, {}, { env, fetchImpl }), (err) => err.code === 'BAD_OUTPUT_NAME');
});

test('synthesizeToFile chunks, synthesizes in order and joins with ffmpeg', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-tts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'voz.mp3');
  const inputs = [];
  const fetchImpl = async (_url, init) => {
    inputs.push(JSON.parse(init.body).input);
    return new Response(Buffer.from('RIFF'), { status: 200, headers: { 'content-type': 'audio/wav' } });
  };
  const spawnCalls = [];
  const spawnImpl = (bin, args) => {
    spawnCalls.push({ bin, args });
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      fs.writeFileSync(args[args.length - 1], 'mp3-joined');
      child.emit('close', 0);
    });
    return child;
  };
  const text = `${'Primera frase del capítulo uno. '.repeat(80)}${'Segunda parte. '.repeat(80)}`;
  const out = await client.synthesizeToFile({ text, voice: 'default', language: 'Spanish', outputPath }, { env, fetchImpl, spawnImpl });
  assert.equal(out.audioPath, outputPath);
  assert.equal(out.mime, 'audio/mpeg');
  assert.ok(out.chunks >= 2);
  assert.equal(inputs.length, out.chunks);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].bin, 'ffmpeg');
  assert.ok(spawnCalls[0].args.includes('libmp3lame'));
  assert.equal(fs.readFileSync(outputPath).toString(), 'mp3-joined');
});
