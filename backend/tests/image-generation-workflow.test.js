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

async function harness({ source = true, chatOwned = true, editable = true, stateful = false, user = {}, references = [], documents = {}, sourceAspect = '16:9', history = null } = {}) {
  const sourceBytes = await image('#de2070'); const outputBytes = await image('#1040fa');
  const dir = await fixtureDir;
  const sourcePath = path.join(dir, 'source.png'); await fs.writeFile(sourcePath, sourceBytes);
  const calls = { generate: [], edit: [], saves: [], messages: [], reads: 0 };
  const liveHistory = Array.isArray(history) ? [...history] : [];
  const records = source ? { beach: { id: 'beach', filename: 'generated-beach.png', mimeType: 'image/png', path: sourcePath } } : {};
  for (const id of references) records[id] = { id, filename: `${id}.png`, mimeType: 'image/png', path: sourcePath };
  for (const [id, doc] of Object.entries(documents)) {
    records[id] = {
      id,
      originalName: doc.originalName || `${id}.pdf`,
      filename: doc.filename || `${id}.pdf`,
      mimeType: doc.mimeType || 'application/pdf',
      extractedText: doc.extractedText || '',
    };
  }
  const sizedBytesFor = async (aspectRatio, color = '#1040fa') => {
    if (!stateful) return outputBytes;
    if (aspectRatio === '16:9') return image(color, 32, 18);
    if (aspectRatio === '9:16') return image(color, 18, 32);
    if (aspectRatio === '3:4') return image(color, 18, 24);
    return image(color, 16, 16);
  };
  const prisma = {
    chat: { findFirst: async () => chatOwned ? { id: 'chat', title: 'Image' } : null, update: async () => ({}) },
    file: { findFirst: async ({ where }) => records[where.id] || null },
    message: {
      findMany: async () => { calls.reads++; if (stateful) return liveHistory; if (history) return history; return source ? [
        { files: [{ type: 'application/pdf', id: 'document' }] },
        { files: [{ type: 'image/png', fileId: 'beach', version: 2, ...(sourceAspect ? { aspectRatio: sourceAspect } : {}), rootFileId: 'original' }] },
      ] : []; },
      create: async ({ data }) => {
        calls.messages.push(data);
        if (stateful && data.files) liveHistory.unshift({ role: data.role, content: data.content, files: data.files });
        return { id: `message-${calls.messages.length}` };
      },
    },
    aiModel: { findUnique: async ({ where } = {}) => ({ name: where?.name || 'gpt-image-2', provider: editable ? 'OpenAI' : 'Fal', isActive: true, type: 'IMAGE' }) },
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
    VERIFIED_CHAT_IMAGE_MODEL_NAMES: new Set(['gpt-image-2', 'fal-ai/flux-pro/v1.1']), publicUploadUrl: (url) => url,
    toImageEngineProvider: (provider) => provider.toLowerCase(), fromImageEngineProvider: (_actual, requested) => requested,
    imageProviderAttemptTimeoutMs: () => 1000,
    imageEngine: {
      canEditImage: (spec) => editable && (!spec.background || spec.provider === 'openai'),
      generateImage: async (spec) => {
        calls.generate.push(spec);
        const bytes = await sizedBytesFor(spec.aspectRatio, '#92400e');
        return { ok: true, images: [{ b64: bytes.toString('base64') }], model: spec.model, provider: spec.provider || 'openai' };
      },
      editImage: async (spec) => {
        calls.edit.push(spec);
        const bytes = await sizedBytesFor(spec.aspectRatio, '#38bdf8');
        return { ok: true, images: Array.from({ length: spec.n }, () => ({ b64: bytes.toString('base64') })), model: spec.model, provider: spec.provider || 'openai' };
      },
    },
    saveBase64Image: async (b64, userId, prompt, aspectRatio, options) => {
      const buffer = Buffer.from(b64, 'base64'); const { width, height } = await sharp(buffer).metadata();
      calls.saves.push({ buffer, userId, prompt, aspectRatio, options });
      const fileId = `result-${calls.saves.length}`;
      if (stateful) {
        const savedPath = path.join(dir, `${fileId}.png`);
        await fs.writeFile(savedPath, buffer);
        records[fileId] = { id: fileId, filename: `generated-${fileId}.png`, mimeType: 'image/png', path: savedPath };
      }
      return { imageUrl: `/uploads/images/${fileId}.png`, fileId, width, height };
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

test('composer: two uploads in upload order → the photo is the canvas and the logo the material', async () => {
  const { request, calls } = await harness({ source: false, references: ['logo', 'foto'] });
  // The composer sends fileId = files[0] and referenceFileIds = files.
  const res = await request({ prompt: 'ponle este logo a la foto', fileId: 'logo', referenceFileIds: ['logo', 'foto'] });
  assert.equal(res.statusCode, 200); assert.ok(!res.body.error, res.body.error);
  assert.equal(calls.edit.length, 1);
  assert.equal(res.body.files[0].parentFileId, 'foto', 'the photo is edited');
  assert.equal(calls.edit[0].referenceImages.length, 1);
  assert.match(calls.edit[0].prompt, /La imagen 1 \(«foto\.png»\) es el lienzo que se edita; la imagen 2 \(«logo\.png»\) es material/);
  // Viewer «Editar» (explicit operation) keeps the chosen canvas.
  const { request: request2, calls: calls2 } = await harness({ source: false, references: ['logo', 'foto'] });
  const res2 = await request2({ prompt: 'ponle este logo a la foto', operation: 'edit', fileId: 'logo', referenceFileIds: ['foto'] });
  assert.equal(res2.statusCode, 200); assert.ok(!res2.body.error, res2.body.error);
  assert.equal(res2.body.files[0].parentFileId, 'logo');
  assert.equal(calls2.edit.length, 1);
});

test('composer: the user bubble keeps the upload order, API clients keep the first-reference contract, and a tie gets no clause', async () => {
  const { request, calls } = await harness({ source: false, references: ['logo', 'foto'] });
  const res = await request({ prompt: 'ponle este logo a la foto', fileId: 'logo', referenceFileIds: ['logo', 'foto'] });
  assert.equal(res.statusCode, 200); assert.ok(!res.body.error, res.body.error);
  assert.equal(res.body.files[0].parentFileId, 'foto');
  // The persisted user message lists the uploads as they were sent.
  assert.deepEqual(JSON.parse(calls.messages[0].files).map((file) => file.id), ['logo', 'foto']);
  // referenceFileIds alone (API clients, never the composer): first reference = canvas, as before.
  const { request: requestApi, calls: callsApi } = await harness({ source: false, references: ['logo', 'foto'] });
  const api = await requestApi({ prompt: 'ponle este logo a la foto', referenceFileIds: ['logo', 'foto'] });
  assert.equal(api.statusCode, 200); assert.ok(!api.body.error, api.body.error);
  assert.equal(api.body.files[0].parentFileId, 'logo');
  assert.doesNotMatch(callsApi.edit[0].prompt, /es el lienzo/);
  const { request: request2, calls: calls2 } = await harness({ source: false, references: ['a', 'b'] });
  const res2 = await request2({ prompt: 'cambia el fondo de esta foto por este paisaje', fileId: 'a', referenceFileIds: ['a', 'b'] });
  assert.equal(res2.statusCode, 200); assert.ok(!res2.body.error, res2.body.error);
  assert.equal(res2.body.files[0].parentFileId, 'a', 'two photos: upload order');
  assert.doesNotMatch(calls2.edit[0].prompt, /es el lienzo/);
});

test('composer: a catalog slug edits and generates through OpenRouter whatever family the chat inference gives it', async () => {
  const { request, calls } = await harness({ references: ['logo'] });
  const edit = await request({ prompt: 'ponle este logo', provider: 'Gemini', model: 'google/gemini-3.1-flash-image-preview', fileId: 'logo', referenceFileIds: ['logo'] });
  assert.equal(edit.statusCode, 200); assert.ok(!edit.body.error, edit.body.error);
  assert.equal(calls.edit[0].provider, 'openrouter');
  const gen = await request({ prompt: 'un gato astronauta', provider: 'Gemini', model: 'google/gemini-3.1-flash-image-preview' });
  assert.equal(gen.statusCode, 200); assert.ok(!gen.body.error, gen.body.error);
  assert.equal(calls.generate[0].provider, 'openrouter');
  // A bare id keeps its provider.
  await request({ prompt: 'un gato', provider: 'Gemini', model: 'gemini-2.5-flash-image' });
  assert.equal(calls.generate[1].provider, 'gemini');
});

test('composer Image RAG: PDF attached with Imágenes chip grounds generation instead of failing source validation', async () => {
  const { request, calls } = await harness({
    source: false,
    documents: {
      'brand-pdf': {
        originalName: 'manual-marca.pdf',
        mimeType: 'application/pdf',
        extractedText: 'Perfume Solaris: frasco octogonal en vidrio esmerilado con tapa de latón cepillado y paleta corporativa #0F172A y #38BDF8.',
      },
    },
  });
  const res = await request({
    prompt: 'genera una foto de estudio del perfume descrito en el documento',
    fileId: 'brand-pdf',
    referenceFileIds: ['brand-pdf'],
  });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.error, res.body.error);
  assert.equal(calls.generate.length, 1);
  assert.equal(calls.edit.length, 0);
  assert.match(calls.generate[0].prompt, /#0F172A, #38BDF8/);
  assert.match(calls.generate[0].prompt, /vidrio esmerilado/i);
  assert.equal(res.body.files[0].ragGrounded, true);
  assert.equal(res.body.files[0].ragArchetype, 'commercial_product_studio');
  assert.deepEqual(JSON.parse(calls.messages[0].files).map((f) => f.id), ['brand-pdf']);
});

test('composer Image RAG: PDF + photo attached together edits the photo grounded with the PDF brand palette', async () => {
  const { request, calls } = await harness({
    source: false,
    references: ['foto'],
    documents: {
      'brand-pdf': {
        originalName: 'brand-book.pdf',
        mimeType: 'application/pdf',
        extractedText: 'Guía de marca: fondos limpios con colores corporativos #1E293B y #F59E0B.',
      },
    },
  });
  const res = await request({
    prompt: 'cambia el fondo aplicando los colores corporativos del manual de marca',
    fileId: 'brand-pdf',
    referenceFileIds: ['brand-pdf', 'foto'],
  });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.error, res.body.error);
  assert.equal(calls.edit.length, 1);
  assert.equal(calls.generate.length, 0);
  assert.equal(res.body.files[0].parentFileId, 'foto');
  assert.match(calls.edit[0].prompt, /#1E293B, #F59E0B/);
  assert.deepEqual(JSON.parse(calls.messages[0].files).map((f) => f.id), ['brand-pdf', 'foto']);
});

test('composer Image RAG: cross-turn strict continuity carries prior character visual bible', async () => {
  const { request, calls } = await harness({
    history: [
      {
        files: JSON.stringify([
          {
            type: 'image',
            prompt: 'Capitán espacial con traje blanco mate, casco dorado y parche azul cobalto',
            aspectRatio: '16:9',
          },
        ]),
      },
    ],
  });
  const res = await request({
    prompt: 'crea una escena nueva con el mismo personaje explorando un cañón marciano al atardecer',
  });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.error, res.body.error);
  assert.equal(calls.generate.length, 1);
  assert.ok(calls.reads >= 1);
  assert.match(calls.generate[0].prompt, /Series visual continuity:[\s\S]*Capitán espacial con traje blanco mate/);
  assert.equal(res.body.files[0].continuityMode, 'strict');
  assert.match(res.body.files[0].visualAnchor, /Capitán espacial con traje blanco mate/);
});

test('composer Image RAG: 3-turn storyboard preserves Turn 1 visualAnchor in Turn 3 without anchor decay', async () => {
  // Simulate Turn 1 having established protagonist, Turn 2 having stored visualAnchor, and now Turn 3 continuing.
  const { request, calls } = await harness({
    history: [
      {
        files: JSON.stringify([
          {
            type: 'image',
            prompt: 'el mismo personaje reparando el motor de la nave',
            visualAnchor: 'Elena, ingeniera orbital con chaqueta naranja reflectante y casco blanco',
            aspectRatio: '16:9',
          },
        ]),
      },
    ],
  });
  const turn3 = await request({
    prompt: 'el mismo personaje observando la Tierra desde la cúpula espacial',
  });
  assert.equal(turn3.statusCode, 200);
  assert.ok(!turn3.body.error, turn3.body.error);
  assert.equal(turn3.body.files[0].continuityMode, 'strict');
  assert.equal(
    turn3.body.files[0].visualAnchor,
    'Elena, ingeniera orbital con chaqueta naranja reflectante y casco blanco'
  );
  assert.match(
    calls.generate[0].prompt,
    /Elena, ingeniera orbital con chaqueta naranja reflectante y casco blanco/
  );
  assert.match(
    calls.generate[0].prompt,
    /reparando el motor de la nave/
  );
});

test('composer Image RAG: Spanish prompt grounds against an English brand guidelines PDF via cross-lingual expansion', async () => {
  const { request, calls } = await harness({
    source: false,
    documents: {
      'en-brand-pdf': {
        originalName: 'brand-guidelines-en.pdf',
        mimeType: 'application/pdf',
        extractedText: 'Vesper Watch Co. Brand Guidelines: Octagonal bottle and brushed titanium watch case with primary palette #0F172A and Pantone 429 C.',
      },
    },
  });
  const res = await request({
    prompt: 'genera una fotografía comercial del reloj siguiendo los colores del manual de marca',
    fileId: 'en-brand-pdf',
    referenceFileIds: ['en-brand-pdf'],
  });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.error, res.body.error);
  assert.equal(res.body.files[0].ragGrounded, true);
  assert.match(calls.generate[0].prompt, /#0F172A, Pantone 429 C/);
  assert.match(calls.generate[0].prompt, /brushed titanium/i);
});

test('universal context continuity (FLUX 1.1 Pro / generation-only): 3-turn cat flow locks identity + sky-blue (#7DD3FC) + 16:9 Facebook cover on the exact selected model', async () => {
  const { request, calls } = await harness({ source: false, editable: false, stateful: true });

  // Turn 1: "crea una imagen de un gato" -> standalone creation, zero history DB reads.
  const turn1 = await request({
    prompt: 'crea una imagen de un gato',
    provider: 'Fal',
    model: 'fal-ai/flux-pro/v1.1',
    aspectRatio: '1:1',
  });
  assert.equal(turn1.statusCode, 200);
  assert.ok(!turn1.body.error, turn1.body.error);
  assert.equal(calls.reads, 0, 'standalone creation never scans chat history');
  assert.equal(calls.generate.length, 1);
  assert.equal(calls.edit.length, 0);
  assert.equal(calls.generate[0].model, 'fal-ai/flux-pro/v1.1');
  assert.equal(turn1.body.files[0].fileId, 'result-1');
  assert.equal(turn1.body.files[0].version, 1);

  // Turn 2: "el gato de color celeste" -> pivots cleanly from implicit edit to Visual-DNA locked generation on FLUX 1.1 Pro!
  const turn2 = await request({
    prompt: 'el gato de color celeste',
    provider: 'Fal',
    model: 'fal-ai/flux-pro/v1.1',
    aspectRatio: '1:1',
  });
  assert.equal(turn2.statusCode, 200, 'must NOT fail with 400 image_edit_unsupported');
  assert.ok(!turn2.body.error, turn2.body.error);
  assert.equal(calls.edit.length, 0);
  assert.equal(calls.generate.length, 2);
  assert.equal(calls.generate[1].model, 'fal-ai/flux-pro/v1.1', 'never switches user selected model');
  assert.match(calls.generate[1].prompt, /^Reference continuity lock:/);
  assert.match(calls.generate[1].prompt, /#7DD3FC/, 'locks vivid sky-blue hex');
  assert.match(calls.generate[1].prompt, /vivid sky-blue \/ light cerulean/);
  assert.match(calls.generate[1].prompt, /Subject visual DNA/);
  assert.doesNotMatch(calls.generate[1].prompt, /honest uncontrived color/i, 'neutralizes conflicting natural-color realism');
  assert.equal(turn2.body.files[0].parentFileId, 'result-1');
  assert.equal(turn2.body.files[0].rootFileId, 'result-1');
  assert.equal(turn2.body.files[0].version, 2);
  assert.ok(Array.isArray(turn2.body.files[0].activeOverrides) && turn2.body.files[0].activeOverrides.some((o) => o.id === 'sky_blue'));

  // Turn 3: "quiero el gato como portada de Facebook" -> resolves 16:9 AND retains BOTH Turn 1 cat identity AND Turn 2 sky-blue (#7DD3FC)!
  const turn3 = await request({
    prompt: 'quiero el gato como portada de Facebook',
    provider: 'Fal',
    model: 'fal-ai/flux-pro/v1.1',
    aspectRatio: '1:1',
  });
  assert.equal(turn3.statusCode, 200);
  assert.ok(!turn3.body.error, turn3.body.error);
  assert.equal(calls.edit.length, 0);
  assert.equal(calls.generate.length, 3);
  assert.equal(calls.generate[2].model, 'fal-ai/flux-pro/v1.1');
  assert.equal(calls.generate[2].aspectRatio, '16:9');
  assert.equal(turn3.body.aspectRatio, '16:9');
  assert.match(calls.generate[2].prompt, /#7DD3FC/, 'Turn 3 retains Turn 2 sky-blue cumulative state');
  assert.match(calls.generate[2].prompt, /gato/i, 'Turn 3 retains Turn 1 cat subject');
  assert.match(calls.generate[2].prompt, /16:9 \(portada de facebook\)/i);
  assert.equal(turn3.body.files[0].parentFileId, 'result-2');
  assert.equal(turn3.body.files[0].rootFileId, 'result-1');
  assert.equal(turn3.body.files[0].version, 3);

  // Explicit viewer/fileId edit on FLUX 1.1 Pro STILL rejects cleanly with 400 image_edit_unsupported!
  const explicitEdit = await request({
    operation: 'edit',
    fileId: 'result-1',
    prompt: 'cambia el fondo',
    provider: 'Fal',
    model: 'fal-ai/flux-pro/v1.1',
  });
  assert.equal(explicitEdit.statusCode, 400);
  assert.equal(explicitEdit.body.code, 'image_edit_unsupported');
});

test('universal context continuity (GPT Image / edit-capable): 3-turn cat flow edits prior pixels, locks #7DD3FC, and preserves 16:9 Facebook cover without squashing to 1:1', async () => {
  const { request, calls } = await harness({ source: false, editable: true, stateful: true });

  const turn1 = await request({
    prompt: 'crea una imagen de un gato',
    provider: 'OpenAI',
    model: 'gpt-image-2',
    aspectRatio: '1:1',
  });
  assert.equal(turn1.statusCode, 200);
  assert.equal(calls.generate.length, 1);

  const turn2 = await request({
    prompt: 'el gato de color celeste',
    provider: 'OpenAI',
    model: 'gpt-image-2',
    aspectRatio: '1:1',
  });
  assert.equal(turn2.statusCode, 200);
  assert.equal(calls.edit.length, 1);
  assert.match(calls.edit[0].prompt, /#7DD3FC/);
  assert.equal(turn2.body.files[0].parentFileId, 'result-1');
  assert.equal(turn2.body.files[0].version, 2);

  const turn3 = await request({
    prompt: 'quiero el gato como portada de Facebook',
    provider: 'OpenAI',
    model: 'gpt-image-2',
    aspectRatio: '1:1',
  });
  assert.equal(turn3.statusCode, 200);
  assert.equal(calls.edit.length, 2);
  assert.equal(calls.edit[1].aspectRatio, '16:9');
  assert.match(calls.edit[1].prompt, /#7DD3FC/, 'Turn 3 edit prompt keeps cumulative sky-blue state');
  assert.equal(turn3.body.aspectRatio, '16:9');
  assert.equal(
    turn3.body.files[0].width / turn3.body.files[0].height,
    16 / 9,
    'finishEditCanvas skipped on deliverable frame change so 16:9 is not squashed back to 1:1'
  );
  assert.equal(turn3.body.files[0].parentFileId, 'result-2');
  assert.equal(turn3.body.files[0].rootFileId, 'result-1');
  assert.equal(turn3.body.files[0].version, 3);
});

test('composer prompt obedience (FLUX 1.1 Pro): "crea una imagen de un perro celeste" compiles positive English sky-blue fur coat lock (#7DD3FC) before framing with zero brown/gray/merle poisoning', async () => {
  const { request, calls } = await harness({ source: false, editable: false });

  const res = await request({
    prompt: 'crea una imagen de un perro celeste',
    provider: 'Fal',
    model: 'fal-ai/flux-pro/v1.1',
    aspectRatio: '1:1',
    quality: '2K',
  });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.error, res.body.error);
  assert.equal(calls.reads, 0, 'standalone prompt performs zero history DB reads');
  assert.equal(calls.generate.length, 1);
  assert.equal(calls.generate[0].model, 'fal-ai/flux-pro/v1.1');

  const sentPrompt = calls.generate[0].prompt;
  assert.match(sentPrompt, /^un perro celeste Exact scene specification: A vivid sky-blue dog \(#7DD3FC\) with a bright light-cerulean sky-blue fur coat covering its entire head, ears, body, legs, and tail/);
  assert.ok(
    sentPrompt.indexOf('Exact scene specification:') < sentPrompt.indexOf('Visual direction:'),
    'sky-blue dog coat lock sits inside prime CLIP tokens ahead of visual direction'
  );
  assert.doesNotMatch(sentPrompt, /\bbrown\b|\borange\b|\btan\b|\bgray\b|\bgrey\b|\bmerle\b|chiaroscuro|warm tungsten/i);
  assert.equal(res.body.files[0].ragArchetype, 'faithful_subject_focus');
});
