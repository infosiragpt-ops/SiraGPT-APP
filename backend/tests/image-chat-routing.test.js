'use strict';

/**
 * Image follow-ups in the chat («el rag de imágenes pierde el contexto»):
 *   - a per-turn guard refuses generate_image once edit_image could not edit
 *     (no provider / unsupported / no source) — a text-only fallback would
 *     replace the user's image with an unrelated one;
 *   - an image edit / reference turn with image evidence is never claimed by
 *     the Office document runner (isImageMediaTurn veto);
 *   - stream level: an attached-image edit turn skips the runner, the loop
 *     runs with edit_image and the attachment reaches the tool's ctx.
 */

process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { PassThrough } = require('node:stream');

const agentRunner = require('../src/services/agent-runner');
const agenticStream = require('../src/services/agentic-chat-stream');

const { withImageEditGuard } = agenticStream._internal;

const IMAGE_FILES = [{ id: 'img1', name: 'foto.png', mimeType: 'image/png' }];
const IMAGE_TURNS = [
  'cambia el color del logo a azul',
  'ahora quítale el fondo',
  'ponle un sombrero al gato',
  'edita la imagen y ponle un fondo blanco',
  'genera una imagen como esta pero con fondo azul',
  'cambia el fondo a #FF00AA',
];
const DOCUMENT_TURNS_WITH_PHOTO = [
  'crea un documento con estas fotos',
  'genera un pdf con la foto adjunta',
  'inserta esta imagen en el word',
  'ponle el logo a la portada de la ppt',
  'crea una ppt con esta imagen de fondo',
];

function imageTools({ edit, generate } = {}) {
  const calls = { edit: [], generate: [] };
  const tools = [
    {
      name: 'edit_image',
      description: 'edit',
      parameters: { type: 'object', properties: { instruction: { type: 'string' } } },
      execute: async (args, ctx) => { calls.edit.push({ args, ctx }); return edit ? edit(args, ctx) : { ok: true, url: '/edited.png' }; },
    },
    {
      name: 'generate_image',
      description: 'generate',
      parameters: { type: 'object', properties: { prompt: { type: 'string' } } },
      execute: async (args, ctx) => { calls.generate.push({ args, ctx }); return generate ? generate(args, ctx) : { ok: true, url: '/new.png' }; },
    },
    {
      name: 'web_search',
      description: 'search',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      execute: async () => ({ ok: true, results: [] }),
    },
  ];
  return { tools, calls };
}

// ── (1) withImageEditGuard ───────────────────────────────────────────────

test('guard: an unsupported edit refuses generate_image for the rest of the turn', async () => {
  const { tools, calls } = imageTools({ edit: async () => ({ ok: false, code: 'image_edit_unsupported', error: 'x' }) });
  const { tools: wrapped, guard } = withImageEditGuard(tools);
  const byName = Object.fromEntries(wrapped.map((tool) => [tool.name, tool]));
  assert.deepEqual(guard.refusedTools(), []);
  const edit = await byName.edit_image.execute({ instruction: 'quítale el fondo' }, {});
  assert.equal(edit.code, 'image_edit_unsupported');
  const gen = await byName.generate_image.execute({ prompt: 'gato' }, {});
  assert.deepEqual(gen, { ok: false, code: 'image_edit_unsupported', error: 'x', refusedAfterEdit: true });
  assert.equal(calls.generate.length, 0, 'the inner generate_image never runs');
  const again = await byName.edit_image.execute({ instruction: 'otra vez' }, {});
  assert.equal(again.refusedAfterEdit, true);
  assert.equal(calls.edit.length, 1, 'edit_image is refused too');
  assert.deepEqual(guard.refusedTools(), ['edit_image', 'generate_image']);
  assert.equal(byName.web_search.execute, tools[2].execute, 'other tools are untouched');
});

test('guard: NO_PROVIDER behaves like unsupported', async () => {
  const { tools, calls } = imageTools({ edit: async () => ({ ok: false, code: 'NO_PROVIDER', error: 'sin proveedor' }) });
  const { tools: wrapped, guard } = withImageEditGuard(tools);
  const byName = Object.fromEntries(wrapped.map((tool) => [tool.name, tool]));
  await byName.edit_image.execute({ instruction: 'x' }, {});
  const gen = await byName.generate_image.execute({ prompt: 'y' }, {});
  assert.equal(gen.code, 'NO_PROVIDER');
  assert.equal(gen.refusedAfterEdit, true);
  assert.equal(calls.generate.length, 0);
  assert.deepEqual(guard.refusedTools(), ['edit_image', 'generate_image']);
});

test('guard: a missing source refuses only generate_image — edit_image may retry', async () => {
  let attempts = 0;
  const { tools, calls } = imageTools({
    edit: async () => { attempts += 1; return attempts === 1 ? { ok: false, code: 'image_source_required', error: 'no source' } : { ok: true, url: '/edited.png' }; },
  });
  const { tools: wrapped, guard } = withImageEditGuard(tools);
  const byName = Object.fromEntries(wrapped.map((tool) => [tool.name, tool]));
  await byName.edit_image.execute({ instruction: 'x' }, {});
  assert.deepEqual(guard.refusedTools(), ['generate_image']);
  const gen = await byName.generate_image.execute({ prompt: 'y' }, {});
  assert.equal(gen.ok, false);
  assert.equal(gen.code, 'image_source_required');
  assert.equal(gen.refusedAfterEdit, true);
  assert.match(gen.error, /No encontré la imagen que quieres editar/);
  assert.match(gen.error, /No voy a generar una imagen nueva/);
  assert.equal(calls.generate.length, 0);
  const retry = await byName.edit_image.execute({ instruction: 'x', fileId: 'img1' }, {});
  assert.deepEqual(retry, { ok: true, url: '/edited.png' });
  assert.equal(calls.edit.length, 2, 'edit_image retried for real');
});

test('guard: a successful edit (or an unrelated error) never refuses anything', async () => {
  for (const edit of [undefined, async () => ({ ok: false, code: 'E_TIMEOUT', error: 'lento' })]) {
    const { tools, calls } = imageTools({ edit });
    const { tools: wrapped, guard } = withImageEditGuard(tools);
    const byName = Object.fromEntries(wrapped.map((tool) => [tool.name, tool]));
    await byName.edit_image.execute({ instruction: 'x' }, {});
    const gen = await byName.generate_image.execute({ prompt: 'y' }, {});
    assert.deepEqual(gen, { ok: true, url: '/new.png' });
    assert.equal(calls.generate.length, 1);
    assert.deepEqual(guard.refusedTools(), []);
  }
  assert.deepEqual(withImageEditGuard(null).tools, []);
});

// ── (2) isImageMediaTurn + runner veto ───────────────────────────────────

test('isImageMediaTurn: image evidence + image intent, no document noun', () => {
  for (const text of IMAGE_TURNS) {
    assert.equal(agentRunner.isImageMediaTurn(text, { priorArtifactFormat: 'png' }), true, `prior png: ${text}`);
    assert.equal(agentRunner.isImageMediaTurn(text, { priorArtifactFormat: 'foto.JPG' }), true, `prior jpg: ${text}`);
    assert.equal(agentRunner.isImageMediaTurn(text, {}), false, `no evidence: ${text}`);
    assert.equal(agentRunner.isImageMediaTurn(text, { priorArtifactFormat: 'pptx' }), false, `pptx prior: ${text}`);
    assert.equal(agentRunner.isImageMediaTurn(text, { files: [{ name: 'deck.pptx' }, ...IMAGE_FILES] }), false, `mixed files: ${text}`);
  }
  for (const text of ['cambia el color del logo a azul', 'ahora quítale el fondo', 'edita la imagen y ponle un fondo blanco', 'genera una imagen como esta pero con fondo azul', 'cambia el fondo a #FF00AA']) {
    assert.equal(agentRunner.isImageMediaTurn(text, { files: IMAGE_FILES }), true, `attached: ${text}`);
  }
  for (const text of DOCUMENT_TURNS_WITH_PHOTO) {
    assert.equal(agentRunner.isImageMediaTurn(text, { files: IMAGE_FILES }), false, `document noun: ${text}`);
    assert.equal(agentRunner.isImageMediaTurn(text, { priorArtifactFormat: 'png' }), false, `document noun (prior): ${text}`);
  }
  assert.equal(agentRunner.isImageMediaTurn('', { files: IMAGE_FILES }), false);
  assert.equal(agentRunner.isImageMediaTurn('hola', { files: IMAGE_FILES }), false);
});

test('runner veto: image edit turns are never claimed nor runner-only; document turns with a photo keep their claim', () => {
  for (const text of IMAGE_TURNS) {
    assert.equal(agentRunner.shouldRunAgentRunner({ files: IMAGE_FILES, text }), false, `files: ${text}`);
    assert.equal(agentRunner.shouldRunAgentRunner({ hasPriorArtifacts: true, priorArtifactFormat: 'png', text }), false, `prior png: ${text}`);
    assert.equal(agentRunner.isRunnerOnlyDocumentTurn(text, { priorArtifactFormat: 'png', files: IMAGE_FILES }), false, `runner-only: ${text}`);
  }
  for (const text of ['crea un documento con estas fotos', 'genera un pdf con la foto adjunta', 'crea una ppt con esta imagen de fondo']) {
    assert.equal(agentRunner.shouldRunAgentRunner({ files: IMAGE_FILES, text }), true, text);
  }
  // Work verbs aimed at an Office file: the photo upload is not the target.
  for (const text of ['inserta esta imagen en el word', 'ponle el logo a la portada de la ppt']) {
    assert.equal(agentRunner.shouldRunAgentRunner({ files: IMAGE_FILES, fileIds: ['img1'], text }), true, text);
    assert.equal(agentRunner.shouldRunAgentRunner({ hasPriorArtifacts: true, priorArtifactFormat: 'pptx', text }), true, text);
  }
  // No image evidence ⇒ no veto: the style follow-up still claims.
  assert.equal(agentRunner.shouldRunAgentRunner({ text: 'cambia el fondo a #FF00AA' }), true);
  assert.equal(agentRunner.shouldRunAgentRunner({ fileIds: ['f1'], text: 'mejora el diseño' }), true);
});

// ── (3) stream level ────────────────────────────────────────────────────

function fakeRes() {
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (c) => chunks.push(c.toString('utf-8')));
  stream.flushHeaders = () => {};
  stream.setHeader = () => {};
  return { res: stream, chunks };
}

function scriptedClient(toolCalls = []) {
  const calls = [];
  const script = [...toolCalls.map((call) => ({ call })), { finalize: true }];
  let i = 0;
  return {
    calls,
    chat: {
      completions: {
        create: async (opts) => {
          calls.push((opts.tools || []).map((tool) => tool && tool.function && tool.function.name).filter(Boolean));
          const step = script[Math.min(i, script.length - 1)];
          i += 1;
          const fn = step.finalize
            ? { name: 'finalize', arguments: JSON.stringify({ answer: 'Listo: aquí tienes la imagen editada.' }) }
            : { name: step.call.name, arguments: JSON.stringify(step.call.args || {}) };
          return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `call_${i}`, type: 'function', function: fn }] } }] };
        },
      },
    },
  };
}

const STREAM_PATH = '../src/services/agentic-chat-stream';

function loadStream() {
  const spies = { runnerCalls: [] };
  const originalLoad = Module._load;
  Module._load = function patched(request) {
    if (request === './agent-runner' || request.endsWith('/agent-runner')) {
      return {
        ...agentRunner,
        hasConversationArtifacts: async () => false,
        getConversationArtifactFormat: async () => null,
        executeAgentRunnerTurn: async (params) => {
          spies.runnerCalls.push(params);
          return { ok: false, skipped: false, summary: '', artifacts: [], steps: [], stoppedReason: 'no_output', errorMessage: null };
        },
      };
    }
    if (request === './source-preserving-document-edit' || request.endsWith('/source-preserving-document-edit')) {
      return {
        requestWantsProfessionalEditing: () => false,
        isSourcePreservingEditRequest: () => false,
        tryGenerateSourcePreservingDocumentEdit: async () => { throw new Error('the quick editor must not run on an image turn'); },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve(STREAM_PATH)];
  const fresh = require(STREAM_PATH);
  return {
    fresh,
    spies,
    restore() {
      Module._load = originalLoad;
      delete require.cache[require.resolve(STREAM_PATH)];
    },
  };
}

const IMAGE_TOOL_CONTEXT = () => ({
  userId: 'u1',
  chatId: 'c1',
  fileIds: ['img1'],
  fileMetadata: IMAGE_FILES.map((file) => ({ ...file })),
  hasImageAttachment: true,
  prisma: {},
});

test('stream: an attached-image edit turn skips the document runner and the loop edits with edit_image', async () => {
  const { fresh, spies, restore } = loadStream();
  const { tools, calls } = imageTools();
  const openai = scriptedClient([{ name: 'edit_image', args: { instruction: 'cambia el color del logo a azul' } }]);
  try {
    const { res } = fakeRes();
    const result = await fresh.runAgenticChat({
      openai,
      model: 'gpt-4o-mini',
      userQuery: 'cambia el color del logo a azul',
      history: [],
      res,
      maxSteps: 4,
      toolContext: IMAGE_TOOL_CONTEXT(),
      toolsOverride: tools,
    });
    assert.equal(spies.runnerCalls.length, 0, 'the document runner never claims an image edit');
    assert.ok(openai.calls.length > 0, 'the loop ran');
    assert.equal(new Set(openai.calls.flat()).has('edit_image'), true, 'edit_image offered');
    assert.equal(calls.edit.length, 1, 'edit_image executed');
    assert.deepEqual(calls.edit[0].ctx.fileIds, ['img1'], 'the attachment reaches the tool');
    assert.equal(calls.generate.length, 0);
    assert.notEqual(result.stoppedReason, 'agent_runner_failed');
    assert.notEqual(result.stoppedReason, 'agent_runner');
    assert.doesNotMatch(String(result.finalAnswer || ''), /^No pude generar el documento/);
  } finally {
    restore();
  }
});

test('stream: after an unsupported edit, generate_image is refused and finalize is not blocked forever', async () => {
  const { fresh, spies, restore } = loadStream();
  const { tools, calls } = imageTools({ edit: async () => ({ ok: false, code: 'image_edit_unsupported', error: 'El modelo elegido no edita imágenes.' }) });
  const openai = scriptedClient([
    { name: 'edit_image', args: { instruction: 'quítale el fondo' } },
    { name: 'generate_image', args: { prompt: 'logo sin fondo' } },
  ]);
  try {
    const { res } = fakeRes();
    const result = await fresh.runAgenticChat({
      openai,
      model: 'gpt-4o-mini',
      userQuery: 'quítale el fondo',
      history: [],
      res,
      maxSteps: 5,
      toolContext: IMAGE_TOOL_CONTEXT(),
      toolsOverride: tools,
    });
    assert.equal(spies.runnerCalls.length, 0);
    assert.equal(calls.edit.length, 1);
    assert.equal(calls.generate.length, 0, 'the text-only generator never replaces the user image');
    assert.equal(result.stoppedReason, 'finalized', 'the refused edit is waived from the finalize gate');
  } finally {
    restore();
  }
});

// ── (4) Round 2: a prior Office file keeps the runner; a prior png is still prior work ──

test('isImageMediaTurn: with an Office artifact in the chat the picture is material unless named as the object', () => {
  for (const text of ['ponle el logo a la portada', 'cambia el fondo a #FF00AA', 'ponlas todas de color rosa', 'cambia el título a rojo', 'ponle este logo a la portada']) {
    assert.equal(agentRunner.isImageMediaTurn(text, { files: IMAGE_FILES, priorArtifactFormat: 'pptx' }), false, text);
    assert.equal(agentRunner.shouldRunAgentRunner({ files: IMAGE_FILES, fileIds: ['img1'], hasPriorArtifacts: true, priorArtifactFormat: 'pptx', text }), true, text);
  }
  for (const text of ['quita el fondo de esta imagen', 'cambia el color del logo a azul']) {
    assert.equal(agentRunner.isImageMediaTurn(text, { files: IMAGE_FILES, priorArtifactFormat: 'pptx' }), true, text);
  }
  // Deck follow-ups after generating an image keep the runner (the png is not the only prior work).
  for (const text of ['agrégale una conclusión a la misma', 'inserta la imagen en la portada', 'cambia el fondo de todas las láminas a azul']) {
    assert.equal(agentRunner.shouldRunAgentRunner({ hasPriorArtifacts: true, priorArtifactFormat: 'png', text }), true, `prior png: ${text}`);
  }
  // …while edits of that png stay with the chat loop.
  for (const text of ['ponle un sombrero', 'quítale el fondo', 'hazla más oscura']) {
    assert.equal(agentRunner.shouldRunAgentRunner({ hasPriorArtifacts: true, priorArtifactFormat: 'png', text }), false, `prior png: ${text}`);
  }
});

test('stream: «crea una ppt con esta imagen de fondo» with only a picture attached reaches the document runner', async () => {
  const { fresh, spies, restore } = loadStream();
  const { tools, calls } = imageTools();
  const openai = scriptedClient([]);
  try {
    const { res } = fakeRes();
    await fresh.runAgenticChat({
      openai,
      model: 'gpt-4o-mini',
      userQuery: 'crea una ppt con esta imagen de fondo',
      history: [],
      res,
      maxSteps: 3,
      toolContext: IMAGE_TOOL_CONTEXT(),
      toolsOverride: tools,
    });
    assert.equal(spies.runnerCalls.length, 1, 'the document runner claims the deck');
    assert.equal(calls.edit.length, 0, 'the picture is material for the deck, never edited');
  } finally {
    restore();
  }
});
