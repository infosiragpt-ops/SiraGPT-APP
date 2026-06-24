/**
 * Tests for the engine-backed media tools in visual-media-tools.js:
 *   - generate_image → image-engine.generateImage (model pass-through,
 *     provider surfaced in the result, failure propagation)
 *   - edit_image → image-engine.editImage (source resolution from explicit
 *     URL / ctx.fileIds / last chat image, error guidance when no image)
 *   - generate_video model parameter resolved via the fal video catalog
 *
 * Fully offline: the engine and heavy deps are stubbed via require.cache.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVICE_DIR = path.resolve(__dirname, '../src/services');
const AGENTS_DIR = path.resolve(__dirname, '../src/services/agents');

// ── Stubs (must be registered before loading visual-media-tools) ─────────

require.cache[require.resolve('openai')] = {
  exports: class FakeOpenAI {
    constructor() {
      this.chat = { completions: { create: async () => ({ choices: [{ message: { content: 'ok' } }] }) } };
    }
  },
};

require.cache[require.resolve(path.join(SERVICE_DIR, 'ai-service'))] = {
  exports: { generateImage: async () => 'unused' },
};

require.cache[require.resolve(path.join(SERVICE_DIR, 'viz-generator'))] = { exports: {} };

require.cache[require.resolve(path.join(AGENTS_DIR, 'code-sandbox'))] = {
  exports: { run: async () => ({ ok: true, stdout: 'done', stderr: '', exitCode: 0 }) },
};

require.cache[require.resolve(path.join(AGENTS_DIR, 'agent-task-persistence'))] = {
  exports: { saveSnapshot: async () => {}, loadSnapshot: async () => null },
};

// Capturing engine stub.
const engineCalls = { generate: [], edit: [] };
let engineGenerateResult = null;
let engineEditResult = null;
require.cache[require.resolve(path.join(SERVICE_DIR, 'media/image-engine'))] = {
  exports: {
    generateImage: async (spec) => {
      engineCalls.generate.push(spec);
      return engineGenerateResult || {
        ok: true,
        images: [{ b64: Buffer.from('generated').toString('base64'), mime: 'image/png' }],
        provider: 'openai',
        model: spec.model || 'gpt-image-2',
        attempts: [],
      };
    },
    editImage: async (spec) => {
      engineCalls.edit.push(spec);
      return engineEditResult || {
        ok: true,
        images: [{ b64: Buffer.from('edited').toString('base64'), mime: 'image/png' }],
        provider: 'gemini',
        model: 'gemini-2.5-flash-image',
        attempts: [],
      };
    },
  },
};

const ARTIFACT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'media-tools-test-'));
process.env.AGENT_ARTIFACT_DIR = ARTIFACT_DIR;

const { VISUAL_MEDIA_TOOLS } = require(path.join(AGENTS_DIR, 'visual-media-tools'));

function tool(name) { return VISUAL_MEDIA_TOOLS.find((t) => t.name === name); }

function fakeCtx(overrides = {}) {
  const events = [];
  return {
    userId: 'user-1',
    chatId: 'chat-1',
    signal: new AbortController().signal,
    onEvent: (e) => { events.push(e); },
    ...overrides,
    _events: events,
  };
}

test.beforeEach(() => {
  engineCalls.generate.length = 0;
  engineCalls.edit.length = 0;
  engineGenerateResult = null;
  engineEditResult = null;
});

// ── generate_image ────────────────────────────────────────────────────────

test('generate_image passes the requested model through to the engine', async () => {
  const ctx = fakeCtx();
  const r = await tool('generate_image').execute(
    { prompt: 'un perro', model: 'fal-ai/flux/schnell', aspectRatio: 'wide', quality: 'hd' },
    ctx
  );
  assert.equal(r.ok, true);
  assert.equal(engineCalls.generate.length, 1);
  assert.equal(engineCalls.generate[0].model, 'fal-ai/flux/schnell');
  assert.equal(engineCalls.generate[0].aspectRatio, 'wide');
  assert.equal(engineCalls.generate[0].quality, 'hd');
  assert.equal(r.provider, 'openai');
  assert.ok(r.filename.endsWith('.png'));
  assert.ok(ctx._events.some((e) => e.type === 'file_artifact'));
});

test('generate_image without model lets the engine pick the provider', async () => {
  const r = await tool('generate_image').execute({ prompt: 'a cat' }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(engineCalls.generate[0].model, undefined);
});

test('generate_image surfaces engine failure with attempts', async () => {
  engineGenerateResult = { ok: false, error: 'todo caído', attempts: [{ provider: 'openai', ok: false, error: 'x' }] };
  const ctx = fakeCtx();
  const r = await tool('generate_image').execute({ prompt: 'x' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /todo caído/);
  assert.ok(Array.isArray(r.attempts));
  const fail = ctx._events.find((e) => e.type === 'tool_output' && e.ok === false);
  assert.ok(fail, 'should emit a failing tool_output event');
});

// ── edit_image ────────────────────────────────────────────────────────────

test('edit_image edits from an explicit data: URL', async () => {
  const ctx = fakeCtx();
  const dataUrl = `data:image/png;base64,${Buffer.from('source-image').toString('base64')}`;
  const r = await tool('edit_image').execute(
    { instruction: 'quita el fondo', imageUrl: dataUrl },
    ctx
  );
  assert.equal(r.ok, true);
  assert.equal(engineCalls.edit.length, 1);
  assert.equal(engineCalls.edit[0].prompt, 'quita el fondo');
  assert.equal(engineCalls.edit[0].imageBuffer.toString(), 'source-image');
  assert.equal(r.provider, 'gemini');
  assert.ok(ctx._events.some((e) => e.type === 'file_artifact'));
});

test('edit_image resolves the image attached to the message (ctx.fileIds)', async () => {
  const tmpImage = path.join(ARTIFACT_DIR, 'uploaded.png');
  fs.writeFileSync(tmpImage, 'attached-bytes');
  const prisma = {
    file: {
      findMany: async ({ where }) => {
        assert.deepEqual(where.id.in, ['f-img']);
        return [{ id: 'f-img', userId: 'user-1', mimeType: 'image/png', path: tmpImage, filename: 'uploaded.png' }];
      },
      findFirst: async () => null,
    },
    message: { findMany: async () => [] },
  };
  const ctx = fakeCtx({ prisma, fileIds: ['f-img'] });
  const r = await tool('edit_image').execute({ instruction: 'ponle un sombrero' }, ctx);
  assert.equal(r.ok, true);
  assert.equal(engineCalls.edit[0].imageBuffer.toString(), 'attached-bytes');
});

test('edit_image falls back to the most recent image in the chat', async () => {
  const tmpImage = path.join(ARTIFACT_DIR, 'generated.png');
  fs.writeFileSync(tmpImage, 'last-chat-image');
  const prisma = {
    file: {
      findMany: async () => [],
      findFirst: async ({ where }) => (
        where.id === 'file-9'
          ? { id: 'file-9', mimeType: 'image/png', path: tmpImage, filename: 'generated.png' }
          : null
      ),
    },
    message: {
      findMany: async () => [
        { files: JSON.stringify([{ type: 'image', fileId: 'file-9', url: '/uploads/images/x.png' }]) },
      ],
    },
  };
  const ctx = fakeCtx({ prisma });
  const r = await tool('edit_image').execute({ instruction: 'hazla blanco y negro' }, ctx);
  assert.equal(r.ok, true);
  assert.equal(engineCalls.edit[0].imageBuffer.toString(), 'last-chat-image');
});

test('edit_image returns clear guidance when no source image exists', async () => {
  const prisma = {
    file: { findMany: async () => [], findFirst: async () => null },
    message: { findMany: async () => [] },
  };
  const r = await tool('edit_image').execute({ instruction: 'quita el fondo' }, fakeCtx({ prisma }));
  assert.equal(r.ok, false);
  assert.match(r.error, /No encontré ninguna imagen/);
  assert.equal(engineCalls.edit.length, 0);
});

test('edit_image requires an instruction', async () => {
  const r = await tool('edit_image').execute({ instruction: '   ' }, fakeCtx());
  assert.equal(r.ok, false);
});

// ── edit_image security hardening ─────────────────────────────────────────

test('edit_image blocks path traversal through /uploads URLs', async () => {
  const prisma = {
    file: { findMany: async () => [], findFirst: async () => null },
    message: { findMany: async () => [] },
  };
  const r = await tool('edit_image').execute(
    { instruction: 'x', imageUrl: '/uploads/../../../../etc/passwd' },
    fakeCtx({ prisma })
  );
  assert.equal(r.ok, false);
  assert.equal(engineCalls.edit.length, 0, 'no edit call should happen for an escaped path');
});

test('edit_image blocks SSRF to private / metadata addresses', async () => {
  const prisma = {
    file: { findMany: async () => [], findFirst: async () => null },
    message: { findMany: async () => [] },
  };
  for (const target of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:5000/admin', 'http://localhost/x.png']) {
    const r = await tool('edit_image').execute({ instruction: 'x', imageUrl: target }, fakeCtx({ prisma }));
    assert.equal(r.ok, false, `should not fetch ${target}`);
  }
  assert.equal(engineCalls.edit.length, 0);
});

test('edit_image last-chat-image lookup filters by owner (no IDOR)', async () => {
  const seenWheres = [];
  const prisma = {
    file: {
      findMany: async () => [],
      findFirst: async ({ where }) => { seenWheres.push(where); return null; },
    },
    message: {
      findMany: async () => [
        { files: JSON.stringify([{ type: 'image', fileId: 'someone-elses-file' }]) },
      ],
    },
  };
  const r = await tool('edit_image').execute({ instruction: 'x' }, fakeCtx({ prisma }));
  assert.equal(r.ok, false);
  assert.ok(seenWheres.length > 0, 'should query the file record');
  for (const where of seenWheres) {
    assert.equal(where.userId, 'user-1', 'every file lookup must be owner-scoped');
  }
});

// ── generate_video model resolution ──────────────────────────────────────

test('generate_video resolves a cataloged fal model and builds its payload', async () => {
  process.env.FAL_KEY = 'fal-test';
  const subscribed = [];
  require.cache[require.resolve('@fal-ai/client')] = {
    exports: {
      fal: {
        config: () => {},
        subscribe: async (endpoint, opts) => {
          subscribed.push({ endpoint, input: opts.input });
          return { data: { video: { url: 'https://fal.example/video.mp4' } } };
        },
      },
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from('mp4-bytes') });
  try {
    const ctx = fakeCtx();
    const r = await tool('generate_video').execute(
      { prompt: 'un dron sobre el mar', duration: 6, aspectRatio: '16:9', model: 'fal-ai/veo3/fast' },
      ctx
    );
    assert.equal(r.ok, true);
    assert.equal(subscribed.length, 1);
    assert.equal(subscribed[0].endpoint, 'fal-ai/veo3/fast');
    assert.equal(subscribed[0].input.aspect_ratio, '16:9');
    assert.equal(r.model, 'fal-ai/veo3/fast');
    assert.equal(r.generationType, 'text-to-video');
    assert.equal(r.mime, 'video/mp4');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.FAL_KEY;
    delete require.cache[require.resolve('@fal-ai/client')];
  }
});
