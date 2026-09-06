'use strict';

// Regression for the authenticated production probe on 2026-09-05. Exercise
// the actual chat/AgentRunner entry, file loading, parser, OOXML edit and
// artifact-delivery contract together. Only storage/DB/provider are fakes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const PptxGenJS = require('pptxgenjs');
const PizZip = require('pizzip');
const { executeAgentRunnerTurn } = require('../src/services/agent-runner');
const { listPptxSlides } = require('../src/services/document-editing/pptx-adapter');

const filename = 'siragpt-release-pr563-original.pptx';
const originalTitle = 'Historia de los Dinosaurios';
const requestedTitle = 'Historia de los Dinosaurios de 1998';
const instruction = `En ${filename}, cambia el título de la primera diapositiva a "${requestedTitle}".`;

for (const entry of ['attached-buffer', 'uploaded-file-id']) {
  test(`production PPTX prompt: ${entry} edits exactly slide 1 without LLM or sandbox`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-pptx-upload-regression-'));
    try {
      const deck = new PptxGenJS();
      for (let n = 1; n <= 11; n += 1) {
        const slide = deck.addSlide();
        slide.addText(n === 1 ? originalTitle : `Contenido ${n}`, { x: 1, y: 1, w: 8, h: 1, bold: true });
        slide.addText(`SIRA-CONTENT-${n}`, { x: 1, y: 3, w: 8, h: 1 });
      }
      const input = Buffer.from(await deck.write({ outputType: 'nodebuffer' }));
      const original = Buffer.from(input);
      const sourcePath = path.join(root, filename);
      await fs.writeFile(sourcePath, input);
      const file = { id: 'qa-pptx-source', originalName: filename, name: filename,
        path: sourcePath, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
      const lookupCalls = [];
      const artifactRows = [];
      const prisma = {
        file: { findMany: async (query) => { lookupCalls.push(query); return [file]; } },
        generatedArtifact: { findMany: async () => [], upsert: async (query) => { artifactRows.push(query); return query.create; } },
      };
      let calls = 0;
      let output;
      const events = [];
      const result = await executeAgentRunnerTurn({
        instruction, userId: 'qa-document-owner', chatId: 'qa-document-chat', prisma,
        ...(entry === 'uploaded-file-id' ? { fileIds: [file.id] }
          : { attachedFiles: [{ name: filename, buffer: input, mime: file.mimeType }] }),
        forceSync: true,
        // Any fallback is a failure, not an opportunity to use a real provider
        // or an executable sandbox in this otherwise deterministic test.
        driver: 'forbidden-for-this-deterministic-test',
        client: { chat: { completions: { create: async () => { calls += 1; throw new Error('LLM must not run'); } } } },
        saveArtifact: (payload) => {
          output = Buffer.from(payload.base64, 'base64');
          return { id: '0123456789abcdef', filename: payload.filename, mime: payload.mime,
            format: 'pptx', sizeBytes: output.length, downloadUrl: '/api/agent/artifact/0123456789abcdef' };
        },
        onEvent: (event) => events.push(event),
      });
      assert.equal(result.ok, true, result.errorMessage || result.summary);
      assert.equal(calls, 0);
      assert.equal(result.iterations, 0);
      assert.equal(result.driver, 'ooxml_surgical');
      assert.equal(result.artifacts.length, 1);
      assert.equal(result.artifacts[0].validation.passed, true);
      assert.equal(result.artifacts[0].filename, 'siragpt-release-pr563-original_editado.pptx');
      assert.equal(events.filter((event) => event.type === 'file_artifact').length, 1);
      assert.equal(events.some((event) => event.type === 'sandbox_ready' || event.type === 'tool_call'), false);
      assert.equal(artifactRows.length, 1);
      assert.equal(artifactRows[0].create.userId, 'qa-document-owner');
      assert.equal(artifactRows[0].create.chatId, 'qa-document-chat');
      if (entry === 'uploaded-file-id') {
        assert.equal(lookupCalls.length, 1);
        assert.deepEqual(lookupCalls[0].where, { id: { in: [file.id] }, userId: 'qa-document-owner' });
      }
      assert.ok(output);
      const before = new PizZip(input);
      const after = new PizZip(output);
      assert.deepEqual(Object.keys(after.files).sort(), Object.keys(before.files).sort());
      const changed = Object.keys(before.files).filter((name) => !before.files[name].dir
        && !before.files[name].asNodeBuffer().equals(after.files[name].asNodeBuffer()));
      assert.deepEqual(changed, ['ppt/slides/slide1.xml']);
      assert.equal(listPptxSlides(output).length, 11);
      assert.equal(listPptxSlides(output)[0].title, requestedTitle);
      assert.ok(input.equals(original));
      assert.ok((await fs.readFile(sourcePath)).equals(original));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
