/**
 * appshots-capture — verifica POST /api/appshots/capture
 *
 *   - Rechaza peticiones sin Bearer (401).
 *   - Rechaza un Bearer con scope distinto a `appshots:capture` (403).
 *   - Rechaza si falta el archivo en el multipart (400).
 *   - Caso feliz: con scope correcto + sesión válida + PNG en el campo
 *     `image`, crea File + Chat + Message y devuelve { chatId, redirectUrl }.
 *   - Cuando `ocr=0` no se invoca Gemini Vision (degradación opt-out).
 *
 * Prisma y el servicio de IA se mockean para que el test no toque la DB
 * ni la red. Reutilizamos http-test-utils para montar el router de forma
 * aislada — mismo patrón que appshots-sessions.test.js.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'appshots-capture-test-secret-32+chars!';

const prisma = require('../src/config/database');
const aiService = require('../src/services/ai-service');
const { buildRouteTestApp } = require('./http-test-utils');
const appshotsRouter = require('../src/routes/appshots');

const TEST_USER = {
  id: 'appshots-capture-user',
  email: 'capture@example.com',
  name: 'Capture Tester',
  isAdmin: false,
  plan: 'ENTERPRISE',
};

function makeScopedToken(userId, scope = 'appshots:capture') {
  return jwt.sign({ userId, scope, nonce: 'n' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

// 1×1 PNG transparente — el byte más pequeño posible que pase el filtro
// MIME de multer (`image/png`). Base64 reduce el ruido del test.
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

function installPrismaMocks(token) {
  const originals = {
    sessionFindUnique: prisma.session.findUnique,
    sessionUpdate: prisma.session.update,
    fileCreate: prisma.file.create,
    chatCreate: prisma.chat.create,
    messageCreate: prisma.message.create,
  };

  const calls = { file: [], chat: [], message: [], sessionUpdate: [] };

  prisma.session.findUnique = async ({ where } = {}) => {
    if (where?.token === token) {
      return {
        id: 'sess-capture-1',
        token,
        userId: TEST_USER.id,
        user: TEST_USER,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        // Sin fingerprint guardado: authenticateToken trata esto como
        // "primera vez", lo materializa y deja pasar la petición.
      };
    }
    return null;
  };
  prisma.session.update = async (args) => {
    calls.sessionUpdate.push(args);
    return { id: args?.where?.id || 'sess-capture-1' };
  };
  prisma.file.create = async ({ data }) => {
    calls.file.push(data);
    return { id: 'file-capture-1', ...data };
  };
  prisma.chat.create = async ({ data }) => {
    calls.chat.push(data);
    return { id: 'chat-capture-1', ...data };
  };
  prisma.message.create = async ({ data }) => {
    calls.message.push(data);
    return { id: 'msg-capture-1', ...data };
  };

  return {
    calls,
    restore() {
      prisma.session.findUnique = originals.sessionFindUnique;
      prisma.session.update = originals.sessionUpdate;
      prisma.file.create = originals.fileCreate;
      prisma.chat.create = originals.chatCreate;
      prisma.message.create = originals.messageCreate;
    },
  };
}

function stubGemini() {
  const original = aiService.describeImagesWithGemini;
  let invoked = 0;
  aiService.describeImagesWithGemini = async () => {
    invoked += 1;
    return 'Texto OCR simulado por el test.';
  };
  return {
    get invocations() { return invoked; },
    restore() { aiService.describeImagesWithGemini = original; },
  };
}

describe('POST /api/appshots/capture', () => {
  let app;
  let token;
  let mocks;
  let gemini;

  beforeEach(() => {
    app = buildRouteTestApp('/api/appshots', appshotsRouter);
    token = makeScopedToken(TEST_USER.id);
    mocks = installPrismaMocks(token);
    gemini = stubGemini();
  });

  afterEach(() => {
    mocks.restore();
    gemini.restore();
  });

  it('rechaza 401 cuando falta el header Authorization', async () => {
    const res = await request(app)
      .post('/api/appshots/capture')
      .attach('image', ONE_PIXEL_PNG, { filename: 'shot.png', contentType: 'image/png' });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'no_bearer');
  });

  it('rechaza 403 cuando el JWT no lleva scope appshots:capture', async () => {
    const wrong = makeScopedToken(TEST_USER.id, 'chats:read');
    const res = await request(app)
      .post('/api/appshots/capture')
      .set('Authorization', `Bearer ${wrong}`)
      .attach('image', ONE_PIXEL_PNG, { filename: 'shot.png', contentType: 'image/png' });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'scope_required');
  });

  it('rechaza 400 cuando no se adjunta el campo image', async () => {
    const res = await request(app)
      .post('/api/appshots/capture')
      .set('Authorization', `Bearer ${token}`)
      .field('source', 'Pantalla de prueba');
    assert.equal(res.status, 400);
    assert.match(res.body.error || '', /image/i);
  });

  it('crea File + Chat + Message y devuelve chatId y redirectUrl', async () => {
    const res = await request(app)
      .post('/api/appshots/capture?ocr=0')
      .set('Authorization', `Bearer ${token}`)
      .field('source', 'Ventana de Chrome')
      .field('note', 'Mira esto, por favor')
      .attach('image', ONE_PIXEL_PNG, { filename: 'shot.png', contentType: 'image/png' });

    assert.equal(res.status, 201, `unexpected body: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.chatId, 'chat-capture-1');
    assert.equal(res.body.fileId, 'file-capture-1');
    assert.match(res.body.redirectUrl, /\/c\/chat-capture-1$/);

    assert.equal(mocks.calls.file.length, 1);
    const file = mocks.calls.file[0];
    assert.equal(file.userId, TEST_USER.id);
    assert.equal(file.mimeType, 'image/png');
    assert.ok(file.filename.startsWith('appshot-'));
    // ocr=0 → no extractedText
    assert.equal(file.extractedText, null);

    assert.equal(mocks.calls.chat.length, 1);
    const chat = mocks.calls.chat[0];
    assert.equal(chat.userId, TEST_USER.id);
    assert.match(chat.title, /Appshot · Ventana de Chrome/);

    assert.equal(mocks.calls.message.length, 1);
    const message = mocks.calls.message[0];
    assert.equal(message.chatId, 'chat-capture-1');
    assert.equal(message.role, 'user');
    assert.equal(message.content, 'Mira esto, por favor');
    assert.ok(Array.isArray(message.files));
    assert.equal(message.files[0].id, 'file-capture-1');
    assert.equal(message.metadata?.source, 'appshots');

    // ocr=0 explícito → Gemini no se invoca.
    assert.equal(gemini.invocations, 0);
  });

  it('cuando ocr=1 invoca Gemini Vision y guarda el texto extraído', async () => {
    const res = await request(app)
      .post('/api/appshots/capture?ocr=1')
      .set('Authorization', `Bearer ${token}`)
      .attach('image', ONE_PIXEL_PNG, { filename: 'shot.png', contentType: 'image/png' });

    assert.equal(res.status, 201, `unexpected body: ${JSON.stringify(res.body)}`);
    assert.equal(gemini.invocations, 1);
    assert.equal(mocks.calls.file[0].extractedText, 'Texto OCR simulado por el test.');
  });
});
