/**
 * Tests for the artifact generator + intent detector.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub openai before requires
function fakeVectorFor(text) {
  const v = new Float32Array(8);
  const tokens = (text || '').toLowerCase().match(/[a-z0-9_]+/g) || [];
  for (const t of tokens) {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 8;
    v[h] += 1;
  }
  let n = 0;
  for (let i = 0; i < 8; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 8; i++) v[i] /= n;
  return v;
}
require.cache[require.resolve('openai')] = {
  exports: class FakeOpenAI {
    constructor() {
      this.embeddings = {
        create: async ({ input }) => ({
          data: input.map(text => ({ embedding: Array.from(fakeVectorFor(text)) })),
        }),
      };
    }
  },
};
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const g = require('../src/services/artifacts/artifact-generator');

function scripted(seq) {
  let i = 0;
  return {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: seq[Math.min(i++, seq.length - 1)] } }],
    })}},
  };
}

// ─── Intent detection ─────────────────────────────────────────────────────

test('isArtifactRequest: bare Spanish verbs (with + without accents)', () => {
  for (const w of ['grafica', 'gráfica', 'grafícalo', 'visualiza', 'visualízalo', 'dibuja', 'dibújalo', 'diagrama', 'anímalo']) {
    assert.equal(g.isArtifactRequest(w), true, `expected true for "${w}"`);
  }
});

test('isArtifactRequest: Spanish phrases', () => {
  assert.equal(g.isArtifactRequest('muestrame una visualización'), true);
  assert.equal(g.isArtifactRequest('enseñame un diagrama'), true);
  assert.equal(g.isArtifactRequest('crea una animación del ciclo'), true);
  assert.equal(g.isArtifactRequest('hazme una simulación'), true);
});

test('isArtifactRequest: English phrases', () => {
  assert.equal(g.isArtifactRequest('plot a sine wave'), true);
  assert.equal(g.isArtifactRequest('draw a triangle'), true);
  assert.equal(g.isArtifactRequest('animate the motion'), true);
  assert.equal(g.isArtifactRequest('make an interactive chart'), true);
  assert.equal(g.isArtifactRequest('build an animation of waves'), true);
});

test('isArtifactRequest: normal text chat → false', () => {
  for (const t of ['hola', 'dame un resumen', 'explica trigonometría', 'cómo se llama esto?', 'analiza el texto']) {
    assert.equal(g.isArtifactRequest(t), false, `expected false for "${t}"`);
  }
});

test('isArtifactRequest: empty / non-string → false', () => {
  assert.equal(g.isArtifactRequest(''), false);
  assert.equal(g.isArtifactRequest('  '), false);
  assert.equal(g.isArtifactRequest(null), false);
  assert.equal(g.isArtifactRequest(undefined), false);
});

// ─── sanitiseArtifactHtml ────────────────────────────────────────────────

test('sanitiseArtifactHtml: strips external <script src>', () => {
  const dirty = '<html><head><script src="https://cdn/lib.js"></script></head><body>x</body></html>';
  const clean = g.sanitiseArtifactHtml(dirty);
  assert.ok(!/<script\b[^>]*\bsrc=/.test(clean));
  assert.ok(clean.includes('external script removed'));
});

test('sanitiseArtifactHtml: strips external stylesheet links', () => {
  const dirty = '<head><link rel="stylesheet" href="https://cdn/style.css"></head>';
  const clean = g.sanitiseArtifactHtml(dirty);
  assert.ok(!/rel=['"]?stylesheet/.test(clean));
});

test('sanitiseArtifactHtml: strips nested iframes', () => {
  const dirty = '<body><iframe src="https://evil"></iframe></body>';
  const clean = g.sanitiseArtifactHtml(dirty);
  assert.ok(!/<iframe/i.test(clean));
});

test('sanitiseArtifactHtml: strips @import in inline CSS', () => {
  const dirty = '<style>@import url("https://fonts/x"); body { color: red; }</style>';
  const clean = g.sanitiseArtifactHtml(dirty);
  assert.ok(!/@import\s+url/.test(clean));
  assert.ok(clean.includes('color: red')); // rest preserved
});

test('sanitiseArtifactHtml: keeps inline <script> blocks', () => {
  const dirty = '<script>document.addEventListener("input", () => {});</script>';
  const clean = g.sanitiseArtifactHtml(dirty);
  assert.ok(clean.includes('addEventListener'));
});

// ─── generate ────────────────────────────────────────────────────────────

test('generate: null openai → refused', async () => {
  const r = await g.generate({ openai: null, userRequest: 'grafica' });
  assert.equal(r.refused, true);
  assert.ok(r.reason);
});

test('generate: empty request → refused', async () => {
  const r = await g.generate({ openai: scripted([]), userRequest: '' });
  assert.equal(r.refused, true);
});

test('generate: valid HTML in LLM response → returns artifact', async () => {
  const html = '<!DOCTYPE html><html><head><style>body{font-family:system-ui;background:#fff;color:#111;margin:0;padding:16px}</style></head><body><h1>Test</h1><p>Some descriptive paragraph to push this over the minimum length.</p><script>console.log(1);document.addEventListener("DOMContentLoaded",()=>{});</script></body></html>';
  const openai = scripted([JSON.stringify({
    title: 'Test artifact',
    description: 'Shows a test',
    html,
  })]);
  const r = await g.generate({ openai, userRequest: 'grafica' });
  assert.equal(r.refused, false);
  assert.equal(r.title, 'Test artifact');
  assert.ok(r.html.includes('<h1>Test</h1>'));
});

test('generate: incomplete HTML (no <html>) → refused', async () => {
  const openai = scripted([JSON.stringify({
    title: 't', description: 'd',
    html: '<div>fragment</div>',
  })]);
  const r = await g.generate({ openai, userRequest: 'grafica' });
  assert.equal(r.refused, true);
  assert.ok(r.reason.includes('incomplete'));
});

test('generate: oversized HTML → refused', async () => {
  const bigHtml = '<!DOCTYPE html><html><head></head><body>' + 'x'.repeat(50000) + '</body></html>';
  const openai = scripted([JSON.stringify({
    title: 't', description: 'd', html: bigHtml,
  })]);
  const r = await g.generate({ openai, userRequest: 'grafica', maxHtmlChars: 40000 });
  assert.equal(r.refused, true);
  assert.ok(r.reason.includes('exceeds'));
});

test('generate: model-refused response is propagated', async () => {
  const openai = scripted([JSON.stringify({
    refused: true,
    reason: 'not visualization-friendly',
  })]);
  const r = await g.generate({ openai, userRequest: 'hola' });
  assert.equal(r.refused, true);
  assert.equal(r.reason, 'not visualization-friendly');
});

test('generate: parse error → refused with reason', async () => {
  const openai = scripted(['not json at all']);
  const r = await g.generate({ openai, userRequest: 'grafica' });
  assert.equal(r.refused, true);
  assert.ok(/error/i.test(r.reason));
});

test('generate: produced HTML is sanitised', async () => {
  const html = '<!DOCTYPE html><html><head><title>Sanitisation sample</title><script src="https://evil.example/bad.js"></script><style>body{font-family:system-ui;padding:20px}</style></head><body><h1>Sanitise me</h1><p>Body long enough to pass the minimum length validator that guards against truncated outputs.</p></body></html>';
  const openai = scripted([JSON.stringify({ title: 't', description: 'd', html })]);
  const r = await g.generate({ openai, userRequest: 'grafica' });
  assert.equal(r.refused, false);
  assert.ok(!/<script[^>]*\bsrc=/.test(r.html));
});

test('generate: size reported matches returned html length', async () => {
  const html = '<!DOCTYPE html><html><head><title>Size check</title><style>body{font-family:system-ui;margin:0;padding:24px;background:#fff;color:#111}</style></head><body><h1>Hello world</h1><p>Padding content to make this document exceed the minimum length threshold.</p></body></html>';
  const openai = scripted([JSON.stringify({ title: 't', description: 'd', html })]);
  const r = await g.generate({ openai, userRequest: 'grafica' });
  assert.equal(r.size, r.html.length);
});

// ─── Vision path ─────────────────────────────────────────────────────────

test('generate: imageDataUrls routes to gpt-4o with vision content', async () => {
  let capturedCall = null;
  const openai = {
    chat: { completions: { create: async (args) => {
      capturedCall = args;
      const html = '<!DOCTYPE html><html><head><style>body{font-family:system-ui;padding:16px}</style></head><body><svg width="800" height="600"><circle cx="400" cy="300" r="200" fill="none" stroke="#111"/></svg><p>Trigonometric circle visualization with interactive controls.</p></body></html>';
      return { choices: [{ message: { content: JSON.stringify({ title: 'Círculo', description: 'Interactivo', html }) } }] };
    }}},
  };
  const png1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  const r = await g.generate({
    openai,
    userRequest: 'grafica esta imagen',
    imageDataUrls: [png1],
  });
  assert.equal(r.refused, false);
  assert.equal(capturedCall.model, 'gpt-4o', 'should pick vision model');
  const userMsg = capturedCall.messages.find(m => m.role === 'user');
  assert.ok(Array.isArray(userMsg.content), 'user content must be an array for vision');
  const imgPart = userMsg.content.find(p => p.type === 'image_url');
  assert.ok(imgPart && imgPart.image_url.url === png1, 'image URL propagated');
});

test('generate: imageDataUrls capped at 4 images', async () => {
  let capturedCall = null;
  const openai = {
    chat: { completions: { create: async (args) => {
      capturedCall = args;
      const html = '<!DOCTYPE html><html><head><style>body{font-family:system-ui;padding:20px}</style></head><body><h1>Many</h1><p>Body long enough to pass minimum length validator guard.</p></body></html>';
      return { choices: [{ message: { content: JSON.stringify({ title: 't', description: 'd', html }) } }] };
    }}},
  };
  const six = Array.from({ length: 6 }, (_, i) => `data:image/png;base64,AAA${i}`);
  await g.generate({ openai, userRequest: 'grafica', imageDataUrls: six });
  const userMsg = capturedCall.messages.find(m => m.role === 'user');
  const imgs = userMsg.content.filter(p => p.type === 'image_url');
  assert.equal(imgs.length, 4);
});

test('generate: non-image data URLs are ignored', async () => {
  let capturedCall = null;
  const openai = {
    chat: { completions: { create: async (args) => {
      capturedCall = args;
      const html = '<!DOCTYPE html><html><head><style>body{font-family:system-ui}</style></head><body><h1>Test</h1><p>Padding content to reach minimum length threshold for validator.</p></body></html>';
      return { choices: [{ message: { content: JSON.stringify({ title: 't', description: 'd', html }) } }] };
    }}},
  };
  await g.generate({
    openai,
    userRequest: 'grafica',
    imageDataUrls: ['data:application/pdf;base64,JVBERi0x', 'http://evil/img.png'],
  });
  const userMsg = capturedCall.messages.find(m => m.role === 'user');
  const imgs = (userMsg.content || []).filter?.(p => p.type === 'image_url') || [];
  assert.equal(imgs.length, 0);
});

// ─── wrapArtifact ────────────────────────────────────────────────────────

test('wrapArtifact: produces parseable <artifact> block', () => {
  const out = g.wrapArtifact({
    title: 'My title',
    description: 'Short description',
    html: '<!DOCTYPE html><html><body>x</body></html>',
  });
  assert.ok(out.startsWith('<artifact '));
  assert.ok(out.includes('title="My title"'));
  assert.ok(out.includes('description="Short description"'));
  assert.ok(out.endsWith('</artifact>'));
});

test('wrapArtifact: escapes quotes in attributes', () => {
  const out = g.wrapArtifact({
    title: 'He said "hi"',
    description: 'A & B',
    html: '<!DOCTYPE html><html></html>',
  });
  assert.ok(out.includes('title="He said &quot;hi&quot;"'));
  assert.ok(out.includes('description="A &amp; B"'));
});

test('wrapArtifact output matches frontend extractArtifact regex shape', () => {
  const out = g.wrapArtifact({
    title: 'T', description: 'D',
    html: '<!DOCTYPE html><html><body>content</body></html>',
  });
  // Same regex used by extractArtifact in components/artifact/InteractiveArtifact.tsx
  const m = out.match(/<artifact\b([^>]*)>([\s\S]*?)<\/artifact>/i);
  assert.ok(m);
  assert.ok(/title="T"/.test(m[1]));
  assert.ok(m[2].includes('<!DOCTYPE html>'));
});
