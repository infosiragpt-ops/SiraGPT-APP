'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isStableServerFileId,
  isPersistedPreviewSource,
} = require('../src/services/document-pipeline/preview-object-ready');

describe('preview-object-ready', () => {
  it('rejects temp composer ids', () => {
    assert.equal(isStableServerFileId('temp-123'), false);
    assert.equal(isStableServerFileId('temp_abc'), false);
    assert.equal(isStableServerFileId('temp'), false);
    assert.equal(isStableServerFileId(''), false);
    assert.equal(isStableServerFileId(null), false);
  });

  it('accepts persisted file ids', () => {
    assert.equal(isStableServerFileId('file_01HXYZ'), true);
    assert.equal(isStableServerFileId('clxyz0123456789'), true);
  });

  it('requires a stable id, a path, a positive size, and an existing object', () => {
    assert.equal(isPersistedPreviewSource({
      id: 'file_1',
      path: 'uploads/user/tesis.docx',
      sizeBytes: 307000,
      objectExists: true,
    }), true);

    assert.equal(isPersistedPreviewSource({
      id: 'temp-1',
      path: 'uploads/user/tesis.docx',
      sizeBytes: 307000,
      objectExists: true,
    }), false);

    assert.equal(isPersistedPreviewSource({
      id: 'file_1',
      path: '',
      sizeBytes: 307000,
      objectExists: true,
    }), false);

    assert.equal(isPersistedPreviewSource({
      id: 'file_1',
      path: 'uploads/user/tesis.docx',
      sizeBytes: 0,
      objectExists: true,
    }), false);

    assert.equal(isPersistedPreviewSource({
      id: 'file_1',
      path: 'uploads/user/tesis.docx',
      sizeBytes: 307000,
      objectExists: false,
    }), false);
  });
});
