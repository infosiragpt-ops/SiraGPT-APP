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
let engineCanEdit = () => true;
require.cache[require.resolve(path.join(SERVICE_DIR, 'media/image-engine'))] = {
  exports: {
    canEditImage: (spec) => engineCanEdit(spec),
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
  engineCanEdit = () => true;
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

test('generate_image does not invent a new scene for "la misma imagen pero vertical"', async () => {
  const prisma = {
    file: { findMany: async () => [], findFirst: async () => null },
    message: { findMany: async () => [] },
  };
  const r = await tool('generate_image').execute(
    { prompt: 'ahora la misma imagen pero vertical porfavor' },
    fakeCtx({ prisma })
  );
  assert.equal(engineCalls.generate.length, 0, 'must not call generateImage');
  assert.equal(r.ok, false);
  assert.match(r.error, /No encontré la imagen/);
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
  // The spoken instruction is kept verbatim as the base and scoped with a
  // preservation clause so the background removal keeps the subject intact.
  assert.ok(engineCalls.edit[0].prompt.startsWith('quita el fondo'), 'provider prompt keeps the user instruction first');
  assert.match(engineCalls.edit[0].prompt, /sujeto principal sin cambios/);
  assert.equal(engineCalls.edit[0].imageBuffer.toString(), 'source-image');
  assert.equal(r.provider, 'gemini');
  assert.ok(ctx._events.some((e) => e.type === 'file_artifact'));
});

test('edit_image resolves the image attached to the message (ctx.fileIds)', async () => {
  const tmpImage = path.join(ARTIFACT_DIR, 'uploaded.png');
  fs.writeFileSync(tmpImage, 'attached-bytes');
  const record = { id: 'f-img', userId: 'user-1', mimeType: 'image/png', path: tmpImage, filename: 'uploaded.png' };
  let revalidated = 0;
  const prisma = {
    file: {
      findMany: async ({ where }) => {
        assert.deepEqual(where, { id: { in: ['f-img'] }, userId: 'user-1', deletedAt: null });
        return [record];
      },
      findFirst: async ({ where }) => {
        assert.deepEqual(where, { id: 'f-img', userId: 'user-1', deletedAt: null });
        revalidated += 1;
        return record;
      },
    },
    message: { findMany: async () => [] },
  };
  const ctx = fakeCtx({ prisma, fileIds: ['f-img'] });
  const r = await tool('edit_image').execute({ instruction: 'ponle un sombrero' }, ctx);
  assert.equal(r.ok, true);
  assert.equal(revalidated, 1, 'must revalidate the owned, visible reference before reading bytes');
  assert.equal(engineCalls.edit.length, 1);
  assert.equal(engineCalls.edit[0].imageBuffer.toString(), 'attached-bytes');
});

test('edit_image rejects an attachment that disappears after reference discovery', async () => {
  const tmpImage = path.join(ARTIFACT_DIR, 'disappeared.png');
  fs.writeFileSync(tmpImage, 'bytes-no-longer-authorized');
  let revalidated = 0;
  const prisma = {
    file: {
      findMany: async ({ where }) => {
        assert.deepEqual(where, { id: { in: ['f-img'] }, userId: 'user-1', deletedAt: null });
        return [{ id: 'f-img', userId: 'user-1', mimeType: 'image/png', path: tmpImage }];
      },
      findFirst: async ({ where }) => {
        assert.deepEqual(where, { id: 'f-img', userId: 'user-1', deletedAt: null });
        revalidated += 1;
        return null;
      },
    },
    message: { findMany: async () => [{ files: [{ type: 'image', fileId: 'unrelated-image' }] }] },
  };
  const ctx = fakeCtx({ prisma, fileIds: ['f-img'] });
  const r = await tool('edit_image').execute({ instruction: 'ponle un sombrero' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'image_source_required');
  assert.equal(revalidated, 1);
  assert.equal(engineCalls.edit.length, 0, 'must not edit stale bytes or an unrelated historical image');
  assert.equal(engineCalls.generate.length, 0, 'must not silently create a substitute image');
  assert.equal(ctx._events.some((event) => event.type === 'file_artifact'), false);
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
  assert.match(r.error, /No encontré la imagen/);
  assert.equal(engineCalls.edit.length, 0);
});

test('edit_image requires an instruction', async () => {
  const r = await tool('edit_image').execute({ instruction: '   ' }, fakeCtx());
  assert.equal(r.ok, false);
});

test('generate_image understands spoken framing ("vertical") without explicit args', async () => {
  const ctx = fakeCtx();
  const r = await tool('generate_image').execute({ prompt: 'dame una imagen vertical de un perro' }, ctx);
  assert.equal(r.ok, true);
  assert.equal(engineCalls.generate[0].aspectRatio, 'portrait');
  assert.equal(r.frame, '3:4');
  assert.match(engineCalls.generate[0].prompt, /Image framing requirement/);
});

test('generate_image keeps explicit args over spoken context', async () => {
  const r = await tool('generate_image').execute(
    { prompt: 'una imagen vertical de un perro', aspectRatio: 'square' },
    fakeCtx()
  );
  assert.equal(r.ok, true);
  assert.equal(engineCalls.generate[0].aspectRatio, 'square');
});

test('edit_image scopes "cambia el cielo" to the target and preserves the rest', async () => {
  const dataUrl = `data:image/png;base64,${Buffer.from('source-image').toString('base64')}`;
  const r = await tool('edit_image').execute(
    { instruction: 'en la imagen cambia el cielo a un atardecer naranja', imageUrl: dataUrl },
    fakeCtx()
  );
  assert.equal(r.ok, true);
  assert.match(r.editTarget, /cielo/);
  assert.match(engineCalls.edit[0].prompt, /cielo/);
  assert.match(engineCalls.edit[0].prompt, /conserva el resto de la imagen exactamente igual/);
});

test('edit_image honours an explicit selection box', async () => {
  const png = await require('sharp')({ create: { width: 32, height: 32, channels: 4, background: 'red' } }).png().toBuffer();
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  engineEditResult = { ok: true, images: [{ b64: png.toString('base64') }], model: 'gpt-image-2', provider: 'openai' };
  const r = await tool('edit_image').execute(
    {
      instruction: 'cambia el color',
      imageUrl: dataUrl,
      target: 'la camiseta',
      selection: { x: 0, y: 0, width: 100, height: 50 },
    },
    fakeCtx()
  );
  assert.equal(r.ok, true);
  assert.equal(r.editTarget, 'la camiseta');
  assert.deepEqual(r.editSelection, { kind: 'box', x: 0, y: 0, width: 100, height: 50 });
  assert.match(engineCalls.edit[0].prompt, /fuera de esa región/);
});

test('generate_image passes an explicit count through to the engine', async () => {
  engineGenerateResult = {
    ok: true,
    images: [1, 2, 3].map((i) => ({ b64: Buffer.from(`generated-${i}`).toString('base64'), mime: 'image/png' })),
    provider: 'openai',
    model: 'gpt-image-2',
    attempts: [],
  };
  const ctx = fakeCtx();
  const r = await tool('generate_image').execute({ prompt: 'un perro', count: 3 }, ctx);
  assert.equal(r.ok, true);
  assert.equal(engineCalls.generate[0].n, 3);
  assert.equal(r.requestedImages, 3);
  assert.equal(r.deliveredImages, 3);
  assert.equal(r.images.length, 3);
  // Back-compat: the first artifact is also exposed at the top level.
  assert.equal(r.filename, r.images[0].filename);
  assert.equal(r.downloadUrl, r.images[0].downloadUrl);
  assert.equal(ctx._events.filter((e) => e.type === 'file_artifact').length, 3);
});

test('generate_image fills count from the spoken prompt when no explicit count', async () => {
  const r = await tool('generate_image').execute({ prompt: 'dame 3 imágenes estilo anime de gatos' }, fakeCtx());
  assert.equal(r.ok, true);
  assert.equal(engineCalls.generate[0].n, 3);
  assert.equal(r.requestedImages, 3);
});

test('generate_image clamps count to 1..5', async () => {
  await tool('generate_image').execute({ prompt: 'x', count: 99 }, fakeCtx());
  assert.equal(engineCalls.generate[0].n, 5);
  await tool('generate_image').execute({ prompt: 'x', count: 0 }, fakeCtx());
  assert.equal(engineCalls.generate[1].n, 1);
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

test('image picker context overrides inferred tool model and survives artifact metadata', async () => {
  const ctx = fakeCtx({ imageModel: 'openai/gpt-image-2', imageProvider: 'openrouter', imageQuality: '4K', prisma: { chat: { findFirst: async () => ({ id: 'chat-1' }) }, message: { findMany: async () => [] } } });
  const generated = await tool('generate_image').execute({ prompt: 'beach', model: 'other-model', quality: 'standard' }, ctx);
  assert.equal(generated.ok, true);
  assert.equal(engineCalls.generate[0].model, ctx.imageModel);
  assert.equal(engineCalls.generate[0].provider, ctx.imageProvider);
  assert.equal(engineCalls.generate[0].quality, ctx.imageQuality);
  const meta = JSON.parse(fs.readFileSync(path.join(ARTIFACT_DIR, `${generated.id}.json`), 'utf8'));
  assert.equal(meta.model, ctx.imageModel); assert.equal(meta.version, 1);
  engineEditResult = { ok: true, images: [{ b64: Buffer.from('next-pixels').toString('base64') }], provider: 'openrouter', model: ctx.imageModel, attempts: [] };
  const edited = await tool('edit_image').execute({ instruction: 'cambia el cielo', fileId: `artifact:${generated.id}`, model: 'wrong' }, ctx);
  assert.equal(edited.ok, true, edited.error);
  assert.equal(engineCalls.edit[0].model, ctx.imageModel); assert.equal(engineCalls.edit[0].provider, ctx.imageProvider);
  const editMeta = JSON.parse(fs.readFileSync(path.join(ARTIFACT_DIR, `${edited.id}.json`), 'utf8'));
  assert.equal(editMeta.parentFileId, `artifact:${generated.id}`);
  assert.equal(editMeta.rootFileId, `artifact:${generated.id}`); assert.equal(editMeta.version, 2);
});

// ── Image context: fresh attachment ⇒ reference-guided edit ───────────────

function attachmentPrisma(records, { history = [] } = {}) {
  const byId = Object.fromEntries(records.map((record) => [record.id, record]));
  return {
    file: {
      findMany: async ({ where }) => {
        assert.equal(where.userId, 'user-1');
        assert.equal(where.deletedAt, null);
        return where.id.in.map((id) => byId[id]).filter(Boolean);
      },
      findFirst: async ({ where }) => {
        assert.equal(where.userId, 'user-1');
        return byId[where.id] || null;
      },
    },
    message: { findMany: async () => history },
  };
}

test('generate_image with a fresh image attachment routes to edit_image with the attachment pixels', async () => {
  const tmpImage = path.join(ARTIFACT_DIR, 'reference-upload.png');
  fs.writeFileSync(tmpImage, 'reference-pixels');
  const prisma = attachmentPrisma([{ id: 'img-1', userId: 'user-1', mimeType: 'image/png', path: tmpImage, filename: 'reference-upload.png' }]);
  const ctx = fakeCtx({ prisma, fileIds: ['img-1'], fileMetadata: [{ id: 'img-1', mimeType: 'image/png', name: 'reference-upload.png' }], hasImageAttachment: true });
  const r = await tool('generate_image').execute({ prompt: 'genera una imagen como esta pero con fondo azul' }, ctx);
  assert.equal(r.ok, true, r.error);
  assert.equal(engineCalls.generate.length, 0, 'the text-only generator must not drop the reference pixels');
  assert.equal(engineCalls.edit.length, 1);
  assert.equal(engineCalls.edit[0].imageBuffer.toString(), 'reference-pixels');
  assert.match(engineCalls.edit[0].prompt, /referencia|reference/i);
  assert.equal(engineCalls.edit[0].aspectRatio, null, 'a plain edit keeps the source frame');
  const artifactEvent = ctx._events.find((e) => e.type === 'file_artifact');
  assert.ok(artifactEvent);
  assert.equal(artifactEvent.artifact.prompt, 'genera una imagen como esta pero con fondo azul');
});

test('generate_image with only a PDF attached still generates a new image', async () => {
  const ctx = fakeCtx({ fileIds: ['doc-1'], fileMetadata: [{ id: 'doc-1', mimeType: 'application/pdf', name: 'brief.pdf' }] });
  const r = await tool('generate_image').execute({ prompt: 'un gato astronauta' }, ctx);
  assert.equal(r.ok, true);
  assert.equal(engineCalls.generate.length, 1);
  assert.equal(engineCalls.edit.length, 0);
});

test('generate_image with an image attachment and a non-editing model reports image_edit_unsupported without switching models', async () => {
  engineCanEdit = () => false;
  const ctx = fakeCtx({ imageModel: 'fal-ai/flux/schnell', imageProvider: 'fal', fileIds: ['img-1'], fileMetadata: [{ id: 'img-1', mimeType: 'image/png' }] });
  const r = await tool('generate_image').execute({ prompt: 'hazme un logo con este logo' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'image_edit_unsupported');
  // Display-name policy: never a raw id, a provider slug or OpenRouter in copy.
  assert.doesNotMatch(r.error, /fal-ai|\/|openrouter|gpt-image-1|gemini-2\.5/i);
  assert.match(r.error, /El modelo de imagen seleccionado no permite editar imágenes/);
  assert.match(r.error, /GPT Image o Gemini Flash Image/);
  assert.match(r.error, /sin adjuntar imágenes/);
  assert.equal(engineCalls.generate.length, 0);
  assert.equal(engineCalls.edit.length, 0);
  // With a catalog row the picker's display name is used.
  const prisma = { aiModel: { findFirst: async ({ where }) => (where.name === 'fal-ai/flux/schnell' ? { name: 'fal-ai/flux/schnell', displayName: 'Flux Schnell', provider: 'fal' } : null) }, file: { findMany: async () => [] } };
  const named = await tool('generate_image').execute({ prompt: 'hazme un logo con este logo' }, fakeCtx({ ...ctx, prisma }));
  assert.match(named.error, /^Flux Schnell no permite editar imágenes/);
  assert.doesNotMatch(named.error, /fal-ai/);
});

test('generate_image → edit_image redirect marks the tool that ran, so the finalize gate credits edit_image', async () => {
  const ctx = fakeCtx({ fileIds: ['img-1'], fileMetadata: [{ id: 'img-1', mimeType: 'image/png' }], prisma: attachmentPrisma([
    { id: 'img-1', userId: 'user-1', mimeType: 'image/png', path: (() => { const p = path.join(ARTIFACT_DIR, 'redirect-src.png'); fs.writeFileSync(p, 'src'); return p; })(), filename: 'redirect-src.png' },
  ]) });
  const r = await tool('generate_image').execute({ prompt: 'genera un banner con este logo' }, ctx);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.executedTool, 'edit_image');
  assert.equal(engineCalls.edit.length, 1);
  assert.equal(engineCalls.generate.length, 0);
  // «banner» frames the deliverable: 16:9 travels to the editor.
  assert.equal(engineCalls.edit[0].aspectRatio, '16:9');
  const { successfulToolCalls } = require(path.join(AGENTS_DIR, 'agentic-execution-profile'));
  const counts = successfulToolCalls([{ actions: [{ tool: 'generate_image', observation: r }] }]);
  assert.equal(counts.get('edit_image'), 1);
  assert.equal(counts.get('generate_image'), undefined);
});

test('generate_image ignores ids the loop recovered from history (no redirect)', async () => {
  const ctx = fakeCtx({ fileIds: ['old'], recoveredFileIds: ['old'], hasImageAttachment: true });
  const r = await tool('generate_image').execute({ prompt: 'una playa al atardecer' }, ctx);
  assert.equal(r.ok, true);
  assert.equal(engineCalls.generate.length, 1);
  assert.equal(engineCalls.edit.length, 0);
});

test('edit_image failure envelope carries the engine code and names the selected model', async () => {
  engineEditResult = { ok: false, code: 'image_edit_unsupported', error: 'El modelo seleccionado no permite esta edición.', attempts: [] };
  const dataUrl = `data:image/png;base64,${Buffer.from('source-image').toString('base64')}`;
  const ctx = fakeCtx({ imageModel: 'grok-2-image' });
  const r = await tool('edit_image').execute({ instruction: 'quita el fondo', imageUrl: dataUrl }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'image_edit_unsupported');
  assert.doesNotMatch(r.error, /grok-2-image|gpt-image-1|gemini-2\.5|\//);
  assert.match(r.error, /El modelo de imagen seleccionado no permite editar imágenes/);
  assert.match(r.error, /Elige un modelo de edición de imágenes \(GPT Image o Gemini Flash Image\)/);
  assert.deepEqual(r.attempts, []);
  engineEditResult = { ok: false, code: 'E_PROVIDER', error: 'fallo del proveedor', attempts: [{ ok: false }] };
  const r2 = await tool('edit_image').execute({ instruction: 'quita el fondo', imageUrl: dataUrl }, fakeCtx());
  assert.equal(r2.code, 'E_PROVIDER');
  assert.equal(r2.error, 'fallo del proveedor');
  // NO_PROVIDER (credentials missing for a model that CAN edit) keeps the
  // engine's own copy instead of telling the user to pick the model they picked.
  engineEditResult = { ok: false, code: 'NO_PROVIDER', error: 'El modelo seleccionado no está disponible.', attempts: [] };
  const r3 = await tool('edit_image').execute({ instruction: 'quita el fondo', imageUrl: dataUrl }, fakeCtx({ imageModel: 'gpt-image-1' }));
  assert.equal(r3.code, 'NO_PROVIDER');
  assert.equal(r3.error, 'El modelo seleccionado no está disponible.');
});

test('edit_image with no resolvable source returns the image_source_required code', async () => {
  const prisma = { file: { findMany: async () => [], findFirst: async () => null }, message: { findMany: async () => [] } };
  const r = await tool('edit_image').execute({ instruction: 'quita el fondo' }, fakeCtx({ prisma }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'image_source_required');
  assert.match(r.error, /No encontré la imagen/);
});

test('edit_image: a pinned non-attachment fileId stays the canvas even with a previous-image cue', async () => {
  const chosen = path.join(ARTIFACT_DIR, 'chosen-older.png'); fs.writeFileSync(chosen, 'chosen-pixels');
  const newest = path.join(ARTIFACT_DIR, 'newest-generated.png'); fs.writeFileSync(newest, 'newest-pixels');
  const logo = path.join(ARTIFACT_DIR, 'logo-2.png'); fs.writeFileSync(logo, 'logo-pixels');
  const prisma = attachmentPrisma([
    { id: 'chosen', userId: 'user-1', mimeType: 'image/png', path: chosen, filename: 'chosen-older.png' },
    { id: 'newest', userId: 'user-1', mimeType: 'image/png', path: newest, filename: 'newest-generated.png' },
    { id: 'logo', userId: 'user-1', mimeType: 'image/png', path: logo, filename: 'logo-2.png' },
  ], { history: [{ files: JSON.stringify([{ type: 'image', fileId: 'newest' }]) }, { files: JSON.stringify([{ type: 'image', fileId: 'chosen' }]) }] });
  const ctx = fakeCtx({ prisma, fileIds: ['logo'], userQuery: 'ponle este logo a la primera imagen' });
  const r = await tool('edit_image').execute({ instruction: 'ponle el logo', fileId: 'chosen', referenceFileIds: ['logo'] }, ctx);
  assert.equal(r.ok, true, r.error);
  assert.equal(engineCalls.edit[0].imageBuffer.toString(), 'chosen-pixels', 'the pinned image is the canvas');
  assert.deepEqual(engineCalls.edit[0].referenceImages.map((image) => image.buffer.toString()), ['logo-pixels']);
});

test('edit_image on a plain edit keeps the source frame and records the real ratio in the lineage', async () => {
  const png = await require('sharp')({ create: { width: 160, height: 90, channels: 4, background: 'blue' } }).png().toBuffer();
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  const ctx = fakeCtx();
  const r = await tool('edit_image').execute({ instruction: 'cambia el cielo a rosa', imageUrl: dataUrl }, ctx);
  assert.equal(r.ok, true, r.error);
  assert.equal(engineCalls.edit[0].aspectRatio, null);
  const meta = JSON.parse(fs.readFileSync(path.join(ARTIFACT_DIR, `${r.id}.json`), 'utf8'));
  assert.equal(meta.aspectRatio, '16:9');
  assert.equal(ctx._events.find((e) => e.type === 'file_artifact').artifact.aspectRatio, '16:9');
  assert.equal(ctx._events.find((e) => e.type === 'file_artifact').artifact.prompt, 'cambia el cielo a rosa');
  const ignored = await tool('edit_image').execute({ instruction: 'cambia el cielo a rosa', imageUrl: dataUrl, aspectRatio: 'portrait' }, fakeCtx());
  assert.equal(ignored.ok, true);
  assert.equal(engineCalls.edit[1].aspectRatio, null, 'an LLM aspectRatio on a plain edit is ignored');
  engineEditResult = { ok: true, images: [{ b64: png.toString('base64') }], provider: 'gemini', model: 'gemini-2.5-flash-image', attempts: [] };
  const spoken = await tool('edit_image').execute({ instruction: 'hazla vertical', imageUrl: dataUrl }, fakeCtx());
  assert.equal(spoken.ok, true, spoken.error);
  assert.equal(engineCalls.edit[2].aspectRatio, '3:4', 'a spoken frame still reframes');
});

test('edit_image "ponle este logo a la imagen anterior" keeps the chat image as canvas and the upload as reference', async () => {
  const previous = path.join(ARTIFACT_DIR, 'previous-generated.png');
  fs.writeFileSync(previous, 'previous-chat-image');
  const logo = path.join(ARTIFACT_DIR, 'logo-upload.png');
  fs.writeFileSync(logo, 'logo-pixels');
  const prisma = attachmentPrisma([
    { id: 'file-9', userId: 'user-1', mimeType: 'image/png', path: previous, filename: 'previous-generated.png' },
    { id: 'logo', userId: 'user-1', mimeType: 'image/png', path: logo, filename: 'logo-upload.png' },
  ], { history: [{ files: JSON.stringify([{ type: 'image', fileId: 'file-9', url: '/uploads/images/x.png' }]) }] });
  const ctx = fakeCtx({ prisma, fileIds: ['logo'], userQuery: 'ponle este logo a la imagen anterior' });
  const r = await tool('edit_image').execute({ instruction: 'ponle el logo', fileId: 'logo' }, ctx);
  assert.equal(r.ok, true, r.error);
  assert.equal(engineCalls.edit.length, 1);
  assert.equal(engineCalls.edit[0].imageBuffer.toString(), 'previous-chat-image');
  assert.deepEqual(engineCalls.edit[0].referenceImages.map((image) => image.buffer.toString()), ['logo-pixels']);
  assert.equal(engineCalls.edit[0].aspectRatio, null, '«logo» is a visual type, not a spoken frame');
  assert.deepEqual(r.referenceFileIds, ['file-9', 'logo']);
});
