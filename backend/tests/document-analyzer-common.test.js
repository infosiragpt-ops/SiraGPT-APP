'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { safeFileName, safeText } = require('../src/services/document-analyzer-common');

test('safeFileName prefers name, then originalName, then id', () => {
  assert.equal(safeFileName({ name: 'a.pdf', originalName: 'b.pdf', id: 'f1' }), 'a.pdf');
  assert.equal(safeFileName({ originalName: 'b.pdf', id: 'f1' }), 'b.pdf');
  assert.equal(safeFileName({ id: 'f1' }), 'f1');
  assert.equal(safeFileName({}), 'attachment');
  assert.equal(safeFileName(null), 'attachment');
  assert.equal(safeFileName(undefined), 'attachment');
});

test('safeText keeps strings and blanks everything else', () => {
  assert.equal(safeText('hola'), 'hola');
  assert.equal(safeText(''), '');
  for (const value of [null, undefined, 0, 42, true, {}, [], ['x']]) assert.equal(safeText(value), '');
});
