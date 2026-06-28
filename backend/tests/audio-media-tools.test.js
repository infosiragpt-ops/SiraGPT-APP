/**
 * Tests for services/agents/audio-media-tools.js — the agentic tools that
 * generate AUDIO (text-to-speech) and MUSIC (song) via ElevenLabs and save
 * the result as a chat artifact.
 *
 * Network is never hit: the ElevenLabs SDK client and global fetch are
 * replaced through the module's test seams. A temp AGENT_ARTIFACT_DIR is
 * set BEFORE requiring the module so saveArtifact writes into a sandbox.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.AGENT_ARTIFACT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-audio-'));

const test = require('node:test');
const assert = require('node:assert/strict');

const audio = require('../src/services/agents/audio-media-tools');
const { generateSpeech, generateMusic, AUDIO_MEDIA_TOOLS, _internal } = audio;

function collectorCtx(extra = {}) {
  const events = [];
  return { ctx: { userId: 'u1', chatId: 'c1', onEvent: (e) => events.push(e), ...extra }, events };
}

function asyncChunks(buffers) {
  return (async function* gen() {
    for (const b of buffers) yield b;
  })();
}

test('exports two tools with the react-agent tool shape', () => {
  assert.equal(AUDIO_MEDIA_TOOLS.length, 2);
  for (const tool of AUDIO_MEDIA_TOOLS) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.description, 'string');
    assert.equal(typeof tool.parameters, 'object');
    assert.equal(typeof tool.execute, 'function');
  }
  assert.deepEqual(AUDIO_MEDIA_TOOLS.map((t) => t.name), ['generate_speech', 'generate_music']);
});

test('generate_speech without a TTS provider returns a graceful error', async () => {
  _internal.resetTestSeams();
  const prevEleven = process.env.ELEVENLABS_API_KEY;
  const prevOpenai = process.env.OPENAI_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const r = await generateSpeech.execute({ text: 'hola mundo' }, {});
    assert.equal(r.ok, false);
    assert.match(r.error, /ELEVENLABS_API_KEY|OPENAI_API_KEY|no está disponible/i);
  } finally {
    if (prevEleven !== undefined) process.env.ELEVENLABS_API_KEY = prevEleven;
    if (prevOpenai !== undefined) process.env.OPENAI_API_KEY = prevOpenai;
    _internal.resetTestSeams();
  }
});

test('generate_speech with empty text is rejected', async () => {
  const r = await generateSpeech.execute({ text: '   ' }, {});
  assert.equal(r.ok, false);
});

test('generate_speech saves an mp3 artifact and emits file_artifact', async () => {
  _internal.setElevenLabsClientFactory(() => ({
    textToSpeech: {
      convert: async (voiceId, opts) => {
        assert.ok(voiceId, 'a voice id must be passed');
        assert.equal(typeof opts.text, 'string');
        return asyncChunks([Buffer.from('AUDIO_'), Buffer.from('BYTES')]);
      },
    },
  }));
  try {
    const { ctx, events } = collectorCtx();
    const r = await generateSpeech.execute({ text: 'Hola, esto es una prueba de voz.' }, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.mime, 'audio/mpeg');
    assert.equal(r.kind, 'speech');
    assert.match(r.downloadUrl, /^\/api\/agent\/artifact\//);
    assert.ok(r.sizeBytes > 0);
    const artifactEvt = events.find((e) => e.type === 'file_artifact');
    assert.ok(artifactEvt, 'should emit a file_artifact event');
    assert.equal(artifactEvt.artifact.format, 'mp3');
    assert.equal(artifactEvt.artifact.mime, 'audio/mpeg');
  } finally {
    _internal.resetTestSeams();
  }
});

test('generate_speech honours a custom voiceId', async () => {
  let usedVoice = null;
  _internal.setElevenLabsClientFactory(() => ({
    textToSpeech: { convert: async (voiceId) => { usedVoice = voiceId; return asyncChunks([Buffer.from('x')]); } },
  }));
  try {
    await generateSpeech.execute({ text: 'hola', voiceId: 'voice-custom-123' }, collectorCtx().ctx);
    assert.equal(usedVoice, 'voice-custom-123');
  } finally {
    _internal.resetTestSeams();
  }
});

test('generate_speech falls back to OpenAI TTS when ElevenLabs fails', async () => {
  const prevEleven = process.env.ELEVENLABS_API_KEY;
  const prevOpenai = process.env.OPENAI_API_KEY;
  process.env.ELEVENLABS_API_KEY = 'test-eleven-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  let captured = null;
  _internal.setElevenLabsClientFactory(() => ({
    textToSpeech: {
      convert: async () => {
        throw new Error('Unauthorized: 401');
      },
    },
  }));
  _internal.setFetchImpl(async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body), headers: opts.headers };
    const data = new TextEncoder().encode('OPENAI_MP3');
    return { ok: true, status: 200, arrayBuffer: async () => data.buffer.slice(0) };
  });
  try {
    const { ctx, events } = collectorCtx();
    const r = await generateSpeech.execute({ text: 'Hola con fallback.' }, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.provider, 'openai');
    assert.equal(r.mime, 'audio/mpeg');
    assert.match(captured.url, /\/audio\/speech$/);
    assert.equal(captured.body.input, 'Hola con fallback.');
    assert.equal(captured.headers.authorization, 'Bearer test-openai-key');
    assert.ok(events.some((e) => e.type === 'tool_output' && /OpenAI TTS/i.test(e.preview || '')));
    assert.ok(events.some((e) => e.type === 'file_artifact'));
  } finally {
    if (prevEleven !== undefined) process.env.ELEVENLABS_API_KEY = prevEleven; else delete process.env.ELEVENLABS_API_KEY;
    if (prevOpenai !== undefined) process.env.OPENAI_API_KEY = prevOpenai; else delete process.env.OPENAI_API_KEY;
    _internal.resetTestSeams();
  }
});

test('generate_music without ELEVENLABS_API_KEY returns a graceful error', async () => {
  _internal.resetTestSeams();
  const prev = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  try {
    const r = await generateMusic.execute({ prompt: 'una canción alegre' }, {});
    assert.equal(r.ok, false);
    assert.match(r.error, /ELEVENLABS_API_KEY|no está disponible/i);
  } finally {
    if (prev !== undefined) process.env.ELEVENLABS_API_KEY = prev;
    _internal.resetTestSeams();
  }
});

test('generate_music posts the right body and saves an mp3 artifact', async () => {
  const prev = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = 'test-key';
  let captured = null;
  _internal.setFetchImpl(async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body), headers: opts.headers };
    const data = new TextEncoder().encode('MP3DATA');
    return { ok: true, status: 200, arrayBuffer: async () => data.buffer.slice(0) };
  });
  try {
    const { ctx, events } = collectorCtx();
    const r = await generateMusic.execute({ prompt: 'una balada de piano', durationSeconds: 180, genre: 'lofi' }, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'music');
    assert.equal(r.durationSeconds, 180);
    assert.match(r.downloadUrl, /^\/api\/agent\/artifact\//);
    assert.match(captured.url, /\/music$/);
    assert.equal(captured.body.music_length_ms, 180000);
    assert.equal(captured.headers['xi-api-key'], 'test-key');
    assert.match(captured.body.prompt, /lofi/i);
    assert.ok(events.some((e) => e.type === 'file_artifact'));
  } finally {
    if (prev !== undefined) process.env.ELEVENLABS_API_KEY = prev; else delete process.env.ELEVENLABS_API_KEY;
    _internal.resetTestSeams();
  }
});

test('generate_music clamps an out-of-range duration', async () => {
  const prev = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = 'test-key';
  let captured = null;
  _internal.setFetchImpl(async (url, opts) => {
    captured = JSON.parse(opts.body);
    const data = new TextEncoder().encode('X');
    return { ok: true, status: 200, arrayBuffer: async () => data.buffer.slice(0) };
  });
  try {
    const r = await generateMusic.execute({ prompt: 'epic', durationSeconds: 100000 }, collectorCtx().ctx);
    assert.equal(r.durationSeconds, _internal.MUSIC_MAX_SECONDS);
    assert.equal(captured.music_length_ms, _internal.MUSIC_MAX_SECONDS * 1000);
  } finally {
    if (prev !== undefined) process.env.ELEVENLABS_API_KEY = prev; else delete process.env.ELEVENLABS_API_KEY;
    _internal.resetTestSeams();
  }
});

test('generate_music surfaces a 402 (insufficient credits) error', async () => {
  const prev = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = 'test-key';
  _internal.setFetchImpl(async () => ({ ok: false, status: 402, text: async () => 'no credits' }));
  try {
    const r = await generateMusic.execute({ prompt: 'jazz' }, collectorCtx().ctx);
    assert.equal(r.ok, false);
    assert.equal(r.status, 402);
    assert.match(r.error, /créditos|insuficientes/i);
  } finally {
    if (prev !== undefined) process.env.ELEVENLABS_API_KEY = prev; else delete process.env.ELEVENLABS_API_KEY;
    _internal.resetTestSeams();
  }
});

test('clampInt clamps and falls back', () => {
  const { clampInt } = _internal;
  assert.equal(clampInt(5, 30, 1, 10), 5);
  assert.equal(clampInt(999, 30, 1, 10), 10);
  assert.equal(clampInt(-5, 30, 1, 10), 1);
  assert.equal(clampInt('nope', 30, 1, 10), 30);
});

test('streamToBuffer handles buffers, typed arrays, async iterables and arrayBuffer', async () => {
  const { streamToBuffer } = _internal;
  assert.equal((await streamToBuffer(Buffer.from('abc'))).toString(), 'abc');
  assert.equal((await streamToBuffer(new Uint8Array([97, 98]))).toString(), 'ab');
  assert.equal((await streamToBuffer(asyncChunks([Buffer.from('x'), Buffer.from('y')]))).toString(), 'xy');
  const ab = new TextEncoder().encode('zz').buffer;
  assert.equal((await streamToBuffer({ arrayBuffer: async () => ab })).toString(), 'zz');
  assert.equal((await streamToBuffer(null)).length, 0);
});
