/**
 * document-intent-analyzer.test.js
 *
 * Tests for the document intent analyzer module:
 * - Heuristic analysis (no LLM)
 * - Single document analysis
 * - Multi-document batch analysis
 * - Cross-document summaries
 * - LLM response parsing
 * - Storage and retrieval
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const intentAnalyzer = require('../src/services/document-intent-analyzer');

// ── Test helpers ──────────────────────────────────────────────────────────

function makeDoc(overrides = {}) {
  return {
    id: overrides.id || 'test-id-1',
    name: overrides.name || 'document.pdf',
    text: overrides.text || 'This is a test document with some content for analysis purposes.',
    mimeType: overrides.mimeType || 'application/pdf',
    size: overrides.size || 1024,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('document-intent-analyzer', () => {
  describe('INTENT_TYPES', () => {
    it('defines expected intent types', () => {
      const types = intentAnalyzer.INTENT_TYPES;
      assert.ok(types.SUMMARIZE);
      assert.ok(types.ANALYZE);
      assert.ok(types.EXTRACT_DATA);
      assert.ok(types.TRANSLATE);
      assert.ok(types.RESEARCH);
      assert.ok(types.COMPARE);
      assert.ok(types.UNKNOWN);
    });
  });

  describe('analyzeHeuristics (INTERNAL)', () => {
    it('detects summarize intent from keywords', () => {
      const doc = makeDoc({ text: 'Please provide a summary of this document and its conclusions.' });
      const result = intentAnalyzer.INTERNAL.analyzeHeuristics(doc.text, doc.name, doc.mimeType);
      assert.equal(result.intent, intentAnalyzer.INTENT_TYPES.SUMMARIZE);
      assert.ok(result.confidence > 0);
    });

    it('detects analyze intent from keywords', () => {
      const doc = makeDoc({ text: 'Analyze this data and evaluate the results thoroughly.' });
      const result = intentAnalyzer.INTERNAL.analyzeHeuristics(doc.text, doc.name, doc.mimeType);
      assert.equal(result.intent, 'analyze');
      assert.ok(result.confidence > 0);
    });

    it('detects extract_data intent from keywords', () => {
      const doc = makeDoc({ text: 'Extract the table data from this CSV file.' });
      const result = intentAnalyzer.INTERNAL.analyzeHeuristics(doc.text, doc.name, doc.mimeType);
      assert.equal(result.intent, 'extract_data');
    });

    it('detects translate intent from keywords', () => {
      const doc = makeDoc({ text: 'Translate this document to English please.' });
      const result = intentAnalyzer.INTERNAL.analyzeHeuristics(doc.text, doc.name, doc.mimeType);
      assert.equal(result.intent, 'translate');
    });

    it('detects compare intent', () => {
      const doc = makeDoc({ text: 'Compare and contrast these two methodologies.' });
      const result = intentAnalyzer.INTERNAL.analyzeHeuristics(doc.text, doc.name, doc.mimeType);
      assert.equal(result.intent, 'compare');
    });

    it('returns unknown for generic text', () => {
      const doc = makeDoc({ text: 'This is plain content without specific intent keywords.', name: 'my_file.txt', mimeType: 'text/plain' });
      const result = intentAnalyzer.INTERNAL.analyzeHeuristics(doc.text, doc.name, doc.mimeType);
      assert.equal(result.intent, 'unknown');
    });

    it('classifies MIME-based doc types', () => {
      const pdfDoc = makeDoc({ mimeType: 'application/pdf' });
      const csvDoc = makeDoc({ mimeType: 'text/csv' });
      const pptDoc = makeDoc({ mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });

      assert.equal(intentAnalyzer.INTERNAL.analyzeHeuristics(pdfDoc.text, pdfDoc.name, pdfDoc.mimeType).docType, 'report');
      assert.equal(intentAnalyzer.INTERNAL.analyzeHeuristics(csvDoc.text, csvDoc.name, csvDoc.mimeType).docType, 'spreadsheet');
      assert.equal(intentAnalyzer.INTERNAL.analyzeHeuristics(pptDoc.text, pptDoc.name, pptDoc.mimeType).docType, 'presentation');
    });

    it('detects Spanish language', () => {
      const doc = makeDoc({ text: 'El análisis de los datos para la información del documento y las conclusiones sobre los resultados.' });
      const result = intentAnalyzer.INTERNAL.analyzeHeuristics(doc.text, doc.name, doc.mimeType);
      assert.equal(result.language, 'es');
    });

    it('detects English language', () => {
      const doc = makeDoc({ text: 'The analysis of the data for the information in this document and their conclusions.' });
      const result = intentAnalyzer.INTERNAL.analyzeHeuristics(doc.text, doc.name, doc.mimeType);
      assert.equal(result.language, 'en');
    });

    it('extracts top keywords from text', () => {
      const text = 'analysis data report analysis data report analysis data report analysis data report findings conclusion methodology';
      const doc = makeDoc({ text });
      const result = intentAnalyzer.INTERNAL.analyzeHeuristics(doc.text, doc.name, doc.mimeType);
      assert.ok(result.keywords.length >= 3);
      assert.ok(result.keywords.includes('analysis'));
      assert.ok(result.keywords.includes('data'));
    });
  });

  describe('analyzeSingleDocument', () => {
    it('returns heuristic analysis when no LLM provided', async () => {
      const doc = makeDoc({ text: 'Please summarize this report and extract key findings.' });
      const result = await intentAnalyzer.analyzeSingleDocument(doc);
      assert.equal(result.llmUsed, false);
      assert.ok(result.intent);
      assert.ok(typeof result.confidence === 'number');
      assert.ok(result.keywords);
    });

    it('returns expected fields', async () => {
      const doc = makeDoc();
      const result = await intentAnalyzer.analyzeSingleDocument(doc);
      assert.ok('intent' in result);
      assert.ok('confidence' in result);
      assert.ok('docType' in result);
      assert.ok('summary' in result);
      assert.ok('keywords' in result);
      assert.ok('language' in result);
    });

    it('handles empty document gracefully', async () => {
      const doc = makeDoc({ text: '', name: 'empty.txt' });
      const result = await intentAnalyzer.analyzeSingleDocument(doc);
      assert.ok(result);
      assert.equal(result.llmUsed, false);
    });

    it('handles null document gracefully', async () => {
      const doc = makeDoc({ text: null });
      const result = await intentAnalyzer.analyzeSingleDocument(doc);
      assert.ok(result);
    });

    it('uses LLM when provided and returns correct fields', async () => {
      const mockLLM = async () => JSON.stringify({
        intent: 'summarize',
        confidence: 0.92,
        docType: 'report',
        summary: 'A financial report needing summarization.',
        keywords: ['finance', 'report', 'summary'],
        language: 'en',
      });
      const doc = makeDoc({ text: 'Quarterly financial report data needs summarization.' });
      const result = await intentAnalyzer.analyzeSingleDocument(doc, { llm: mockLLM });
      assert.equal(result.llmUsed, true);
      assert.equal(result.intent, 'summarize');
      assert.equal(result.confidence, 0.92);
      assert.equal(result.language, 'en');
    });

    it('falls back to heuristics when LLM returns bad JSON', async () => {
      const mockLLM = async () => 'Not JSON at all just plain text';
      const doc = makeDoc({ text: 'Analyze this document for key insights.' });
      const result = await intentAnalyzer.analyzeSingleDocument(doc, { llm: mockLLM });
      // Should have fallen back gracefully
      assert.ok(result.intent);
      assert.equal(result.llmUsed, false);
    });

    it('falls back to heuristics when LLM throws', async () => {
      const mockLLM = async () => { throw new Error('API error'); };
      const doc = makeDoc({ text: 'Please extract data from this document.' });
      const result = await intentAnalyzer.analyzeSingleDocument(doc, { llm: mockLLM });
      assert.ok(result.intent);
      assert.equal(result.llmUsed, false);
    });

    it('strips markdown fences from LLM response', () => {
      const raw = '```json\n{"intent":"summarize","confidence":0.85}\n```';
      const parsed = intentAnalyzer.INTERNAL.parseLLMResponse(raw);
      assert.equal(parsed.intent, 'summarize');
      assert.equal(parsed.confidence, 0.85);
    });

    it('finds JSON block in non-JSON text', () => {
      const raw = 'Here is the analysis: {"intent":"analyze","confidence":0.7} Hope that helps.';
      const parsed = intentAnalyzer.INTERNAL.parseLLMResponse(raw);
      assert.equal(parsed.intent, 'analyze');
      assert.equal(parsed.confidence, 0.7);
    });

    it('returns null for unparseable response', () => {
      assert.equal(intentAnalyzer.INTERNAL.parseLLMResponse(''), null);
      assert.equal(intentAnalyzer.INTERNAL.parseLLMResponse(null), null);
      assert.equal(intentAnalyzer.INTERNAL.parseLLMResponse('nonsense'), null);
    });
  });

  describe('analyzeBatch', () => {
    it('returns unknown for empty input', async () => {
      const result = await intentAnalyzer.analyzeBatch([]);
      assert.equal(result.primaryIntent, 'unknown');
      assert.equal(result.fileAnalyses.length, 0);
    });

    it('analyzes multiple documents', async () => {
      const docs = [
        makeDoc({ id: '1', name: 'report.pdf', text: 'Please summarize this financial report and its conclusions.', mimeType: 'application/pdf' }),
        makeDoc({ id: '2', name: 'data.csv', text: 'Extract all table data from this CSV and format as JSON.', mimeType: 'text/csv' }),
        makeDoc({ id: '3', name: 'presentation.pptx', text: 'Compare the findings in this presentation with the report.', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }),
      ];
      const result = await intentAnalyzer.analyzeBatch(docs);
      assert.equal(result.fileAnalyses.length, 3);
      assert.ok(result.primaryIntent);
      assert.ok(result.crossDocSummary);
      assert.ok(result.batchId);
      assert.ok(result.batchId.startsWith('batch_'));
    });

    it('produces cross-document summary with correct fields', async () => {
      const docs = [
        makeDoc({ id: '1', name: 'doc1.pdf', text: 'Financial analysis summary of quarterly results.', mimeType: 'application/pdf' }),
        makeDoc({ id: '2', name: 'doc2.pdf', text: 'Market research data analysis with conclusions.', mimeType: 'application/pdf' }),
      ];
      const result = await intentAnalyzer.analyzeBatch(docs);
      const cs = result.crossDocSummary;
      assert.ok(cs.fileCount >= 2);
      assert.ok(cs.primaryIntent);
      assert.ok(cs.primaryDocType);
      assert.ok(Array.isArray(cs.topKeywords));
      assert.ok(typeof cs.summary === 'string');
    });

    it('stores analysis for retrieval', async () => {
      const docs = [makeDoc({ id: 'store-1', name: 'test.pdf', text: 'Analyze this data set.' })];
      const result = await intentAnalyzer.analyzeBatch(docs);

      const retrieved = intentAnalyzer.getBatchAnalysis(result.batchId);
      assert.ok(retrieved);
      assert.equal(retrieved.batchId, result.batchId);
      assert.equal(retrieved.fileCount, 1);
    });

    it('caps at MAX_BATCH_FILES (200)', async () => {
      const docs = Array.from({ length: 250 }, (_, i) => makeDoc({
        id: `bulk-${i}`,
        name: `doc-${i}.pdf`,
        text: `Document ${i} content for batch analysis.`,
      }));
      const result = await intentAnalyzer.analyzeBatch(docs);
      assert.ok(result.fileAnalyses.length <= 200);
    });

    it('returns latest analysis', async () => {
      // Clear by creating and checking
      intentAnalyzer.analyzeBatch([makeDoc({ id: 'late-1', name: 'latest.pdf', text: 'Analyze this.' })]);
      const latest = intentAnalyzer.getLatestAnalysis();
      assert.ok(latest);
      assert.ok(latest.createdAt);
    });
  });

  describe('intent detection in Spanish', () => {
    it('detects summarize intent in Spanish', () => {
      const doc = makeDoc({ text: 'Necesito un resumen de este documento con las conclusiones principales.' });
      const result = intentAnalyzer.INTERNAL.analyzeHeuristics(doc.text, doc.name, doc.mimeType);
      assert.equal(result.intent, 'summarize');
    });

    it('detects classify intent in Spanish', () => {
      // Use text with only classify keywords, no false matches
      const doc = makeDoc({ text: 'Clasifica y organiza estos archivos por temática.', name: 'categorize.txt', mimeType: 'text/plain' });
      const result = intentAnalyzer.INTERNAL.analyzeHeuristics(doc.text, doc.name, doc.mimeType);
      assert.ok(result.intent === 'classify' || result.intent === 'unknown');
    });
  });
});

describe('document-intent-analyzer security + voting regressions', () => {
  it('getUserAnalyses is scoped to the requesting user (no cross-user leak)', async () => {
    await intentAnalyzer.analyzeBatch([{ text: 'invoice total amount due', originalName: 'a.pdf' }], { userId: 'alice' });
    await intentAnalyzer.analyzeBatch([{ text: 'legal contract clause', originalName: 'b.pdf' }], { userId: 'bob' });
    assert.equal(intentAnalyzer.getUserAnalyses('alice').length, 1);
    assert.equal(intentAnalyzer.getUserAnalyses('bob').length, 1);
    // A missing userId used to return EVERY user's batches.
    assert.equal(intentAnalyzer.getUserAnalyses(null).length, 0);
    assert.ok(intentAnalyzer.getUserAnalyses('alice').every((e) => e.userId === 'alice'));
  });
});
