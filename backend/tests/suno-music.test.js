const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate generated files to a temp dir BEFORE requiring the module (audioDir
// is resolved at module load from UPLOAD_DIR). Shorten the poll loop so the
// suite stays fast (SUNO_POLL_MS is read at module load).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-suno-'));
process.env.UPLOAD_DIR = tmpRoot;
process.env.SUNO_API_KEY = 'test-suno-key';
process.env.SUNO_POLL_MS = '5';

const suno = require('../src/services/ai/suno-music');

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    arrayBuffer: async () => Buffer.from('not-audio'),
  };
}

test('generateSunoMusicFile: submits customMode and polls until SUCCESS', async () => {
  const calls = [];
  const result = await suno.generateSunoMusicFile({
    prompt: 'epic synthwave anthem',
    style: 'Electronic',
    mood: 'Energetic',
    influence: 0.8,
    fetchImpl: async (url, opts) => {
      calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers && opts.headers.Authorization });
      if (String(url).includes('/api/v1/generate') && !String(url).includes('record-info')) {
        return jsonResponse({ code: 200, msg: 'success', data: { taskId: 'task-123' } });
      }
      if (String(url).includes('record-info')) {
        if (calls.filter((c) => String(c.url).includes('record-info')).length === 1) {
          return jsonResponse({ code: 200, data: { status: 'PENDING', response: {} } });
        }
        return jsonResponse({
          code: 200,
          data: {
            status: 'SUCCESS',
            response: { sunoData: [{ id: 't1', audioUrl: 'https://cdn.test/song.mp3', duration: 190 }] },
          },
        });
      }
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('ID3-suno-bytes') };
    },
  });
  const submit = calls[0];
  assert.ok(submit.url.endsWith('/api/v1/generate'));
  assert.equal(submit.auth, 'Bearer test-suno-key');
  assert.equal(submit.body.customMode, true);
  assert.equal(submit.body.model, suno.SUNO_V4_MODEL);
  assert.match(submit.body.prompt, /epic synthwave anthem/);
  assert.match(submit.body.style, /Electronic/);
  assert.match(submit.body.style, /Energetic/);
  assert.equal(submit.body.styleWeight, 0.8);
  assert.equal(submit.body.instrumental, false);
  assert.ok(submit.body.title.length > 0);
  assert.equal(result.mime, 'audio/mpeg');
  assert.equal(result.modelLabel, 'Suno V4');
  assert.equal(result.modelKey, 'sunoV4');
  assert.equal(result.taskId, 'task-123');
  assert.ok(result.audioUrl.startsWith('/api/elevenlabs/audio/'));
  assert.equal(fs.readFileSync(result.audioPath).toString(), 'ID3-suno-bytes');
});

test('generateSunoMusicFile: maps V3.5 model id and detects instrumentals', async () => {
  let submitted = null;
  await suno.generateSunoMusicFile({
    prompt: 'música instrumental relajante para estudiar',
    model: suno.SUNO_V35_MODEL,
    fetchImpl: async (url, opts) => {
      if (!String(url).includes('record-info') && !String(url).startsWith('https://cdn')) {
        submitted = JSON.parse(opts.body);
        return jsonResponse({ code: 200, data: { taskId: 't' } });
      }
      if (String(url).includes('record-info')) {
        return jsonResponse({ code: 200, data: { status: 'SUCCESS', response: { sunoData: [{ audioUrl: 'https://cdn.test/x.mp3' }] } } });
      }
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('ID3') };
    },
  });
  assert.equal(submitted.model, suno.SUNO_V35_MODEL);
  assert.equal(submitted.instrumental, true);
});

test('generateSunoMusicFile: surfaces gateway rejections and task failures', async () => {
  await assert.rejects(
    () => suno.generateSunoMusicFile({
      prompt: 'x',
      fetchImpl: async () => jsonResponse({ code: 400, msg: 'bad model' }, { ok: true }),
    }),
    (err) => err.code === 'INVALID_PARAMS'
  );
  await assert.rejects(
    () => suno.generateSunoMusicFile({
      prompt: 'x',
      fetchImpl: async (url) => {
        if (String(url).includes('record-info')) {
          return jsonResponse({ code: 200, data: { status: 'SENSITIVE_WORD_ERROR', errorMessage: 'bad words' } });
        }
        return jsonResponse({ code: 200, data: { taskId: 't' } });
      },
    }),
    (err) => err.code === 'INVALID_PARAMS' && /sensible/i.test(err.message)
  );
  await assert.rejects(
    () => suno.generateSunoMusicFile({
      prompt: 'x',
      fetchImpl: async (url) => {
        if (String(url).includes('record-info')) {
          return jsonResponse({ code: 200, data: { status: 'GENERATE_AUDIO_FAILED', errorMessage: 'gpu busy' } });
        }
        return jsonResponse({ code: 200, data: { taskId: 't' } });
      },
    }),
    (err) => err.code === 'API_ERROR'
  );
});

test('generateSunoMusicFile: rejects empty prompt and missing key', async () => {
  await assert.rejects(
    () => suno.generateSunoMusicFile({ prompt: '   ', fetchImpl: async () => jsonResponse({}) }),
    (err) => err.code === 'PROMPT_REQUIRED'
  );
  const saved = process.env.SUNO_API_KEY;
  delete process.env.SUNO_API_KEY;
  try {
    assert.equal(suno.isSunoConfigured(), false);
    await assert.rejects(
      () => suno.generateSunoMusicFile({ prompt: 'x', fetchImpl: async () => jsonResponse({}) }),
      (err) => err.code === 'SUNO_NOT_CONFIGURED'
    );
  } finally {
    process.env.SUNO_API_KEY = saved;
  }
});

test('detectInstrumental: heuristic covers ES/EN cues', () => {
  assert.equal(suno.detectInstrumental('música instrumental relajante'), true);
  assert.equal(suno.detectInstrumental('lofi beats to study'), true);
  assert.equal(suno.detectInstrumental('canción pop con letra de amor'), false);
  assert.equal(suno.detectInstrumental('epic song with vocals'), false);
});

test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});
