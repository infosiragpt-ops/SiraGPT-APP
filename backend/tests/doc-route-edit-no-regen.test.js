'use strict';

/**
 * /api/doc must NOT regenerate a brand-new document when the user attached a
 * file and asked to edit it. Silent regeneration was the "can't edit my
 * document" failure mode — the user got an unrelated Word instead of a
 * surgical edit of their upload.
 *
 * We unit-test the decision helper inline (mirrors the gate in routes/doc.js)
 * so the suite stays hermetic without spinning Express.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isSourcePreservingEditRequest,
} = require('../src/services/source-preserving-document-edit');
const { isDocumentEditRequest } = require('../src/services/agents/agentic-trigger');

function shouldRefuseRegeneration({ prompt, fileIds }) {
  const ids = Array.isArray(fileIds) ? fileIds : [];
  const editIntent = isSourcePreservingEditRequest(prompt, ids)
    || (ids.length > 0 && isDocumentEditRequest(prompt));
  return Boolean(editIntent && ids.length > 0);
}

test('edit intent + attachment → refuse regeneration (force surgical path)', () => {
  assert.equal(
    shouldRefuseRegeneration({
      prompt: 'edita el documento: cambia el título a Informe Final',
      fileIds: ['file-1'],
    }),
    true,
  );
  assert.equal(
    shouldRefuseRegeneration({
      prompt: 'borra el párrafo del jurado evaluador',
      fileIds: ['file-1'],
    }),
    true,
  );
  assert.equal(
    shouldRefuseRegeneration({
      prompt: 'corrige la ortografía del word adjunto',
      fileIds: ['file-1'],
    }),
    true,
  );
});

test('create-from-scratch (no attachment) → allow regeneration', () => {
  assert.equal(
    shouldRefuseRegeneration({
      prompt: 'crea un informe de 10 páginas sobre IA',
      fileIds: [],
    }),
    false,
  );
});

test('attachment without edit intent → allow generation (reference file)', () => {
  assert.equal(
    shouldRefuseRegeneration({
      prompt: 'genera un documento nuevo de propuesta comercial',
      fileIds: ['file-1'],
    }),
    false,
  );
});
