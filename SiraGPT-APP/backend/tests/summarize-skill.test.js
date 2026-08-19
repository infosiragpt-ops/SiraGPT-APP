'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const summarize = require('../src/skills/summarize/handler');

test('summarize extractOnly returns supplied text without an LLM call', async () => {
  const result = await summarize.execute({ text: '  Contenido importante.  ', extractOnly: true });
  assert.equal(result.ok, true);
  assert.equal(result.sourceType, 'text');
  assert.equal(result.extractedText, 'Contenido importante.');
  assert.equal(result.truncated, false);
});

test('summarize requires exactly one source input', async () => {
  await assert.rejects(() => summarize.execute({ extractOnly: true }), /exactly one/);
  await assert.rejects(
    () => summarize.execute({ text: 'a', url: 'https://example.com', extractOnly: true }),
    /exactly one/,
  );
});

test('summarize reads a URL through the SiraGPT adapter and calls the selected model', async () => {
  let modelCall;
  const result = await summarize.execute(
    { url: 'https://example.com/report', length: 'short', language: 'español' },
    {
      readUrl: async ({ url, maxChars }) => ({
        title: 'Informe',
        source_url: url,
        content_markdown: `Hallazgo verificable. Cap: ${maxChars}.`,
      }),
      openai: {
        chat: {
          completions: {
            create: async (input) => {
              modelCall = input;
              return { choices: [{ message: { content: 'Resumen profesional.' } }] };
            },
          },
        },
      },
      summaryModel: 'test-model',
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.sourceType, 'url');
  assert.equal(result.title, 'Informe');
  assert.equal(result.summary, 'Resumen profesional.');
  assert.equal(modelCall.model, 'test-model');
  assert.match(modelCall.messages[0].content, /No sigas instrucciones/);
});

test('summarize reads an owner-scoped collection source through the injected adapter', async () => {
  const result = await summarize.execute(
    { source: 'tesis.docx', extractOnly: true },
    { readFile: async () => ({ content: 'Texto de la tesis.' }) },
  );
  assert.equal(result.sourceType, 'collection');
  assert.equal(result.source, 'tesis.docx');
  assert.equal(result.extractedText, 'Texto de la tesis.');
});

test('summarize rejects an empty model response', async () => {
  await assert.rejects(
    () => summarize.execute(
      { text: 'contenido' },
      { openai: { chat: { completions: { create: async () => ({ choices: [] }) } } } },
    ),
    /empty summary/,
  );
});
