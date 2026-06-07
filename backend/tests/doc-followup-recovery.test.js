'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { resolveChatDocumentFileIds } = require('../src/services/message-attachments');
const agentTaskRoute = require('../src/routes/agent-task');
const { looksLikeDocumentFollowupQuestion } = agentTaskRoute;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function mockPrisma({ chat = { id: 'chat1' }, messages = [], files = [] } = {}) {
  return {
    chat: { findFirst: async () => chat },
    message: { findMany: async () => messages },
    file: {
      findMany: async ({ where }) => {
        const ids = (where && where.id && where.id.in) || [];
        return files.filter((f) => ids.includes(f.id));
      },
    },
  };
}

describe('resolveChatDocumentFileIds — recover prior document on a follow-up', () => {
  test('returns provided fileIds untouched when present', async () => {
    const out = await resolveChatDocumentFileIds(mockPrisma(), { userId: 'u1', chatId: 'c1', providedFileIds: ['x'] });
    assert.deepEqual(out, ['x']);
  });

  test('recovers the docx attached earlier in the chat (the bug scenario)', async () => {
    const prisma = mockPrisma({
      messages: [
        { files: JSON.stringify([{ id: 'file-doc-1', mimeType: DOCX_MIME, originalName: 'Formato para el proyecto de tesis.docx' }]) },
      ],
      files: [{ id: 'file-doc-1', mimeType: DOCX_MIME, originalName: 'tesis.docx', extractedText: 'GESTIÓN DEL PROCESO ADMINISTRATIVO...' }],
    });
    const out = await resolveChatDocumentFileIds(prisma, { userId: 'u1', chatId: 'c1', providedFileIds: [] });
    assert.deepEqual(out, ['file-doc-1']);
  });

  test('filters out non-readable attachments', async () => {
    const prisma = mockPrisma({
      messages: [{ files: JSON.stringify([{ id: 'weird' }]) }],
      files: [{ id: 'weird', mimeType: 'application/x-unknown', originalName: 'blob.bin', extractedText: '' }],
    });
    const out = await resolveChatDocumentFileIds(prisma, { userId: 'u1', chatId: 'c1', providedFileIds: [] });
    assert.deepEqual(out, []);
  });

  test('returns [] when the chat has no document attachments', async () => {
    const prisma = mockPrisma({ messages: [{ files: null }, { files: '[]' }] });
    const out = await resolveChatDocumentFileIds(prisma, { userId: 'u1', chatId: 'c1', providedFileIds: [] });
    assert.deepEqual(out, []);
  });

  test('returns [] when chat not found / not owned', async () => {
    const prisma = mockPrisma({ chat: null });
    const out = await resolveChatDocumentFileIds(prisma, { userId: 'u1', chatId: 'c1', providedFileIds: [] });
    assert.deepEqual(out, []);
  });

  test('safe with no chatId / no prisma / no user', async () => {
    assert.deepEqual(await resolveChatDocumentFileIds(mockPrisma(), { userId: 'u1', chatId: null }), []);
    assert.deepEqual(await resolveChatDocumentFileIds(null, { userId: 'u1', chatId: 'c1' }), []);
    assert.deepEqual(await resolveChatDocumentFileIds(mockPrisma(), { userId: null, chatId: 'c1' }), []);
  });

  test('keeps multiple docs in recency order, capped', async () => {
    const prisma = mockPrisma({
      messages: [
        { files: JSON.stringify([{ id: 'newest', mimeType: DOCX_MIME, originalName: 'a.docx' }]) },
        { files: JSON.stringify([{ id: 'older', mimeType: 'application/pdf', originalName: 'b.pdf' }]) },
      ],
      files: [
        { id: 'newest', mimeType: DOCX_MIME, originalName: 'a.docx', extractedText: 'x' },
        { id: 'older', mimeType: 'application/pdf', originalName: 'b.pdf', extractedText: 'y' },
      ],
    });
    const out = await resolveChatDocumentFileIds(prisma, { userId: 'u1', chatId: 'c1', providedFileIds: [] });
    assert.equal(out[0], 'newest');
    assert.ok(out.includes('older'));
  });
});

describe('looksLikeDocumentFollowupQuestion — when to reattach', () => {
  test('THE reported case + common doc questions → true', () => {
    for (const q of [
      'cual es el titulo de la investigacion ?',
      'dame un resumen en un solo parrafo',
      '¿de qué trata el documento?',
      'explícame la metodología',
      'cuál es el objetivo del proyecto',
      'quién es el autor',
      'what is the title of the research?',
      'resume el archivo',
    ]) {
      assert.equal(looksLikeDocumentFollowupQuestion(q), true, `expected true for: ${q}`);
    }
  });

  test('build / research / generation commands → false (never hijack those)', () => {
    for (const q of [
      'crea una web para mi empresa de carros',
      'genera un dashboard con métricas',
      'investiga en internet sobre los precios actuales',
      'busca en la web noticias de hoy',
      'desarrolla una app móvil',
      'haz una página de aterrizaje',
    ]) {
      assert.equal(looksLikeDocumentFollowupQuestion(q), false, `expected false for: ${q}`);
    }
  });

  test('empty / overlong → false', () => {
    assert.equal(looksLikeDocumentFollowupQuestion(''), false);
    assert.equal(looksLikeDocumentFollowupQuestion('   '), false);
    assert.equal(looksLikeDocumentFollowupQuestion('cuál '.repeat(120)), false); // > 400 chars
  });
});
