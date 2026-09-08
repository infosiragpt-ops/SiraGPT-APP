'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const edge = require('../src/services/agents/edge-tts-client');
const {
  synthesizeEdgeSpeech,
  generateSecMsGec,
  pickVoice,
  isEdgeVoiceId,
  chunkText,
  buildSsml,
  extractAudioFromBinary,
  DEFAULT_VOICE,
  TRUSTED_CLIENT_TOKEN,
  _internal,
} = edge;

class FakeWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit('open'));
  }

  send(payload) {
    this.sent.push(String(payload));
  }

  close() {
    this.closed = true;
  }

  pushAudio(bytes) {
    const header = Buffer.from('X-RequestId:abc\r\nContent-Type:audio/mpeg\r\nPath:audio');
    const prefix = Buffer.alloc(2);
    prefix.writeUInt16BE(header.length, 0);
    this.emit('message', Buffer.concat([prefix, header, Buffer.from(bytes)]), true);
  }

  finish() {
    this.emit('message', 'X-RequestId:abc\r\nPath:turn.end\r\n\r\n', false);
  }
}
FakeWebSocket.instances = [];

test('empty text is refused before opening a socket', async () => {
  FakeWebSocket.instances = [];
  _internal.setWebSocketFactory(() => FakeWebSocket);
  try {
    await assert.rejects(() => synthesizeEdgeSpeech('   '), /vacío/i);
    assert.equal(FakeWebSocket.instances.length, 0);
  } finally {
    _internal.resetTestSeams();
  }
});

test('synthesizeEdgeSpeech accepts text frames delivered as Buffer (real ws)', async () => {
  FakeWebSocket.instances = [];
  _internal.setWebSocketFactory(() => FakeWebSocket);
  const pending = synthesizeEdgeSpeech('Hola');
  await new Promise((resolve) => setImmediate(resolve));
  const ws = FakeWebSocket.instances[0];
  ws.pushAudio('ID3REALWS');
  ws.emit('message', Buffer.from('X-RequestId:abc\r\nPath:turn.end\r\n\r\n'), false);
  const result = await pending;
  assert.equal(result.buffer.toString(), 'ID3REALWS');
  _internal.resetTestSeams();
});

test('synthesizeEdgeSpeech writes an mp3 buffer from Edge frames', async () => {
  FakeWebSocket.instances = [];
  _internal.setWebSocketFactory(() => FakeWebSocket);
  const pending = synthesizeEdgeSpeech('Juan vende papas en el mercado');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FakeWebSocket.instances.length, 1);
  const ws = FakeWebSocket.instances[0];
  assert.match(ws.url, /TrustedClientToken=/);
  assert.match(ws.url, /Sec-MS-GEC=/);
  assert.ok(ws.sent.some((msg) => /Path:speech\.config/.test(msg)));
  assert.ok(ws.sent.some((msg) => /es-PE-CamilaNeural/.test(msg) && /Juan vende papas/.test(msg)));
  ws.pushAudio('ID3FAKEMP3');
  ws.finish();
  const result = await pending;
  assert.equal(result.mime, 'audio/mpeg');
  assert.equal(result.format, 'mp3');
  assert.equal(result.voice, DEFAULT_VOICE);
  assert.equal(result.buffer.toString(), 'ID3FAKEMP3');
  _internal.resetTestSeams();
});

test('generateSecMsGec is deterministic for a fixed unix timestamp', () => {
  const token = generateSecMsGec(1_700_000_000, 0);
  assert.equal(token.length, 64);
  assert.match(token, /^[0-9A-F]+$/);
  assert.equal(token, generateSecMsGec(1_700_000_000, 0));
  assert.notEqual(token, generateSecMsGec(1_700_000_300, 0));
  assert.ok(TRUSTED_CLIENT_TOKEN.length > 8);
});

test('pickVoice keeps neural names and defaults to Camila', () => {
  assert.equal(isEdgeVoiceId('es-ES-ElviraNeural'), true);
  assert.equal(isEdgeVoiceId('21m00Tcm4TlvDq8ikWAM'), false);
  assert.equal(pickVoice('es-ES-ElviraNeural'), 'es-ES-ElviraNeural');
  assert.equal(pickVoice('21m00Tcm4TlvDq8ikWAM'), DEFAULT_VOICE);
});

test('buildSsml escapes user text and extractAudioFromBinary splits headers', () => {
  const ssml = buildSsml('Juan & María <hola>', 'es-PE-CamilaNeural');
  assert.match(ssml, /Juan &amp; María &lt;hola&gt;/);
  assert.doesNotMatch(ssml, /<hola>/);
  const header = Buffer.from('X-RequestId:abc\r\nContent-Type:audio/mpeg\r\nPath:audio');
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(header.length, 0);
  const raw = Buffer.concat([prefix, header, Buffer.from('BYTES')]);
  assert.equal(extractAudioFromBinary(raw).toString(), 'BYTES');
  const blank = Buffer.concat([
    Buffer.from('Path:audio\r\nContent-Type:audio/mpeg\r\n\r\n'),
    Buffer.from('LEGACY'),
  ]);
  assert.equal(extractAudioFromBinary(blank).toString(), 'LEGACY');
});

test('chunkText splits long narration without dropping the tail', () => {
  const long = `${'hola '.repeat(900)}fin`;
  const chunks = chunkText(long, 80);
  assert.ok(chunks.length > 1);
  assert.match(chunks.join(' '), /fin/);
  assert.ok(chunks.every((c) => c.length <= 80));
});
