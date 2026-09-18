'use strict';

/**
 * chat-document-editor deterministic-first — the /document-edit route serves
 * machine-plannable edits (add_slide, replace_text, …) with the
 * source-preserving engine BEFORE spending model iterations in the sandbox
 * loop. Anything the engine declines (null/clarification/invalid, or an
 * explicit "modo reformateo" redesign) falls through to the LLM loop, so the
 * previous behavior is fully preserved as fallback.
 *
 * Offline: injected deps only, Prisma fake. No network, no API keys.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runChatDocumentEdit } = require('../src/services/document-editor/chat-document-editor');

const USER = 'user-1';
const DOCX = Buffer.from('PK\x03\x04fake-docx');

function fakePrisma({ files = [] } = {}) {
  return {
    file: {
      findMany: async (query) => {
        const ids = query.where.id.in;
        return files.filter((row) => ids.includes(row.id) && row.userId === query.where.userId);
      },
    },
    message: { findMany: async () => [] },
  };
}

function detArtifact(overrides = {}) {
  return {
    id: 'det-artifact-1',
    filename: 'Gestion_Administrativa-editado.pptx',
    format: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    sizeBytes: 12345,
    downloadUrl: '/api/agent/artifact/det-artifact-1?name=Gestion_Administrativa-editado.pptx',
    ...overrides,
  };
}

function baseDeps(overrides = {}) {
  const agentCalls = [];
  const detCalls = [];
  const deps = {
    env: {},
    readSourceBuffer: async () => ({ buffer: DOCX, cleanup: async () => {} }),
    extractFileIds: (files) => (Array.isArray(files) ? files : []).map((f) => (typeof f === 'string' ? f : f.id)).filter(Boolean),
    saveArtifact: (input) => ({
      id: 'loop-artifact-1',
      filename: input.filename,
      format: input.filename.split('.').pop(),
      mime: input.mime,
      sizeBytes: 10,
      downloadUrl: '/api/agent/artifact/loop-artifact-1',
    }),
    runDocumentAgent: async (opts) => {
      agentCalls.push(opts);
      return { finalText: 'Listo por el loop.', outputs: [{ name: 'out.pptx', buffer: Buffer.from('edited'), valid: true }] };
    },
    tryDeterministicEdit: async (opts) => {
      detCalls.push(opts);
      return null;
    },
    log: () => {},
    sleep: async () => {},
    ...overrides,
  };
  return { deps, agentCalls, detCalls };
}

function runEdit(deps, instruction = 'puedes agregar una diapositiva mas como un ejemplo') {
  const prisma = fakePrisma({ files: [{ id: 'f1', userId: USER, originalName: 'Gestion_Administrativa.pptx', path: '/tmp/f1.pptx' }] });
  return runChatDocumentEdit({
    prisma, userId: USER, chatId: 'chat-1', fileIds: ['f1'], instruction,
    llm: { client: {}, model: 'm', provider: 'P', toolCallMode: 'native' },
    deps,
  });
}

test('deterministic hit serves the edit without spending model iterations', async () => {
  const { deps, agentCalls, detCalls } = baseDeps({
    tryDeterministicEdit: async (opts) => {
      detCalls.push(opts);
      return {
        content: 'Listo. Agregué la diapositiva de ejemplo al final.',
        artifact: detArtifact(),
        validation: { passed: true },
      };
    },
  });
  const result = await runEdit(deps);
  assert.equal(result.ok, true);
  assert.equal(agentCalls.length, 0);
  assert.equal(detCalls.length, 1);
  assert.equal(detCalls[0].prompt, 'puedes agregar una diapositiva mas como un ejemplo');
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].id, 'det-artifact-1');
  assert.equal(result.artifacts[0].downloadUrl, detArtifact().downloadUrl);
  assert.equal(result.summary, 'Listo. Agregué la diapositiva de ejemplo al final.');
});

test('deterministic batch results deliver every validated artifact', async () => {
  const second = detArtifact({ id: 'det-artifact-2', filename: 'otro-editado.pptx' });
  const { deps, agentCalls } = baseDeps({
    tryDeterministicEdit: async () => ({
      results: [
        { artifact: detArtifact(), validation: { passed: true } },
        { artifact: second, validation: { passed: true } },
        { artifact: detArtifact({ id: 'bad' }), validation: { passed: false } },
      ],
    }),
  });
  const result = await runEdit(deps);
  assert.equal(result.ok, true);
  assert.equal(agentCalls.length, 0);
  assert.deepEqual(result.artifacts.map((a) => a.id), ['det-artifact-1', 'det-artifact-2']);
});

test('modo reformateo skips the deterministic path and uses the loop', async () => {
  const { deps, agentCalls, detCalls } = baseDeps();
  const result = await runEdit(deps, 'modo reformateo: cambia todo el diseño');
  assert.equal(result.ok, true);
  assert.equal(detCalls.length, 0);
  assert.equal(agentCalls.length, 1);
});

test('deterministic decline (null/clarification/throw) falls through to the loop', async () => {
  for (const detReturn of [null, { clarification: true, content: '¿Qué diapositiva?' }]) {
    const { deps, agentCalls } = baseDeps({ tryDeterministicEdit: async () => detReturn });
    const result = await runEdit(deps);
    assert.equal(result.ok, true);
    assert.equal(agentCalls.length, 1);
    assert.equal(result.artifacts[0].id, 'loop-artifact-1');
  }
  const { deps, agentCalls } = baseDeps({
    tryDeterministicEdit: async () => { throw new Error('boom'); },
  });
  const result = await runEdit(deps);
  assert.equal(result.ok, true);
  assert.equal(agentCalls.length, 1);
});
