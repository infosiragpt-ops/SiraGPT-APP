'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PizZip = require('pizzip');

const { resolveChatDocumentFileIds } = require('../src/services/message-attachments');
const agentTaskRoute = require('../src/routes/agent-task');
// looksLikeDocumentFollowupQuestion now lives in message-attachments (shared by
// the chat + agent-task routes); the route re-exports it for back-compat.
const { looksLikeDocumentFollowupQuestion } = agentTaskRoute;
const { shouldRunForPrompt } = require('../src/services/rag/operational-runtime');
const {
  buildPreviousContentDocumentPrompt,
  findPreviousAssistantContent,
  isPreviousContentExportRequest,
} = require('../src/services/document-followup-context');
const {
  buildPlan,
  validateDocument,
  INTERNAL: documentPipelineInternals,
} = require('../src/services/document-pipeline/advanced-document-pipeline');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function mockPrisma({ chat = { id: 'chat1' }, messages = [], files = [] } = {}) {
  return {
    chat: { findFirst: async () => chat },
    message: { findMany: async () => messages },
    file: {
      findMany: async ({ where }) => {
        const ids = (where && where.id && where.id.in) || [];
        return files.filter((f) => ids.includes(f.id));
      },
    },
  };
}

describe('resolveChatDocumentFileIds — recover prior document on a follow-up', () => {
  test('returns provided fileIds untouched when present', async () => {
    const out = await resolveChatDocumentFileIds(mockPrisma(), { userId: 'u1', chatId: 'c1', providedFileIds: ['x'] });
    assert.deepEqual(out, ['x']);
  });

  test('recovers the docx attached earlier in the chat (the bug scenario)', async () => {
    const prisma = mockPrisma({
      messages: [
        { files: JSON.stringify([{ id: 'file-doc-1', mimeType: DOCX_MIME, originalName: 'Formato para el proyecto de tesis.docx' }]) },
      ],
      files: [{ id: 'file-doc-1', mimeType: DOCX_MIME, originalName: 'tesis.docx', extractedText: 'GESTIÓN DEL PROCESO ADMINISTRATIVO...' }],
    });
    const out = await resolveChatDocumentFileIds(prisma, { userId: 'u1', chatId: 'c1', providedFileIds: [] });
    assert.deepEqual(out, ['file-doc-1']);
  });

  test('filters out non-readable attachments', async () => {
    const prisma = mockPrisma({
      messages: [{ files: JSON.stringify([{ id: 'weird' }]) }],
      files: [{ id: 'weird', mimeType: 'application/x-unknown', originalName: 'blob.bin', extractedText: '' }],
    });
    const out = await resolveChatDocumentFileIds(prisma, { userId: 'u1', chatId: 'c1', providedFileIds: [] });
    assert.deepEqual(out, []);
  });

  test('returns [] when the chat has no document attachments', async () => {
    const prisma = mockPrisma({ messages: [{ files: null }, { files: '[]' }] });
    const out = await resolveChatDocumentFileIds(prisma, { userId: 'u1', chatId: 'c1', providedFileIds: [] });
    assert.deepEqual(out, []);
  });

  test('returns [] when chat not found / not owned', async () => {
    const prisma = mockPrisma({ chat: null });
    const out = await resolveChatDocumentFileIds(prisma, { userId: 'u1', chatId: 'c1', providedFileIds: [] });
    assert.deepEqual(out, []);
  });

  test('safe with no chatId / no prisma / no user', async () => {
    assert.deepEqual(await resolveChatDocumentFileIds(mockPrisma(), { userId: 'u1', chatId: null }), []);
    assert.deepEqual(await resolveChatDocumentFileIds(null, { userId: 'u1', chatId: 'c1' }), []);
    assert.deepEqual(await resolveChatDocumentFileIds(mockPrisma(), { userId: null, chatId: 'c1' }), []);
  });

  test('keeps multiple docs in recency order, capped', async () => {
    const prisma = mockPrisma({
      messages: [
        { files: JSON.stringify([{ id: 'newest', mimeType: DOCX_MIME, originalName: 'a.docx' }]) },
        { files: JSON.stringify([{ id: 'older', mimeType: 'application/pdf', originalName: 'b.pdf' }]) },
      ],
      files: [
        { id: 'newest', mimeType: DOCX_MIME, originalName: 'a.docx', extractedText: 'x' },
        { id: 'older', mimeType: 'application/pdf', originalName: 'b.pdf', extractedText: 'y' },
      ],
    });
    const out = await resolveChatDocumentFileIds(prisma, { userId: 'u1', chatId: 'c1', providedFileIds: [] });
    assert.equal(out[0], 'newest');
    assert.ok(out.includes('older'));
  });
});

describe('looksLikeDocumentFollowupQuestion — when to reattach', () => {
  test('THE reported case + common doc questions → true', () => {
    for (const q of [
      'cual es el titulo de la investigacion ?',
      'dame un resumen en un solo parrafo',
      '¿de qué trata el documento?',
      'explícame la metodología',
      'cuál es el objetivo del proyecto',
      'quién es el autor',
      'what is the title of the research?',
      'resume el archivo',
    ]) {
      assert.equal(looksLikeDocumentFollowupQuestion(q), true, `expected true for: ${q}`);
    }
  });

  test('build / research / generation commands → false (never hijack those)', () => {
    for (const q of [
      'crea una web para mi empresa de carros',
      'genera un dashboard con métricas',
      'investiga en internet sobre los precios actuales',
      'busca en la web noticias de hoy',
      'desarrolla una app móvil',
      'haz una página de aterrizaje',
    ]) {
      assert.equal(looksLikeDocumentFollowupQuestion(q), false, `expected false for: ${q}`);
    }
  });

  test('empty / overlong → false', () => {
    assert.equal(looksLikeDocumentFollowupQuestion(''), false);
    assert.equal(looksLikeDocumentFollowupQuestion('   '), false);
    assert.equal(looksLikeDocumentFollowupQuestion('cuál '.repeat(120)), false); // > 400 chars
  });

  test('shared helper is also exported from message-attachments', () => {
    const { looksLikeDocumentFollowupQuestion: shared } = require('../src/services/message-attachments');
    assert.equal(typeof shared, 'function');
    assert.equal(shared('cual es el titulo de la investigacion ?'), true);
  });
});

describe('RAG gate relax — questions retrieve when a document is in scope', () => {
  const docs = [{ chars: 500, text: 'x'.repeat(500) }]; // short doc (< long threshold)

  test('no docs → never runs', () => {
    assert.equal(shouldRunForPrompt('cual es el titulo?', []), false);
  });

  test('pure greeting → does not run even with a doc', () => {
    assert.equal(shouldRunForPrompt('hola', docs), false);
  });

  test('THE reported follow-up (no doc keyword) now retrieves', () => {
    assert.equal(shouldRunForPrompt('cual es el titulo de la investigacion ?', docs), true);
  });

  test('interrogatives without a trailing "?" still retrieve', () => {
    assert.equal(shouldRunForPrompt('cuál es el objetivo del proyecto', docs), true);
    assert.equal(shouldRunForPrompt('quién es el autor', docs), true);
  });

  test('explicit doc keyword still retrieves (unchanged)', () => {
    assert.equal(shouldRunForPrompt('resume el documento', docs), true);
  });

  test('a non-question statement without keywords does not over-trigger', () => {
    assert.equal(shouldRunForPrompt('gracias, perfecto', docs), false);
  });
});

describe('document export follow-up — previous assistant content becomes the source', () => {
  test('detects short "put it in Word" follow-ups without hijacking new documents', () => {
    assert.equal(isPreviousContentExportRequest('colocado en un word para poder descargarlo'), true);
    assert.equal(isPreviousContentExportRequest('pásalo a Word descargable'), true);
    assert.equal(isPreviousContentExportRequest('pon el resultado anterior en un docx'), true);
    assert.equal(isPreviousContentExportRequest('crea un word sobre marketing digital'), false);
  });

  test('selects the last substantive assistant answer and skips generic document cards', () => {
    const messages = [
      {
        role: 'ASSISTANT',
        content: '**Colocado para poder descargarlo**\n\nDocumento generado por la pipeline multiagente de siraGPT.\n\nVerificaciones técnicas: 15/15 ✓',
        files: JSON.stringify([{ id: 'doc1', filename: 'x.docx' }]),
      },
      {
        role: 'ASSISTANT',
        content: '## 4. Resultado Final\n\nEl tamaño de la muestra requerido, redondeado al entero más cercano, es: n ≈ 97',
      },
    ];

    const source = findPreviousAssistantContent(messages);
    assert.match(source, /n ≈ 97/);
    assert.doesNotMatch(source, /pipeline multiagente/);
  });

  test('renders the recovered source content inside the generated DOCX', async () => {
    const source = '## 4. Resultado Final\n\nEl tamaño de la muestra requerido, redondeado al entero más cercano, es: n ≈ 97';
    const prompt = buildPreviousContentDocumentPrompt({
      prompt: 'colocado en un word para poder descargarlo',
      sourceContent: source,
      format: 'docx',
    });
    const plan = buildPlan({
      prompt,
      format: 'docx',
      template: 'premium',
      complexity: 'standard',
      referenceFiles: [],
    });
    assert.equal(plan.title, 'Resultado Final');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-doc-followup-'));
    const artifact = await documentPipelineInternals.buildDocumentFile({ plan, outputDir: outDir });
    const expected = documentPipelineInternals.expectedFor(plan.format, plan.template, plan.complexity, plan);
    const validation = validateDocument({ format: 'docx', buffer: artifact.buffer, expected });
    const documentXml = new PizZip(artifact.buffer).file('word/document.xml').asText();
    const text = documentXml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    assert.equal(validation.passed, true);
    assert.match(text, /Resultado Final/);
    assert.match(text, /n ≈ 97/);
    assert.doesNotMatch(text, /Contenido específico pendiente de regeneración/);
  });
});

// Prod 2026-09-27: «cuando es 2+2?» re-attached the chat's earlier (a+b)²
// screenshot to the NEW message (saved and shown with it) because any question
// word counted as a document follow-up.
describe('looksLikeDocumentFollowupQuestion — a question word alone is not a follow-up', () => {
  const { looksLikeImageFollowupQuestion } = require('../src/services/message-attachments');

  test('self-contained questions never re-attach earlier files', () => {
    for (const q of [
      'cuando es 2+2?',
      '¿qué hora es?',
      '¿cómo estás?',
      '¿cuánto es 15*3?',
      'qué opinas de la inteligencia artificial',
      '¿dónde queda Lima?',
      'entiendo',
      'y puedes resolver ejercicios mas avanzado?',
    ]) {
      assert.equal(looksLikeDocumentFollowupQuestion(q), false, `expected false for: ${q}`);
    }
  });

  test('questions that point at the document (noun, pronoun or reference) still re-attach', () => {
    for (const q of [
      'resúmelo',
      'explícalo mejor',
      'de qué trata',
      '¿qué dice en la página 3?',
      'cuál es la conclusión',
      'y el título del de arriba?',
      'agrega una tabla al final',
    ]) {
      assert.equal(looksLikeDocumentFollowupQuestion(q), true, `expected true for: ${q}`);
    }
  });

  test('earlier images are only re-used when the message is about them', () => {
    for (const q of ['resuélvelo', 'y el ejercicio de la imagen?', 'explica la foto', 'qué dice la captura']) {
      assert.equal(looksLikeImageFollowupQuestion(q), true, `image follow-up: ${q}`);
    }
    for (const q of ['cuando es 2+2?', 'resume el documento', 'gracias', '¿qué hora es?']) {
      assert.equal(looksLikeImageFollowupQuestion(q), false, `not about the image: ${q}`);
    }
  });
});

describe('generate route: recovered files are context, never the new message attachments', () => {
  const aiSource = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');

  test('the user message is persisted with only the files the user attached', () => {
    assert.match(aiSource, /const userAttachedFiles = userAttachedOnly\(processedFiles\);/);
    assert.match(aiSource, /userAttachedFiles\.length > 0 \? JSON\.stringify\(userAttachedFiles\) : null/);
    assert.doesNotMatch(aiSource, /persistUserMessageOnce\(\s*chatId,\s*prompt,\s*processedFiles\.length > 0 \? JSON\.stringify\(processedFiles\)/);
  });

  test('both recovery paths mark files as recovered and unrelated earlier images are dropped', () => {
    assert.match(aiSource, /__recoveredFileRefs = new Set\(__reattachedDocs\.map/);
    assert.match(aiSource, /processedFiles = recovered\.map\(markRecoveredFromHistory\);/);
    assert.match(aiSource, /messageAttachments\.looksLikeImageFollowupQuestion\(prompt\)/);
    assert.match(aiSource, /pf\.attachmentKind === 'image' && !imageRelevant/);
  });

  test('the recovered marker survives object spreads and is never serialized', () => {
    const MARK = Symbol.for('siragpt.recoveredFromHistory');
    assert.match(aiSource, /Symbol\.for\('siragpt\.recoveredFromHistory'\)/);
    assert.match(aiSource, /enumerable: true/);
    const copy = { id: 'f1', name: 'a.png' };
    Object.defineProperty(copy, MARK, { value: true, enumerable: true });
    const refreshed = { ...copy, extractedText: 'x' };
    assert.equal(refreshed[MARK], true);
    assert.equal(JSON.stringify(refreshed).includes('recovered'), false);
  });
});
