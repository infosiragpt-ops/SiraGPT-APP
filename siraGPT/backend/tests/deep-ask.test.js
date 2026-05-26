/**
 * Tests for services/rag/deep-ask.js — the multi-hop orchestrator.
 *
 * The function is pure composition over three stubbable dependencies
 * (decomposer LLM, anthropicCitations module, optional NLI). Tests
 * inject fakes for all three.
 *
 * Coverage:
 *   - buildEnrichedQuestion: single subquery → unchanged; multi-
 *     subquery → enriched with combine-aware framing
 *   - deepAskFile end-to-end: decompose → cite → verification summary
 *   - Typed-code errors for missing args / missing openai / missing
 *     anthropicCitations module
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const da = require('../src/services/rag/deep-ask');

function fakeOpenai(decomposerPayload) {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: { content: JSON.stringify(decomposerPayload) },
          }],
        }),
      },
    },
  };
}

function fakeAnthropicCitations({ blocks, citations, verifyAttachesVerdict = false }) {
  return {
    answerFileQuestionWithCitations: async ({ prisma: _p, userId: _u, fileId, question, options }) => {
      const finalBlocks = blocks.map((b) => ({
        ...b,
        citations: b.citations.map((c) => ({ ...c })),
      }));
      if (options.verify && verifyAttachesVerdict) {
        for (const b of finalBlocks) {
          for (const c of b.citations) {
            c.verification = { label: 'entailment', score: 0.9, reason: 'ok', backend: 'llm' };
          }
        }
      }
      const flat = finalBlocks.flatMap((b) => b.citations);
      return {
        fileId,
        fileTitle: `title-${fileId}`,
        text: 'final answer',
        blocks: finalBlocks,
        citations: flat,
        usage: { input_tokens: 100, output_tokens: 50 },
        __seenQuestion: question,
        __seenVerify: !!options.verify,
      };
    },
  };
}

// ── buildEnrichedQuestion ────────────────────────────────────────────────

test('buildEnrichedQuestion returns original when only one subquery', () => {
  const out = da.buildEnrichedQuestion('what is X?', { subqueries: ['what is X?'], combine: 'concat' });
  assert.equal(out, 'what is X?');
});

test('buildEnrichedQuestion lists multiple subqueries with concat framing by default', () => {
  const out = da.buildEnrichedQuestion('original', {
    subqueries: ['a', 'b', 'c'],
    combine: 'concat',
  });
  assert.match(out, /^original\n\n---/);
  assert.match(out, /Address EACH/);
  assert.match(out, /1\. a/);
  assert.match(out, /3\. c/);
});

test('buildEnrichedQuestion uses sequence framing when combine=sequence', () => {
  const out = da.buildEnrichedQuestion('orig', {
    subqueries: ['s1', 's2'],
    combine: 'sequence',
  });
  assert.match(out, /BUILD on each other/);
});

test('buildEnrichedQuestion uses intersect framing when combine=intersect', () => {
  const out = da.buildEnrichedQuestion('orig', {
    subqueries: ['s1', 's2'],
    combine: 'intersect',
  });
  assert.match(out, /satisfies ALL/);
});

test('buildEnrichedQuestion falls back to concat framing for unknown combine', () => {
  const out = da.buildEnrichedQuestion('orig', {
    subqueries: ['s1', 's2'],
    combine: 'cosmic',
  });
  assert.match(out, /Address EACH/);
});

// ── deepAskFile end-to-end ──────────────────────────────────────────────

test('deepAskFile threads decomposition into the citations call', async () => {
  const openai = fakeOpenai({
    subqueries: ['what is X?', 'how does Y interact with X?'],
    rationale: 'two hops',
    combine: 'concat',
  });
  const anth = fakeAnthropicCitations({
    blocks: [{
      text: 'X is defined as ... Y interacts via ...',
      citations: [
        { cited: 'X is defined as foo', documentIndex: 0, start: 0, end: 19, kind: 'char' },
        { cited: 'Y interacts via bar', documentIndex: 0, start: 20, end: 39, kind: 'char' },
      ],
    }],
  });

  const out = await da.deepAskFile({
    prisma: {},
    openai,
    anthropicCitations: anth,
    userId: 'u1',
    fileId: 'f1',
    question: 'tell me about X and Y',
  });

  assert.equal(out.decomposition.subqueries.length, 2);
  assert.equal(out.answer, 'final answer');
  assert.equal(out.citations.length, 2);
  assert.equal(out.verification, undefined, 'no verify flag → no verification summary');
});

test('deepAskFile passes a single-subquery decomp through unchanged', async () => {
  const openai = fakeOpenai({
    subqueries: ['solo question'],
    rationale: 'atomic',
    combine: 'concat',
  });
  let capturedQuestion = null;
  const anth = {
    answerFileQuestionWithCitations: async ({ question }) => {
      capturedQuestion = question;
      return {
        fileId: 'f1',
        fileTitle: 'doc',
        text: 'ok',
        blocks: [],
        citations: [],
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
  };
  await da.deepAskFile({
    prisma: {},
    openai,
    anthropicCitations: anth,
    userId: 'u1',
    fileId: 'f1',
    question: 'solo question',
  });
  // Single subquery → no enrichment
  assert.equal(capturedQuestion, 'solo question');
});

test('deepAskFile with verify=true forwards verify into citations and surfaces summary', async () => {
  const openai = fakeOpenai({
    subqueries: ['only one'],
    rationale: '',
    combine: 'concat',
  });
  const anth = fakeAnthropicCitations({
    blocks: [{
      text: 'claim text',
      citations: [
        { cited: 'evidence one', documentIndex: 0, kind: 'char', start: 0, end: 12 },
        { cited: 'evidence two', documentIndex: 0, kind: 'char', start: 12, end: 24 },
      ],
    }],
    verifyAttachesVerdict: true,
  });

  const out = await da.deepAskFile({
    prisma: {},
    openai,
    anthropicCitations: anth,
    userId: 'u1',
    fileId: 'f1',
    question: 'q',
    options: { verify: true },
  });

  assert.ok(out.verification);
  assert.equal(out.verification.applied, true);
  assert.equal(out.verification.perCitation, 2);
  assert.equal(out.verification.entailment, 2);
  assert.equal(out.verification.contradiction, 0);
});

test('deepAskFile rejects with deep_ask_bad_args when args are missing', async () => {
  await assert.rejects(
    () => da.deepAskFile({ openai: fakeOpenai({}), anthropicCitations: fakeAnthropicCitations({ blocks: [] }), userId: 'u', fileId: 'f', question: 'q' }),
    (err) => err.code === 'deep_ask_bad_args',
  );
  await assert.rejects(
    () => da.deepAskFile({ prisma: {}, openai: fakeOpenai({}), anthropicCitations: fakeAnthropicCitations({ blocks: [] }), userId: '', fileId: 'f', question: 'q' }),
    (err) => err.code === 'deep_ask_bad_args',
  );
  await assert.rejects(
    () => da.deepAskFile({ prisma: {}, openai: fakeOpenai({}), anthropicCitations: fakeAnthropicCitations({ blocks: [] }), userId: 'u', fileId: 'f', question: '   ' }),
    (err) => err.code === 'deep_ask_bad_args',
  );
});

test('deepAskFile rejects with deep_ask_no_openai when openai client is missing', async () => {
  await assert.rejects(
    () => da.deepAskFile({
      prisma: {}, anthropicCitations: fakeAnthropicCitations({ blocks: [] }),
      userId: 'u', fileId: 'f', question: 'q',
    }),
    (err) => err.code === 'deep_ask_no_openai',
  );
});

test('deepAskFile rejects with deep_ask_no_anthropic_module when wiring missing', async () => {
  await assert.rejects(
    () => da.deepAskFile({
      prisma: {}, openai: fakeOpenai({}),
      userId: 'u', fileId: 'f', question: 'q',
    }),
    (err) => err.code === 'deep_ask_no_anthropic_module',
  );
});
