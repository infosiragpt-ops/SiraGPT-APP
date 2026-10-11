'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {
  historyHasRecentImage,
  chatHasRecentImage,
  nearestAspectRatio,
  aspectRatioFromBuffer,
} = require('../src/services/media/image-followup-context');

const sentinel = (mime, name = 'image_1.png') => '```agent-task-state\n' + JSON.stringify({ artifacts: [{ id: 'abc123def456', filename: name, mime, downloadUrl: `/api/agent/artifact/abc123def456?name=${name}` }] }) + '\n```\nListo.';

test('historyHasRecentImage sees uploads, composer images and agentic artifacts', () => {
  assert.equal(historyHasRecentImage([{ role: 'user', content: 'hola', files: [{ type: 'image/png', id: 'f1' }] }]), true);
  assert.equal(historyHasRecentImage([{ role: 'assistant', content: 'listo', files: JSON.stringify([{ type: 'image', fileId: 'beach', url: '/uploads/images/x.png' }]) }]), true);
  assert.equal(historyHasRecentImage([{ role: 'assistant', content: sentinel('image/png') }]), true);
  assert.equal(historyHasRecentImage([{ role: 'assistant', content: [{ type: 'text', text: sentinel('image/webp') }] }]), true);
  // The composer stores the generated image URL as the assistant content; a
  // vision turn in LLM shape carries an image_url part.
  assert.equal(historyHasRecentImage([{ role: 'assistant', content: '/uploads/images/result-3.png' }]), true);
  assert.equal(historyHasRecentImage([{ role: 'assistant', content: 'https://siragpt.com/uploads/u1/foto.jpg' }]), true);
  assert.equal(historyHasRecentImage([{ role: 'assistant', content: 'Aquí tienes: ![logo](/api/agent/artifact/abc123def456?name=logo.png)' }]), true);
  assert.equal(historyHasRecentImage([{ role: 'user', content: [{ type: 'text', text: 'qué ves' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }]), true);
  assert.equal(historyHasRecentImage([{ role: 'assistant', content: 'Descarga el informe en /uploads/docs/informe.pdf' }]), false);
});

test('historyHasRecentImage ignores documents, tombstones and old rows', () => {
  assert.equal(historyHasRecentImage([]), false);
  assert.equal(historyHasRecentImage(null), false);
  assert.equal(historyHasRecentImage([{ content: 'x', files: [{ type: 'application/pdf', id: 'd' }] }]), false);
  assert.equal(historyHasRecentImage([{ content: sentinel('application/pdf', 'informe.pdf') }]), false);
  assert.equal(historyHasRecentImage([{ content: 'x', files: [{ type: 'image/png', id: 'f1', deletedAt: '2026-01-01' }] }]), false);
  const old = { content: 'x', files: [{ type: 'image/png', id: 'f1' }] };
  const prose = Array.from({ length: 20 }, (_, i) => ({ content: `turn ${i}` }));
  assert.equal(historyHasRecentImage([old, ...prose], { limit: 12 }), false);
  assert.equal(historyHasRecentImage([old, ...prose], { limit: 30 }), true);
});

test('chatHasRecentImage reads one bounded page of the owned chat only', async () => {
  const calls = [];
  const prisma = {
    chat: { findFirst: async ({ where }) => (where.userId === 'owner' && where.id === 'chat' ? { id: 'chat' } : null) },
    message: {
      findMany: async (args) => {
        calls.push(args);
        return [{ files: null, content: 'ok' }, { files: JSON.stringify([{ type: 'image', fileId: 'beach' }]), content: '' }];
      },
    },
  };
  assert.equal(await chatHasRecentImage(prisma, { userId: 'owner', chatId: 'chat' }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].take, 12);
  assert.deepEqual(calls[0].where, { chatId: 'chat', deletedAt: null });
  assert.equal(await chatHasRecentImage(prisma, { userId: 'intruder', chatId: 'chat' }), false);
  assert.equal(calls.length, 1, 'a foreign chat never reads messages');
  assert.equal(await chatHasRecentImage(null, { userId: 'owner', chatId: 'chat' }), false);
  assert.equal(await chatHasRecentImage(prisma, { userId: 'owner' }), false);
});

test('nearestAspectRatio snaps real dimensions to a supported frame', () => {
  assert.equal(nearestAspectRatio(1600, 900), '16:9');
  assert.equal(nearestAspectRatio(1080, 1920), '9:16');
  assert.equal(nearestAspectRatio(1024, 1024), '1:1');
  assert.equal(nearestAspectRatio(1000, 1333), '3:4');
  assert.equal(nearestAspectRatio(8, 4), '16:9');
  assert.equal(nearestAspectRatio(0, 10), null);
  assert.equal(nearestAspectRatio('x', 10), null);
  assert.equal(nearestAspectRatio(1600, 900, ['1:1', '3:4', '4:3', '9:16', '16:9']), '16:9');
});

test('aspectRatioFromBuffer is best-effort: real images resolve, other bytes return null', async () => {
  const wide = await sharp({ create: { width: 160, height: 90, channels: 4, background: '#102030' } }).png().toBuffer();
  assert.equal(await aspectRatioFromBuffer(wide), '16:9');
  assert.equal(await aspectRatioFromBuffer(Buffer.from('source-image')), null);
  assert.equal(await aspectRatioFromBuffer(null), null);
});

test('a document delivered after the picture ends the image context for the chat loop, not for the composer', () => {
  const picture = { role: 'user', content: 'mira', files: [{ type: 'image/png', id: 'shot' }] };
  const docRow = { role: 'assistant', content: sentinel('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'informe.docx') };
  assert.equal(historyHasRecentImage([picture, { role: 'assistant', content: 'veo un gato' }]), true);
  assert.equal(historyHasRecentImage([picture, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'hazme un word' }, docRow]), false);
  assert.equal(historyHasRecentImage([picture, { role: 'user', content: 'x', files: [{ type: 'application/pdf', id: 'd' }] }]), false);
  assert.equal(historyHasRecentImage([picture, { role: 'assistant', content: 'Descarga: /uploads/docs/informe.pdf' }]), false);
  // The composer only produces images: a later document does not end its context.
  assert.equal(historyHasRecentImage([picture, docRow], { documentEndsContext: false }), true);
  // A picture AFTER the document restores the context.
  assert.equal(historyHasRecentImage([docRow, picture]), true);
  // External markdown images from a web answer are not editable chat images.
  assert.equal(historyHasRecentImage([{ role: 'assistant', content: '![Torre](https://upload.wikimedia.org/x/Tour_Eiffel.jpg)' }]), false);
});

test('chatHasRecentImage keeps the picture past a later PDF upload (composer semantics)', async () => {
  const prisma = {
    chat: { findFirst: async () => ({ id: 'chat' }) },
    message: { findMany: async () => [
      { files: JSON.stringify([{ type: 'application/pdf', id: 'document' }]), content: '' },
      { files: JSON.stringify([{ type: 'image/png', fileId: 'beach' }]), content: '' },
    ] },
  };
  assert.equal(await chatHasRecentImage(prisma, { userId: 'owner', chatId: 'chat' }), true);
});
