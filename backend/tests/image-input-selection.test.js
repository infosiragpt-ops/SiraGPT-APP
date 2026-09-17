'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isGrokImageModelName } = require('../src/services/model-output-type');
const { resolveImageGenerationFileId } = require('../src/services/media/image-input-selection');
const { resolveImageOperation } = require('../src/services/media/image-input-selection');

test('new generations are explicit and same-scene follow-ups require a source', () => {
  assert.equal(resolveImageOperation({ prompt: 'crea otra imagen de una ciudad' }), 'generate');
  assert.equal(resolveImageOperation({ prompt: 'ahora la misma imagen pero vertical porfavor' }), 'reframe');
  assert.equal(resolveImageOperation({ prompt: 'la misma, en vertical' }), 'reframe');
  assert.equal(resolveImageOperation({ prompt: 'ahora 9:16' }), 'reframe');
  assert.equal(resolveImageOperation({ operation: 'edit', fileId: 'beach', prompt: 'ahora la misma imagen pero vertical porfavor' }), 'reframe');
  assert.equal(resolveImageOperation({ prompt: 'quita el fondo' }), 'edit');
  assert.equal(resolveImageOperation({ prompt: 'cambia el cielo', fileId: 'chosen' }), 'edit');
  assert.equal(resolveImageOperation({ operation: 'generate', prompt: 'otra imagen' }), 'generate');
  assert.throws(() => resolveImageOperation({ operation: 'unknown' }), { code: 'E_PARAMS' });
});

test('repeated Grok generations in the same chat never become edits of a historical image', async () => {
  const history = new Map([['chat-with-images', 'previous-generated-image']]);
  let historyReads = 0;
  const request = {
    chatId: 'chat-with-images',
    generationOnly: isGrokImageModelName('x-ai/grok-imagine-image-2.0'),
    findPreviousImageFileId: async (chatId) => {
      historyReads++;
      return history.get(chatId);
    },
  };
  assert.equal(await resolveImageGenerationFileId(request), undefined);
  history.set(request.chatId, 'newly-generated-image');
  assert.equal(await resolveImageGenerationFileId(request), undefined);
  assert.equal(historyReads, 0);
});

test('an explicit Grok edit input remains visible to the unsupported-edit validation', async () => {
  const fileId = await resolveImageGenerationFileId({
    chatId: 'same-chat',
    fileId: 'explicit-upload',
    generationOnly: true,
    findPreviousImageFileId: async () => { throw new Error('must not replace explicit input'); },
  });
  assert.equal(fileId, 'explicit-upload');
});

test('existing edit-capable models retain implicit history and explicit input behavior', async () => {
  const request = {
    chatId: 'same-chat',
    generationOnly: false,
    findPreviousImageFileId: async () => 'previous-image',
  };
  assert.equal(await resolveImageGenerationFileId(request), 'previous-image');
  assert.equal(await resolveImageGenerationFileId({ ...request, fileId: 'upload' }), 'upload');
  assert.equal(await resolveImageGenerationFileId({ ...request, chatId: undefined }), undefined);
});
