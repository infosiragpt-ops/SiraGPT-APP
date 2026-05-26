'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// We don't need a server here — just want to test the exported helpers
// and the schema construction.
const paraphraseRoute = require('../src/routes/paraphrase');

const {
  resolveMaxTextLength,
  MAX_TEXT_LENGTH,
  ParaphraseSchema,
  SUPPORTED_MODES,
  SUPPORTED_LANGUAGES,
  paraphraseCost,
} = paraphraseRoute;

test('SUPPORTED_MODES: matches the spec\'s 8 modes + custom', () => {
  assert.deepEqual(SUPPORTED_MODES.sort(), [
    'academic', 'creative', 'custom', 'expand', 'formal',
    'humanize', 'shorten', 'simple', 'standard',
  ].sort());
});

test('SUPPORTED_LANGUAGES: at least Spanish + English', () => {
  assert.ok(SUPPORTED_LANGUAGES.includes('es'));
  assert.ok(SUPPORTED_LANGUAGES.includes('en'));
});

test('resolveMaxTextLength: defaults to 20_000 when env is empty', () => {
  assert.equal(resolveMaxTextLength({}), 20_000);
  assert.equal(resolveMaxTextLength({ PARAPHRASE_MAX_TEXT_LENGTH: '' }), 20_000);
  assert.equal(resolveMaxTextLength({ PARAPHRASE_MAX_TEXT_LENGTH: null }), 20_000);
});

test('resolveMaxTextLength: respects valid positive integer overrides', () => {
  assert.equal(resolveMaxTextLength({ PARAPHRASE_MAX_TEXT_LENGTH: '8000' }), 8_000);
  assert.equal(resolveMaxTextLength({ PARAPHRASE_MAX_TEXT_LENGTH: '50000' }), 50_000);
});

test('resolveMaxTextLength: clamps to the 100_000 hard upper bound', () => {
  assert.equal(resolveMaxTextLength({ PARAPHRASE_MAX_TEXT_LENGTH: '999999' }), 100_000);
  assert.equal(resolveMaxTextLength({ PARAPHRASE_MAX_TEXT_LENGTH: '100001' }), 100_000);
});

test('resolveMaxTextLength: falls back to default on invalid / negative / garbage', () => {
  assert.equal(resolveMaxTextLength({ PARAPHRASE_MAX_TEXT_LENGTH: '-5' }), 20_000);
  assert.equal(resolveMaxTextLength({ PARAPHRASE_MAX_TEXT_LENGTH: '0' }), 20_000);
  assert.equal(resolveMaxTextLength({ PARAPHRASE_MAX_TEXT_LENGTH: 'not-a-number' }), 20_000);
  assert.equal(resolveMaxTextLength({ PARAPHRASE_MAX_TEXT_LENGTH: '1.5' }), 1); // parseInt → 1, still positive
});

test('MAX_TEXT_LENGTH: snapshot equals resolver result for the current env', () => {
  // Whatever the env was at load time, the exported constant must match
  // a fresh call with the live process.env.
  assert.equal(MAX_TEXT_LENGTH, resolveMaxTextLength(process.env));
});

test('ParaphraseSchema: rejects empty text', () => {
  const r = ParaphraseSchema.safeParse({ text: '' });
  assert.equal(r.success, false);
});

test('ParaphraseSchema: rejects text over the cap', () => {
  const tooLong = 'a'.repeat(MAX_TEXT_LENGTH + 1);
  const r = ParaphraseSchema.safeParse({ text: tooLong });
  assert.equal(r.success, false);
});

test('ParaphraseSchema: accepts text at the cap', () => {
  const justRight = 'a'.repeat(MAX_TEXT_LENGTH);
  const r = ParaphraseSchema.safeParse({ text: justRight });
  assert.equal(r.success, true);
});

test('ParaphraseSchema: defaults mode → standard, language → es', () => {
  const r = ParaphraseSchema.safeParse({ text: 'hello' });
  assert.equal(r.success, true);
  assert.equal(r.data.mode, 'standard');
  assert.equal(r.data.language, 'es');
});

test('ParaphraseSchema: rejects an unknown mode', () => {
  const r = ParaphraseSchema.safeParse({ text: 'hello', mode: 'turbocharge' });
  assert.equal(r.success, false);
});

test('paraphrase-humanizer.topAITellsFound: imported + callable from the route file context', () => {
  // The route uses lazy-require to load topAITellsFound on `?showTells=1`.
  // This locks down that the symbol is importable from the same path
  // the route uses, so a future rename of the export catches here.
  const { topAITellsFound } = require('../src/services/paraphrase-humanizer');
  assert.equal(typeof topAITellsFound, 'function');
  const result = topAITellsFound('Furthermore, moreover, the data is fine.');
  assert.ok(Array.isArray(result));
  assert.ok(result.length >= 2);
});

test('ParaphraseSchema: a body without mode defaults cleanly (alias middleware safe)', () => {
  // Mirrors what the route's pre-parse middleware would leave behind
  // when no mode was sent — the schema must still resolve mode to
  // "standard" via its .default('standard').
  const r = ParaphraseSchema.safeParse({ text: 'hello' });
  assert.equal(r.success, true);
  assert.equal(r.data.mode, 'standard');
});

test('ParaphraseSchema: explicit canonical mode survives validation', () => {
  for (const mode of ['standard', 'humanize', 'formal', 'academic', 'simple', 'creative', 'expand', 'shorten', 'custom']) {
    const r = ParaphraseSchema.safeParse({ text: 'hello', mode });
    assert.equal(r.success, true, `expected "${mode}" to validate`);
    assert.equal(r.data.mode, mode);
  }
});

test('paraphraseCost: at least 1 credit', () => {
  assert.ok(paraphraseCost({ body: { text: '' } }) >= 1);
  assert.ok(paraphraseCost({ body: { text: 'a'.repeat(500) } }) >= 1);
});

test('paraphraseCost: ~1 credit per 1000 chars by default', () => {
  // ratio resolved from CREDITS_PARAPHRASE_PER_1K_CHARS at call time
  const prevRatio = process.env.CREDITS_PARAPHRASE_PER_1K_CHARS;
  delete process.env.CREDITS_PARAPHRASE_PER_1K_CHARS;
  try {
    assert.equal(paraphraseCost({ body: { text: 'a'.repeat(1000) } }), 1);
    assert.equal(paraphraseCost({ body: { text: 'a'.repeat(2500) } }), 3);
    assert.equal(paraphraseCost({ body: { text: 'a'.repeat(10_000) } }), 10);
  } finally {
    if (prevRatio !== undefined) process.env.CREDITS_PARAPHRASE_PER_1K_CHARS = prevRatio;
  }
});

// POST /api/paraphrase/score — integration tests via in-process express.
const http = require('node:http');
const express = require('express');

function startScoreServer() {
  const app = express();
  app.use('/api/paraphrase', paraphraseRoute.router || paraphraseRoute);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseURL: `http://127.0.0.1:${port}` });
    });
  });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ status: res.statusCode, body: parsed });
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

test('POST /api/paraphrase/score: scores AI-heavy text high + topTells populated', async () => {
  const { server, baseURL } = await startScoreServer();
  try {
    const aiLike = 'Furthermore, the analysis demonstrates significant impact. Moreover, results indicate strong correlation. Additionally, the methodology supports the conclusion. In conclusion, the findings are robust.';
    const { status, body } = await postJSON(`${baseURL}/api/paraphrase/score`, { text: aiLike });
    assert.equal(status, 200);
    assert.ok(body.score >= 0.25, `expected mixed-or-higher score, got ${body.score}`);
    assert.ok(body.components);
    assert.ok(body.weights);
    assert.ok(Array.isArray(body.topTells));
    assert.ok(['likely_ai', 'mixed', 'likely_human'].includes(body.verdict));
  } finally {
    server.close();
  }
});

test('POST /api/paraphrase/score: empty text returns 400', async () => {
  const { server, baseURL } = await startScoreServer();
  try {
    const { status, body } = await postJSON(`${baseURL}/api/paraphrase/score`, { text: '' });
    assert.equal(status, 400);
    assert.equal(body.error, 'missing_text');
  } finally {
    server.close();
  }
});

test('POST /api/paraphrase/score: human text scores as likely_human', async () => {
  const { server, baseURL } = await startScoreServer();
  try {
    const human = 'I ran a few tests last week. Some passed. Others failed in weird ways I did not expect, so I went back to the logs. Turns out the cache was stale.';
    const { status, body } = await postJSON(`${baseURL}/api/paraphrase/score`, { text: human });
    assert.equal(status, 200);
    assert.equal(body.verdict, 'likely_human');
  } finally {
    server.close();
  }
});

test('POST /api/paraphrase/score: text > MAX_TEXT_LENGTH returns 413', async () => {
  const { server, baseURL } = await startScoreServer();
  try {
    const huge = 'a'.repeat(MAX_TEXT_LENGTH + 100);
    const { status, body } = await postJSON(`${baseURL}/api/paraphrase/score`, { text: huge });
    assert.equal(status, 413);
    assert.equal(body.error, 'text_too_long');
  } finally {
    server.close();
  }
});

test('POST /api/paraphrase/humanize: drops AI-tell words from input', async () => {
  const { server, baseURL } = await startScoreServer();
  try {
    const input = 'Furthermore, the framework demonstrates significant capacity. Moreover, the results indicate strong performance.';
    const { status, body } = await postJSON(
      `${baseURL}/api/paraphrase/humanize`,
      { text: input, language: 'en', intensity: 'medium' },
    );
    assert.equal(status, 200);
    assert.equal(typeof body.text, 'string');
    // The humanizer should have lowered the AI score.
    assert.ok(body.aiScoreAfter <= body.aiScoreBefore, `score should not increase`);
    // Furthermore/Moreover should be replaced
    assert.ok(!/furthermore/i.test(body.text), 'furthermore should be removed');
    assert.ok(!/moreover/i.test(body.text), 'moreover should be removed');
  } finally {
    server.close();
  }
});

test('POST /api/paraphrase/humanize: empty text returns 400', async () => {
  const { server, baseURL } = await startScoreServer();
  try {
    const { status, body } = await postJSON(`${baseURL}/api/paraphrase/humanize`, { text: '' });
    assert.equal(status, 400);
    assert.equal(body.error, 'missing_text');
  } finally {
    server.close();
  }
});

test('POST /api/paraphrase/humanize: text > MAX_TEXT_LENGTH returns 413', async () => {
  const { server, baseURL } = await startScoreServer();
  try {
    const huge = 'a'.repeat(MAX_TEXT_LENGTH + 100);
    const { status, body } = await postJSON(`${baseURL}/api/paraphrase/humanize`, { text: huge });
    assert.equal(status, 413);
    assert.equal(body.error, 'text_too_long');
  } finally {
    server.close();
  }
});

test('POST /api/paraphrase/humanize: long input routes through humanizeChunked', async () => {
  const { server, baseURL } = await startScoreServer();
  try {
    // 9000 chars > 8000 threshold → uses humanizeChunked
    const input = 'Furthermore, this is excellent. '.repeat(300);
    const { status, body } = await postJSON(
      `${baseURL}/api/paraphrase/humanize`,
      { text: input, language: 'en', intensity: 'medium' },
    );
    assert.equal(status, 200);
    assert.equal(typeof body.text, 'string');
    assert.ok(body.text.length > 0);
  } finally {
    server.close();
  }
});
