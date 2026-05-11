/**
 * Tests for the NLI faithfulness verifier.
 *
 * No real API calls — every test injects either a fake fetch (HF
 * backend) or a fake openai (LLM backend). Coverage:
 *   - verifyClaim routes to HF when token is set + HTTP probe
 *   - verifyClaim routes to LLM when no HF token but openai provided
 *   - verifyClaim throws nli_disabled when neither is configured
 *   - HF response parsing: nested arrays, label vocab variants,
 *     malformed payloads
 *   - LLM backend: strict schema sent by default; opt-out works
 *   - verifyClaimsBatch: per-item failure isolation, order preserved
 *   - Bad inputs (missing claim / evidence) raise nli_bad_args
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const nli = require('../src/services/rag/nli-faithfulness');

function withEnv(temp, fn) {
  const saved = {};
  for (const k of Object.keys(temp)) {
    saved[k] = process.env[k];
    if (temp[k] === undefined) delete process.env[k];
    else process.env[k] = temp[k];
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function fakeHfFetch(payload, opts = {}) {
  return async (_url, init) => {
    if (opts.assertHeaders) opts.assertHeaders(init.headers);
    if (opts.throws) throw opts.throws;
    if (opts.status && opts.status >= 400) {
      return { ok: false, status: opts.status, json: async () => ({}), text: async () => '' };
    }
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
}

function fakeOpenai(payload, opts = {}) {
  const calls = [];
  const client = {
    chat: {
      completions: {
        create: async (req) => {
          calls.push(req);
          if (opts.throws) throw opts.throws;
          const content = typeof payload === 'string' ? payload : JSON.stringify(payload);
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
  client.__calls = calls;
  return client;
}

// ── pickBackend ───────────────────────────────────────────────────────────

test('pickBackend prefers huggingface when HF token is set', () => {
  withEnv({ HUGGINGFACE_API_TOKEN: 'hf-test' }, () => {
    assert.equal(nli.pickBackend(process.env), 'huggingface');
  });
  withEnv({ HUGGINGFACE_API_TOKEN: undefined }, () => {
    assert.equal(nli.pickBackend(process.env), null);
  });
});

// ── canonicaliseLabel + normalizeHfResponse ──────────────────────────────

test('canonicaliseLabel maps common label variants to the 3-class set', () => {
  assert.equal(nli.canonicaliseLabel('ENTAILMENT'), 'entailment');
  assert.equal(nli.canonicaliseLabel('Entail'), 'entailment');
  assert.equal(nli.canonicaliseLabel('contradiction'), 'contradiction');
  assert.equal(nli.canonicaliseLabel('CONTRADICT'), 'contradiction');
  assert.equal(nli.canonicaliseLabel('NEUTRAL'), 'neutral');
  assert.equal(nli.canonicaliseLabel('unrelated'), 'neutral');
  assert.equal(nli.canonicaliseLabel('garbage'), null);
});

test('normalizeHfResponse picks the highest-scoring known label', () => {
  const out = nli.normalizeHfResponse([
    { label: 'NEUTRAL', score: 0.05 },
    { label: 'CONTRADICTION', score: 0.02 },
    { label: 'ENTAILMENT', score: 0.93 },
  ]);
  assert.deepEqual(out, { label: 'entailment', score: 0.93 });
});

test('normalizeHfResponse unwraps nested arrays', () => {
  const out = nli.normalizeHfResponse([[
    { label: 'CONTRADICTION', score: 0.88 },
    { label: 'NEUTRAL', score: 0.10 },
  ]]);
  assert.equal(out.label, 'contradiction');
});

test('normalizeHfResponse returns null when no labels are recognised', () => {
  assert.equal(nli.normalizeHfResponse([{ label: 'GARBAGE', score: 0.9 }]), null);
  assert.equal(nli.normalizeHfResponse('not an array'), null);
  assert.equal(nli.normalizeHfResponse([]), null);
});

// ── verifyClaim — HF backend ──────────────────────────────────────────────

test('verifyClaim routes to HF backend when HF token is set + returns canonical envelope', async () => {
  await withEnv({ HUGGINGFACE_API_TOKEN: 'hf-test' }, async () => {
    const out = await nli.verifyClaim({
      claim: 'unemployment fell in Q2',
      evidence: 'Q2 unemployment dropped 1.2 points compared to Q1.',
      options: {
        fetchImpl: fakeHfFetch([
          { label: 'ENTAILMENT', score: 0.96 },
          { label: 'NEUTRAL', score: 0.03 },
        ], {
          assertHeaders: (h) => assert.match(h.Authorization, /^Bearer hf-test$/),
        }),
      },
    });
    assert.equal(out.label, 'entailment');
    assert.equal(out.backend, 'huggingface');
    assert.ok(out.score > 0.9);
  });
});

test('verifyClaim HF maps non-2xx to nli_huggingface_failed with status', async () => {
  await withEnv({ HUGGINGFACE_API_TOKEN: 'hf-test' }, async () => {
    await assert.rejects(
      () => nli.verifyClaim({
        claim: 'c', evidence: 'e',
        options: { fetchImpl: fakeHfFetch(null, { status: 503 }) },
      }),
      (err) => {
        assert.equal(err.code, 'nli_huggingface_failed');
        assert.equal(err.status, 503);
        return true;
      },
    );
  });
});

test('verifyClaim HF wraps network errors with nli_huggingface_failed', async () => {
  await withEnv({ HUGGINGFACE_API_TOKEN: 'hf-test' }, async () => {
    await assert.rejects(
      () => nli.verifyClaim({
        claim: 'c', evidence: 'e',
        options: { fetchImpl: async () => { throw new Error('ECONNRESET'); } },
      }),
      (err) => err.code === 'nli_huggingface_failed',
    );
  });
});

// ── verifyClaim — LLM backend ─────────────────────────────────────────────

test('verifyClaim routes to LLM backend when no HF token but openai is provided', async () => {
  await withEnv({ HUGGINGFACE_API_TOKEN: undefined }, async () => {
    const openai = fakeOpenai({ label: 'contradiction', score: 0.82, reason: 'evidence states the opposite' });
    const out = await nli.verifyClaim({
      claim: 'X is true', evidence: 'X is false',
      options: { openai },
    });
    assert.equal(out.label, 'contradiction');
    assert.equal(out.score, 0.82);
    assert.equal(out.backend, 'llm');
    // Default backend uses strict schema.
    const req = openai.__calls[0];
    assert.equal(req.response_format.type, 'json_schema');
    assert.equal(req.response_format.json_schema.strict, true);
  });
});

test('verifyClaim LLM opts out to json_object when useStrictSchema=false', async () => {
  await withEnv({ HUGGINGFACE_API_TOKEN: undefined }, async () => {
    const openai = fakeOpenai({ label: 'neutral', score: 0.5, reason: 'unclear' });
    await nli.verifyClaim({
      claim: 'c', evidence: 'e',
      options: { openai, useStrictSchema: false },
    });
    assert.equal(openai.__calls[0].response_format.type, 'json_object');
  });
});

test('verifyClaim LLM snaps unknown label to neutral', async () => {
  await withEnv({ HUGGINGFACE_API_TOKEN: undefined }, async () => {
    const openai = fakeOpenai({ label: 'YES_DEFINITELY', score: 1.5, reason: 'x' });
    const out = await nli.verifyClaim({
      claim: 'c', evidence: 'e',
      options: { openai },
    });
    assert.equal(out.label, 'neutral');
    // Score also clamped.
    assert.equal(out.score, 1);
  });
});

test('verifyClaim throws nli_disabled when neither backend is configured', async () => {
  await withEnv({ HUGGINGFACE_API_TOKEN: undefined }, async () => {
    await assert.rejects(
      () => nli.verifyClaim({ claim: 'c', evidence: 'e' }),
      (err) => err.code === 'nli_disabled',
    );
  });
});

test('verifyClaim raises nli_bad_args on missing claim or evidence', async () => {
  await assert.rejects(() => nli.verifyClaim({ evidence: 'e' }), (err) => err.code === 'nli_bad_args');
  await assert.rejects(() => nli.verifyClaim({ claim: 'c', evidence: '   ' }), (err) => err.code === 'nli_bad_args');
});

// ── verifyClaimsBatch ────────────────────────────────────────────────────

test('verifyClaimsBatch returns one verdict per input in input order', async () => {
  await withEnv({ HUGGINGFACE_API_TOKEN: undefined }, async () => {
    const openai = fakeOpenai({ label: 'entailment', score: 0.9, reason: 'matches' });
    const out = await nli.verifyClaimsBatch({
      items: [
        { claim: 'A', evidence: 'a-text' },
        { claim: 'B', evidence: 'b-text' },
        { claim: 'C', evidence: 'c-text' },
      ],
      options: { openai, concurrency: 1 },
    });
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((r) => r.claim), ['A', 'B', 'C']);
    assert.equal(out[0].backend, 'llm');
  });
});

test('verifyClaimsBatch isolates per-item failures (returns backend:error verdict)', async () => {
  await withEnv({ HUGGINGFACE_API_TOKEN: undefined }, async () => {
    let n = 0;
    const openai = {
      chat: {
        completions: {
          create: async () => {
            n += 1;
            if (n === 2) throw new Error('429 rate limit');
            return { choices: [{ message: { content: JSON.stringify({ label: 'entailment', score: 0.9, reason: 'ok' }) } }] };
          },
        },
      },
    };
    const out = await nli.verifyClaimsBatch({
      items: [
        { claim: 'A', evidence: 'a' },
        { claim: 'B', evidence: 'b' },
        { claim: 'C', evidence: 'c' },
      ],
      options: { openai, concurrency: 1 },
    });
    assert.equal(out.length, 3);
    assert.equal(out[0].label, 'entailment');
    assert.equal(out[1].backend, 'error');
    assert.equal(out[1].label, 'neutral');
    assert.match(out[1].error, /rate limit/);
    assert.equal(out[2].backend, 'llm');
  });
});

test('verifyClaimsBatch returns [] for empty input', async () => {
  const out = await nli.verifyClaimsBatch({ items: [] });
  assert.deepEqual(out, []);
});
