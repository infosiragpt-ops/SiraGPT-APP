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

test('backend Dockerfile installs whisper.cpp with sh and a hard smoke test', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'backend/Dockerfile'), 'utf8');
  assert.doesNotMatch(dockerfile, /bash \/tmp\/install-local-whisper\.sh/);
  assert.match(dockerfile, /sh \/tmp\/install-local-whisper\.sh/);
  assert.match(dockerfile, /WHISPER_LANGUAGE=es/);
  assert.match(dockerfile, /WHISPER_CPP_MODEL=\/usr\/local\/share\/whisper\/ggml-base\.bin/);
  assert.match(dockerfile, /whisper-cli -h/);
  assert.match(dockerfile, /test -s "\$\{WHISPER_CPP_MODEL\}"/);
  // Old bug: `cmd && apk del … || true` made a missing-bash install exit 0.
  assert.doesNotMatch(
    dockerfile,
    /install-local-whisper\.sh[^\n]*\n\s*&& apk del[^\n]*\|\| true/,
  );
  assert.match(dockerfile, /\{\s*apk del[^}]*\|\|\s*true;\s*\}/);
});

test('install-local-whisper.sh is POSIX sh and ships ggml shared libs', () => {
  const { spawnSync } = require('node:child_process');
  const scriptPath = path.join(root, 'backend/scripts/install-local-whisper.sh');
  const script = fs.readFileSync(scriptPath, 'utf8');
  assert.match(script, /^#!\/bin\/sh\b/m);
  assert.doesNotMatch(script, /\[\[/);
  assert.match(script, /libwhisper\.so/);
  assert.match(script, /libggml/);
  assert.match(script, /ldconfig/);
  const parsed = spawnSync('sh', ['-n', scriptPath], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
});
