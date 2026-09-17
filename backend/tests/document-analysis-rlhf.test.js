'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  preferenceAgent,
  formatDocumentRlhfBlock,
  isCodingOrPreviewTurn,
  stripDocumentConfidenceFooter,
} = require('../src/services/document-analysis-rlhf');
const { loadPreferenceRows } = require('../src/services/agents/feedback-durable');

const docx = {
  name: 'tesis.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

test('preferenceAgent tags document turns, not plain chat', () => {
  assert.equal(preferenceAgent({ prompt: 'hola' }), 'chat');
  assert.equal(preferenceAgent({ prompt: 'analiza el documento', files: [docx] }), 'document');
  assert.equal(preferenceAgent({ files: [docx], prompt: '' }), 'document');
});

test('preferenceAgent never tags local-preview / coding prompts as document', () => {
  const coding = 'quiero que podamos trabajar en https://siragpt.com/agentes del github https://github.com/infosiragpt-ops/SiraGPT-APP y dame la web en local 5000';
  assert.equal(isCodingOrPreviewTurn(coding), true);
  assert.equal(preferenceAgent({ prompt: coding }), 'chat');
  assert.equal(preferenceAgent({ prompt: coding, files: [docx] }), 'chat');
  assert.equal(stripDocumentConfidenceFooter('Listo.\n\nNivel de confianza: medio — no inspeccioné el repo.'), 'Listo.');
});

test('formatDocumentRlhfBlock is empty without exemplars', () => {
  assert.equal(formatDocumentRlhfBlock([]), '');
  assert.equal(formatDocumentRlhfBlock(null), '');
});

test('formatDocumentRlhfBlock labels helpful document answers', () => {
  const block = formatDocumentRlhfBlock([{
    agent: 'document',
    request: 'resume la tesis',
    response: 'El objetivo es X',
    helpful: true,
  }]);
  assert.match(block, /DOCUMENT ANALYSIS RLHF/);
  assert.match(block, /resume la tesis/);
  assert.match(block, /El objetivo es X/);
});

test('loadPreferenceRows tags document agent when the user turn had files', async () => {
  const t0 = new Date('2026-01-01T00:00:00Z');
  const t1 = new Date('2026-01-01T00:00:01Z');
  const prisma = {
    message: {
      findMany: async ({ where }) => {
        if (where.role === 'ASSISTANT') {
          return [{
            id: 'a1',
            chatId: 'c1',
            content: 'hallazgos A y B',
            feedback: 'liked',
            timestamp: t1,
          }];
        }
        return [{
          chatId: 'c1',
          content: 'analiza',
          timestamp: t0,
          files: [docx],
        }];
      },
    },
  };
  const rows = await loadPreferenceRows(prisma, 'owner');
  assert.equal(rows[0].agent, 'document');
});
