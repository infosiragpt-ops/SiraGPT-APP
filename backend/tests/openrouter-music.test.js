const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate generated files to a temp dir BEFORE requiring the module (audioDir
// is resolved at module load from UPLOAD_DIR).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-or-music-'));
process.env.UPLOAD_DIR = tmpRoot;
process.env.OPENROUTER_API_KEY = 'sk-or-test';

const music = require('../src/services/ai/openrouter-music');

// Build a fake OpenRouter SSE Response whose body is async-iterable, matching
// what generateOpenRouterMusicFile consumes.
function sseResponse(lines, { ok = true, status = 200 } = {}) {
  const enc = new TextEncoder();
  const text = lines.join('\n') + '\n';
  return {
    ok,
    status,
    body: (async function* () {
      const mid = Math.floor(text.length / 2);
      yield enc.encode(text.slice(0, mid));
      yield enc.encode(text.slice(mid));
    })(),
    text: async () => text,
  };
}

function audioEvent(b64) {
  return `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: b64 } } }] })}`;
}

test('generateOpenRouterMusicFile: defaults to Lyria and rebuilds the mp3', async () => {
  const payload = Buffer.from('ID3-lyria-music-bytes');
  const b64 = payload.toString('base64');
  const captured = {};
  const result = await music.generateOpenRouterMusicFile({
    prompt: 'calm lofi piano',
    durationSeconds: 40,
    fetchImpl: async (url, opts) => {
      captured.url = url;
      captured.body = JSON.parse(opts.body);
      captured.auth = opts.headers.Authorization;
      return sseResponse([': OPENROUTER PROCESSING', '', audioEvent(b64.slice(0, 8)), audioEvent(b64.slice(8)), 'data: [DONE]']);
    },
  });
  assert.ok(captured.url.endsWith('/chat/completions'));
  assert.equal(captured.body.model, music.LYRIA_MODEL);
  assert.deepEqual(captured.body.modalities, ['text', 'audio']);
  assert.equal(captured.body.audio.format, 'mp3');
  assert.equal(captured.body.stream, true);
  assert.match(captured.body.messages[0].content, /40 segundos/);
  assert.equal(captured.auth, 'Bearer sk-or-test');
  assert.equal(result.mime, 'audio/mpeg');
  assert.equal(result.modelLabel, 'Lyria 3 Pro');
  assert.equal(result.modelKey, 'lyria');
  assert.ok(result.audioUrl.startsWith('/api/elevenlabs/audio/'));
  assert.equal(result.durationSeconds, 40);
  assert.ok(result.sizeBytes > 0);
  assert.equal(fs.readFileSync(result.audioPath).toString(), 'ID3-lyria-music-bytes');
});

test('generateOpenRouterMusicFile: passes explicit slugs through untouched', async () => {
  const b64 = Buffer.from('ID3-custom').toString('base64');
  const captured = {};
  const result = await music.generateOpenRouterMusicFile({
    prompt: 'x',
    model: 'my-vendor/my-music-model',
    fetchImpl: async (_url, opts) => {
      captured.body = JSON.parse(opts.body);
      return sseResponse([audioEvent(b64)]);
    },
  });
  assert.equal(captured.body.model, 'my-vendor/my-music-model');
  assert.equal(result.modelLabel, 'my-vendor/my-music-model');
  assert.equal(result.modelKey, 'custom');
});

test('generateOpenRouterMusicFile: clamps duration into [5,300]', async () => {
  const b64 = Buffer.from('ID3-x').toString('base64');
  const bodies = [];
  const fake = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return sseResponse([audioEvent(b64)]);
  };
  const hi = await music.generateOpenRouterMusicFile({ prompt: 'x', durationSeconds: 5000, fetchImpl: fake });
  assert.equal(hi.durationSeconds, 300);
  const lo = await music.generateOpenRouterMusicFile({ prompt: 'x', durationSeconds: 1, fetchImpl: fake });
  assert.equal(lo.durationSeconds, 5);
  assert.match(bodies[0].messages[0].content, /300 segundos/);
  assert.match(bodies[1].messages[0].content, /5 segundos/);
});

test('generateOpenRouterMusicFile: maps 404 to MODEL_NOT_FOUND and 402 to credits', async () => {
  await assert.rejects(
    () => music.generateOpenRouterMusicFile({ prompt: 'x', fetchImpl: async () => sseResponse([], { ok: false, status: 404 }) }),
    (err) => err.code === 'MODEL_NOT_FOUND'
  );
  await assert.rejects(
    () => music.generateOpenRouterMusicFile({ prompt: 'x', fetchImpl: async () => sseResponse([], { ok: false, status: 402 }) }),
    (err) => err.code === 'INSUFFICIENT_CREDITS'
  );
});

test('generateOpenRouterMusicFile: rejects empty prompt and missing key', async () => {
  await assert.rejects(
    () => music.generateOpenRouterMusicFile({ prompt: '   ', fetchImpl: async () => sseResponse([]) }),
    (err) => err.code === 'PROMPT_REQUIRED'
  );
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    assert.equal(music.isOpenRouterMusicConfigured(), false);
    await assert.rejects(
      () => music.generateOpenRouterMusicFile({ prompt: 'x', fetchImpl: async () => sseResponse([]) }),
      (err) => err.code === 'OPENROUTER_NOT_CONFIGURED'
    );
  } finally {
    process.env.OPENROUTER_API_KEY = saved;
  }
});

test('generateOpenRouterMusicFile: aborts the stream when the user cancels', async () => {
  const controller = new AbortController();
  let started;
  const providerStarted = new Promise((resolve) => { started = resolve; });
  const run = music.generateOpenRouterMusicFile({
    prompt: 'pista cancelable',
    signal: controller.signal,
    fetchImpl: async (_url, opts) => {
      started(opts.signal);
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      });
    },
  });
  const providerSignal = await providerStarted;
  controller.abort();
  await assert.rejects(run, (err) => err?.name === 'AbortError');
  assert.equal(providerSignal.aborted, true);
});

test('classifyOpenRouterError: mapping covers music failures', () => {
  assert.equal(music.classifyOpenRouterError(402, ''), 'INSUFFICIENT_CREDITS');
  assert.equal(music.classifyOpenRouterError(200, 'quota exceeded'), 'INSUFFICIENT_CREDITS');
  assert.equal(music.classifyOpenRouterError(429, ''), 'RATE_LIMITED');
  assert.equal(music.classifyOpenRouterError(404, ''), 'MODEL_NOT_FOUND');
  assert.equal(music.classifyOpenRouterError(400, ''), 'INVALID_PARAMS');
  assert.equal(music.classifyOpenRouterError(500, ''), 'API_ERROR');
});

test('clampSeconds bounds the value', () => {
  assert.equal(music.clampSeconds(30), 30);
  assert.equal(music.clampSeconds(5000), 300);
  assert.equal(music.clampSeconds(1), 5);
  assert.equal(music.clampSeconds('nope', 30), 30);
});

test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});
