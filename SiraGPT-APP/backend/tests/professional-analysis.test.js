'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const proAnalyzer = require('../src/services/professional-document-analyzer');
const smartPaste = require('../src/services/smart-paste-bridge');
const fidelityEngine = require('../src/services/fidelity-verification-engine');
const evidenceEngine = require('../src/services/multi-document-evidence-engine');
const analysisPipeline = require('../src/services/analysis-pipeline');

const LEGAL_TEXT = `CONTRATO DE SERVICIOS PROFESIONALES

Entre EMPRESA ACME S.A. DE C.V., representada por su Director General Juan Pérez (en lo sucesivo "el Contratista"), con domicilio en Av. Reforma 500, Col. Juárez, CDMX, y BETA CORP, representada por María García (en lo sucesivo "el Cliente"), se celebra el presente contrato bajo las siguientes:

CLÁUSULA PRIMERA. El Contratista se obliga a prestar servicios de consultoría tecnológica por un monto de $150,000 USD mensuales.

CLÁUSULA SEGUNDA. En caso de incumplimiento, el Contratista pagará una penalidad del 50% del valor total del contrato.

CLÁUSULA TERCERA. La vigencia del contrato es del 2024-01-01 al 2025-12-31 con renovación automática.

CLÁUSULA CUARTA. Toda información compartida será confidencial.

Contacto: legal@acme.com
SSN de ejemplo: 123-45-6789
`;

const FINANCIAL_TEXT = `ESTADO DE RESULTADOS - Q4 2024

Ingresos por ventas: $2,500,000 USD
Costo de ventas: $1,200,000 USD
Gasto operativo: $800,000 USD
EBITDA: $500,000 USD
Impuestos: 30%

Balance General:
Activos corrientes: $3,000,000 USD
Pasivos corrientes: $2,500,000 USD
Deuda total: $5,000,000 USD
Capital: $1,500,000 USD

Contacto: finanzas@empresa.com
`;

describe('professional-document-analyzer', () => {
  it('detects legal domain', () => {
    const domain = proAnalyzer.detectDomain(LEGAL_TEXT, 'contract.pdf', 'application/pdf');
    assert.equal(domain.primary, 'legal');
    assert.ok(domain.confidence > 0.3);
  });

  it('detects financial domain', () => {
    const domain = proAnalyzer.detectDomain(FINANCIAL_TEXT, 'results.xlsx', 'application/vnd.ms-excel');
    assert.equal(domain.primary, 'financial');
  });

  it('extracts entities with PII', () => {
    const entities = proAnalyzer.extractEntities(LEGAL_TEXT);
    assert.ok(entities.length >= 3, `expected 3+ entities, got ${entities.length}`);
    const emails = entities.filter(e => e.type === 'email');
    assert.ok(emails.length >= 1, 'should find email');
    const ssns = entities.filter(e => e.type === 'ssn');
    assert.ok(ssns.length >= 1, 'should find SSN');
    assert.equal(ssns[0].sensitivity, 'critical');
  });

  it('extracts structure with headings or paragraphs', () => {
    const structure = proAnalyzer.extractStructure(LEGAL_TEXT);
    assert.ok(structure.headings.length >= 1 || structure.paragraphCount >= 2, `expected headings or paragraphs`);
    assert.ok(structure.wordCount > 50);
  });

  it('assesses risks by domain', () => {
    const entities = proAnalyzer.extractEntities(LEGAL_TEXT);
    const risks = proAnalyzer.assessRisks(LEGAL_TEXT, 'legal', entities);
    assert.ok(risks.items.length >= 1, 'should detect at least 1 risk');
    assert.ok(risks.severity !== 'low', 'legal doc with PII should have higher risk');
  });

  it('computes quality metrics with grade', () => {
    const entities = proAnalyzer.extractEntities(LEGAL_TEXT);
    const risks = proAnalyzer.assessRisks(LEGAL_TEXT, 'legal', entities);
    const quality = proAnalyzer.computeQualityMetrics(LEGAL_TEXT, 'legal', entities, risks);
    assert.ok(quality.grade);
    assert.ok(quality.overall > 0);
    assert.ok(quality.overall <= 100);
  });

  it('detects format', () => {
    assert.equal(proAnalyzer.detectFormat('{"key": "value"}'), 'json');
    assert.equal(proAnalyzer.detectFormat('# Hello\n\nWorld'), 'markdown');
    assert.equal(proAnalyzer.detectFormat('plain text nothing special'), 'plain');
  });

  it('full analyzeDocument returns structured report', () => {
    const result = proAnalyzer.analyzeDocument(LEGAL_TEXT, { fileName: 'contract.pdf' });
    assert.ok(result.ok);
    assert.ok(result.id);
    assert.ok(result.format);
    assert.ok(result.domain);
    assert.ok(result.entities);
    assert.ok(result.risks);
    assert.ok(result.quality);
    assert.ok(result.dimensions);
    assert.ok(result.riskMapping);
    assert.ok(result.autoTags);
    assert.ok(result.metadata);
  });

  it('financial analysis has financial dimensions', () => {
    const result = proAnalyzer.analyzeDocument(FINANCIAL_TEXT, { fileName: 'results.xlsx' });
    assert.ok(result.domain.primary === 'financial' || result.domain.scores.financial > 0);
  });
});

describe('smart-paste-bridge', () => {
  it('shouldAutoFile returns true for long content', () => {
    assert.ok(smartPaste.shouldAutoFile('a'.repeat(200)));
  });

  it('shouldAutoFile returns false for short content', () => {
    assert.ok(!smartPaste.shouldAutoFile('hi'));
  });

  it('isStructuredContent detects JSON', () => {
    const json = JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `item ${i}`, value: i * 100 })) });
    assert.ok(smartPaste.isStructuredContent(json));
  });

  it('isStructuredContent detects code', () => {
    const code = 'import os\nimport sys\ndef main():\n    print("hello")\n    return 0\n\nif __name__ == "__main__":\n    main()\n\n' + '# ' + 'x'.repeat(200);
    assert.ok(smartPaste.isStructuredContent(code));
  });

  it('detectContentType identifies JSON', () => {
    const result = smartPaste.detectContentType('{"test": true}');
    assert.equal(result.format, 'json');
  });

  it('detectContentType identifies CSV', () => {
    const csv = 'name,age,city\nAlice,30,NYC\nBob,25,LA\n' + 'x'.repeat(200);
    const result = smartPaste.detectContentType(csv);
    assert.equal(result.format, 'csv');
  });

  it('ingestPastedContent returns structured result', async () => {
    const result = await smartPaste.ingestPastedContent('user1', 'x'.repeat(300));
    assert.ok(result.autoFiled);
    assert.ok(result.fileName);
    assert.ok(result.format);
  });

  it('ingestPastedContent rejects empty content', async () => {
    const result = await smartPaste.ingestPastedContent('user1', '');
    assert.ok(!result.autoFiled);
  });
});

describe('fidelity-verification-engine', () => {
  it('extractAnchors finds numbers and dates', () => {
    const anchors = fidelityEngine.extractAnchors('Revenue was $1,500,000 USD in 2024-01-15');
    assert.ok(anchors.numbers.length >= 1);
    assert.ok(anchors.dates.length >= 1);
  });

  it('buildEvidencePool aggregates from multiple sources', () => {
    const pool = fidelityEngine.buildEvidencePool(['Revenue was $1.5M', 'Costs hit $500K in 2024-03-01']);
    assert.ok(pool.numbers.size >= 1);
    assert.ok(pool.dates.size >= 1);
  });

  it('verifyClaim returns supported for matching anchors', () => {
    const pool = fidelityEngine.buildEvidencePool(['The total is $1,500,000 USD']);
    const result = fidelityEngine.verifyClaim('The total was $1,500,000 USD', pool);
    assert.ok(result.supportedCount >= 1);
  });

  it('verifyClaim returns unsupported for novel claims', () => {
    const pool = fidelityEngine.buildEvidencePool(['Revenue was $1.5M']);
    const result = fidelityEngine.verifyClaim('The total was $9,999,999 USD', pool);
    assert.ok(result.unsupportedCount >= 1);
  });

  it('buildVerificationReport produces structured report', () => {
    const report = fidelityEngine.buildVerificationReport(
      'Revenue was $1,500,000 USD. Costs were $500,000.',
      ['Revenue was $1,500,000 USD. Costs were $500,000.']
    );
    assert.ok(report.total >= 1);
    assert.ok(report.score >= 0);
    assert.ok(report.level);
  });

  it('renderVerificationNote produces markdown', () => {
    const report = fidelityEngine.buildVerificationReport(
      'Revenue was $1,500,000 USD. Unknown amount was $9,999,999.',
      ['Revenue was $1,500,000 USD.']
    );
    const note = fidelityEngine.renderVerificationNote(report);
    if (report.unsupported > 0) {
      assert.ok(note.includes('VERIFICACIÓN'));
    }
  });
});

describe('multi-document-evidence-engine', () => {
  it('jaccard returns 1 for identical texts', () => {
    const result = evidenceEngine.jaccard(tokenize('hello world test'), tokenize('hello world test'));
    assert.equal(result, 1);
  });

  it('buildEvidenceChain produces chains for 2+ docs', () => {
    const docs = [
      { id: 'a', text: LEGAL_TEXT },
      { id: 'b', text: FINANCIAL_TEXT },
    ];
    const analyses = docs.map(d => proAnalyzer.analyzeDocument(d.text));
    const result = evidenceEngine.buildEvidenceChain(docs, analyses);
    assert.ok(result.chains.length >= 1);
    assert.ok(result.crossReferences.length >= 0);
  });

  it('buildCrossAnalysisReport produces synthesis', () => {
    const docs = [
      { id: 'a', text: LEGAL_TEXT },
      { id: 'b', text: FINANCIAL_TEXT },
    ];
    const result = evidenceEngine.buildCrossAnalysisReport(docs, docs.map(d => proAnalyzer.analyzeDocument(d.text)));
    assert.ok(result.synthesis);
    assert.ok(result.synthesis.documentCount === 2);
  });
});

describe('analysis-pipeline', () => {
  it('runAnalysisPipeline produces full report', () => {
    const result = analysisPipeline.runAnalysisPipeline(LEGAL_TEXT, { fileName: 'contract.pdf' });
    assert.ok(result.ok);
    assert.ok(result.format);
    assert.ok(result.domain);
    assert.ok(result.quality);
    assert.ok(result.dimensions);
  });

  it('runMultiDocumentAnalysis works for 2+ docs', () => {
    const result = analysisPipeline.runMultiDocumentAnalysis([
      { text: LEGAL_TEXT, name: 'contract.pdf' },
      { text: FINANCIAL_TEXT, name: 'results.xlsx' },
    ]);
    assert.ok(result.ok);
    assert.equal(result.documentCount, 2);
    assert.ok(result.crossAnalysis);
  });

  it('buildAnalysisSystemPrompt generates rich prompt', () => {
    const result = analysisPipeline.runAnalysisPipeline(LEGAL_TEXT);
    const prompt = analysisPipeline.buildAnalysisSystemPrompt(result);
    assert.ok(prompt.includes('ANÁLISIS PROFESIONAL'));
    assert.ok(prompt.includes('legal'));
    assert.ok(prompt.includes('Instrucciones'));
  });

  it('STAGES and STAGE_LABELS are complete', () => {
    for (const stage of Object.values(analysisPipeline.STAGES)) {
      assert.ok(analysisPipeline.STAGE_LABELS[stage], `missing label for ${stage}`);
    }
  });
});

function tokenize(text) {
  return (text || '').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || [];
}
