/**
 * Tests for the Anthropic Citations API wrapper.
 *
 * No real API calls — every test injects a fake SDK client via the
 * module's _setClientForTests seam (or stubs process.env for the
 * isAvailable / disabled-error paths via anthropic-native).
 *
 * Coverage:
 *   - buildDocumentBlocks: text / pdf / custom_content shape mapping
 *   - buildMessages: documents are attached to the LAST user turn
 *   - normalizeCitations: char_location / page_location / block_location
 *   - callAnthropicWithCitations: round-trip happy path + typed errors
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../src/services/providers/anthropic-citations');
const native = require('../src/services/providers/anthropic-native');

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

// ─── buildDocumentBlocks ──────────────────────────────────────────────────

test('buildDocumentBlocks maps a text document to the SDK shape with citations enabled', () => {
  const out = mod.buildDocumentBlocks([
    { type: 'text', title: 'Hello', data: 'Body text here', context: 'Provenance: test' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'document');
  assert.equal(out[0].title, 'Hello');
  assert.equal(out[0].source.type, 'text');
  assert.equal(out[0].source.media_type, 'text/plain');
  assert.equal(out[0].source.data, 'Body text here');
  assert.equal(out[0].citations.enabled, true);
  assert.equal(out[0].context, 'Provenance: test');
});

test('buildDocumentBlocks maps a pdf document to base64 source with application/pdf', () => {
  const fakeBase64 = 'JVBERi0xLjQK';
  const out = mod.buildDocumentBlocks([{ type: 'pdf', title: 'Report.pdf', data: fakeBase64 }]);
  assert.equal(out[0].source.type, 'base64');
  assert.equal(out[0].source.media_type, 'application/pdf');
  assert.equal(out[0].source.data, fakeBase64);
});

test('buildDocumentBlocks maps custom_content to a content array of text blocks', () => {
  const out = mod.buildDocumentBlocks([
    { type: 'custom_content', title: 'Chunks', chunks: ['first chunk', { text: 'second chunk' }, ''] },
  ]);
  assert.equal(out[0].source.type, 'content');
  assert.deepEqual(
    out[0].source.content.map((c) => c.text),
    ['first chunk', 'second chunk'],
  );
});

test('buildDocumentBlocks skips empty/invalid documents quietly', () => {
  const out = mod.buildDocumentBlocks([
    null,
    { type: 'text', title: 'empty', data: '' },
    { type: 'unknown_type', title: 'x', data: 'y' },
    { type: 'text', title: 'good', data: 'real' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'good');
});

test('buildDocumentBlocks defaults title to "document" when missing', () => {
  const out = mod.buildDocumentBlocks([{ type: 'text', data: 'x' }]);
  assert.equal(out[0].title, 'document');
});

// ─── buildMessages ────────────────────────────────────────────────────────

test('buildMessages synthesises a user turn when no messages are provided', () => {
  const docs = mod.buildDocumentBlocks([{ type: 'text', title: 'A', data: 'A body' }]);
  const out = mod.buildMessages([], docs);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].content[0].type, 'document');
  assert.equal(out[0].content[1].type, 'text');
});

test('buildMessages attaches documents to the LAST user turn, preserves prior history', () => {
  const docs = mod.buildDocumentBlocks([{ type: 'text', title: 'A', data: 'A body' }]);
  const out = mod.buildMessages([
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
  ], docs);

  assert.equal(out.length, 3);
  // First user turn untouched (string content, no doc blocks).
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].content, 'first question');
  // Assistant turn untouched.
  assert.equal(out[1].role, 'assistant');
  assert.equal(out[1].content, 'first answer');
  // Last user turn has documents prepended.
  assert.equal(out[2].role, 'user');
  assert.equal(Array.isArray(out[2].content), true);
  assert.equal(out[2].content[0].type, 'document');
  assert.equal(out[2].content[1].type, 'text');
  assert.equal(out[2].content[1].text, 'second question');
});

test('buildMessages stringifies non-string assistant content for SDK compatibility', () => {
  const docs = mod.buildDocumentBlocks([{ type: 'text', title: 'A', data: 'A body' }]);
  const out = mod.buildMessages([
    { role: 'assistant', content: { tool: 'use', payload: 'x' } },
    { role: 'user', content: 'q' },
  ], docs);
  assert.equal(out[0].content, '{"tool":"use","payload":"x"}');
});

// ─── normalizeCitations ───────────────────────────────────────────────────

test('normalizeCitations returns empty shape for non-array input', () => {
  const out = mod.normalizeCitations(null);
  assert.equal(out.text, '');
  assert.deepEqual(out.blocks, []);
  assert.deepEqual(out.citations, []);
});

test('normalizeCitations concatenates plain text blocks and ignores non-text blocks', () => {
  const out = mod.normalizeCitations([
    { type: 'text', text: 'hello ' },
    { type: 'tool_use', id: 'x', name: 'foo', input: {} },
    { type: 'text', text: 'world' },
  ]);
  assert.equal(out.text, 'hello world');
  assert.equal(out.blocks.length, 2);
});

test('normalizeCitations parses char_location citations with start/end indices', () => {
  const out = mod.normalizeCitations([
    {
      type: 'text',
      text: 'According to the doc, the fox is quick.',
      citations: [{
        type: 'char_location',
        cited_text: 'The quick brown fox',
        document_index: 0,
        document_title: 'Sample',
        start_char_index: 0,
        end_char_index: 19,
      }],
    },
  ]);
  assert.equal(out.citations.length, 1);
  assert.equal(out.citations[0].kind, 'char');
  assert.equal(out.citations[0].documentIndex, 0);
  assert.equal(out.citations[0].documentTitle, 'Sample');
  assert.equal(out.citations[0].cited, 'The quick brown fox');
  assert.equal(out.citations[0].start, 0);
  assert.equal(out.citations[0].end, 19);
});

test('normalizeCitations parses page_location citations into kind="page"', () => {
  const out = mod.normalizeCitations([
    {
      type: 'text',
      text: 'P3 says so.',
      citations: [{
        type: 'page_location',
        cited_text: 'page 3 content',
        document_index: 1,
        document_title: 'Report.pdf',
        start_page_number: 3,
        end_page_number: 3,
      }],
    },
  ]);
  assert.equal(out.citations[0].kind, 'page');
  assert.equal(out.citations[0].start, 3);
  assert.equal(out.citations[0].end, 3);
});

test('normalizeCitations parses content_block_location citations into kind="block"', () => {
  const out = mod.normalizeCitations([
    {
      type: 'text',
      text: 'See chunk 2.',
      citations: [{
        type: 'content_block_location',
        cited_text: 'block 2 text',
        document_index: 0,
        start_block_index: 2,
        end_block_index: 2,
      }],
    },
  ]);
  assert.equal(out.citations[0].kind, 'block');
  assert.equal(out.citations[0].start, 2);
  assert.equal(out.citations[0].end, 2);
});

test('normalizeCitations dedupes identical citations across multiple text blocks', () => {
  const cite = {
    type: 'char_location',
    cited_text: 'duplicate quote',
    document_index: 0,
    document_title: 'A',
    start_char_index: 10,
    end_char_index: 25,
  };
  const out = mod.normalizeCitations([
    { type: 'text', text: 'first mention', citations: [cite] },
    { type: 'text', text: 'second mention', citations: [cite] },
  ]);
  assert.equal(out.citations.length, 1);
});

test('normalizeOneCitation drops unknown citation types', () => {
  assert.equal(mod.normalizeOneCitation({ type: 'made_up' }), null);
  assert.equal(mod.normalizeOneCitation(null), null);
  assert.equal(mod.normalizeOneCitation({}), null);
});

// ─── callAnthropicWithCitations end-to-end ────────────────────────────────

test('callAnthropicWithCitations returns the normalized envelope from a fake SDK', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, async () => {
    native._resetClientForTests();
    mod._setClientForTests({
      messages: {
        create: async (req) => {
          // Verify the request shape: documents prepended to user turn,
          // citations enabled, system passed through.
          assert.equal(req.system, 'be terse');
          const lastMsg = req.messages[req.messages.length - 1];
          assert.equal(lastMsg.role, 'user');
          assert.equal(lastMsg.content[0].type, 'document');
          assert.equal(lastMsg.content[0].citations.enabled, true);
          assert.equal(lastMsg.content[1].type, 'text');
          assert.equal(lastMsg.content[1].text, 'what is in here?');
          return {
            content: [
              {
                type: 'text',
                text: 'The doc says hello.',
                citations: [{
                  type: 'char_location',
                  cited_text: 'hello world',
                  document_index: 0,
                  document_title: 'Doc',
                  start_char_index: 0,
                  end_char_index: 11,
                }],
              },
            ],
            usage: { input_tokens: 50, output_tokens: 10 },
          };
        },
      },
    });
    try {
      const out = await mod.callAnthropicWithCitations({
        system: 'be terse',
        messages: [{ role: 'user', content: 'what is in here?' }],
        documents: [{ type: 'text', title: 'Doc', data: 'hello world' }],
      });
      assert.equal(out.text, 'The doc says hello.');
      assert.equal(out.citations.length, 1);
      assert.equal(out.citations[0].cited, 'hello world');
      assert.equal(out.usage.input_tokens, 50);
      assert.equal(out.usage.output_tokens, 10);
    } finally {
      mod._resetClientForTests();
    }
  });
});

test('callAnthropicWithCitations rejects with typed code when no API key', async () => {
  await withEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_NATIVE_ENABLED: undefined }, async () => {
    native._resetClientForTests();
    mod._resetClientForTests();
    await assert.rejects(
      () => mod.callAnthropicWithCitations({
        documents: [{ type: 'text', title: 'D', data: 'x' }],
      }),
      (err) => err.code === 'anthropic_citations_disabled',
    );
  });
});

test('callAnthropicWithCitations rejects when no documents are supplied', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, async () => {
    mod._setClientForTests({ messages: { create: async () => ({}) } });
    try {
      await assert.rejects(
        () => mod.callAnthropicWithCitations({ documents: [] }),
        (err) => err.code === 'anthropic_citations_no_documents',
      );
    } finally {
      mod._resetClientForTests();
    }
  });
});

// ─── answerFileQuestionWithCitations ──────────────────────────────────────
//
// Backs POST /api/files/:id/cite. Uses fake prisma + fake SDK client.

function fakePrisma({ file = null } = {}) {
  return {
    file: {
      findFirst: async ({ where }) => {
        if (!file) return null;
        if (file.userId && where?.userId && file.userId !== where.userId) return null;
        if (where?.id && file.id !== where.id) return null;
        return file;
      },
    },
  };
}

test('answerFileQuestionWithCitations end-to-end with fake prisma + SDK', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, async () => {
    mod._setClientForTests({
      messages: {
        create: async (req) => {
          // Verify the document was attached and the question is the trailing text.
          const lastMsg = req.messages[req.messages.length - 1];
          assert.equal(lastMsg.content[0].type, 'document');
          assert.equal(lastMsg.content[0].title, 'doc.pdf');
          assert.equal(lastMsg.content[0].context, 'mimeType=application/pdf');
          assert.equal(lastMsg.content[1].type, 'text');
          assert.equal(lastMsg.content[1].text, '¿De qué trata?');
          return {
            content: [{
              type: 'text',
              text: 'Trata sobre el clima.',
              citations: [{
                type: 'char_location',
                cited_text: 'el clima en CDMX',
                document_index: 0,
                document_title: 'doc.pdf',
                start_char_index: 5,
                end_char_index: 21,
              }],
            }],
            usage: { input_tokens: 80, output_tokens: 12 },
          };
        },
      },
    });
    try {
      const prisma = fakePrisma({
        file: { id: 'f1', userId: 'u1', originalName: 'doc.pdf', mimeType: 'application/pdf', extractedText: 'sobre el clima en CDMX 2026.' },
      });
      const out = await mod.answerFileQuestionWithCitations({
        prisma,
        userId: 'u1',
        fileId: 'f1',
        question: '¿De qué trata?',
      });
      assert.equal(out.fileId, 'f1');
      assert.equal(out.fileTitle, 'doc.pdf');
      assert.equal(out.text, 'Trata sobre el clima.');
      assert.equal(out.citations.length, 1);
      assert.equal(out.citations[0].cited, 'el clima en CDMX');
      assert.equal(out.citations[0].start, 5);
    } finally {
      mod._resetClientForTests();
    }
  });
});

test('answerFileQuestionWithCitations with verify=true attaches NLI verdicts onto citations', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', HUGGINGFACE_API_TOKEN: undefined }, async () => {
    mod._setClientForTests({
      messages: {
        create: async () => ({
          content: [{
            type: 'text',
            text: 'El documento dice que el clima cambió.',
            citations: [{
              type: 'char_location',
              cited_text: 'el clima en CDMX cambió',
              document_index: 0,
              document_title: 'doc.pdf',
              start_char_index: 0,
              end_char_index: 22,
            }],
          }],
          usage: { input_tokens: 80, output_tokens: 12 },
        }),
      },
    });

    // Fake openai for the NLI LLM-judge backend. The cite call itself
    // uses Anthropic; only the verification step hits OpenAI.
    const nliOpenai = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: { content: JSON.stringify({ label: 'entailment', score: 0.91, reason: 'evidence supports the claim' }) },
            }],
          }),
        },
      },
    };

    try {
      const prisma = fakePrisma({
        file: { id: 'f1', userId: 'u1', originalName: 'doc.pdf', mimeType: 'application/pdf', extractedText: 'el clima en CDMX cambió en 2026.' },
      });
      const out = await mod.answerFileQuestionWithCitations({
        prisma,
        userId: 'u1',
        fileId: 'f1',
        question: '¿De qué trata?',
        options: { verify: true, nli: { openai: nliOpenai } },
      });

      // Per-block citation gets a verification verdict
      assert.equal(out.blocks.length, 1);
      assert.equal(out.blocks[0].citations[0].verification.label, 'entailment');
      assert.ok(out.blocks[0].citations[0].verification.score >= 0.9);
      assert.equal(out.blocks[0].citations[0].verification.backend, 'llm');
      // Flat citations list shares the SAME reference, so the verdict
      // is visible through both views without a second pass.
      assert.equal(out.citations[0].verification.label, 'entailment');
    } finally {
      mod._resetClientForTests();
    }
  });
});

test('answerFileQuestionWithCitations without verify leaves citations unannotated', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, async () => {
    mod._setClientForTests({
      messages: {
        create: async () => ({
          content: [{
            type: 'text',
            text: 'Trata sobre el clima.',
            citations: [{
              type: 'char_location',
              cited_text: 'el clima en CDMX',
              document_index: 0,
              document_title: 'doc.pdf',
              start_char_index: 0,
              end_char_index: 16,
            }],
          }],
          usage: { input_tokens: 80, output_tokens: 12 },
        }),
      },
    });
    try {
      const prisma = fakePrisma({
        file: { id: 'f1', userId: 'u1', originalName: 'doc.pdf', mimeType: 'application/pdf', extractedText: 'el clima en CDMX cambió.' },
      });
      const out = await mod.answerFileQuestionWithCitations({
        prisma, userId: 'u1', fileId: 'f1', question: '¿de qué trata?',
      });
      assert.equal(out.citations[0].verification, undefined);
    } finally {
      mod._resetClientForTests();
    }
  });
});

test('attachCitationVerifications is a no-op when there are no citations', async () => {
  await mod.attachCitationVerifications([{ text: 'hi', citations: [] }, { text: 'world', citations: [] }], {});
  // No throw, no side effects beyond what we already verified above —
  // the assertion here is that the function returns cleanly.
  assert.ok(true);
});

test('answerFileQuestionWithCitations rejects with typed code on bad inputs', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, async () => {
    mod._setClientForTests({ messages: { create: async () => ({}) } });
    try {
      const prisma = fakePrisma({});
      // Missing prisma
      await assert.rejects(
        () => mod.answerFileQuestionWithCitations({ userId: 'u', fileId: 'f', question: 'q' }),
        (err) => err.code === 'anthropic_citations_no_prisma',
      );
      // Missing question
      await assert.rejects(
        () => mod.answerFileQuestionWithCitations({ prisma, userId: 'u', fileId: 'f', question: '   ' }),
        (err) => err.code === 'anthropic_citations_empty_question',
      );
      // Missing userId/fileId
      await assert.rejects(
        () => mod.answerFileQuestionWithCitations({ prisma, userId: '', fileId: 'f', question: 'q' }),
        (err) => err.code === 'anthropic_citations_bad_args',
      );
      // File not found / wrong owner
      await assert.rejects(
        () => mod.answerFileQuestionWithCitations({ prisma, userId: 'u1', fileId: 'missing', question: 'q' }),
        (err) => err.code === 'anthropic_citations_file_not_found',
      );
      // File present but no extracted text
      const emptyTextPrisma = fakePrisma({
        file: { id: 'f1', userId: 'u1', originalName: 'doc.pdf', mimeType: 'application/pdf', extractedText: '   ' },
      });
      await assert.rejects(
        () => mod.answerFileQuestionWithCitations({ prisma: emptyTextPrisma, userId: 'u1', fileId: 'f1', question: 'q' }),
        (err) => err.code === 'anthropic_citations_empty_text',
      );
    } finally {
      mod._resetClientForTests();
    }
  });
});

test('callAnthropicWithCitations wraps SDK throws as anthropic_citations_llm_failed', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, async () => {
    mod._setClientForTests({
      messages: {
        create: async () => { throw new Error('429 rate limit'); },
      },
    });
    try {
      await assert.rejects(
        () => mod.callAnthropicWithCitations({
          documents: [{ type: 'text', title: 'D', data: 'x' }],
          messages: [{ role: 'user', content: 'q' }],
        }),
        (err) => {
          assert.equal(err.code, 'anthropic_citations_llm_failed');
          assert.ok(err.cause);
          return true;
        },
      );
    } finally {
      mod._resetClientForTests();
    }
  });
});
