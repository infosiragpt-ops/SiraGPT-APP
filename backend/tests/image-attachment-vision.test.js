'use strict';

// Live bug 2026-09-25 (siragpt.com): a photo of handwritten "(a+b)^2 =" +
// "resolver" on Grok 4.6 answered «Recibí tu archivo, pero no encontré texto
// suficiente para responder con precisión…» instead of a^2 + 2ab + b^2.
// The image went down the document text-extraction path; OCR produced ~3
// characters and the canned document fallback fired.
//
// Contract pinned here:
//   * an image turn always builds a model request with an image_url part;
//   * low / empty OCR text never replaces the image;
//   * the «no encontré texto suficiente» copy never answers an image;
//   * a scanned PDF (no text, no image) still gets the helpful fallback;
//   * a text-only selected model hands the image to a vision runtime.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const service = require('../src/services/ai-service');
const {
  shouldRecoverAttachmentResponse,
  recoverChatAttachmentResponse,
} = require('../src/services/chat-attachment-recovery');
const {
  buildAttachmentUnavailableFallbackAnswer,
  resolveAttachmentFallbackMarkdown,
} = require('../src/services/agents/agent-task-runner');

const NO_TEXT_RE = /no\s+encontr[eé]\s+texto\s+suficiente/i;
const VISION_KEYS = [
  'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY',
  'MODEL_API_KEY', 'META_API_KEY', 'LLAMA_API_KEY',
  'VISION_MODEL', 'GEMINI_VISION_MODEL', 'OPENROUTER_VISION_MODEL', 'META_VISION_MODEL', 'XAI_VISION_MODEL',
];

const IMAGE_TYPES = [
  { ext: 'png', mime: 'image/png' },
  { ext: 'jpg', mime: 'image/jpeg' },
  { ext: 'jpeg', mime: 'image/jpeg' },
  { ext: 'webp', mime: 'image/webp' },
  { ext: 'heic', mime: 'image/heic' },
];
const PROMPTS = ['resolver', 'qué dice', 'explica', 'traduce', 'resuelve la ecuación'];

let tmpDir;
let savedEnv;
let savedGetClient;
let requests;
let clientProviders;

function writeImage(ext) {
  const p = path.join(tmpDir, `math-${ext}-${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]));
  return p;
}

function imageFile(ext, mime, extra = {}) {
  return {
    id: `f-${ext}`,
    name: `ejercicio.${ext}`,
    originalName: `ejercicio.${ext}`,
    mimeType: mime,
    path: writeImage(ext),
    // Tesseract on "(a+b)^2 =" → a handful of characters: weak OCR.
    extractedText: '(a+b)^2 =',
    ...extra,
  };
}

function fakeClient(answer = 'Aplicando el binomio al cuadrado: $(a+b)^2 = a^2 + 2ab + b^2$.') {
  return {
    chat: {
      completions: {
        create: async (req) => {
          requests.push(req);
          return { choices: [{ message: { content: typeof answer === 'function' ? answer(req) : answer } }] };
        },
      },
    },
  };
}

function imageParts(req) {
  const content = req && req.messages && req.messages[req.messages.length - 1] && req.messages[req.messages.length - 1].content;
  return Array.isArray(content) ? content.filter((p) => p && p.type === 'image_url') : [];
}

function textPart(req) {
  const content = req.messages[req.messages.length - 1].content;
  return (content.find((p) => p.type === 'text') || {}).text || '';
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-vision-'));
  savedEnv = {};
  for (const k of VISION_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  process.env.GEMINI_API_KEY = 'g-test';
  requests = [];
  clientProviders = [];
  savedGetClient = service.getClient;
  service.getClient = (provider) => { clientProviders.push(provider); return fakeClient(); };
});

afterEach(() => {
  service.getClient = savedGetClient;
  for (const k of VISION_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('image-only send reaches a vision model (chat recovery path)', () => {
  for (const { ext, mime } of IMAGE_TYPES.filter((t) => ['png', 'jpg', 'webp'].includes(t.ext))) {
    test(`${ext} + "resolver" builds a request with an image part and never the no-text fallback`, async () => {
      const file = imageFile(ext, mime);
      const answer = await recoverChatAttachmentResponse({
        prisma: null,
        userId: 'u1',
        prompt: 'resolver',
        processedFiles: [file],
        uploadedFileContext: '',
        reason: 'stream_failed',
        provider: 'xAI',
        model: 'grok-4.6',
      });
      assert.doesNotMatch(answer, NO_TEXT_RE);
      assert.match(answer, /a\^2 \+ 2ab \+ b\^2/);
      assert.equal(requests.length, 1);
      const parts = imageParts(requests[0]);
      assert.equal(parts.length, 1, 'the model request must carry the image');
      assert.ok(parts[0].image_url.url.startsWith(`data:${mime};base64,`));
      assert.match(textPart(requests[0]), /^resolver/);
    });
  }

  test('image + low OCR text still sends the image (OCR is only a hint)', async () => {
    const file = imageFile('png', 'image/png', { extractedText: 'ab2' });
    const answer = await recoverChatAttachmentResponse({
      prisma: null, userId: 'u1', prompt: 'resolver', processedFiles: [file], provider: 'xAI', model: 'grok-4.6',
    });
    assert.doesNotMatch(answer, NO_TEXT_RE);
    assert.equal(imageParts(requests[0]).length, 1);
    assert.match(textPart(requests[0]), /OCR preliminar[\s\S]*ab2/);
  });

  test('image with an empty / placeholder OCR still sends the image', async () => {
    const file = imageFile('jpg', 'image/jpeg', { extractedText: 'No text found in image' });
    const answer = await recoverChatAttachmentResponse({
      prisma: null, userId: 'u1', prompt: 'resolver', processedFiles: [file],
    });
    assert.doesNotMatch(answer, NO_TEXT_RE);
    assert.equal(imageParts(requests[0]).length, 1);
    assert.doesNotMatch(textPart(requests[0]), /No text found/);
  });

  test('when every vision runtime fails a png gets an image notice, never the document no-text copy', async () => {
    service.getClient = () => ({ chat: { completions: { create: async () => { throw new Error('503'); } } } });
    const answer = await recoverChatAttachmentResponse({
      prisma: null, userId: 'u1', prompt: 'resolver', processedFiles: [imageFile('png', 'image/png')],
    });
    assert.doesNotMatch(answer, NO_TEXT_RE);
    assert.doesNotMatch(answer, /versión más nítida|con OCR/i);
    assert.match(answer, /imagen/i);
  });

  test('png with an octet-stream MIME is still treated as an image (by extension)', async () => {
    const file = imageFile('heic', 'application/octet-stream');
    const answer = await recoverChatAttachmentResponse({
      prisma: null, userId: 'u1', prompt: 'resolver', processedFiles: [file],
    });
    assert.doesNotMatch(answer, NO_TEXT_RE);
    const parts = imageParts(requests[0]);
    assert.equal(parts.length, 1);
    assert.ok(parts[0].image_url.url.startsWith('data:image/heic;base64,'));
  });

  test('mixed document + image: the image is read instead of the no-text copy', async () => {
    const pdf = { id: 'p1', name: 'scan.pdf', mimeType: 'application/pdf', extractedText: '' };
    const answer = await recoverChatAttachmentResponse({
      prisma: null, userId: 'u1', prompt: 'resolver', processedFiles: [pdf, imageFile('png', 'image/png')],
    });
    assert.doesNotMatch(answer, NO_TEXT_RE);
    assert.equal(imageParts(requests[0]).length, 1);
  });
});

describe('scanned PDF vs png', () => {
  test('a scanned PDF with no text still gets the helpful document fallback', async () => {
    const pdf = { id: 'p1', name: 'escaneado.pdf', mimeType: 'application/pdf', extractedText: '' };
    const answer = await recoverChatAttachmentResponse({
      prisma: null, userId: 'u1', prompt: 'resume el documento', processedFiles: [pdf],
    });
    assert.match(answer, NO_TEXT_RE);
    assert.match(answer, /PDF escaneado/);
    assert.equal(requests.length, 0, 'no vision call without an image');
  });

  test('a png never gets the document fallback, even from the runner helpers', () => {
    const direct = buildAttachmentUnavailableFallbackAnswer({ goal: 'resolver', uploadedFileContext: '', imageAttachment: true });
    const resolved = resolveAttachmentFallbackMarkdown({ goal: 'resolver', uploadedFileContext: '', imageAttachment: true });
    for (const text of [direct, resolved]) {
      assert.doesNotMatch(text, NO_TEXT_RE);
      assert.doesNotMatch(text, /versión más nítida/);
    }
    // Documents keep their copy.
    assert.match(buildAttachmentUnavailableFallbackAnswer({ goal: 'resume', uploadedFileContext: '' }), NO_TEXT_RE);
  });

  test('shouldRecoverAttachmentResponse: empty / no-text replies on a png trigger VISION recovery, short answers do not', () => {
    const png = [{ id: 'f1', name: 'x.png', mimeType: 'image/png', extractedText: '' }];
    assert.equal(shouldRecoverAttachmentResponse({ prompt: 'resolver', response: '', processedFiles: png }), true);
    assert.equal(shouldRecoverAttachmentResponse({
      prompt: 'resolver',
      response: 'Recibí tu archivo, pero no encontré texto suficiente para responder con precisión.',
      processedFiles: png,
    }), true);
    assert.equal(shouldRecoverAttachmentResponse({ prompt: 'resolver', response: '$a^2+2ab+b^2$', processedFiles: png }), false);
  });
});

describe('model without vision → vision-capable runtime', () => {
  test('a text-only selected model (DeepSeek) routes the image turn to a vision runtime', async () => {
    const text = await service.answerImagesWithVision([imageFile('png', 'image/png')], 'resolver', {
      provider: 'DeepSeek', model: 'deepseek-chat',
    });
    assert.ok(text);
    assert.equal(requests.length, 1);
    assert.equal(clientProviders[0], 'Gemini');
    assert.match(requests[0].model, /gemini/);
    assert.equal(imageParts(requests[0]).length, 1);
  });

  test('Grok 4.6 is vision-capable and is used first when selected', async () => {
    process.env.XAI_API_KEY = 'x-test';
    await service.answerImagesWithVision([imageFile('png', 'image/png')], 'resolver', {
      provider: 'xAI', model: 'grok-4.6',
    });
    assert.equal(service.modelSupportsVision('xAI', 'grok-4.6'), true);
    assert.equal(service.modelSupportsVision('OpenRouter', 'x-ai/grok-4.6'), true);
    assert.match(requests[0].model, /grok-4\.6/);
  });

  test('if the selected vision model fails, the next vision runtime answers', async () => {
    let calls = 0;
    service.getClient = (provider) => {
      clientProviders.push(provider);
      calls += 1;
      if (calls === 1) return { chat: { completions: { create: async () => { throw new Error('timeout'); } } } };
      return fakeClient();
    };
    const text = await service.answerImagesWithVision([imageFile('webp', 'image/webp')], 'resolver', {
      provider: 'xAI', model: 'grok-4.6',
    });
    assert.match(text, /a\^2 \+ 2ab \+ b\^2/);
    assert.equal(clientProviders.length, 2);
    assert.equal(clientProviders[1], 'Gemini');
    assert.equal(imageParts(requests[0]).length, 1);
  });
});

describe('combinatorial: prompts × image types always include image content', () => {
  for (const prompt of PROMPTS) {
    for (const { ext, mime } of IMAGE_TYPES) {
      test(`"${prompt}" × ${ext}`, async () => {
        const answer = await recoverChatAttachmentResponse({
          prisma: null, userId: 'u1', prompt, processedFiles: [imageFile(ext, mime)], provider: 'xAI', model: 'grok-4.6',
        });
        assert.doesNotMatch(answer, NO_TEXT_RE);
        assert.equal(requests.length, 1);
        const parts = imageParts(requests[0]);
        assert.equal(parts.length, 1);
        assert.ok(parts[0].image_url.url.startsWith(`data:${mime};base64,`));
        assert.ok(textPart(requests[0]).startsWith(prompt));
      });
    }
  }
});

describe('source contracts: runner and chat route never send images to the no-text fallback', () => {
  const runnerSrc = fs.readFileSync(path.join(__dirname, '../src/services/agents/agent-task-runner.js'), 'utf8');
  const routeSrc = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');

  test('every runner fallback call carries the image flag', () => {
    const calls = runnerSrc.match(/finalFallbackMarkdown = recoveredMarkdown \|\| buildAttachmentUnavailableFallbackAnswer\(\{[^}]*\}/g) || [];
    assert.ok(calls.length >= 4);
    for (const call of calls) assert.match(call, /imageAttachment: imageOnlyAttachmentTurn/);
  });

  test('image-only runner turns answer with vision BEFORE the AgentRunner, thin guard and attachment fast path', () => {
    const visionIdx = runnerSrc.indexOf('if (imageOnlyAttachmentTurn && !imageDeliverableRequested)');
    assert.ok(visionIdx > 0);
    assert.ok(visionIdx < runnerSrc.indexOf('// ── F2: AgentRunner PRIMARY on the durable agent-task entry'));
    assert.ok(visionIdx < runnerSrc.indexOf('// ── Thin-attachment guard'));
    assert.ok(visionIdx < runnerSrc.indexOf('if (deterministicAttachmentAnswer) {'));
    assert.match(runnerSrc.slice(visionIdx, visionIdx + 2500), /answerImagesWithVision\(/);
  });

  test('chat route recovery hands the selected model to the vision recovery', () => {
    const calls = routeSrc.match(/recoverChatAttachmentResponse\(\{[\s\S]*?\}\);/g) || [];
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.match(call, /provider: actualProvider/);
      assert.match(call, /model: actualModel/);
    }
  });
});
