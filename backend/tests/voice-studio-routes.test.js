'use strict';

const { after, before, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const { buildRouteTestApp, mockResolvedModule, reloadModule } = require('./http-test-utils');

describe('/api/voice-studio (Sira Voz)', () => {
  let tmpDir;
  let oldUploadDir;
  let oldUrl;
  let restoreDatabase;
  let restoreAuth;
  let restoreClient;
  let restoreJobs;
  let app;
  const voiceRows = [];
  const jobs = [];
  const created = [];
  const deleted = [];
  const enqueued = [];
  const user = { id: 'user-voz', plan: 'FREE' };

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-voice-studio-'));
    oldUploadDir = process.env.UPLOAD_DIR;
    oldUrl = process.env.VOICESTUDIO_URL;
    process.env.UPLOAD_DIR = tmpDir;
    process.env.VOICESTUDIO_URL = 'http://voicestudio.test:3900';

    restoreAuth = mockResolvedModule(require.resolve('../src/middleware/auth'), {
      authenticateToken: (req, _res, next) => { req.user = user; next(); },
    });
    restoreDatabase = mockResolvedModule(require.resolve('../src/config/database'), {
      voiceProfile: {
        async count({ where }) { return voiceRows.filter((r) => r.userId === where.userId && !r.deletedAt).length; },
        async findMany({ where }) { return voiceRows.filter((r) => r.userId === where.userId && !r.deletedAt); },
        async findFirst({ where }) { return voiceRows.find((r) => r.id === where.id && r.userId === where.userId && !r.deletedAt) || null; },
        async create({ data }) { const row = { id: `vp${voiceRows.length + 1}`, createdAt: new Date(), deletedAt: null, ...data }; voiceRows.push(row); return row; },
        async update({ where, data }) { const row = voiceRows.find((r) => r.id === where.id); Object.assign(row, data); return row; },
      },
      chat: { async findFirst({ where }) { return where.id === 'chat-1' && where.userId === user.id ? { id: 'chat-1' } : null; } },
      message: { async create({ data }) { jobs.push({ message: data }); return { id: 'm1' }; } },
      file: { async findFirst() { return null; } },
      voiceStudioJob: {},
    });
    restoreClient = mockResolvedModule(require.resolve('../src/services/ai/voicestudio-client'), {
      VoiceStudioError: class VoiceStudioError extends Error { constructor(m, o = {}) { super(m); this.status = o.status || 0; this.code = o.code || 'X'; } },
      isConfigured: () => Boolean(process.env.VOICESTUDIO_URL),
      isSiraVozModel: (v) => /sira[-_\s]?voz|voicestudio/i.test(String(v || '')),
      languageCode: (v) => ({ spanish: 'es', english: 'en', es: 'es', en: 'en' }[String(v || '').toLowerCase()] || null),
      languageName: (v) => ({ es: 'Spanish', en: 'English', spanish: 'Spanish', english: 'English' }[String(v || '').toLowerCase()] || 'Auto'),
      async health() { return { ok: true, configured: true, status: 'ok', device: 'cpu', version: '0.5.1' }; },
      async createCloneProfile(args) { created.push(args); return { id: `prov-${created.length}`, name: args.name, kind: 'clone' }; },
      async deleteProfile(id) { deleted.push(id); return {}; },
      async fetchProfileAudio() {
        const { Readable } = require('stream');
        const body = Readable.from([Buffer.from('RIFFwav')]);
        return { headers: { get: () => 'audio/wav' }, body, releaseTimeout() {} };
      },
      async synthesizeSpeech({ text }) { return { buffer: Buffer.from(`wav:${text}`), mime: 'audio/wav', ext: 'wav' }; },
      async transcribe({ filename }) { return { text: `transcripción de ${filename}`, language: 'es', duration: 2, segments: [{ start: 0, end: 2, text: 'hola' }] }; },
    });
    restoreJobs = mockResolvedModule(require.resolve('../src/services/voice-studio/jobs'), {
      getJobQueue: () => ({
        async activeCount() { return enqueued.filter((j) => j.status === 'queued').length; },
        async enqueue(spec) { const job = { id: `job${enqueued.length + 1}`, status: 'queued', kind: spec.kind, title: spec.title, chatId: spec.chatId, input: spec.input, _runner: spec.runner }; enqueued.push(job); return { id: job.id, status: 'queued', kind: job.kind, title: job.title, chatId: job.chatId, input: job.input }; },
        async list() { return enqueued.map((j) => ({ id: j.id, status: j.status, kind: j.kind })); },
        async get(_userId, id) { const j = enqueued.find((x) => x.id === id); return j ? { id: j.id, status: j.status, kind: j.kind } : null; },
        async getRow(_userId, id) {
          if (id === 'done-1') return { id, status: 'done', result: { kind: 'dub', filename: 'd.mp4', mime: 'video/mp4', __private: { outputPath: path.join(tmpDir, 'd.mp4'), srtPath: path.join(tmpDir, 'd.srt') } } };
          const j = enqueued.find((x) => x.id === id); return j || null;
        },
        async cancel(_userId, id) { const j = enqueued.find((x) => x.id === id); if (!j) return null; j.status = 'cancelled'; return { id: j.id, status: 'cancelled', kind: j.kind }; },
      }),
    });
    fs.writeFileSync(path.join(tmpDir, 'd.mp4'), 'dubbed');
    fs.writeFileSync(path.join(tmpDir, 'd.srt'), '1\n00:00:00,000 --> 00:00:01,000\nHola\n');
    app = buildRouteTestApp('/api/voice-studio', reloadModule('../src/routes/voice-studio'));
  });

  after(() => {
    restoreJobs();
    restoreClient();
    restoreDatabase();
    restoreAuth();
    if (oldUploadDir === undefined) delete process.env.UPLOAD_DIR; else process.env.UPLOAD_DIR = oldUploadDir;
    if (oldUrl === undefined) delete process.env.VOICESTUDIO_URL; else process.env.VOICESTUDIO_URL = oldUrl;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('GET /status reports configured + healthy + free features', async () => {
    const res = await request(app).get('/api/voice-studio/status');
    assert.equal(res.status, 200);
    assert.equal(res.body.configured, true);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.device, 'cpu');
    assert.equal(res.body.features.free, true);
    assert.equal(res.body.limits.maxActiveJobs, 1);
  });

  test('POST /voices/clone stores a per-user profile and DELETE removes it upstream too', async () => {
    const res = await request(app)
      .post('/api/voice-studio/voices/clone')
      .field('name', 'Mi voz')
      .field('language', 'Spanish')
      .attach('audio', Buffer.from('RIFFwavdata'), { filename: 'muestra.wav', contentType: 'audio/wav' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.voice.name, 'Mi voz');
    assert.equal(res.body.voice.language, 'Spanish');
    assert.match(res.body.voice.previewUrl, /\/api\/voice-studio\/voices\/vp1\/preview$/);
    assert.equal(created.length, 1);
    assert.match(created[0].name, /^Mi voz · user-voz/);
    assert.ok(!fs.existsSync(created[0].audioPath), 'temp sample is deleted after the upload');

    const list = await request(app).get('/api/voice-studio/voices');
    assert.equal(list.body.voices.length, 1);

    const preview = await request(app).get('/api/voice-studio/voices/vp1/preview');
    assert.equal(preview.status, 200);
    assert.match(preview.headers['content-type'], /audio\/wav/);

    const del = await request(app).delete('/api/voice-studio/voices/vp1');
    assert.equal(del.status, 200);
    assert.deepEqual(deleted, ['prov-1']);
    assert.equal((await request(app).get('/api/voice-studio/voices')).body.voices.length, 0);
    assert.equal((await request(app).get('/api/voice-studio/voices/vp1/preview')).status, 404);
  });

  test('POST /voices/clone validates name and audio', async () => {
    const noName = await request(app).post('/api/voice-studio/voices/clone').attach('audio', Buffer.from('x'), { filename: 'a.wav', contentType: 'audio/wav' });
    assert.equal(noName.status, 400);
    assert.equal(noName.body.code, 'name_required');
    const noAudio = await request(app).post('/api/voice-studio/voices/clone').field('name', 'x');
    assert.equal(noAudio.status, 400);
    assert.equal(noAudio.body.code, 'audio_required');
    const badType = await request(app).post('/api/voice-studio/voices/clone').field('name', 'x').attach('audio', Buffer.from('x'), { filename: 'a.exe', contentType: 'application/octet-stream' });
    assert.equal(badType.status, 400);
  });

  test('POST /speech/preview streams wav and rejects long text', async () => {
    const ok = await request(app).post('/api/voice-studio/speech/preview').send({ text: 'Hola Sira', language: 'Spanish' }).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    assert.equal(ok.status, 200);
    assert.match(ok.headers['content-type'], /audio\/wav/);
    assert.equal(ok.body.toString(), 'wav:Hola Sira');
    const long = await request(app).post('/api/voice-studio/speech/preview').send({ text: 'a'.repeat(700) });
    assert.equal(long.status, 400);
    const unknownVoice = await request(app).post('/api/voice-studio/speech/preview').send({ text: 'hola', voiceId: 'nope' });
    assert.equal(unknownVoice.status, 404);
  });

  test('POST /transcriptions returns text + segments + srt for an uploaded clip', async () => {
    const res = await request(app)
      .post('/api/voice-studio/transcriptions')
      .field('language', 'Spanish')
      .attach('media', Buffer.from('mp3'), { filename: 'nota.mp3', contentType: 'audio/mpeg' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.text, 'transcripción de nota.mp3');
    assert.equal(res.body.language, 'es');
    assert.match(res.body.srt, /00:00:00,000 --> 00:00:02,000/);
    const none = await request(app).post('/api/voice-studio/transcriptions').send({});
    assert.equal(none.status, 400);
    assert.equal(none.body.code, 'media_required');
    const missing = await request(app).post('/api/voice-studio/transcriptions').send({ fileId: 'ghost' });
    assert.equal(missing.status, 404);
  });

  test('POST /jobs/dub enqueues a job, persists the user turn and enforces the per-user limit', async () => {
    const res = await request(app)
      .post('/api/voice-studio/jobs/dub')
      .field('targetLanguage', 'Spanish')
      .field('chatId', 'chat-1')
      .attach('media', Buffer.from('mp4'), { filename: 'clip.mp4', contentType: 'video/mp4' });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.job.kind, 'dub');
    assert.equal(res.body.job.chatId, 'chat-1');
    assert.equal(res.body.job.input.targetLanguage, 'Spanish');
    assert.equal(res.body.job.input.inputType, 'video');
    assert.equal(res.body.job.input.sourcePath, undefined);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].message.role, 'USER');
    assert.match(jobs[0].message.content, /Dobla «clip\.mp4» al español/);

    const busy = await request(app).post('/api/voice-studio/jobs/dub').field('targetLanguage', 'Spanish').attach('media', Buffer.from('mp4'), { filename: 'b.mp4', contentType: 'video/mp4' });
    assert.equal(busy.status, 429);
    assert.equal(busy.body.code, 'job_limit');
    enqueued[0].status = 'done';

    const noLang = await request(app).post('/api/voice-studio/jobs/dub').attach('media', Buffer.from('mp4'), { filename: 'b.mp4', contentType: 'video/mp4' });
    assert.equal(noLang.status, 400);
    assert.equal(noLang.body.code, 'target_language_required');
  });

  test('POST /jobs/audiobook accepts pasted text and rejects empty requests', async () => {
    const res = await request(app).post('/api/voice-studio/jobs/audiobook').send({ text: '# Capítulo 1\nHabía una vez…', title: 'Cuento', author: 'Luis', format: 'mp3', chatId: 'chat-1' });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.job.kind, 'audiobook');
    assert.equal(res.body.job.input.format, 'mp3');
    assert.equal(res.body.job.input.title, 'Cuento');
    assert.match(jobs[jobs.length - 1].message.content, /audiolibro «Cuento» de Luis/);
    enqueued[enqueued.length - 1].status = 'done';
    const empty = await request(app).post('/api/voice-studio/jobs/audiobook').send({});
    assert.equal(empty.status, 400);
    assert.equal(empty.body.code, 'text_required');
  });

  test('GET /jobs, /jobs/:id, cancel, download and subtitles', async () => {
    const list = await request(app).get('/api/voice-studio/jobs');
    assert.equal(list.status, 200);
    assert.ok(list.body.jobs.length >= 2);
    const one = await request(app).get(`/api/voice-studio/jobs/${enqueued[0].id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.job.id, enqueued[0].id);
    assert.equal((await request(app).get('/api/voice-studio/jobs/nope')).status, 404);
    const cancel = await request(app).post(`/api/voice-studio/jobs/${enqueued[1].id}/cancel`);
    assert.equal(cancel.body.job.status, 'cancelled');

    const notReady = await request(app).get(`/api/voice-studio/jobs/${enqueued[0].id}/download`);
    assert.equal(notReady.status, 409);
    const download = await request(app).get('/api/voice-studio/jobs/done-1/download').buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    assert.equal(download.status, 200);
    assert.match(download.headers['content-type'], /video\/mp4/);
    assert.match(download.headers['content-disposition'], /attachment/);
    assert.equal(download.body.toString(), 'dubbed');
    const srt = await request(app).get('/api/voice-studio/jobs/done-1/subtitles');
    assert.equal(srt.status, 200);
    assert.match(srt.text, /Hola/);
  });

  test('every endpoint answers 503 with a typed code when VoiceStudio is not configured', async () => {
    delete process.env.VOICESTUDIO_URL;
    try {
      const res = await request(app).post('/api/voice-studio/speech/preview').send({ text: 'hola' });
      assert.equal(res.status, 503);
      assert.equal(res.body.code, 'VOICESTUDIO_NOT_CONFIGURED');
      const status = await request(app).get('/api/voice-studio/status');
      assert.equal(status.body.configured, false);
    } finally {
      process.env.VOICESTUDIO_URL = 'http://voicestudio.test:3900';
    }
  });
});
