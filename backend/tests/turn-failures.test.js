'use strict';

/**
 * Turn failure tracker — Admin → Logs → «Fallos de respuesta».
 * One row per FAILED user turn; normal turns write nothing.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

process.env.SIRAGPT_TURN_FAILURES = '1';

const classify = require('../src/services/observability/turn-failures/classify');
const { createTurnFailureStore, mergeMetadata, itemsToCsv } = require('../src/services/observability/turn-failures/store');
const { TurnTap, attachResponseTap, parseDataFrames } = require('../src/services/observability/turn-failures/tap');
const turnFailures = require('../src/services/observability/turn-failures');

// ── In-memory Prisma double (only the shapes the store uses) ───────────
function getPath(obj, keys) {
  return keys.reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), obj);
}
function matchDate(value, cond) {
  const t = new Date(value).getTime();
  if (cond.gte && t < new Date(cond.gte).getTime()) return false;
  if (cond.gt && t <= new Date(cond.gt).getTime()) return false;
  if (cond.lte && t > new Date(cond.lte).getTime()) return false;
  if (cond.lt && t >= new Date(cond.lt).getTime()) return false;
  return true;
}
function matches(row, where) {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'AND') { if (!cond.every((c) => matches(row, c))) return false; continue; }
    if (key === 'OR') { if (!cond.some((c) => matches(row, c))) return false; continue; }
    if (key === 'createdAt' || key === 'timestamp') { if (!matchDate(row[key], cond)) return false; continue; }
    if (key === 'metadata') {
      const v = getPath(row.metadata, cond.path);
      if ('equals' in cond && v !== cond.equals) return false;
      if ('string_contains' in cond && !(typeof v === 'string' && v.includes(cond.string_contains))) return false;
      continue;
    }
    if (cond && typeof cond === 'object' && 'contains' in cond) {
      const v = String(row[key] || '');
      if (!(cond.mode === 'insensitive' ? v.toLowerCase().includes(String(cond.contains).toLowerCase()) : v.includes(cond.contains))) return false;
      continue;
    }
    if (row[key] !== cond) return false;
  }
  return true;
}
function fakePrisma({ failCreate = false } = {}) {
  const rows = [];
  let seq = 0;
  return {
    rows,
    auditLog: {
      async create({ data }) {
        if (failCreate) throw new Error('db down');
        const row = { id: `al_${++seq}`, createdAt: new Date(), ...data };
        rows.push(row);
        return { id: row.id };
      },
      async findFirst({ where }) {
        const found = rows.filter((r) => matches(r, where)).sort((a, b) => b.createdAt - a.createdAt)[0];
        return found ? { id: found.id, metadata: found.metadata } : null;
      },
      async findUnique({ where }) {
        const found = rows.find((r) => r.id === where.id);
        return found ? { metadata: found.metadata } : null;
      },
      async update({ where, data }) {
        const found = rows.find((r) => r.id === where.id);
        Object.assign(found, data);
        return found;
      },
      async findMany({ where, take = 1000, skip = 0 }) {
        return rows.filter((r) => matches(r, where)).sort((a, b) => b.createdAt - a.createdAt).slice(skip, skip + take);
      },
      async count({ where }) { return rows.filter((r) => matches(r, where)).length; },
      async deleteMany({ where }) {
        const keep = rows.filter((r) => !matches(r, where));
        const count = rows.length - keep.length;
        rows.length = 0;
        rows.push(...keep);
        return { count };
      },
    },
    message: { async count() { return 40; } },
    user: { async findUnique({ where }) { return where.id === 'u1' ? { email: 'luis@example.com' } : null; } },
  };
}

function fakeRes() {
  const res = new EventEmitter();
  res.chunks = [];
  res.statusCode = 200;
  res.write = function write(chunk) { this.chunks.push(String(chunk)); return true; };
  res.json = function json(body) { this.body = body; this.emit('finish'); return this; };
  res.status = function status(code) { this.statusCode = code; return this; };
  res.end = function end() { this.emit('finish'); return this; };
  return res;
}

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

describe('classify — categories', () => {
  const base = { startedAt: 0, endedAt: 5_000, prompt: '¿Cuál es la capital de Perú?' };

  it('a normal answer is not recorded', () => {
    assert.equal(classify.classifyTurnOutcome({ ...base, visibleText: 'La capital de Perú es Lima.' }), null);
  });

  it('an explicit Stop is the user\'s choice', () => {
    assert.equal(classify.classifyTurnOutcome({ ...base, userStopped: true, signalAborted: true }), null);
  });

  it('empty quick reply → sin_respuesta; empty slow reply → colgado', () => {
    assert.equal(classify.classifyTurnOutcome({ ...base, visibleText: '' }).category, 'sin_respuesta');
    assert.equal(classify.classifyTurnOutcome({ ...base, endedAt: 81_000, visibleText: '' }).category, 'colgado');
  });

  it('TTFB watchdog abort → colgado', () => {
    const c = classify.classifyTurnOutcome({ ...base, ttfbAborted: true });
    assert.equal(c.category, 'colgado');
    assert.equal(c.severity, 'critical');
    assert.equal(c.sound, 'strong');
  });

  it('lost image (the (a+b)² case) → adjunto_perdido', () => {
    const c = classify.classifyTurnOutcome({
      ...base,
      visibleText: 'Necesito ver la imagen',
      notes: [{ kind: 'attachment_missing', data: { kind: 'image', file: 'files-1.png' } }],
    });
    assert.equal(c.category, 'adjunto_perdido');
    assert.equal(c.cause, 'Imagen no encontrada al responder');
    assert.equal(classify.classifyTurnOutcome({ ...base, visibleText: 'x', requestedFiles: 2, loadedFiles: 1 }).cause, 'Adjunto no cargado (1 de 2)');
  });

  it('provider error frame → error_visible with a groupable «xAI 429» cause', () => {
    const c = classify.classifyTurnOutcome({
      ...base,
      errorFrames: [{ code: 'E_PROVIDER', message: 'El modelo no pudo completar la respuesta.' }],
      notes: [{ kind: 'provider_failure', data: { provider: 'xAI', status: 429 } }],
    });
    assert.equal(c.category, 'error_visible');
    assert.equal(c.cause, 'xAI 429');
    const recovered = classify.classifyTurnOutcome({
      ...base,
      visibleText: 'Lo siento, el servicio no está disponible',
      errorFrames: [{ message: 'AI service temporarily unavailable', recovered: true }],
      notes: [{ kind: 'provider_failure', data: { provider: 'deepseek', status: 402 } }],
    });
    assert.equal(recovered.category, 'error_visible');
    assert.equal(recovered.cause, 'DeepSeek 402 → mensaje de respaldo');
  });

  it('tool / document failures → herramienta_fallida', () => {
    assert.equal(classify.classifyTurnOutcome({ ...base, errorFrames: [{ code: 'agent_runner_failed', message: 'x' }] }).category, 'herramienta_fallida');
    assert.equal(classify.classifyTurnOutcome({ ...base, visibleText: 'No se pudo completar', doneFrame: { ok: false, code: 'FAILED' } }).cause, 'Editor de documentos: edición no completada');
    assert.equal(classify.classifyTurnOutcome({ ...base, doneFrame: { ok: false, code: 'CANCELLED' }, visibleText: 'Edición detenida' }), null);
    // «El documento ya cumplía lo pedido»: an answer, never «herramienta fallida».
    assert.equal(classify.classifyTurnOutcome({ ...base, doneFrame: { ok: false, code: 'NO_CHANGES_NEEDED' },
      visibleText: 'El documento ya cumplía lo pedido, no fue necesario cambiarlo.' }), null);
    const fatal = classify.classifyTurnOutcome({
      ...base,
      visibleText: 'No pude editar el documento.',
      notes: [{ kind: 'tool_failure', data: { tool: 'agent_runner', reason: 'agent_runner_failed', fatal: true } }],
    });
    assert.equal(fatal.category, 'herramienta_fallida');
    assert.equal(fatal.cause, 'Agente de documentos: no entregó el archivo');
  });

  it('a clarifying question is not a failure', () => {
    assert.equal(classify.classifyTurnOutcome({ ...base, errorFrames: [{ code: 'clarification_required', message: '¿Qué imagen quieres editar?' }] }), null);
  });

  it('system abort with no output → cancelado_por_sistema', () => {
    assert.equal(classify.classifyTurnOutcome({ ...base, signalAborted: true }).category, 'cancelado_por_sistema');
  });

  it('artifacts count as output', () => {
    assert.equal(classify.classifyTurnOutcome({ ...base, visibleText: '', artifactsCount: 1 }), null);
  });

  it('recordable HTTP exits → error_visible', () => {
    const c = classify.classifyTurnOutcome({ ...base, httpFailure: { method: 'POST', endpoint: '/api/ai/document-edit', status: 503, code: 'provider_unavailable' } });
    assert.equal(c.category, 'error_visible');
    assert.equal(c.cause, 'POST /api/ai/document-edit → 503 provider_unavailable');
  });
});

describe('classify — «respuesta no entendible» heuristics', () => {
  const run = (text, extra = {}) => classify.classifyTurnOutcome({ startedAt: 0, endedAt: 1000, visibleText: text, prompt: 'explícame la fotosíntesis por favor', ...extra });

  it('leaked tool-call markup', () => {
    assert.equal(run('Voy a buscar.\n```tool_call\n{"tool":"web_search"}\n```').category, 'respuesta_no_entendible');
    assert.equal(run('<function_calls><invoke name="x"></invoke></function_calls>').category, 'respuesta_no_entendible');
  });

  it('[object Object], bare undefined and server stack traces', () => {
    assert.equal(run('Resultado: [object Object]').cause, 'Respuesta con «[object Object]»');
    assert.equal(run('undefined').cause, 'Respuesta «undefined»');
    assert.equal(run('TypeError: x is not a function\n    at foo (/app/src/routes/ai.js:10:5)').cause, 'Respuesta con traza de error del servidor');
  });

  it('claims a file that was not delivered', () => {
    assert.equal(run('Listo. Generé gestion_administrativa.pptx.').category, 'respuesta_no_entendible');
    assert.equal(run('Listo. Generé gestion_administrativa.pptx.', { artifactsCount: 1 }), null);
  });

  it('English answer to a Spanish question (long answers only)', () => {
    const english = 'The photosynthesis process is the way that plants turn light into energy. It is a process that happens in the chloroplasts of the leaf and it has two main stages which are the light reactions and the Calvin cycle. In this process the plant uses water and carbon dioxide and it releases oxygen as a product that we can breathe. '.repeat(2);
    assert.equal(run(english).cause, 'Respuesta en inglés a una pregunta en español');
    assert.equal(run(english, { prompt: 'explain photosynthesis in english' }), null);
  });

  it('bare «Listo» when content was requested', () => {
    assert.equal(run('Listo.').cause, 'Respondió solo «Listo» sin el contenido pedido');
  });

  it('echo of the attachment instead of an answer', () => {
    const doc = 'tiene la facultad de evaluar cada una de las preguntas marcando con una x en las columnas de si o no asimismo le exhortamos en la correccion de los items indicando sus observaciones y sugerencias con la finalidad de mejorar la coherencia de las preguntas sobre la variable en estudio '.repeat(3);
    const out = run(doc, { prompt: 'EN EL MISMO WORD QIERO QUE AGREGES COMENTARIOS EN OBSERVACIONES', attachmentTexts: [doc] });
    assert.equal(out.category, 'respuesta_no_entendible');
    assert.equal(out.cause, 'Devolvió el texto del adjunto en lugar de responder');
    assert.equal(run(doc, { prompt: 'transcribe el texto completo del documento', attachmentTexts: [doc] }), null);
  });

  it('internal agent-task-state fences are stripped, not flagged', () => {
    const text = '```agent-task-state\n{"artifacts":[{"id":"a"}]}\n```\n\nAquí está tu respuesta sobre la fotosíntesis.';
    assert.equal(run(text), null);
    assert.equal(classify.countSentinelArtifacts(text), 1);
  });
});

describe('classify — HTTP filter', () => {
  it('records 5xx and user-facing 4xx, never auth/validation/quota noise', () => {
    assert.equal(classify.isRecordableHttpFailure(500, {}), true);
    assert.equal(classify.isRecordableHttpFailure(503, { error: 'provider_unavailable' }), true);
    assert.equal(classify.isRecordableHttpFailure(503, { message: 'Stripe not configured' }), false);
    assert.equal(classify.isRecordableHttpFailure(402, {}), true);
    assert.equal(classify.isRecordableHttpFailure(413, {}), true);
    assert.equal(classify.isRecordableHttpFailure(400, {}), false);
    assert.equal(classify.isRecordableHttpFailure(401, {}), false);
    assert.equal(classify.isRecordableHttpFailure(404, {}), false);
    assert.equal(classify.isRecordableHttpFailure(429, { error: 'Monthly API limit exceeded' }), false);
    assert.equal(classify.isRecordableHttpFailure(429, { error: 'xAI rate limited' }), true);
  });

  it('provider not configured / feature disabled is a config state at ANY status', () => {
    assert.equal(classify.isRecordableHttpFailure(400, { error: 'ElevenLabs API key not configured', code: 'provider_not_configured' }), false);
    assert.equal(classify.isRecordableHttpFailure(424, { error: 'Feature disabled on this server' }), false);
    assert.equal(classify.isRecordableHttpFailure(500, { error: 'OPENAI_API_KEY not configured' }), false);
    assert.equal(classify.isRecordableHttpFailure(503, { ok: false, error: 'El servicio de música no está configurado.' }), false);
  });
});

describe('media generation failures (image / video / music / voice)', () => {
  const generation = require('../src/services/observability/turn-failures/generation');
  let prisma;
  beforeEach(() => {
    prisma = fakePrisma();
    turnFailures.__setStoreForTests(createTurnFailureStore({ prisma }));
  });
  afterEach(() => turnFailures.__setStoreForTests(null));
  const flush = () => new Promise((r) => setTimeout(r, 30));
  const genReq = (body = {}) => ({
    method: 'POST',
    baseUrl: '/api/ai',
    route: { path: '/generate-image' },
    originalUrl: '/api/ai/generate-image',
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/140.0 Safari/537.36', 'x-request-id': 'req-gen-1' },
    user: { id: 'u1', email: 'luis@example.com' },
    body,
  });

  it('names the reason: moderation, timeout, credits, rate limit, empty, degenerate', () => {
    const cause = (d) => generation.generationCause(d);
    assert.equal(cause({ kind: 'image', provider: 'xai', message: 'Request blocked by content moderation' }), 'Generación de imagen: rechazada por moderación · xAI');
    assert.equal(cause({ kind: 'image', message: 'Image generation timeout' }), 'Generación de imagen: tiempo agotado');
    assert.equal(cause({ kind: 'music', code: 'INSUFFICIENT_CREDITS', message: 'x' }), 'Generación de música: sin saldo en el proveedor');
    assert.equal(cause({ kind: 'video', message: 'Video generation rate limit exceeded' }), 'Generación de video: límite de peticiones del proveedor');
    assert.equal(cause({ kind: 'image', message: 'Image provider did not return any image data.' }), 'Generación de imagen: el proveedor no devolvió resultado');
    assert.equal(cause({ kind: 'speech', degenerate: 'archivo_vacio', provider: 'elevenlabs' }), 'Generación de voz: archivo vacío (0 bytes) · ElevenLabs');
    assert.equal(cause({ kind: 'image', degenerate: 'imagen_en_blanco' }), 'Generación de imagen: imagen en blanco');
    assert.equal(generation.generationKindOfTool('generate_music'), 'music');
    assert.equal(generation.generationKindOfTool('web_search'), null);
  });

  it('a failed media tool inside a chat turn → herramienta_fallida + subtype, even with a polite answer', async () => {
    const res = fakeRes();
    const tap = turnFailures.beginTurn(genReq({ chatId: 'chat-img', prompt: 'hazme un gato astronauta' }), res, {
      route: 'generate', context: { chatId: 'chat-img', idempotencyKey: 'turn-g1', prompt: 'hazme un gato astronauta', modelPicked: 'deepseek-v4-flash' },
    });
    await Promise.resolve();
    turnFailures.observeGenerationToolEvent({ type: 'tool_output', tool: 'generate_image', preview: 'Generando imagen…', partial: true });
    turnFailures.observeGenerationToolEvent(
      { type: 'tool_output', tool: 'generate_image', ok: false, preview: 'Error: Your request was rejected by the safety system' },
      { imageProvider: 'openai', imageModel: 'gpt-image-2' },
    );
    res.write(frame({ content: 'No pude generar la imagen porque el proveedor la rechazó.' }));
    const cls = turnFailures.finishTurn(tap, { finalText: 'No pude generar la imagen porque el proveedor la rechazó.' });
    assert.equal(cls.category, 'herramienta_fallida');
    assert.equal(cls.subtype, 'generacion_imagen');
    await flush();
    assert.equal(prisma.rows.length, 1);
    const m = prisma.rows[0].metadata;
    assert.equal(m.subtype, 'generacion_imagen');
    assert.equal(m.cause, 'Generación de imagen: rechazada por moderación · OpenAI');
    assert.equal(m.prompt, 'hazme un gato astronauta');
    const note = m.notes.find((n) => n.kind === 'generation_failure');
    assert.equal(note.data.model, 'gpt-image-2');
  });

  it('the agent retrying successfully clears the error; a 0-byte artifact never clears', async () => {
    const res = fakeRes();
    const tap = turnFailures.beginTurn(genReq({}), res, { route: 'generate', context: { prompt: 'una canción', idempotencyKey: 't2' } });
    await Promise.resolve();
    turnFailures.observeGenerationToolEvent({ type: 'tool_output', tool: 'generate_music', ok: false, preview: 'timeout' });
    turnFailures.observeGenerationToolEvent({ type: 'tool_output', tool: 'generate_music', ok: true, preview: 'Música lista' });
    res.write(frame({ content: 'Aquí tienes tu canción.' }));
    assert.equal(turnFailures.finishTurn(tap, { finalText: 'Aquí tienes tu canción.' }), null, 'recovered in the same turn → normal');

    const res2 = fakeRes();
    const tap2 = turnFailures.beginTurn(genReq({}), res2, { route: 'generate', context: { prompt: 'léelo en voz alta', idempotencyKey: 't3' } });
    await Promise.resolve();
    turnFailures.observeGenerationToolEvent({ type: 'file_artifact', artifact: { mime: 'audio/mpeg', kind: 'speech', sizeBytes: 0, downloadUrl: '/x' } });
    turnFailures.observeGenerationToolEvent({ type: 'tool_output', tool: 'generate_speech', ok: true, preview: 'Audio listo' });
    res2.write(frame({ content: 'Listo, aquí está el audio.' }));
    const cls = turnFailures.finishTurn(tap2, { finalText: 'Listo, aquí está el audio.' });
    assert.equal(cls.category, 'herramienta_fallida');
    assert.equal(cls.subtype, 'generacion_voz');
    assert.match(cls.cause, /archivo vacío/);
  });

  it('composer routes record one row with provider / model / prompt, and mute the generic HTTP row', async () => {
    const req = genReq({ prompt: 'logo minimalista', provider: 'Gemini', model: 'imagen-4.0-generate-001', chatId: 'chat-9' });
    const mw = turnFailures.httpFailureMiddleware();
    const res = fakeRes();
    await new Promise((resolve) => mw(req, res, resolve));
    await turnFailures.recordGenerationFailure(req, {
      kind: 'image', code: 'provider_quota', message: 'RESOURCE_EXHAUSTED: quota exceeded', status: 429, startedAt: Date.now() - 4200,
      userSaw: 'No se pudo generar la imagen: límite del proveedor',
    });
    res.status(429).json({ error: 'límite', code: 'provider_quota' });
    await flush();
    assert.equal(prisma.rows.length, 1, 'no second generic «POST … → 429» row');
    const m = prisma.rows[0].metadata;
    assert.equal(m.category, 'herramienta_fallida');
    assert.equal(m.subtype, 'generacion_imagen');
    assert.equal(m.prompt, 'logo minimalista');
    assert.equal(m.providerUsed, 'Gemini');
    assert.equal(m.modelLabel, 'imagen-4.0-generate-001');
    assert.equal(m.whatUserSaw, 'No se pudo generar la imagen: límite del proveedor');
    assert.equal(m.generation.reason, 'limite');
    assert.deepEqual(m.reqIds, ['req-gen-1']);
    assert.ok(m.totalMs >= 4000);
  });

  it('never records «not configured» or requests without a user', async () => {
    await turnFailures.recordGenerationFailure(genReq({}), { kind: 'speech', code: 'ELEVENLABS_NOT_CONFIGURED', message: 'ElevenLabs API key not configured' });
    await turnFailures.recordGenerationFailure({ ...genReq({}), user: null }, { kind: 'image', message: 'boom' });
    await flush();
    assert.equal(prisma.rows.length, 0);
  });

  it('detects a blank generated picture (flat colour) and records it off the response path', async () => {
    const sharp = require('sharp');
    const blank = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
    const pixels = Buffer.alloc(64 * 64 * 3);
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 37) % 256;
    const busy = await sharp(pixels, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
    assert.equal(await generation.isBlankImage(blank), true);
    assert.equal(await generation.isBlankImage(busy), false);
    assert.equal(await generation.isBlankImage(Buffer.from('not an image')), false);

    const req = genReq({ prompt: 'un paisaje', provider: 'fal', model: 'fal-ai/flux/schnell', chatId: 'chat-b' });
    assert.equal(await turnFailures.recordBlankImagesIfAny(req, [{ b64: busy.toString('base64') }], { provider: 'fal' }), false);
    assert.equal(await turnFailures.recordBlankImagesIfAny(req, [{ b64: blank.toString('base64') }], { provider: 'fal', model: 'fal-ai/flux/schnell' }), true);
    await flush();
    assert.equal(prisma.rows.length, 1);
    assert.equal(prisma.rows[0].metadata.cause, 'Generación de imagen: imagen en blanco · fal.ai');
    assert.equal(prisma.rows[0].metadata.whatUserSaw, 'Una imagen en blanco');
  });
});

describe('store — record / merge / flood / queries', () => {
  it('creates one row per failed turn with the user email resolved', async () => {
    const prisma = fakePrisma();
    const store = createTurnFailureStore({ prisma });
    const res = await store.record({ resourceId: 'c1:k1', userId: 'u1', metadata: { category: 'sin_respuesta', severity: 'critical', cause: 'Respuesta vacía', fingerprint: 'f1' } });
    assert.ok(res.id);
    assert.equal(prisma.rows.length, 1);
    assert.equal(prisma.rows[0].action, 'turn_failed');
    assert.equal(prisma.rows[0].resourceType, 'chat_turn');
    assert.equal(prisma.rows[0].actorName, 'luis@example.com');
    assert.deepEqual(prisma.rows[0].metadata.tags, ['turn-failure', 'sin_respuesta', 'critical']);
  });

  it('a second signal for the same turn merges; the most severe stays primary', async () => {
    const prisma = fakePrisma();
    const store = createTurnFailureStore({ prisma });
    await store.record({ resourceId: 'c1:k1', metadata: { category: 'respuesta_no_entendible', severity: 'medium', cause: 'a', fingerprint: 'a', signals: [{ source: 'server' }] } });
    const second = await store.record({ resourceId: 'c1:k1', metadata: { category: 'colgado', severity: 'critical', cause: 'b', fingerprint: 'b', signals: [{ source: 'client' }] } });
    assert.equal(second.merged, true);
    assert.equal(prisma.rows.length, 1);
    const m = prisma.rows[0].metadata;
    assert.equal(m.category, 'colgado');
    assert.equal(m.occurrences, 2);
    assert.equal(m.signals.length, 2);
  });

  it('floods of one cause are rate-limited', async () => {
    const prisma = fakePrisma();
    const store = createTurnFailureStore({ prisma, rateLimitPerMinute: 2 });
    for (let i = 0; i < 5; i += 1) {
      await store.record({ resourceId: `c:${i}`, metadata: { category: 'error_visible', severity: 'high', cause: 'xAI 429', fingerprint: 'error_visible|xai 429' } });
    }
    assert.equal(prisma.rows.length, 2);
  });

  it('never throws when the database fails', async () => {
    const store = createTurnFailureStore({ prisma: fakePrisma({ failCreate: true }), logger: { warn() {} } });
    assert.deepEqual(await store.record({ resourceId: 'x', metadata: { category: 'sin_respuesta', severity: 'critical' } }), {});
    assert.deepEqual(await store.record(null), {});
  });

  it('secrets are redacted from stored metadata', async () => {
    const prisma = fakePrisma();
    const store = createTurnFailureStore({ prisma });
    await store.record({ resourceId: 'c:s', metadata: { category: 'error_visible', severity: 'high', cause: 'x', errorMessage: 'Authorization: Bearer abc.def.ghi and key sk-proj-1234567890abcdef' } });
    const msg = prisma.rows[0].metadata.errorMessage;
    assert.ok(!msg.includes('sk-proj-1234567890abcdef'));
    assert.ok(msg.includes('[REDACTED'));
  });

  it('list filters by category/model/text; recent polls; stats groups causes with trend', async () => {
    const prisma = fakePrisma();
    let now = Date.parse('2026-09-26T12:00:00Z');
    const store = createTurnFailureStore({ prisma, now: () => now });
    const put = async (id, category, cause, modelLabel, agoMs) => {
      now = Date.parse('2026-09-26T12:00:00Z') - agoMs;
      await store.record({ resourceId: id, userId: 'u1', metadata: { category, severity: classify.CATEGORIES[category].severity, cause, fingerprint: classify.fingerprintOf(category, cause), modelLabel, prompt: `pregunta ${id}` } });
      prisma.rows[prisma.rows.length - 1].createdAt = new Date(now);
    };
    const HOUR = 3600e3;
    await put('a', 'error_visible', 'xAI 429', 'Grok 4.7', 1 * HOUR);
    await put('b', 'error_visible', 'xAI 429', 'Grok 4.7', 2 * HOUR);
    await put('c', 'adjunto_perdido', 'Imagen no encontrada al responder', 'Grok 4.7', 3 * HOUR);
    await put('d', 'error_visible', 'xAI 429', 'Grok 4.7', 30 * HOUR); // previous 24 h window
    now = Date.parse('2026-09-26T12:00:00Z');

    const byCat = await store.list({ category: 'adjunto_perdido' });
    assert.equal(byCat.items.length, 1);
    assert.equal(byCat.items[0].categoryLabel, 'Adjunto perdido');
    assert.equal((await store.list({ model: 'Grok 4.7' })).items.length, 4);
    assert.equal((await store.list({ q: 'pregunta c' })).items.length, 1);

    const stats = await store.stats();
    assert.equal(stats.counts.last24h, 3);
    const top = stats.topCauses['24h'][0];
    assert.equal(top.cause, 'xAI 429');
    assert.equal(top.count, 2);
    assert.equal(top.previousCount, 1);
    assert.equal(top.trendPct, 100);
    assert.equal(top.affectedUsers, 1);
    assert.ok(top.examples.length >= 1);
    assert.equal(stats.failureRate24h.total, 40);

    const recent = await store.recent({ since: new Date(now - 1.5 * HOUR).toISOString() });
    assert.equal(recent.count, 1);
    assert.equal(recent.items[0].cause, 'xAI 429');
    assert.equal((await store.recent({})).count, 0);
  });

  it('retention sweep deletes only expired turn_failed rows', async () => {
    const prisma = fakePrisma();
    const store = createTurnFailureStore({ prisma });
    await store.record({ resourceId: 'old', metadata: { category: 'sin_respuesta', severity: 'critical', cause: 'x', fingerprint: 'x' } });
    prisma.rows[0].createdAt = new Date(Date.now() - 40 * 86400e3);
    prisma.rows.push({ id: 'other', action: 'login', createdAt: new Date(Date.now() - 400 * 86400e3) });
    const res = await store.sweepExpired({ retentionDays: 30 });
    assert.equal(res.deleted, 1);
    assert.equal(prisma.rows.length, 1);
    assert.equal(prisma.rows[0].id, 'other');
  });

  it('mergeMetadata keeps reqIds unique and CSV escapes fields', () => {
    const m = mergeMetadata({ reqIds: ['a'], severity: 'high' }, { reqIds: ['a', 'b'], severity: 'medium' });
    assert.deepEqual(m.reqIds, ['a', 'b']);
    const csv = itemsToCsv([{ createdAt: 't', categoryLabel: 'Sin respuesta', prompt: 'hola, "mundo"', metadata: {} }]);
    assert.ok(csv.includes('"hola, ""mundo"""'));
  });
});

describe('tap — what the user actually saw', () => {
  it('parses SSE frames (content, replace, error, stage, done, final)', () => {
    const tap = new TurnTap({ route: 'generate' });
    tap.observeWrite(frame({ type: 'stage', label: 'Leyendo el archivo adjunto' }));
    tap.observeWrite(frame({ content: 'Hola' }) + frame({ content: ' Luis' }));
    assert.equal(tap.visibleText, 'Hola Luis');
    tap.observeWrite(frame({ replace: true, content: 'Nuevo' }));
    assert.equal(tap.visibleText, 'Nuevo');
    tap.observeWrite(frame({ type: 'error', code: 'E_PROVIDER', message: 'fallo' }));
    assert.equal(tap.errorFrames[0].code, 'E_PROVIDER');
    tap.observeWrite(frame({ type: 'done', ok: false, code: 'FAILED', content: 'No se pudo', files: [] }));
    assert.equal(tap.doneFrame.ok, false);
    tap.observeWrite(frame({ type: 'final', content: 'Documento listo', file: { url: '/x' } }));
    assert.equal(tap.frameArtifacts, 1);
    assert.equal(tap.stages[0].label, 'Leyendo el archivo adjunto');
    assert.deepEqual(parseDataFrames(': ping\n\n'), []);
  });

  it('sees frames written through a later raw-write capture (mirror guard)', () => {
    const tap = new TurnTap({ route: 'generate' });
    const res = fakeRes();
    attachResponseTap(tap, res);
    const rawWrite = res.write.bind(res); // what the route stores as _siraRawWrite
    rawWrite(frame({ type: 'error', code: 'connection_unavailable', message: 'Conexión no disponible' }));
    assert.equal(tap.errorFrames.length, 1);
    assert.equal(res.chunks.length, 1);
  });
});

describe('turn lifecycle — beginTurn / noteTurn / finishTurn', () => {
  let prisma;
  beforeEach(() => {
    prisma = fakePrisma();
    turnFailures.__setStoreForTests(createTurnFailureStore({ prisma }));
  });
  afterEach(() => turnFailures.__setStoreForTests(null));

  const req = (body = {}) => ({ method: 'POST', baseUrl: '/api/ai', path: '/generate', headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15' }, user: { id: 'u1', email: 'luis@example.com' }, body });
  const flush = () => new Promise((r) => setTimeout(r, 20));

  it('records the lost-image turn with context noted deep in the async chain', async () => {
    const res = fakeRes();
    const r = req({ chatId: 'cmuj01io7000jpj5kuy7nyolt', idempotencyKey: 'turn-1', prompt: 'resolver este problema', model: 'grok-4.7' });
    const tap = turnFailures.beginTurn(r, res, { route: 'generate', context: { chatId: r.body.chatId, idempotencyKey: 'turn-1', prompt: r.body.prompt, modelPicked: 'grok-4.7' } });
    tap.set({ modelLabel: 'Grok 4.7' });
    await (async () => {
      await Promise.resolve();
      turnFailures.noteTurn('model', { provider: 'xAI', model: 'grok-4.7', fallbacks: [] });
      turnFailures.noteTurn('attachment_missing', { kind: 'image', file: 'files-1790464059991.png' });
      turnFailures.noteTurn('provider_aborted', { provider: 'xAI' });
    })();
    const cls = turnFailures.finishTurn(tap, { signalAborted: true, finalText: '' });
    assert.equal(cls.category, 'adjunto_perdido');
    await flush();
    assert.equal(prisma.rows.length, 1);
    const m = prisma.rows[0].metadata;
    assert.equal(prisma.rows[0].resourceId, 'cmuj01io7000jpj5kuy7nyolt:turn-1');
    assert.equal(m.modelLabel, 'Grok 4.7');
    assert.equal(m.providerUsed, 'xAI');
    assert.equal(m.whatUserSaw, '(nada)');
    assert.equal(m.openLink, '/agentes/cmuj01io7000jpj5kuy7nyolt');
    assert.equal(m.browser, 'Safari 26.5 · macOS');
    assert.ok(m.notes.some((n) => n.kind === 'attachment_missing'));
    assert.equal(turnFailures.finishTurn(tap, {}), null, 'finishTurn is idempotent');
  });

  it('converges with the «never end in silence» guard: its honest message is what the user saw, the turn still failed', async () => {
    const res = fakeRes();
    const tap = turnFailures.beginTurn(req({}), res, { route: 'generate', context: { chatId: 'chat-empty', idempotencyKey: 'turn-e', prompt: 'explícame esto' } });
    const honest = 'El modelo terminó sin dar una respuesta. Vuelve a enviar tu mensaje; si se repite, prueba con otro modelo.';
    res.write(frame({ content: honest }));
    tap.note('turn_no_output', { category: 'sin_respuesta', message: honest });
    const cls = turnFailures.finishTurn(tap, { finalText: honest, streamCompleted: true });
    assert.equal(cls.category, 'sin_respuesta');
    await flush();
    assert.equal(prisma.rows.length, 1);
    assert.equal(prisma.rows[0].metadata.whatUserSaw, honest);

    const res2 = fakeRes();
    const tap2 = turnFailures.beginTurn(req({}), res2, { route: 'generate', context: { idempotencyKey: 'turn-w' } });
    tap2.note('turn_no_output', { category: 'cancelado_por_sistema', message: 'El modelo no empezó a responder a tiempo…' });
    assert.equal(turnFailures.finishTurn(tap2, { finalText: 'El modelo no empezó a responder a tiempo…' }).category, 'colgado');
  });

  it('a normal streamed answer writes nothing', async () => {
    const res = fakeRes();
    const tap = turnFailures.beginTurn(req({}), res, { route: 'generate', context: { prompt: 'hola' } });
    res.write(frame({ content: 'Hola, ¿en qué te ayudo?' }));
    assert.equal(turnFailures.finishTurn(tap, { streamCompleted: true }), null);
    await flush();
    assert.equal(prisma.rows.length, 0);
  });

  it('a validation 400 JSON exit is never «sin respuesta»; a 503 JSON exit is recorded', async () => {
    const res = fakeRes();
    turnFailures.beginTurn(req({}), res, { route: 'generate' });
    res.status(400).json({ errors: [] });
    await flush();
    assert.equal(prisma.rows.length, 0);
    const res2 = fakeRes();
    turnFailures.beginTurn(req({ chatId: 'c2', idempotencyKey: 'k2' }), res2, { route: 'document-edit', context: { chatId: 'c2', idempotencyKey: 'k2' } });
    res2.status(503).json({ error: 'provider_unavailable', message: 'El modelo no está disponible' });
    await flush();
    assert.equal(prisma.rows.length, 1);
    assert.equal(prisma.rows[0].metadata.category, 'error_visible');
    assert.match(prisma.rows[0].metadata.cause, /503 provider_unavailable/);
  });

  it('replays (duplicate turn / resume follower) are never recorded', async () => {
    const res = fakeRes();
    const tap = turnFailures.beginTurn(req({}), res, { route: 'generate' });
    assert.equal(turnFailures.finishTurn(tap, { replay: true }), null);
    await flush();
    assert.equal(prisma.rows.length, 0);
  });

  it('a turn that never finalizes is recorded as sin_cierre by the sweeper', async () => {
    const res = fakeRes();
    const tap = turnFailures.beginTurn(req({ chatId: 'c9', idempotencyKey: 'k9' }), res, { route: 'generate', context: { chatId: 'c9', idempotencyKey: 'k9' } });
    tap.startedAt -= 11 * 60 * 1000;
    tap.lastActivityAt -= 11 * 60 * 1000;
    await Promise.all(turnFailures.sweepUnfinished());
    assert.equal(prisma.rows.length, 1);
    assert.equal(prisma.rows[0].metadata.category, 'sin_cierre');
    turnFailures.finishTurn(tap, { replay: true });
  });

  it('a browser report merges into the same turn row as the server', async () => {
    const res = fakeRes();
    const r = req({ chatId: 'c3', idempotencyKey: 'k3' });
    const tap = turnFailures.beginTurn(r, res, { route: 'generate', context: { chatId: 'c3', idempotencyKey: 'k3', prompt: 'hola' } });
    turnFailures.finishTurn(tap, { signalAborted: false, finalText: '' });
    await flush();
    await turnFailures.recordClientSignal({ message: 'El stream terminó antes de completar', turn: { chatId: 'c3', idempotencyKey: 'k3', reason: 'stream_error', model: 'grok-4.7' } }, r);
    assert.equal(prisma.rows.length, 1);
    assert.equal(prisma.rows[0].metadata.occurrences, 2);
    assert.deepEqual(prisma.rows[0].metadata.signals.map((s) => s.source), ['server', 'client']);
  });

  it('client signals need a known reason and an authenticated user', async () => {
    await turnFailures.recordClientSignal({ turn: { reason: 'whatever' } }, req({}));
    await turnFailures.recordClientSignal({ turn: { reason: 'no_activity' } }, { headers: {} });
    assert.equal(prisma.rows.length, 0);
    await turnFailures.recordClientSignal({ turn: { chatId: 'c4', streamId: 's4', reason: 'no_activity', elapsedMs: 95000 } }, req({}));
    assert.equal(prisma.rows[0].metadata.category, 'colgado');
    assert.equal(prisma.rows[0].metadata.cause, 'Sin actividad en el navegador durante 95 s');
  });

  it('thumbs-down → usuario_reporto', async () => {
    await turnFailures.recordFeedbackFailure({ userId: 'u1', chatId: 'c5', messageId: 'm5', reasonCode: 'incorrect', prompt: '¿cuánto es 2+2?', response: '5', model: 'Grok 4.7' });
    assert.equal(prisma.rows[0].metadata.category, 'usuario_reporto');
    assert.equal(prisma.rows[0].metadata.cause, 'Pulgar abajo: incorrect');
    assert.equal(prisma.rows[0].metadata.sound, 'soft');
  });

  it('agent tasks: failed and partial transcription are recorded, success is not', async () => {
    await turnFailures.recordAgentTaskFailure({ taskId: 't1', userId: 'u1', chatId: 'c6', displayGoal: 'transcribir el video', stats: { stoppedReason: 'media_batch_failed' } }, 'error');
    await turnFailures.recordAgentTaskFailure({ taskId: 't2', userId: 'u1', chatId: 'c6', stats: { stoppedReason: 'media_batch_partial' } }, 'completed');
    await turnFailures.recordAgentTaskFailure({ taskId: 't3', userId: 'u1', chatId: 'c6', stats: { stoppedReason: 'final' } }, 'completed');
    assert.equal(prisma.rows.length, 2);
    assert.equal(prisma.rows[0].metadata.cause, 'Transcripción: falló');
    assert.equal(prisma.rows[1].metadata.cause, 'Transcripción: algunos archivos fallaron');
    assert.equal(prisma.rows[1].metadata.severity, 'medium');
  });
});

describe('httpFailureMiddleware — non-2xx on user endpoints', () => {
  let prisma;
  beforeEach(() => {
    prisma = fakePrisma();
    turnFailures.__setStoreForTests(createTurnFailureStore({ prisma }));
  });
  afterEach(() => turnFailures.__setStoreForTests(null));
  const run = async ({ url, method = 'POST', status, body = {}, extra = {} }) => {
    const mw = turnFailures.httpFailureMiddleware();
    const req = { originalUrl: url, method, headers: {}, body: { chatId: 'c7' }, user: { id: 'u1', email: 'luis@example.com' }, ...extra };
    const res = fakeRes();
    await new Promise((resolve) => mw(req, res, resolve));
    res.status(status).json(body);
    await new Promise((r) => setTimeout(r, 20));
  };

  it('records 5xx with method, endpoint and status', async () => {
    await run({ url: '/api/files/upload', status: 500, body: { error: 'upload_failed' } });
    assert.equal(prisma.rows.length, 1);
    assert.equal(prisma.rows[0].metadata.cause, 'POST /api/files/upload → 500 upload_failed');
    assert.equal(prisma.rows[0].metadata.chatId, 'c7');
  });

  it('skips validation noise, GET 4xx, admin paths and self-classified turn routes', async () => {
    await run({ url: '/api/files/upload', status: 400 });
    await run({ url: '/api/chats/c7', method: 'GET', status: 404 });
    await run({ url: '/api/admin/users', status: 500 });
    await run({ url: '/api/ai/generate', status: 500, extra: { _turnTap: {} } });
    assert.equal(prisma.rows.length, 0);
  });
});

describe('wiring contracts', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

  it('the empty-turn guard (services/turn-outcome) tells the tracker why the turn failed', () => {
    const ai = read('src/routes/ai.js');
    assert.match(ai, /if \(__turnTap\) __turnTap\.note\('turn_no_output', \{ category: __emptyTurn\.category, message: __emptyTurn\.message \}\);/);
  });

  it('media generation is tracked on the agentic path and on every composer route', () => {
    const stream = read('src/services/agentic-chat-stream.js');
    assert.match(stream, /require\('\.\/observability\/turn-failures'\)\.observeGenerationToolEvent\(evt, toolContext\)/);
    const tools = read('src/services/agents/visual-media-tools.js');
    assert.match(tools, /noteBlankImage\(buffer, \{\s*tool: 'generate_image'/);
    const ai = read('src/routes/ai.js');
    for (const kind of ['image', 'speech', 'music', 'video']) {
      assert.match(ai, new RegExp(`turnFailures\\.recordGenerationFailure\\(req, \\{\\s*kind: '${kind}'`), kind);
    }
    assert.match(ai, /turnFailures\.recordBlankImagesIfAny\(req, imageResults/);
    assert.match(ai, /resourceKey: `video:\$\{req\.params\.operationId\}`/);
  });

  it('generate route installs the tap before the mirror guard and finalizes in finally', () => {
    const ai = read('src/routes/ai.js');
    const begin = ai.indexOf("route: 'generate',");
    const mirror = ai.indexOf('res._siraRawWrite = rawWrite;');
    assert.ok(begin > 0 && mirror > begin, 'tap must wrap res.write before the raw-write capture');
    assert.match(ai, /if \(streamResumeFollower\) \{\s*if \(__turnTap\) turnFailures\.finishTurn\(__turnTap, \{ replay: true \}\);/);
    assert.match(ai, /turnFailures\.finishTurn\(__turnTap, \{\s*ttfbAborted: __ttfbAbortedAt != null,/);
    assert.match(ai, /controller\.__siraStopReason = String\(req\.body\?\.reason \|\| 'user'\)/);
    assert.match(ai, /route: 'document-edit',/);
    assert.match(ai, /turnFailures\.finishTurn\(__docTurnTap, \{/);
    assert.match(ai, /router\.post\('\/stop-stream'/);
  });

  it('deep code notes context; other turn paths are wired', () => {
    const svc = read('src/services/ai-service.js');
    assert.match(svc, /noteTurnContext\('attachment_missing'/);
    assert.match(svc, /noteTurnContext\('model', \{ provider, model, fallbacks/);
    assert.match(svc, /noteTurnContext\('provider_failure', \{/);
    assert.match(read('src/services/agentic-chat-stream.js'), /noteTurn\('tool_failure', \{/);
    assert.match(read('src/routes/doc.js'), /route: 'doc-generate',/);
    assert.match(read('src/routes/chats.js'), /recordFeedbackFailure\(\{/);
    assert.match(read('src/routes/telemetry.js'), /recordClientSignal\(body, req\)/);
    assert.match(read('src/services/agents/task-store.js'), /recordAgentTaskFailure\(task, status\)/);
    assert.match(read('index.js'), /turn-failures'\)\.httpFailureMiddleware\(\)/);
    assert.match(read('src/jobs/system-cron.js'), /name: 'sweep-turn-failures'/);
  });

  it('admin endpoints are mapped in the route policy', () => {
    const policy = require('../src/services/admin-route-policy');
    for (const route of ['/api/admin/turn-failures', '/api/admin/turn-failures/stats', '/api/admin/turn-failures/recent']) {
      assert.equal(policy.matchAdminRoutePolicy('GET', route).permission, 'audit.read', route);
    }
    assert.equal(policy.matchAdminRoutePolicy('GET', '/api/admin/turn-failures.csv').permission, 'audit.export');
    const admin = read('src/routes/admin.js');
    assert.match(admin, /router\.get\('\/turn-failures\/recent'/);
    assert.match(admin, /router\.get\('\/turn-failures\.csv'/);
  });
});
