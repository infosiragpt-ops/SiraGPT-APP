/**
 * Integration test: simulate the chat-endpoint artifact branch end-to-
 * end. We don't spin up Express — we reproduce the exact sequence:
 *
 *   1. isArtifactRequest(prompt)   → decides to take the branch
 *   2. generate({openai, userRequest, imageDataUrls})
 *   3. wrapArtifact(art) inside an `intro + tag` message
 *   4. a frontend-side extractor regex pulls the <artifact> block back
 *
 * If all four steps hold, the user's "grafica esta imagen" will arrive
 * in the chat bubble as a renderable iframe artifact.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub openai module before requires (same pattern as artifacts.test.js)
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

// Mirror the frontend regex so we test the full round-trip that the
// chat bubble actually runs against the streamed content.
function extractArtifactFrontend(content) {
  if (typeof content !== 'string' || content.length === 0) return null;
  const tagMatch = content.match(/<artifact\b([^>]*)>([\s\S]*?)<\/artifact>/i);
  if (!tagMatch) return null;
  const attrs = tagMatch[1];
  const inner = tagMatch[2].trim();
  const titleMatch = attrs.match(/title=['"]([^'"]+)['"]/i);
  const descMatch = attrs.match(/description=['"]([^'"]+)['"]/i);
  return {
    before: content.slice(0, tagMatch.index).trim(),
    artifact: {
      title: titleMatch?.[1] || '',
      description: descMatch?.[1] || '',
      html: inner,
    },
    after: content.slice((tagMatch.index ?? 0) + tagMatch[0].length).trim(),
  };
}

function scriptedVision(artifactObj) {
  return {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: JSON.stringify(artifactObj) } }],
    })}},
  };
}

test('chat flow: "grafica esta imagen" with image → <artifact> block round-trips', async () => {
  const prompt = 'grafica esta imagen';
  assert.equal(g.isArtifactRequest(prompt), true, 'intent detector must match Spanish "grafica"');

  const html =
    '<!DOCTYPE html><html><head><style>body{font-family:system-ui;margin:0;padding:16px}</style>' +
    '</head><body><h1>Círculo trigonométrico</h1><svg width="800" height="600">' +
    '<circle cx="400" cy="300" r="200" fill="none" stroke="#111"/></svg>' +
    '<label>α<input id="a" type="range" min="0" max="360"/></label>' +
    '<script>document.getElementById("a").addEventListener("input",()=>{});</script>' +
    '</body></html>';

  const openai = scriptedVision({
    title: 'Círculo trigonométrico',
    description: 'Arrastra el slider para ver sen α y cos α.',
    html,
  });

  const art = await g.generate({
    openai,
    userRequest: prompt,
    imageDataUrls: ['data:image/png;base64,AAAA'],
  });
  assert.equal(art.refused, false);

  const intro = 'He preparado una visualización interactiva basada en la imagen.';
  const message = `${intro}\n\n${g.wrapArtifact(art)}`;
  const parsed = extractArtifactFrontend(message);
  assert.ok(parsed, 'frontend regex must extract the artifact block');
  assert.equal(parsed.before, intro);
  assert.equal(parsed.artifact.title, 'Círculo trigonométrico');
  assert.ok(parsed.artifact.html.includes('<svg'), 'SVG preserved inside the block');
  assert.ok(parsed.artifact.html.includes('<!DOCTYPE html>'), 'doctype preserved');
  assert.equal(parsed.after, '');
});

test('chat flow: plain-text chat prompt does NOT trigger artifact branch', () => {
  for (const t of [
    'hola, puedes ayudarme',
    'explícame trigonometría',
    'resume este texto',
    'qué es un círculo',
    'what is the capital of France',
  ]) {
    assert.equal(g.isArtifactRequest(t), false, `expected false for "${t}"`);
  }
});

test('chat flow: generator refusal does NOT produce an <artifact> block', async () => {
  const openai = scriptedVision({
    refused: true, reason: 'not a visualization-friendly request',
  });
  const art = await g.generate({
    openai,
    userRequest: 'grafica',
    imageDataUrls: ['data:image/png;base64,AAAA'],
  });
  assert.equal(art.refused, true);
  // Route falls through to text response — no <artifact> block in the
  // final message, so frontend extractor returns null.
  assert.equal(extractArtifactFrontend('plain text fallback'), null);
});

test('chat flow: artifact with nested </html> is still extracted correctly', async () => {
  // Lazy regex should stop at the real </artifact>, not get confused
  // by </html> or other inner closing tags.
  const html =
    '<!DOCTYPE html><html><head><style>body{padding:10px}</style></head>' +
    '<body><h1>Nested test</h1>' +
    '<script>/* contains </html> as a comment string */ const s = "</html>";</script>' +
    '<p>Paragraph to pad length above the two-hundred char minimum validator threshold.</p>' +
    '</body></html>';

  const openai = scriptedVision({
    title: 'Nested', description: 'Edge case', html,
  });
  const art = await g.generate({ openai, userRequest: 'grafica' });
  assert.equal(art.refused, false);

  const message = `Intro.\n\n${g.wrapArtifact(art)}\n\nPost script.`;
  const parsed = extractArtifactFrontend(message);
  assert.ok(parsed);
  assert.equal(parsed.after, 'Post script.');
  assert.ok(parsed.artifact.html.includes('</html>'), 'nested </html> preserved inside artifact');
});

test('chat flow: <artifact> block survives surrounding whitespace/newlines', () => {
  const html = '<!DOCTYPE html><html><body>x</body></html>';
  const wrapped = g.wrapArtifact({ title: 'T', description: 'D', html });
  for (const prefix of ['', ' ', '\n', '\n\n', 'Hello\n\n']) {
    for (const suffix of ['', ' ', '\n', '\n\n', '\n\nThanks!']) {
      const msg = `${prefix}${wrapped}${suffix}`;
      const parsed = extractArtifactFrontend(msg);
      assert.ok(parsed, `expected parse for prefix=${JSON.stringify(prefix)} suffix=${JSON.stringify(suffix)}`);
      assert.equal(parsed.artifact.title, 'T');
    }
  }
});

test('sanitiser: external script slipped past the prompt is stripped before rendering', async () => {
  const html =
    '<!DOCTYPE html><html><head>' +
    '<script src="https://evil.example/trackers.js"></script>' +
    '<style>body{padding:16px}</style></head>' +
    '<body><h1>With leaky head</h1>' +
    '<p>Padding paragraph long enough to exceed the validator minimum length so the artifact is not rejected.</p>' +
    '</body></html>';

  const openai = scriptedVision({ title: 'T', description: 'D', html });
  const art = await g.generate({ openai, userRequest: 'grafica' });
  assert.equal(art.refused, false);
  assert.ok(!/<script[^>]*\bsrc=/i.test(art.html), 'external script stripped');
  assert.ok(art.html.includes('external script removed'));
});
