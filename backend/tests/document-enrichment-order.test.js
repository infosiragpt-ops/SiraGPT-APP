'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ENRICHMENT_BLOCK_ORDER } = require('../src/services/document-enrichment-order');
const analyzer = require('../src/services/document-professional-analyzer');

test('enrichment order is a frozen list of unique block names', () => {
  assert.ok(Object.isFrozen(ENRICHMENT_BLOCK_ORDER));
  assert.equal(new Set(ENRICHMENT_BLOCK_ORDER).size, ENRICHMENT_BLOCK_ORDER.length);
  for (const name of ENRICHMENT_BLOCK_ORDER) assert.match(name, /^[a-z][A-Za-z0-9]*Block$/);
});

test('PII safety frame opens the enrichment and the directive closes it', () => {
  assert.equal(ENRICHMENT_BLOCK_ORDER[0], 'piiSafetyBlock');
  assert.equal(ENRICHMENT_BLOCK_ORDER[1], 'profileBlock');
  assert.equal(ENRICHMENT_BLOCK_ORDER[ENRICHMENT_BLOCK_ORDER.length - 1], 'directiveBlock');
});

test('every block the analyzer returns has a position in the prompt', async () => {
  const out = await analyzer.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [{
      id: 'contract',
      name: 'contrato.pdf',
      originalName: 'contrato.pdf',
      mimeType: 'application/pdf',
      extractedText: 'CONTRATO. Cláusula 1: el Cliente pagará $100 USD antes del 2026-12-01. Ver Anexo A.',
    }],
  });
  const returned = Object.keys(out).filter((key) => key.endsWith('Block'));
  assert.ok(returned.length > 0);
  const missing = returned.filter((key) => !ENRICHMENT_BLOCK_ORDER.includes(key));
  assert.deepEqual(missing, [], 'add new analyzer blocks to services/document-enrichment-order.js');
});
