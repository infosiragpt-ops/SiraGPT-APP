'use strict';

/**
 * Memory extraction parsing (prod 2026-09-28: «[long-term-memory] extraction
 * returned no parseable JSON» while facts were silently lost on other turns).
 * The memory model is DeepSeek V4 (thinking by default) and answers with a
 * fence followed by prose, prose before the JSON, a <think> prefix, trailing
 * commas, a bare array or a single fact — all must parse. An empty answer or
 * a «no facts» prose answer is not an error and must not warn.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseExtractionPayload,
  parseModelJson,
  extractFacts,
} = require('../src/services/long-term-memory');

describe('parseExtractionPayload — tolerant shapes', () => {
  test('a fence followed by prose', () => {
    const out = parseExtractionPayload('```json\n{"facts":[{"fact":"usa Mac","confidence":0.9}]}\n```\nNo hay más hechos duraderos.');
    assert.deepEqual(out.facts.map((f) => f.fact), ['usa Mac']);
  });

  test('prose before the JSON', () => {
    const out = parseExtractionPayload('Here is the JSON:\n{"facts":[{"fact":"vive en Lima"}]}');
    assert.deepEqual(out.facts.map((f) => f.fact), ['vive en Lima']);
  });

  test('a <think> prefix (even one containing braces)', () => {
    const out = parseExtractionPayload('<think>el usuario dijo {algo}; revisar [x]</think>\n{"facts":[{"fact":"prefiere respuestas cortas"}]}');
    assert.deepEqual(out.facts.map((f) => f.fact), ['prefiere respuestas cortas']);
  });

  test('trailing commas', () => {
    const out = parseExtractionPayload('{"facts":[{"fact":"trabaja en finanzas","category":"work",},],}');
    assert.deepEqual(out.facts, [{ fact: 'trabaja en finanzas', category: 'work' }]);
  });

  test('a bare array becomes {facts}', () => {
    const out = parseExtractionPayload('[{"fact":"habla español","category":"personal"}]');
    assert.deepEqual(out, { facts: [{ fact: 'habla español', category: 'personal' }] });
  });

  test('a single fact object becomes {facts:[obj]}', () => {
    const out = parseExtractionPayload('{"fact":"usa Linux","category":"preference","confidence":0.8}');
    assert.deepEqual(out, { facts: [{ fact: 'usa Linux', category: 'preference', confidence: 0.8 }] });
  });

  test('facts given as an object becomes a one-item array', () => {
    const out = parseExtractionPayload('{"facts":{"fact":"es médico","category":"work"}}');
    assert.deepEqual(out.facts, [{ fact: 'es médico', category: 'work' }]);
  });

  test('an empty facts array stays empty', () => {
    assert.deepEqual(parseExtractionPayload('{"facts":[]}'), { facts: [] });
  });
});

describe('parseExtractionPayload — nothing to recover', () => {
  test("'not json at all' and '' still return null", () => {
    assert.equal(parseExtractionPayload('not json at all'), null);
    assert.equal(parseExtractionPayload(''), null);
    assert.equal(parseExtractionPayload('<think>solo pensé</think>'), null);
  });

  test('a first fact cut inside its text returns null (no half fact is invented)', () => {
    assert.equal(parseExtractionPayload('{"facts":[{"fact":"El usuario trabaja en'), null);
  });

  test('the complete facts of a truncated answer are still salvaged', () => {
    const out = parseExtractionPayload('{"facts":[{"fact":"usa Mac","confidence":0.9},{"fact":"vive en Li');
    assert.equal(out.salvaged, true);
    assert.deepEqual(out.facts.map((f) => f.fact), ['usa Mac']);
  });
});

describe('parseModelJson (shared with personal-lexicon)', () => {
  test('parses terms behind a <think> prefix and a fence', () => {
    assert.deepEqual(parseModelJson('<think>x</think>```json\n{"terms":[{"term":"mi CV","definition":"cv.pdf"}]}\n```'), {
      terms: [{ term: 'mi CV', definition: 'cv.pdf' }],
    });
  });
  test('returns null for prose', () => {
    assert.equal(parseModelJson('No encontré términos personales.'), null);
  });
});

function fakeClient(reply, calls = []) {
  return {
    chat: {
      completions: {
        create: async (payload) => {
          calls.push(payload);
          return { choices: [{ message: { content: reply.content }, finish_reason: reply.finish_reason || 'stop' }] };
        },
      },
    },
  };
}

describe('extractFacts — logging and budget', () => {
  const USER = 'Trabajo como contador en Lima y prefiero respuestas breves.';
  const ASSISTANT = 'Entendido, seré breve.';
  let warnCalls;
  let infoCalls;
  let originalWarn;
  let originalInfo;

  beforeEach(() => {
    warnCalls = [];
    infoCalls = [];
    originalWarn = console.warn;
    originalInfo = console.info;
    console.warn = (...args) => { warnCalls.push(args.join(' ')); };
    console.info = (...args) => { infoCalls.push(args.join(' ')); };
  });

  afterEach(() => {
    console.warn = originalWarn;
    console.info = originalInfo;
  });

  test("content '' → [] and console.warn is never called", async () => {
    const facts = await extractFacts(fakeClient({ content: '' }), USER, ASSISTANT);
    assert.deepEqual(facts, []);
    assert.deepEqual(warnCalls, []);
  });

  test('a «no facts» prose answer is a silent empty result', async () => {
    const facts = await extractFacts(fakeClient({ content: 'No hay hechos duraderos en este turno.' }), USER, ASSISTANT);
    assert.deepEqual(facts, []);
    assert.deepEqual(warnCalls, []);
  });

  test("finish_reason 'length' with nothing salvageable → info, never warn", async () => {
    const facts = await extractFacts(
      fakeClient({ content: '{"facts":[{"fact":"El usuario trabaja como cont', finish_reason: 'length' }),
      USER,
      ASSISTANT,
    );
    assert.deepEqual(facts, []);
    assert.deepEqual(warnCalls, []);
    assert.equal(infoCalls.length, 1);
    assert.match(infoCalls[0], /truncated/);
  });

  test('the request budget is at least 1200 tokens', async () => {
    const calls = [];
    await extractFacts(fakeClient({ content: '{"facts":[]}' }, calls), USER, ASSISTANT);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].max_tokens >= 1200, `max_tokens=${calls[0].max_tokens}`);
  });

  test('a bare-array reply returns the facts', async () => {
    const facts = await extractFacts(
      fakeClient({ content: '[{"fact":"Trabaja como contador en Lima","category":"work","confidence":0.9}]' }),
      USER,
      ASSISTANT,
    );
    assert.deepEqual(facts, [{ fact: 'Trabaja como contador en Lima', category: 'work', confidence: 0.9 }]);
  });

  test('broken JSON warns at most once per window', async () => {
    const broken = fakeClient({ content: '{"facts": [ {"fact": nope} ] ??? }' });
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      assert.deepEqual(await extractFacts(broken, USER, ASSISTANT), []);
    }
    assert.ok(warnCalls.length <= 1, `expected ≤1 warn, got ${warnCalls.length}`);
  });
});
