'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');

describe('Voice Grok route persistent session contract', () => {
  let auth;
  let voiceModule;

  beforeEach(() => {
    auth = installAuthSessionMock();
    voiceModule = reloadModule('../src/routes/voice-grok');
    voiceModule.activeVoiceSessions.clear();
  });

  afterEach(() => {
    voiceModule?.activeVoiceSessions?.clear();
    auth.restore();
  });

  function buildApp() {
    return buildRouteTestApp('/api/voice/grok', voiceModule);
  }

  test('requires auth for session endpoints', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/api/voice/grok/sessions')
      .send({ chatId: 'chat-1' });

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Access token required');
  });

  test('creates a persistent voice session scoped to the authenticated user', async () => {
    const res = await request(buildApp())
      .post('/api/voice/grok/sessions')
      .set('Authorization', auth.authHeader)
      .send({ chatId: 'chat-1', mode: 'hands_free' });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.match(res.body.session.id, /^voice_/);
    assert.equal(res.body.session.chatId, 'chat-1');
    assert.equal(res.body.session.mode, 'hands_free');
    assert.equal(res.body.session.capabilities.chatComposerRemainsUsable, true);
  });

  test('turn endpoint routes regular transcripts back to chat dispatch', async () => {
    const create = await request(buildApp())
      .post('/api/voice/grok/sessions')
      .set('Authorization', auth.authHeader)
      .send({ chatId: 'chat-1' });

    const res = await request(buildApp())
      .post(`/api/voice/grok/sessions/${create.body.session.id}/turn`)
      .set('Authorization', auth.authHeader)
      .send({ text: 'haz una consulta sobre React' });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.turn.route, 'chat_message');
    assert.equal(res.body.turn.chatDispatch.enabled, true);
    assert.equal(res.body.session.status, 'listening');
  });

  test('turn endpoint can attach a Grok assistant reply with xAI speech audio without taking over chat', async () => {
    const app = buildApp();
    app.locals.grokVoiceResponder = async ({ turn }) => ({
      provider: 'openrouter',
      model: 'x-ai/grok-4',
      configured: true,
      text: `Respuesta Grok para: ${turn.transcript}`,
      spoken: true,
    });
    app.locals.grokVoiceSynthesizer = async ({ text }) => ({
      provider: 'xai',
      voice: 'eve',
      language: 'es',
      format: 'mp3',
      mimeType: 'audio/mpeg',
      buffer: Buffer.from(`audio:${text}`),
    });

    const create = await request(app)
      .post('/api/voice/grok/sessions')
      .set('Authorization', auth.authHeader)
      .send({ chatId: 'chat-1' });

    const res = await request(app)
      .post(`/api/voice/grok/sessions/${create.body.session.id}/turn`)
      .set('Authorization', auth.authHeader)
      .send({ text: 'explicame la arquitectura', respond: true });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.session.capabilities.chatComposerRemainsUsable, true);
    assert.equal(res.body.turn.chatDispatch.canUseComposerConcurrently, true);
    assert.equal(res.body.assistant.model, 'x-ai/grok-4');
    assert.equal(res.body.assistant.text, 'Respuesta Grok para: explicame la arquitectura');
    assert.equal(res.body.assistant.audio.provider, 'xai');
    assert.equal(res.body.assistant.audio.voice, 'eve');
    assert.equal(res.body.assistant.audio.base64, Buffer.from('audio:Respuesta Grok para: explicame la arquitectura').toString('base64'));
  });

  test('transcribe endpoint accepts browser audio and delegates to xAI STT', async () => {
    const app = buildApp();
    app.locals.grokVoiceTranscriber = async ({ file, body }) => {
      assert.equal(file.originalname, 'voice.webm');
      assert.equal(file.mimetype, 'audio/webm');
      assert.equal(body.model, 'grok-stt');
      assert.equal(body.language, 'es');
      return {
        provider: 'xai',
        model: body.model,
        text: 'hola desde grok stt',
      };
    };

    const res = await request(app)
      .post('/api/voice/grok/transcribe')
      .set('Authorization', auth.authHeader)
      .field('model', 'grok-stt')
      .field('language', 'es')
      .attach('audio', Buffer.from('fake-audio'), {
        filename: 'voice.webm',
        contentType: 'audio/webm',
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.provider, 'xai');
    assert.equal(res.body.model, 'grok-stt');
    assert.equal(res.body.text, 'hola desde grok stt');
  });

  test('turn endpoint can rebind the voice session to the active normal chat', async () => {
    const app = buildApp();
    const create = await request(app)
      .post('/api/voice/grok/sessions')
      .set('Authorization', auth.authHeader)
      .send({ chatId: null });

    assert.equal(create.status, 200);
    assert.equal(create.body.session.chatId, null);

    const res = await request(app)
      .post(`/api/voice/grok/sessions/${create.body.session.id}/turn`)
      .set('Authorization', auth.authHeader)
      .send({ text: 'continua en este chat', chatId: 'chat-live-2' });

    assert.equal(res.status, 200);
    assert.equal(res.body.session.chatId, 'chat-live-2');
    assert.equal(res.body.turn.chatDispatch.chatId, 'chat-live-2');
    assert.equal(res.body.turn.chatDispatch.canUseComposerConcurrently, true);
  });

  test('turn endpoint plans allowlisted desktop actions without executing them', async () => {
    const create = await request(buildApp())
      .post('/api/voice/grok/sessions')
      .set('Authorization', auth.authHeader)
      .send({ chatId: 'chat-1' });

    const res = await request(buildApp())
      .post(`/api/voice/grok/sessions/${create.body.session.id}/turn`)
      .set('Authorization', auth.authHeader)
      .send({ text: 'abre mi terminal' });

    assert.equal(res.status, 200);
    assert.equal(res.body.turn.route, 'desktop_action');
    assert.equal(res.body.turn.desktopAction.action.type, 'open_app');
    assert.equal(res.body.turn.desktopAction.action.app, 'Terminal');
    assert.equal(res.body.session.status, 'awaiting_local_bridge');
  });

  test('turn endpoint blocks unsafe local desktop requests', async () => {
    const create = await request(buildApp())
      .post('/api/voice/grok/sessions')
      .set('Authorization', auth.authHeader)
      .send({ chatId: 'chat-1' });

    const res = await request(buildApp())
      .post(`/api/voice/grok/sessions/${create.body.session.id}/turn`)
      .set('Authorization', auth.authHeader)
      .send({ text: 'ejecuta rm -rf /' });

    assert.equal(res.status, 200);
    assert.equal(res.body.turn.desktopAction.allowed, false);
    assert.equal(res.body.session.status, 'blocked');
  });

  test('does not expose sessions owned by another authenticated user', async () => {
    const session = {
      id: 'voice-owned-elsewhere',
      userId: 'other-user',
      status: 'listening',
      turns: [],
      capabilities: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10000).toISOString(),
      version: 'test',
    };
    voiceModule.activeVoiceSessions.set(session.id, session);

    const res = await request(buildApp())
      .get(`/api/voice/grok/sessions/${session.id}`)
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Voice session not found');
  });

  test('stream endpoint emits a session and desktop action planning event', async () => {
    const res = await request(buildApp())
      .post('/api/voice/grok/stream')
      .set('Authorization', auth.authHeader)
      .send({ chatId: 'chat-1', text: 'abre el repositorio siraGPT' });

    assert.equal(res.status, 200);
    assert.match(res.text, /"type":"session"/);
    assert.match(res.text, /"type":"turn"/);
    assert.match(res.text, /desktop_action_planned/);
    assert.match(res.text, /open_project/);
  });
});
