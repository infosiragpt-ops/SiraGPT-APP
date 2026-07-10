'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROUTES_DIR = path.join(__dirname, '..', 'src', 'routes');
const ROUTER_PATH = path.join(ROUTES_DIR, 'gpts.js');

function resolveFrom(requestPath) {
  return require.resolve(requestPath, { paths: [ROUTES_DIR] });
}

function injectFakeModule(requestPath, exportsValue) {
  const resolved = resolveFrom(requestPath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function loadRouterWithUploadRoot(uploadRoot) {
  for (const p of [
    ROUTER_PATH,
    resolveFrom('../config/database'),
    resolveFrom('../middleware/auth'),
    resolveFrom('../middleware/upload'),
    resolveFrom('../services/fileProcessor'),
    resolveFrom('../services/upload-security-policy'),
    resolveFrom('../services/ai/cerebras-client'),
  ]) {
    delete require.cache[p];
  }

  injectFakeModule('../config/database', {
    customGpt: {
      async update() {
        return {};
      },
    },
  });
  injectFakeModule('../middleware/auth', {
    authenticateToken: (_req, _res, next) => next(),
  });
  const safeStorageSegment = (value) => {
    const segment = String(value || '');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/.test(segment)) return null;
    if (segment === '.' || segment === '..' || segment.includes('..') || segment.includes('/') || segment.includes('\\')) return null;
    return segment;
  };
  injectFakeModule('../middleware/upload', {
    uploadDir: uploadRoot,
    safeStorageSegment,
    single: () => (_req, _res, next) => next(),
    array: () => (_req, _res, next) => next(),
  });
  injectFakeModule('../services/fileProcessor', { async processFile() { return { extractedText: '' }; } });
  injectFakeModule('../services/upload-security-policy', {
    validateUploadPolicy: ({ declaredMime }) => ({ ok: true, mimeType: declaredMime }),
  });
  injectFakeModule('../services/ai/cerebras-client', {
    createCerebrasClient: () => null,
    getCerebrasConfig: () => ({ model: 'fake', displayName: 'fake' }),
  });

  return require(ROUTER_PATH);
}

test('publicizeGptIconUrl moves public GPT icons out of user-scoped uploads', async () => {
  const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-gpt-icons-'));
  try {
    const sourceDir = path.join(uploadRoot, 'user-1');
    fs.mkdirSync(sourceDir, { recursive: true });
    const sourcePath = path.join(sourceDir, 'icon.png');
    fs.writeFileSync(sourcePath, 'image-bytes');

    const router = loadRouterWithUploadRoot(uploadRoot);
    const result = await router._internal.publicizeGptIconUrl({
      iconUrl: '/uploads/user-1/icon.png',
      visibility: 'PUBLIC',
      gptId: 'gpt-1',
      uploadRoot,
      moveSource: true,
    });

    assert.equal(result.changed, true);
    assert.equal(result.iconUrl, '/uploads/gpt-icons/gpt-1-icon.png');
    assert.equal(fs.existsSync(sourcePath), false);
    assert.equal(fs.readFileSync(path.join(uploadRoot, 'gpt-icons', 'gpt-1-icon.png'), 'utf8'), 'image-bytes');
  } finally {
    fs.rmSync(uploadRoot, { recursive: true, force: true });
  }
});

test('publicizeGptIconUrl leaves private GPT icons user-scoped', async () => {
  const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-gpt-icons-'));
  try {
    const sourceDir = path.join(uploadRoot, 'user-1');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'icon.png'), 'image-bytes');

    const router = loadRouterWithUploadRoot(uploadRoot);
    const result = await router._internal.publicizeGptIconUrl({
      iconUrl: '/uploads/user-1/icon.png',
      visibility: 'PRIVATE',
      gptId: 'gpt-1',
      uploadRoot,
    });

    assert.equal(result.changed, false);
    assert.equal(result.iconUrl, '/uploads/user-1/icon.png');
  } finally {
    fs.rmSync(uploadRoot, { recursive: true, force: true });
  }
});
