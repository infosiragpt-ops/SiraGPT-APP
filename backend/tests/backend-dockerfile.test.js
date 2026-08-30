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
  assert.match(dockerfile, /sine=frequency=440:duration=1/);
  assert.match(dockerfile, /-ng -t 1/);
  assert.match(dockerfile, /DGGML_OPENMP=OFF/);
  assert.match(dockerfile, /DBUILD_SHARED_LIBS=OFF/);
  // Old bug: `cmd && apk del … || true` made a missing-bash install exit 0.
  assert.doesNotMatch(
    dockerfile,
    /install-local-whisper\.sh[^\n]*\n\s*&& apk del[^\n]*\|\| true/,
  );
  assert.match(dockerfile, /\{\s*apk del[^}]*\|\|\s*true;\s*\}/);
});

function readInstallLocalWhisper() {
  const scriptPath = path.join(root, 'backend/scripts/install-local-whisper.sh');
  return { scriptPath, script: fs.readFileSync(scriptPath, 'utf8') };
}

function extractShFunction(script, name) {
  const re = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm');
  const match = script.match(re);
  assert.ok(match, `${name}() must exist in install-local-whisper.sh`);
  return match[0];
}

test('install-local-whisper.sh is POSIX sh and ships ggml shared libs', () => {
  const { spawnSync } = require('node:child_process');
  const { scriptPath, script } = readInstallLocalWhisper();
  assert.match(script, /^#!\/bin\/sh\b/m);
  assert.doesNotMatch(script, /\[\[/);
  assert.match(script, /libwhisper\.so/);
  assert.match(script, /libggml/);
  assert.match(script, /ldconfig/);
  assert.match(script, /-DBUILD_SHARED_LIBS=OFF/);
  assert.match(script, /-DGGML_OPENMP=OFF/);
  assert.match(script, /-DGGML_NATIVE=OFF/);
  assert.match(script, /-DGGML_CUDA=OFF/);
  assert.match(script, /-DGGML_VULKAN=OFF/);
  assert.match(script, /-DGGML_METAL=OFF/);
  const parsed = spawnSync('sh', ['-n', scriptPath], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
});

test('install-local-whisper.sh skips same-file install and still fails if binary is missing', () => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const { script } = readInstallLocalWhisper();

  assert.match(script, /^same_file\(\) \{/m);
  assert.match(script, /^install_cli\(\) \{/m);
  assert.match(script, /skipping same-file copy/);
  assert.match(script, /whisper-cli binary not found after build/);
  assert.match(script, /whisper-cli missing at \$\{DEST\} after install/);
  assert.match(script, /install_cli "\$\{CLI\}" "\$\{DEST\}"/);
  assert.match(script, /install -m 0755 "\$\{src\}" "\$\{dest\}"/);
  // Real copy must still fail the build; never mask it with || true.
  assert.doesNotMatch(script, /install -m 0755[^\n]*\|\|\s*true/);
  assert.doesNotMatch(script, /install_cli[^\n]*\|\|\s*true/);

  const helpers = [
    extractShFunction(script, 'same_file'),
    extractShFunction(script, 'install_cli'),
  ].join('\n');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-whisper-install-'));
  const dest = path.join(dir, 'whisper-cli');
  const other = path.join(dir, 'other-cli');
  const missing = path.join(dir, 'missing-cli');
  const viaDotDot = path.join(dir, 'sub', '..', 'whisper-cli');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(dest, '#!/bin/sh\necho Usage: whisper-cli\n');
  fs.chmodSync(dest, 0o755);
  fs.writeFileSync(other, '#!/bin/sh\necho Usage: other\n');
  fs.chmodSync(other, 0o755);

  const probe = `
set -eu
${helpers}
same_file "${dest}" "${dest}"
same_file "${dest}" "${viaDotDot}"
! same_file "${other}" "${dest}"
! same_file "${missing}" "${dest}"
! same_file "" "${dest}"
install_cli "${dest}" "${dest}"
test -x "${dest}"
install_cli "${other}" "${dest}"
test -x "${dest}"
if install_cli "${missing}" "${path.join(dir, 'new-cli')}"; then
  echo "missing source must fail" >&2
  exit 1
fi
`;
  const ran = spawnSync('sh', ['-c', probe], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(ran.status, 0, ran.stderr || ran.stdout);
  assert.match(ran.stderr || '', /skipping same-file copy/);
});
