'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const streamer = require('../src/services/agentic-final-streamer');

describe('isEnabled — progressive final-answer streaming defaults ON', () => {
  test('enabled when the env var is unset (default ON)', () => {
    const prev = process.env.SIRAGPT_AGENTIC_STREAM_FINAL;
    delete process.env.SIRAGPT_AGENTIC_STREAM_FINAL;
    try { assert.equal(streamer.isEnabled(), true); }
    finally { if (prev !== undefined) process.env.SIRAGPT_AGENTIC_STREAM_FINAL = prev; }
  });

  test('disabled only when explicitly set to 0/off/false', () => {
    const prev = process.env.SIRAGPT_AGENTIC_STREAM_FINAL;
    try {
      for (const off of ['0', 'off', 'false']) {
        process.env.SIRAGPT_AGENTIC_STREAM_FINAL = off;
        assert.equal(streamer.isEnabled(), false, `"${off}" must disable`);
      }
      for (const on of ['1', 'on', 'true']) {
        process.env.SIRAGPT_AGENTIC_STREAM_FINAL = on;
        assert.equal(streamer.isEnabled(), true, `"${on}" must enable`);
      }
    } finally {
      if (prev === undefined) delete process.env.SIRAGPT_AGENTIC_STREAM_FINAL;
      else process.env.SIRAGPT_AGENTIC_STREAM_FINAL = prev;
    }
  });
});

describe('chunkForStreaming', () => {
  test('empty → []', () => {
    assert.deepEqual(streamer.chunkForStreaming(''), []);
    assert.deepEqual(streamer.chunkForStreaming(null), []);
  });

  test('reassembles to the exact original text (lossless)', () => {
    const text = 'Esta es una respuesta larga. Tiene varias frases, comas y palabras que no deben partirse. '.repeat(6);
    const chunks = streamer.chunkForStreaming(text, { targetChars: 40 });
    assert.equal(chunks.join(''), text);
  });

  // A boundary splits a word when chunk[k] ends on a non-space AND chunk[k+1]
  // starts on a non-space (a word run spans the seam with no whitespace).
  function midWordSeams(chunks) {
    const seams = [];
    for (let k = 0; k < chunks.length - 1; k += 1) {
      const a = chunks[k];
      const b = chunks[k + 1];
      if (a && b && !/\s/.test(a[a.length - 1]) && !/\s/.test(b[0])) {
        seams.push([a, b]);
      }
    }
    return seams;
  }

  test('never splits mid-word for normal prose', () => {
    const text = 'palabra1 palabra2 palabra3 palabra4 palabra5 palabra6 palabra7 palabra8';
    const chunks = streamer.chunkForStreaming(text, { targetChars: 12 });
    assert.equal(chunks.join(''), text);
    assert.deepEqual(midWordSeams(chunks), [], 'no chunk seam falls inside a word');
  });

  test('keeps a word whole when it starts in the first half and crosses the target', () => {
    // Regression: the old i+0.5·target back-off floor split this word
    // ("aa bbbbbbbbbbbb" → "aa bbbbbbbbb" | "bbb cc").
    const text = `aa ${'b'.repeat(12)} cc`;
    const chunks = streamer.chunkForStreaming(text, { targetChars: 12 });
    assert.equal(chunks.join(''), text);
    assert.deepEqual(midWordSeams(chunks), [], `unexpected mid-word seam: ${JSON.stringify(chunks)}`);
  });

  test('hard-splits a pathologically long token (no whitespace to break on)', () => {
    const url = 'x'.repeat(500);
    const chunks = streamer.chunkForStreaming(`see ${url} end`, { targetChars: 32 });
    assert.equal(chunks.join(''), `see ${url} end`);
    // The 500-char token MUST be split (unavoidable), but each chunk stays
    // bounded — never the whole token in one frame.
    for (const c of chunks) assert.ok(c.length <= 32 * 4, `chunk too long: ${c.length}`);
  });

  test('caps the number of chunks', () => {
    const text = 'x '.repeat(5000);
    const chunks = streamer.chunkForStreaming(text, { targetChars: 8, maxChunks: 20 });
    assert.ok(chunks.length <= 20);
    assert.equal(chunks.join(''), text);
  });

  test('prefers sentence boundaries', () => {
    const text = 'Uno. Dos. Tres. Cuatro. Cinco.';
    const chunks = streamer.chunkForStreaming(text, { targetChars: 5 });
    // first chunk should end right after a sentence terminator
    assert.match(chunks[0], /\.\s?$/);
  });
});

describe('streamFinalAnswer', () => {
  function collector() {
    const frames = [];
    return { frames, writeSse: async (_res, payload) => { frames.push(payload); } };
  }

  test('disabled → single frame with prefix', async () => {
    const { frames, writeSse } = collector();
    await streamer.streamFinalAnswer({ res: {}, writeSse, prefix: 'SENTINEL', finalAnswer: 'x'.repeat(500), enabled: false });
    assert.equal(frames.length, 1);
    assert.equal(frames[0].replace, true);
    assert.equal(frames[0].content, `SENTINEL\n\n${'x'.repeat(500)}`);
  });

  test('short answer → single frame even when enabled', async () => {
    const { frames, writeSse } = collector();
    await streamer.streamFinalAnswer({ res: {}, writeSse, prefix: 'S', finalAnswer: 'corto', enabled: true });
    assert.equal(frames.length, 1);
  });

  test('enabled + long → multiple growing frames ending with full answer', async () => {
    const answer = 'Frase número uno. Frase número dos. Frase número tres. Frase número cuatro. '.repeat(4);
    const { frames, writeSse } = collector();
    await streamer.streamFinalAnswer({ res: {}, writeSse, prefix: 'TL', finalAnswer: answer, enabled: true, delayMs: 0 });
    assert.ok(frames.length > 1, `expected multiple frames, got ${frames.length}`);
    // every frame is a replace with the sentinel prefix
    for (const f of frames) {
      assert.equal(f.replace, true);
      assert.match(f.content, /^TL\n\n/);
    }
    // content grows monotonically
    for (let i = 1; i < frames.length; i += 1) {
      assert.ok(frames[i].content.length >= frames[i - 1].content.length);
    }
    // final frame contains the full answer
    assert.equal(frames[frames.length - 1].content, `TL\n\n${answer}`);
  });

  test('stops when res.writableEnded mid-stream but still nothing throws', async () => {
    const answer = 'Una frase. '.repeat(50);
    const res = { writableEnded: false };
    let calls = 0;
    const writeSse = async () => { calls += 1; if (calls === 2) res.writableEnded = true; };
    await streamer.streamFinalAnswer({ res, writeSse, prefix: 'P', finalAnswer: answer, enabled: true, delayMs: 0 });
    assert.ok(calls >= 2);
  });

  test('writeSse throwing falls back without rethrowing', async () => {
    let calls = 0;
    const writeSse = async () => { calls += 1; if (calls === 1) throw new Error('boom'); };
    await assert.doesNotReject(
      streamer.streamFinalAnswer({ res: {}, writeSse, prefix: '', finalAnswer: 'y'.repeat(400), enabled: true, delayMs: 0 })
    );
  });
});
