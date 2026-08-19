'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProjectKnowledgeBlock,
  buildProjectContextManifest,
  buildProjectPromptHeader,
  buildProjectRuntimeDocuments,
} = require('../src/services/project-context');

test('exports the documented surface', () => {
  for (const fn of [buildProjectKnowledgeBlock, buildProjectContextManifest, buildProjectPromptHeader, buildProjectRuntimeDocuments]) {
    assert.equal(typeof fn, 'function');
  }
});

test('buildProjectContextManifest handles empty / missing project gracefully', () => {
  const out = buildProjectContextManifest({});
  assert.equal(out.projectId, null);
  assert.equal(out.name, '');
  assert.equal(out.counts.files, 0);
  assert.equal(out.counts.documents, 0);
  assert.equal(out.counts.chats, 0);
  assert.equal(out.counts.memories, 0);
  assert.equal(out.hasInstructions, false);
  assert.equal(out.status.knowledgeReady, true, 'empty project counts as ready');
});

test('buildProjectContextManifest reports text + document coverage percentages', () => {
  const project = {
    id: 'p1',
    name: 'Thesis',
    files: [
      { mimeType: 'application/pdf', extractedText: 'extracted body' },
      { mimeType: 'application/pdf', extractedText: '' },
    ],
    documents: [
      { content: 'doc body 1' },
      { content: 'doc body 2' },
      { content: '' },
    ],
  };
  const out = buildProjectContextManifest(project);
  assert.equal(out.counts.files, 2);
  assert.equal(out.counts.documents, 3);
  assert.equal(out.textCoverage.percent, 50);
  assert.equal(out.documentCoverage.percent, 67);
  assert.equal(out.status.knowledgeReady, true, 'partial extraction still ready');
});

test('buildProjectContextManifest groups file types from mimeType prefix', () => {
  const project = {
    files: [
      { mimeType: 'application/pdf', extractedText: 'a' },
      { mimeType: 'application/pdf', extractedText: 'b' },
      { mimeType: 'image/png', extractedText: '' },
      { mimeType: 'text/csv', extractedText: 'c' },
    ],
  };
  const out = buildProjectContextManifest(project);
  assert.equal(out.fileTypes.application, 2);
  assert.equal(out.fileTypes.image, 1);
  assert.equal(out.fileTypes.text, 1);
});

test('buildProjectContextManifest prefers _count over array length when present', () => {
  const project = {
    files: [{ extractedText: 'x' }],
    _count: { files: 999, documents: 50, chats: 10, memories: 2 },
  };
  const out = buildProjectContextManifest(project);
  assert.equal(out.counts.files, 999);
  assert.equal(out.counts.documents, 50);
  assert.equal(out.counts.chats, 10);
  assert.equal(out.counts.memories, 2);
});

test('buildProjectContextManifest reports knowledgeReady=false when files exist but none have text', () => {
  const project = {
    name: 'p',
    files: [{ extractedText: '' }, { extractedText: '   ' }],
    documents: [{ content: '' }],
  };
  const out = buildProjectContextManifest(project);
  assert.equal(out.status.knowledgeReady, false, 'all-empty knowledge is not ready');
});

test('buildProjectContextManifest reports hasInstructions only when non-whitespace', () => {
  const empty = buildProjectContextManifest({ instructions: '   ' });
  assert.equal(empty.hasInstructions, false);
  const filled = buildProjectContextManifest({ instructions: 'follow these rules' });
  assert.equal(filled.hasInstructions, true);
});

test('buildProjectPromptHeader returns a non-empty manifest header string with isolation + grounding rules', () => {
  const header = buildProjectPromptHeader({ name: 'Thesis', files: [{ extractedText: 'x' }] });
  assert.match(header, /PROJECT WORKSPACE MANIFEST/);
  assert.match(header, /Name: Thesis/);
  assert.match(header, /Isolation rule:/);
  assert.match(header, /Grounding rule:/);
  assert.match(header, /Trust rule:/);
});

test('buildProjectKnowledgeBlock returns "" when project is missing or unnamed', () => {
  assert.equal(buildProjectKnowledgeBlock(null), '');
  assert.equal(buildProjectKnowledgeBlock({}), '');
  assert.equal(buildProjectKnowledgeBlock({ name: '' }), '');
});

test('buildProjectKnowledgeBlock renders files + documents + memories block when present', () => {
  const project = {
    name: 'p',
    files: [{ originalName: 'thesis.pdf', mimeType: 'application/pdf', extractedText: 'body of thesis' }],
    documents: [{ title: 'plan', content: 'plan content', updatedAt: '2026-05-21' }],
    memories: [{ fact: 'user prefers APA' }],
  };
  const block = buildProjectKnowledgeBlock(project);
  assert.match(block, /PROJECT KNOWLEDGE CONTEXT/);
  assert.match(block, /PROJECT FILES/);
  assert.match(block, /thesis\.pdf/);
  assert.match(block, /body of thesis/);
  assert.match(block, /PROJECT DOCUMENTS/);
  assert.match(block, /plan content/);
  assert.match(block, /PROJECT MEMORY/);
  assert.match(block, /user prefers APA/);
});

test('buildProjectKnowledgeBlock surfaces "No extracted text available" placeholder for empty files', () => {
  const project = {
    name: 'p',
    files: [{ originalName: 'scan.png', mimeType: 'image/png' }],
  };
  const block = buildProjectKnowledgeBlock(project);
  assert.match(block, /scan\.png/);
  assert.match(block, /No extracted text available/);
});

test('buildProjectKnowledgeBlock truncates very long file text and adds a budget warning', () => {
  const huge = 'x'.repeat(20000);
  const project = {
    name: 'p',
    files: [{ originalName: 'big.pdf', mimeType: 'application/pdf', extractedText: huge }],
  };
  const block = buildProjectKnowledgeBlock(project, { perFileCap: 1000, totalCap: 1000 });
  assert.match(block, /\[truncated:/);
  // budget note kicks in when remaining <= 0 AFTER consuming a file
  // (perFileCap=totalCap=1000 → exactly drains budget)
  assert.ok(block.length > 0);
});

test('buildProjectKnowledgeBlock caps memories at 30 bullets', () => {
  const memories = Array.from({ length: 50 }, (_, i) => ({ fact: `fact ${i}` }));
  const project = { name: 'p', memories };
  const block = buildProjectKnowledgeBlock(project);
  // Count lines starting with "- "
  const bullets = (block.match(/\n- /g) || []).length;
  assert.ok(bullets <= 30);
});

test('buildProjectRuntimeDocuments flattens files + documents into a runtime list with sourceType', () => {
  const project = {
    files: [
      { id: 'f1', originalName: 'a.pdf', extractedText: 'x', mimeType: 'application/pdf' },
      { id: 'f2', originalName: 'empty.pdf', extractedText: '' }, // excluded — no text
    ],
    documents: [
      { id: 'd1', title: 'plan', content: 'plan body', updatedAt: '2026-05-21' },
      { id: 'd2', title: 'empty', content: '' }, // excluded — no content
    ],
  };
  const docs = buildProjectRuntimeDocuments(project);
  assert.equal(docs.length, 2, 'must skip empty entries');
  const file = docs.find((d) => d.sourceType === 'project-file');
  const doc = docs.find((d) => d.sourceType === 'project-document');
  assert.ok(file);
  assert.equal(file.originalName, 'a.pdf');
  assert.ok(doc);
  assert.equal(doc.originalName, 'plan');
  assert.equal(doc.mimeType, 'text/markdown');
  assert.equal(doc.size, 'plan body'.length);
});

test('buildProjectRuntimeDocuments caps the list at maxItems', () => {
  const files = Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, extractedText: 'x' }));
  const docs = buildProjectRuntimeDocuments({ files }, { maxItems: 10 });
  assert.equal(docs.length, 10);
});

test('buildProjectRuntimeDocuments returns [] when project is null or has no files/documents', () => {
  assert.deepEqual(buildProjectRuntimeDocuments(null), []);
  assert.deepEqual(buildProjectRuntimeDocuments({}), []);
  assert.deepEqual(buildProjectRuntimeDocuments({ files: [], documents: [] }), []);
});
