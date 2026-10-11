'use strict';

// Execute the actual canonical HTTP handler with offline boundaries. Loading
// the entire AI router would boot unrelated services; this fixture isolates
// only the registered /generate-image handler, not a rewritten implementation.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const sharp = require('sharp');
const { resolveImageOperation } = require('../src/services/media/image-input-selection');
const { resolveImageSource } = require('../src/services/media/image-source');
const { prepareEditCanvas, finishEditCanvas } = require('../src/services/media/image-edit-canvas');
const { classifyImageGenError } = require('../src/services/image-error-classifier');
const { checkPaidTokenCap } = require('../src/services/plan-quota');
const routeFile = path.resolve(__dirname, '../src/routes/ai.js');
const routeSource = fsSync.readFileSync(routeFile, 'utf8');
const routeStart = routeSource.indexOf("router.post(\n  '/generate-image',");
const routeEnd = routeSource.indexOf('// Add this route after the existing generate-image route', routeStart);
const fixtureDir = fs.mkdtemp(path.join(os.tmpdir(), 'image-handler-'));
after(async () => fs.rm(await fixtureDir, { recursive: true, force: true }));
const image = (color, width = 8, height = 4) => sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();

async function harness({ source = true, chatOwned = true, editable = true, user = {}, references = [], sourceAspect = '16:9', history = null } = {}) {
  const sourceBytes = await image('#de2070'); const outputBytes = await image('#1040fa');
  const sourcePath = path.join(await fixtureDir, 'source.png'); await fs.writeFile(sourcePath, sourceBytes);
  const calls = { generate: [], edit: [], saves: [], messages: [], reads: 0 };
  const records = source ? { beach: { id: 'beach', filename: 'generated-beach.png', mimeType: 'image/png', path: sourcePath } } : {};
  for (const id of references) records[id] = { id, filename: `${id}.png`, mimeType: 'image/png', path: sourcePath };
  const prisma = {
    chat: { findFirst: async () => chatOwned ? { id: 'chat', title: 'Image' } : null, update: async () => ({}) },
    file: { findFirst: async ({ where }) => records[where.id] || null },
    message: {
      findMany: async () => { calls.reads++; if (history) return history; return source ? [
        { files: [{ type: 'application/pdf', id: 'document' }] },
        { files: [{ type: 'image/png', fileId: 'beach', version: 2, ...(sourceAspect ? { aspectRatio: sourceAspect } : {}), rootFileId: 'original' }] },
      ] : []; },
      create: async ({ data }) => { calls.messages.push(data); return { id: `message-${calls.messages.length}` }; },
    },
    aiModel: { findUnique: async () => ({ name: 'gpt-image-2', provider: 'OpenAI', isActive: true, type: 'IMAGE' }) },
  };
  let handler;
  const chain = new Proxy(() => {}, { get: () => () => chain });
  const context = {
    router: { post: (_path, ...args) => { handler = args.at(-1); } },
    body: () => chain, authenticateToken: () => {}, requirePaidPlan: () => () => {},
    validationResult: () => ({ isEmpty: () => true }),
    require: createRequire(routeFile), Buffer, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    console: { log() {}, warn() {}, error() {} },
    honorPickerModel: (model, { provider }) => ({ model, provider }), isGrokImageModelName: () => false,
    normalizeImageAspectRatio: (ratio) => ratio || '1:1', normalizeImageQuality: (quality) => quality || '2K', normalizeImageCount: (count) => Number(count) || 1,
    promptWithImageAspectRatio: (prompt) => prompt, imageGenerationSizeFor: () => '1024x1024',
    checkPaidTokenCap, prisma, resolveImageOperation, resolveImageSource, prepareEditCanvas, finishEditCanvas,
    ADMIN_MANAGED_IMAGE_MODEL_NAMES: new Set(), isActiveGrokImageModel: () => false,
    isVerifiedChatImageModelName: () => true, normalizeCatalogModelType: () => ({ type: 'IMAGE' }),
    VERIFIED_CHAT_IMAGE_MODEL_NAMES: new Set(['gpt-image-2']), publicUploadUrl: (url) => url,
    toImageEngineProvider: (provider) => provider.toLowerCase(), fromImageEngineProvider: (_actual, requested) => requested,
    imageProviderAttemptTimeoutMs: () => 1000,
    imageEngine: {
      canEditImage: (spec) => editable && (!spec.background || spec.provider === 'openai'),
      generateImage: async (spec) => { calls.generate.push(spec); return { ok: true, images: [{ b64: outputBytes.toString('base64') }], model: spec.model, provider: 'openai' }; },
      editImage: async (spec) => { calls.edit.push(spec); return { ok: true, images: Array.from({ length: spec.n }, () => ({ b64: outputBytes.toString('base64') })), model: spec.model, provider: 'openai' }; },
    },
    saveBase64Image: async (b64, userId, prompt, aspectRatio, options) => {
      const buffer = Buffer.from(b64, 'base64'); const { width, height } = await sharp(buffer).metadata();
      calls.saves.push({ buffer, userId, prompt, aspectRatio, options });
      return { imageUrl: `/uploads/images/result-${calls.saves.length}.png`, fileId: `result-${calls.saves.length}`, width, height };
    },
    recordApiUsage: async () => ({}), usagePayloadFor: () => ({}), classifyImageGenError,
    // «Fallos de respuesta» hooks (turn-failures) — advisory, stubbed here.
    turnFailures: { recordGenerationFailure: async () => ({}), recordBlankImagesIfAny: async () => false },
    IMAGE_ASPECT_RATIOS: { '1:1': {}, '3:4': {}, '16:9': {}, '9:16': {} },
  };
  vm.runInNewContext(routeSource.slice(routeStart, routeEnd), context, { filename: routeFile });
  async function request(body) {
    const res = new EventEmitter(); res.statusCode = 200; res.writableEnded = false;
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; res.writableEnded = true; return res; };
    res.writeHead = (code) => { res.statusCode = code; res.headersSent = true; };
    res.flushHeaders = () => {}; res.write = () => {};
    res.end = (payload) => { res.body = payload ? JSON.parse(payload) : null; res.writableEnded = true; };
    await handler({ body: { prompt: 'edit', chatId: 'chat', provider: 'OpenAI', model: 'gpt-image-2', ...body }, user: { id: 'owner', ...user } }, res);
    return res;
  }
  return { request, calls, sourceBytes };
}

test('canonical route uses the same beach for vertical follow-up and stores linked versions', async () => {
  const { request, calls, sourceBytes } = await harness();
  const res = await request({ operation: 'edit', prompt: 'ahora la misma imagen pero vertical porfavor', imageCount: 2, quality: '4K' });
  assert.equal(res.statusCode, 200); assert.ok(!res.body.error, res.body.error);
  assert.equal(calls.generate.length, 0); assert.equal(calls.edit.length, 1);
  const spec = calls.edit[0]; assert.equal(spec.model, 'gpt-image-2'); assert.equal(spec.aspectRatio, '3:4'); assert.equal(spec.quality, '4K'); assert.equal(spec.n, 2); assert.equal(spec.failover, false);
  assert.ok(spec.maskBuffer); assert.equal(calls.saves[0].options.preservePixels, true);
  const file = res.body.files[0]; assert.equal(file.parentFileId, 'beach'); assert.equal(file.rootFileId, 'original'); assert.equal(file.version, 3); assert.equal(file.width / file.height, 3 / 4);
  assert.equal(res.body.messageId, 'message-2'); assert.equal(res.body.chatId, 'chat');
  const kept = await sharp(calls.saves[0].buffer).extract({ left: Math.floor((file.width - 8) / 2), top: Math.floor((file.height - 4) / 2), width: 8, height: 4 }).raw().toBuffer();
  assert.deepEqual(kept, await sharp(sourceBytes).raw().toBuffer());
  assert.equal(JSON.parse(calls.messages[1].files)[0].parentFileId, 'beach');
});

test('canonical new generation does not inherit an image from history', async () => {
  const { request, calls } = await harness();
  const res = await request({ prompt: 'crea otra imagen de una ciudad' });
  assert.ok(!res.body.error, res.body.error); assert.equal(calls.generate.length, 1); assert.equal(calls.edit.length, 0); assert.equal(calls.reads, 0);
  assert.equal(res.body.files[0].parentFileId, null); assert.equal(res.body.files[0].version, 1);
});

test('image route preserves paid quota and the canonical superAdmin exemption', async () => {
  for (const isSuperAdmin of [false, true]) {
    const { request, calls } = await harness({ user: { plan: 'PRO', apiUsage: 500, monthlyLimit: 500, isSuperAdmin } });
    const res = await request({ prompt: 'crea otra imagen de una ciudad' });
    assert.equal(res.statusCode, isSuperAdmin ? 200 : 429);
    assert.equal(calls.generate.length, isSuperAdmin ? 1 : 0);
    if (!isSuperAdmin) {
      assert.equal(res.body.error, 'Monthly API limit exceeded');
      assert.deepEqual(res.body.usage, { current: 500, limit: 500 });
      assert.equal(calls.messages.length, 0);
    }
  }
});

test('explicit absent source and absent history fail without generating an unrelated image', async () => {
  for (const setup of [{ source: true }, { source: false }]) {
    const { request, calls } = await harness(setup);
    const res = await request({ operation: 'edit', fileId: setup.source ? 'missing-id' : undefined });
    assert.equal(res.statusCode, 400); assert.equal(res.body.code, 'image_source_required');
    assert.equal(calls.generate.length, 0); assert.equal(calls.edit.length, 0);
  }
});

test('unowned conversation and unsupported selected editor never call a provider', async () => {
  for (const setup of [{ chatOwned: false }, { editable: false }]) {
    const { request, calls } = await harness(setup);
    const res = await request({ operation: 'edit', fileId: 'beach' });
    assert.ok(res.statusCode >= 400); assert.equal(calls.generate.length + calls.edit.length, 0);
  }
});

test('invalid masks fail before provider calls and edits never ignore an explicit source', async () => {
  const { request, calls } = await harness();
  const invalid = await request({ operation: 'edit', fileId: 'beach', maskDataUrl: 'not-a-png' });
  assert.equal(invalid.body.code, 'E_PARAMS');
  const contradictory = await request({ operation: 'generate', fileId: 'beach' });
  assert.equal(contradictory.body.code, 'E_PARAMS');
  assert.equal(calls.generate.length + calls.edit.length, 0);
});

test('remove background binds a real provider transparency parameter and rejects unsupported API before cost', async () => {
  const { request, calls } = await harness();
  const unsupported = await request({ operation: 'edit', fileId: 'beach', background: 'transparent', provider: 'OpenRouter', model: 'openai/gpt-image-2' });
  assert.equal(unsupported.body.code, 'E_PARAMS'); assert.equal(calls.edit.length, 0);
  const supported = await request({ operation: 'edit', fileId: 'beach', background: 'transparent' });
  assert.ok(!supported.body.error); assert.equal(calls.edit[0].background, 'transparent');
  assert.equal(supported.body.files[0].background, 'transparent');
});


test('canonical edit preserves every reference and records source lineage with the explicit reply first', async () => {
  const { request, calls, sourceBytes } = await harness({ references: ['palette', 'logo'] });
  const res = await request({ fileId: 'beach', referenceFileIds: ['palette', 'beach', 'logo'], prompt: 'Usa el logo de la tercera imagen y los colores de la segunda' });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.error, res.body.error);
  assert.equal(calls.edit.length, 1);
  assert.equal(calls.generate.length, 0);
  assert.equal(calls.edit[0].referenceImages.length, 2);
  assert.ok(calls.edit[0].referenceImages.every((image) => image.buffer.equals(sourceBytes)));
  assert.equal(res.body.files[0].parentFileId, 'beach');
  assert.deepEqual(Array.from(res.body.files[0].referenceFileIds), ['beach', 'palette', 'logo']);
  assert.deepEqual(JSON.parse(calls.messages[0].files).map((file) => file.fileId), ['palette', 'logo']);
});

test('references without an explicit fileId select the first reference, never a historical source', async () => {
  const { request, calls } = await harness({ references: ['logo', 'palette'] });
  const res = await request({ referenceFileIds: ['logo', 'palette'], prompt: 'Diseña un anuncio profesional con estas referencias' });
  assert.ok(!res.body.error, res.body.error);
  assert.equal(calls.edit.length, 1);
  assert.equal(res.body.files[0].parentFileId, 'logo');
});

test('an unavailable reference blocks generation before spending or persisting partial results', async () => {
  const { request, calls } = await harness();
  const res = await request({ fileId: 'beach', referenceFileIds: ['beach', 'missing'] });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'image_source_required');
  assert.equal(calls.generate.length + calls.edit.length + calls.saves.length + calls.messages.length, 0);
});

// ── Follow-up context (composer image mode, no fileId) ─────────────────────

test('«cambia el color del logo» without a fileId edits the chat image instead of generating an unrelated one', async () => {
  const { request, calls } = await harness();
  const res = await request({ prompt: 'cambia el color del logo' });
  assert.equal(res.statusCode, 200); assert.ok(!res.body.error, res.body.error);
  assert.equal(calls.edit.length, 1); assert.equal(calls.generate.length, 0);
  assert.ok(calls.reads >= 1);
  assert.equal(res.body.files[0].parentFileId, 'beach');
  assert.equal(JSON.parse(calls.messages[1].files)[0].parentFileId, 'beach');
});

test('«ponle un sombrero al gato» without a fileId is an edit of the chat image', async () => {
  const { request, calls } = await harness();
  const res = await request({ prompt: 'ponle un sombrero al gato' });
  assert.ok(!res.body.error, res.body.error);
  assert.equal(calls.edit.length, 1); assert.equal(calls.generate.length, 0);
  assert.equal(res.body.files[0].parentFileId, 'beach');
});

test('a previous-image cue makes the chat image the canvas and the attachment a reference', async () => {
  const { request, calls } = await harness({ references: ['logo'] });
  const res = await request({ prompt: 'ponle este logo a la imagen anterior', fileId: 'logo', referenceFileIds: ['logo'] });
  assert.equal(res.statusCode, 200); assert.ok(!res.body.error, res.body.error);
  assert.equal(calls.edit.length, 1); assert.equal(calls.generate.length, 0);
  assert.equal(calls.edit[0].referenceImages.length, 1);
  assert.equal(res.body.files[0].parentFileId, 'beach');
});

test('an upload without a stored aspect ratio keeps its own frame instead of the picker default', async () => {
  const { request, calls } = await harness({ sourceAspect: null });
  const res = await request({ operation: 'edit', fileId: 'beach', prompt: 'cambia el fondo a azul' });
  assert.equal(res.statusCode, 200); assert.ok(!res.body.error, res.body.error);
  assert.equal(calls.edit.length, 1);
  assert.equal(calls.edit[0].aspectRatio, '16:9');
});

test('a follow-up promoted to an edit by the history pre-check generates when nothing in the chat can be opened', async () => {
  // The chat's last row only mentions an upload URL in its text (no files
  // entry, no artifact id): the pre-check sees an image, the resolver cannot
  // open it → generate instead of a 400.
  const { request, calls } = await harness({ source: false, history: [{ files: null, content: '/uploads/images/old-result.png' }] });
  const res = await request({ prompt: 'ahora en azul' });
  assert.equal(res.statusCode, 200); assert.ok(!res.body.error, res.body.error);
  assert.equal(calls.generate.length, 1); assert.equal(calls.edit.length, 0);
});

test('a viewer-chosen canvas stays the canvas even when the prompt names the previous image', async () => {
  const { request, calls } = await harness({ references: ['older', 'logo'] });
  const res = await request({ prompt: 'ponle el logo de la última imagen', operation: 'edit', fileId: 'older', referenceFileIds: ['logo'] });
  assert.equal(res.statusCode, 200); assert.ok(!res.body.error, res.body.error);
  assert.equal(calls.edit.length, 1);
  assert.equal(res.body.files[0].parentFileId, 'older');
});

test('a framed deliverable built from an upload takes its frame from the words, not from the upload', async () => {
  const { request, calls } = await harness({ sourceAspect: null, references: ['logo'] });
  const res = await request({ prompt: 'crea un banner con este logo', fileId: 'logo', referenceFileIds: ['logo'] });
  assert.equal(res.statusCode, 200); assert.ok(!res.body.error, res.body.error);
  assert.equal(calls.edit.length, 1);
  assert.equal(calls.edit[0].aspectRatio, '16:9');
});
