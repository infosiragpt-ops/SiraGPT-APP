const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-lyria-'));
process.env.UPLOAD_DIR = tmpRoot;
process.env.OPENROUTER_API_KEY = 'sk-or-test';

const lyria = require('../src/services/ai/lyria-music');

// Build a fake OpenRouter SSE Response whose body is async-iterable, matching
// what generateLyriaMusicFile consumes (`for await (const chunk of resp.body)`).
function sseResponse(lines, { ok = true, status = 200 } = {}) {
  const enc = new TextEncoder();
  const text = lines.join('\n') + '\n';
  return {
    ok,
    status,
    body: (async function* () {
      // Emit in two slices to exercise the partial-line buffering.
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

test('generateLyriaMusicFile: reconstructs the MP3 from streamed audio deltas', async () => {
  const payload = Buffer.from('ID3-lyria-music-bytes');
  const b64 = payload.toString('base64');
  // Split the base64 across two SSE events — the helper concatenates before decoding.
  const a = b64.slice(0, 8);
  const b = b64.slice(8);
  const captured = {};
  const result = await lyria.generateLyriaMusicFile({
    prompt: 'calm lofi piano',
    durationSeconds: 40,
    fetchImpl: async (url, opts) => {
      captured.url = url;
      captured.body = JSON.parse(opts.body);
      captured.auth = opts.headers.Authorization;
      return sseResponse([': OPENROUTER PROCESSING', '', audioEvent(a), audioEvent(b), 'data: [DONE]']);
    },
  });
  assert.ok(captured.url.endsWith('/chat/completions'));
  assert.equal(captured.body.model, lyria.LYRIA_MODEL);
  assert.deepEqual(captured.body.modalities, ['text', 'audio']);
  assert.equal(captured.body.audio.format, 'mp3');
  assert.equal(captured.body.stream, true);
  assert.match(captured.body.messages[0].content, /40 segundos/);
  assert.equal(captured.auth, 'Bearer sk-or-test');
  assert.equal(result.mime, 'audio/mpeg');
  assert.ok(result.audioUrl.startsWith('/api/elevenlabs/audio/'));
  assert.equal(result.durationSeconds, 40);
  assert.ok(result.sizeBytes > 0);
  assert.equal(fs.readFileSync(result.audioPath).toString(), 'ID3-lyria-music-bytes');
});

test('generateLyriaMusicFile: maps an HTTP 402 to INSUFFICIENT_CREDITS', async () => {
  await assert.rejects(
    () => lyria.generateLyriaMusicFile({
      prompt: 'x',
      fetchImpl: async () => sseResponse([], { ok: false, status: 402 }),
    }),
    (err) => err.code === 'INSUFFICIENT_CREDITS'
  );
});

test('generateLyriaMusicFile: surfaces a mid-stream error with no audio', async () => {
  await assert.rejects(
    () => lyria.generateLyriaMusicFile({
      prompt: 'x',
      fetchImpl: async () => sseResponse([`data: ${JSON.stringify({ error: { code: 429, message: 'rate limited' } })}`]),
    }),
    (err) => err.code === 'RATE_LIMITED'
  );
});

test('generateLyriaMusicFile: aborts the OpenRouter stream when the user cancels', async () => {
  const controller = new AbortController();
  let started;
  const providerStarted = new Promise((resolve) => { started = resolve; });
  const run = lyria.generateLyriaMusicFile({
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

test('generateLyriaMusicFile: rejects empty prompt', async () => {
  await assert.rejects(
    () => lyria.generateLyriaMusicFile({ prompt: '  ', fetchImpl: async () => sseResponse([]) }),
    (err) => err.code === 'PROMPT_REQUIRED'
  );
});

test('generateLyriaMusicFile: rejects when OpenRouter key is missing', async () => {
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    assert.equal(lyria.isLyriaConfigured(), false);
    await assert.rejects(
      () => lyria.generateLyriaMusicFile({ prompt: 'x', fetchImpl: async () => sseResponse([]) }),
      (err) => err.code === 'OPENROUTER_NOT_CONFIGURED'
    );
  } finally {
    process.env.OPENROUTER_API_KEY = saved;
  }
});

test('classifyOpenRouterError: quota and rate-limit mapping', () => {
  assert.equal(lyria.classifyOpenRouterError(402, ''), 'INSUFFICIENT_CREDITS');
  assert.equal(lyria.classifyOpenRouterError(200, 'quota exceeded'), 'INSUFFICIENT_CREDITS');
  assert.equal(lyria.classifyOpenRouterError(429, ''), 'RATE_LIMITED');
  assert.equal(lyria.classifyOpenRouterError(400, ''), 'INVALID_PARAMS');
  assert.equal(lyria.classifyOpenRouterError(500, ''), 'API_ERROR');
});

test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});
