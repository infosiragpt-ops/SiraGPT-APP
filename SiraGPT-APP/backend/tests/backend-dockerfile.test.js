'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('backend Dockerfile creates uploads instead of copying an optional directory', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'backend/Dockerfile'), 'utf8');
  assert.doesNotMatch(dockerfile, /COPY --from=build[^\n]+\/app\/uploads/);
  assert.match(dockerfile, /mkdir -p \/app\/uploads/);
});

test('backend Dockerfile includes Linux Office/PDF/OCR tooling for document edits', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'backend/Dockerfile'), 'utf8');
  for (const pkg of [
    'libreoffice',
    'poppler-utils',
    'tesseract-ocr',
    'tesseract-ocr-data-spa',
    'tesseract-ocr-data-osd',
    'font-liberation',
    'font-noto',
    'pandoc',
    'py3-openpyxl',
    'python3',
  ]) {
    assert.match(dockerfile, new RegExp(`\\b${pkg}\\b`));
  }
});
