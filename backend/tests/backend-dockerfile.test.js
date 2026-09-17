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

test('backend Dockerfile installs bash and probes /bin/bash after USER appuser', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'backend/Dockerfile'), 'utf8');
  const runnerStage = dockerfile.split('FROM node:22-alpine AS runner')[1] || '';
  assert.match(runnerStage, /^\s+bash\s*\\$/m);
  const userIdx = runnerStage.indexOf('\nUSER appuser');
  assert.ok(userIdx !== -1, 'runner must switch to USER appuser');
  const afterUser = runnerStage.slice(userIdx);
  assert.match(
    afterUser,
    /RUN \/bin\/bash -lc 'set -euo pipefail; test -n "\$\{BASH_VERSION\}"/,
  );
  assert.doesNotMatch(afterUser, /ln -s[^\n]*\/bin\/sh[^\n]*\/bin\/bash/);
  assert.doesNotMatch(afterUser, /spawn\(['"]sh['"]/);
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

function globalDockerfileArgs(dockerfile) {
  const firstFrom = dockerfile.search(/^\s*FROM\s+/m);
  assert.ok(firstFrom !== -1, 'Dockerfile must have a FROM');
  return dockerfile.slice(0, firstFrom);
}

function interpolateFromStage(dockerfile, name, buildArgs = {}) {
  const globalBlock = globalDockerfileArgs(dockerfile);
  const declared = {};
  for (const line of globalBlock.split('\n')) {
    const match = line.match(/^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/);
    if (!match) continue;
    declared[match[1]] = match[2] === undefined ? '' : match[2];
  }
  const value = Object.prototype.hasOwnProperty.call(buildArgs, name)
    ? String(buildArgs[name])
    : declared[name];
  assert.ok(value !== undefined && value !== '', `${name} must be a non-empty global ARG (usable in FROM)`);
  const fromLine = dockerfile.match(
    new RegExp(`^\\s*FROM\\s+whisper-seed-\\$\\{${name}\\}\\s+AS\\s+whisper-seed\\s*$`, 'm'),
  );
  assert.ok(fromLine, `FROM whisper-seed-\${${name}} AS whisper-seed must exist`);
  return `whisper-seed-${value}`;
}

test('backend Dockerfile can seed ggml-base.bin without HuggingFace', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'backend/Dockerfile'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.prod.yml'), 'utf8');
  const dockerignore = fs.readFileSync(path.join(root, 'backend/.dockerignore'), 'utf8');
  const opsDoc = fs.readFileSync(path.join(root, 'docs/operations/LOCAL_WHISPER.md'), 'utf8');

  assert.match(
    dockerfile,
    /ARG WHISPER_MODEL_URL=https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/main\/ggml-base\.bin/,
  );
  assert.match(dockerfile, /WHISPER_MODEL_URL=\$\{WHISPER_MODEL_URL\}/);
  assert.match(globalDockerfileArgs(dockerfile), /^\s*ARG BUNDLE_WHISPER_MODEL=0\s*$/m);
  assert.match(dockerfile, /FROM [^\n]+ AS whisper-seed-0/);
  assert.match(dockerfile, /FROM [^\n]+ AS whisper-seed-1/);
  assert.match(dockerfile, /FROM whisper-seed-\$\{BUNDLE_WHISPER_MODEL\} AS whisper-seed/);
  assert.equal(
    interpolateFromStage(dockerfile, 'BUNDLE_WHISPER_MODEL', { BUNDLE_WHISPER_MODEL: '0' }),
    'whisper-seed-0',
  );
  assert.equal(interpolateFromStage(dockerfile, 'BUNDLE_WHISPER_MODEL'), 'whisper-seed-0');
  assert.equal(
    interpolateFromStage(dockerfile, 'BUNDLE_WHISPER_MODEL', { BUNDLE_WHISPER_MODEL: '1' }),
    'whisper-seed-1',
  );
  assert.match(dockerfile, /COPY ggml-base\.bin \/whisper-seed\/ggml-base\.bin/);
  assert.match(dockerfile, /COPY --from=whisper-seed \/whisper-seed\/ \/tmp\/whisper-seed\//);

  const runnerStage = dockerfile.split('FROM node:22-alpine AS runner')[1] || '';
  assert.doesNotMatch(
    runnerStage,
    /^\s*COPY ggml-base\.bin/m,
    'runner must not COPY ggml-base.bin unless BUNDLE_WHISPER_MODEL=1 selected the seed-1 stage',
  );

  assert.match(compose, /BUNDLE_WHISPER_MODEL:\s+\$\{BUNDLE_WHISPER_MODEL:-0\}/);
  assert.match(compose, /WHISPER_MODEL_URL:\s+\$\{WHISPER_MODEL_URL:-https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/main\/ggml-base\.bin\}/);
  assert.doesNotMatch(dockerignore, /^ggml-base\.bin$/m);
  assert.doesNotMatch(dockerignore, /^\*\.bin$/m);
  assert.match(opsDoc, /BUNDLE_WHISPER_MODEL=1/);
  assert.match(opsDoc, /WHISPER_MODEL_URL/);
  assert.match(opsDoc, /before the\nfirst `FROM`/s);
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

test('install-local-whisper.sh skips HuggingFace when a model is already seeded', () => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const { script } = readInstallLocalWhisper();

  assert.match(script, /^seed_model\(\) \{/m);
  assert.match(script, /skipping download; model already present/);
  assert.match(script, /\/tmp\/whisper-seed\/\$\{MODEL_NAME\}/);
  assert.match(script, /\/tmp\/\$\{MODEL_NAME\}/);
  assert.match(script, /WHISPER_SEED_FILE/);
  assert.match(script, /file:\/\//);
  assert.match(script, /local model missing/);

  const helpers = [
    extractShFunction(script, 'same_file'),
    extractShFunction(script, 'download'),
    extractShFunction(script, 'seed_model'),
  ].join('\n');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-whisper-seed-'));
  const modelDir = path.join(dir, 'share', 'whisper');
  const dest = path.join(modelDir, 'ggml-base.bin');
  const bundleSeed = path.join(dir, 'bundle-ggml-base.bin');
  const otherSeed = path.join(dir, 'other-ggml-base.bin');
  const localSrc = path.join(dir, 'cached-ggml-base.bin');
  const fileUrlDest = path.join(dir, 'from-file-url.bin');
  const absDest = path.join(dir, 'from-abs.bin');
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(bundleSeed, 'SEED-FROM-BUNDLE');
  fs.writeFileSync(otherSeed, 'SEED-FROM-OTHER');
  fs.writeFileSync(localSrc, 'SEED-FROM-FILE-URL');

  const probe = `
set -eu
MODEL_DIR="${modelDir}"
MODEL_NAME="ggml-base.bin"
WHISPER_SEED_FILE="${bundleSeed}"
${helpers}

seed_model
test -s "${dest}"
grep -q SEED-FROM-BUNDLE "${dest}"

# Existing non-empty dest must not be overwritten or re-downloaded.
WHISPER_SEED_FILE="${otherSeed}"
seed_model
grep -q SEED-FROM-BUNDLE "${dest}"

download "file://${localSrc}" "${fileUrlDest}"
grep -q SEED-FROM-FILE-URL "${fileUrlDest}"

download "${localSrc}" "${absDest}"
grep -q SEED-FROM-FILE-URL "${absDest}"

if download "file://${dir}/missing.bin" "${dir}/should-not-exist.bin"; then
  echo "missing local source must fail" >&2
  exit 1
fi
test ! -e "${dir}/should-not-exist.bin"
`;
  const ran = spawnSync('sh', ['-c', probe], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(ran.status, 0, ran.stderr || ran.stdout);
  assert.match(ran.stderr || '', /seeding model from/);
});
