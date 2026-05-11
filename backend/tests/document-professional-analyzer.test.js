'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const analyzer = require('../src/services/document-professional-analyzer');

// ──────────────────────────────────────────────────────────────────────────
// detectDocumentType — type classifier
// ──────────────────────────────────────────────────────────────────────────

test('detectDocumentType: legal contract by name+body', () => {
  const file = { originalName: 'NDA-MutualConfidentiality.pdf', mimeType: 'application/pdf' };
  const text = `
    MUTUAL NON-DISCLOSURE AGREEMENT
    WHEREAS the Parties wish to exchange information...
    Article 1. Confidentiality. Each Party hereby agrees that any disclosure...
    Article 7. Governing law and jurisdiction. This Agreement shall be governed by...
    SIGNED BY: __________
  `;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'legal_contract');
  assert.ok(['high', 'medium'].includes(out.confidence), `expected high/medium got ${out.confidence}`);
});

test('detectDocumentType: financial statement by body only', () => {
  const file = { originalName: 'q3-report.pdf', mimeType: 'application/pdf' };
  const text = `
    Consolidated Income Statement — Q3 2025 (in USD thousands)
    Revenue ................... 12,400
    Cost of goods sold ........  6,800
    Gross profit ..............  5,600
    Operating expenses ........  3,200
    Operating income ..........  2,400
    Net income ................  1,800
    EBITDA ....................  3,100
    Margin analysis follows.
  `;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'financial_statement');
});

test('detectDocumentType: academic paper with abstract + references', () => {
  const file = { originalName: 'preprint-arxiv-2024.pdf', mimeType: 'application/pdf' };
  const text = `
    Abstract
    We propose a novel method for unsupervised representation learning...
    1. Introduction
    Prior work (Smith et al., 2019; Lee, 2021) has shown...
    3. Methods
    We trained on N = 1,000,000 samples.
    4. Results
    Table 1 shows accuracy of 92.3 % (95% CI [90.1, 94.5]).
    References
    Smith, A. (2019). Foundations of representation learning. Journal of ML, 3(2), 12–34. doi:10.1234/jml.0032
  `;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'academic_paper');
});

test('detectDocumentType: CV by name + body sections', () => {
  const file = { originalName: 'Maria_Lopez_CV.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  const text = `
    Maria Lopez · Senior Data Engineer · maria@example.com · LinkedIn: /in/maria
    EXPERIENCIA PROFESIONAL
    Senior Data Engineer @ Acme · 2020 — present
    EDUCACION
    BSc Computer Science · Universidad Nacional · 2015 — 2019
    HABILIDADES
    Python, SQL, dbt, Airflow, Snowflake
    IDIOMAS
    Español: nativo · English: fluent
    CERTIFICACIONES
    AWS Solutions Architect — Associate
  `;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'cv_resume');
  assert.equal(out.confidence, 'high');
});

test('detectDocumentType: invoice by name + currency/numbers', () => {
  const file = { originalName: 'invoice-2025-04-001.pdf', mimeType: 'application/pdf' };
  const text = `
    INVOICE #2025-04-001
    Bill to: Acme Co · Tax ID: 123456789
    Date: 2025-04-15
    -------------------------------
    Web design services ............. $1,200.00
    Hosting (annual) ................   $240.00
    -------------------------------
    Subtotal ........................ $1,440.00
    Tax (18%) .......................   $259.20
    Total ........................... $1,699.20
  `;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'invoice');
});

test('detectDocumentType: medical clinical', () => {
  const file = { originalName: 'historia-clinica-paciente.pdf', mimeType: 'application/pdf' };
  const text = `
    HISTORIA CLINICA
    Paciente: J.D., 54 años, masculino
    Diagnostico: Hipertension arterial esencial
    Tratamiento: Losartan 50 mg cada 24 horas
    Sintomas referidos: cefalea ocasional
    Alergias: Penicilina
    Dr. Garcia, Cardiologia
  `;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'medical_clinical');
});

test('detectDocumentType: technical spec by API keywords', () => {
  const file = { originalName: 'api-spec-v2.md', mimeType: 'text/markdown' };
  const text = `
    # Payments API v2.1
    Authentication: Bearer token via OAuth 2.0
    ## Endpoints
    POST /v2/payments — create a payment
    Request body (JSON schema):
    \`\`\`json
    { "amount": 1000, "currency": "USD", "idempotency_key": "..." }
    \`\`\`
    Response 200: { "id": "...", "status": "succeeded" }
    Rate limit: 100 req/min per API key. Deprecated in v3.
  `;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'technical_spec');
});

test('detectDocumentType: spreadsheet by mime alone', () => {
  const file = { originalName: 'sales.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  const out = analyzer.detectDocumentType(file, '');
  assert.equal(out.type, 'spreadsheet_data');
  assert.equal(out.confidence, 'high');
});

test('detectDocumentType: presentation by mime', () => {
  const file = { originalName: 'pitch.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  const out = analyzer.detectDocumentType(file, 'Slide 1\nVision\nSlide 2\nMarket');
  assert.equal(out.type, 'presentation_slides');
});

test('detectDocumentType: email message by eml ext + headers', () => {
  const file = { originalName: 'thread.eml', mimeType: 'message/rfc822' };
  const text = `From: alice@example.com\nTo: bob@example.com\nSubject: Q4 review\nDate: Mon, 10 Nov 2025\n\nHi Bob, ...`;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'email_message');
});

test('detectDocumentType: image document', () => {
  const file = { originalName: 'receipt-scan.jpg', mimeType: 'image/jpeg' };
  const out = analyzer.detectDocumentType(file, '');
  assert.equal(out.type, 'image_document');
});

test('detectDocumentType: falls back to general_document below threshold', () => {
  const file = { originalName: 'random-notes.txt', mimeType: 'text/plain' };
  const text = 'Some random unstructured notes about a trip last weekend.';
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'general_document');
  assert.equal(out.confidence, 'low');
});

test('detectDocumentType: gracefully handles null inputs', () => {
  const out = analyzer.detectDocumentType(null, null);
  assert.equal(out.type, 'general_document');
  assert.equal(out.confidence, 'low');
});

// ──────────────────────────────────────────────────────────────────────────
// Directives
// ──────────────────────────────────────────────────────────────────────────

test('getProfessionalAnalysisDirective: returns specific recipe for known type', () => {
  const directive = analyzer.getProfessionalAnalysisDirective('legal_contract');
  assert.match(directive, /LEGAL DOCUMENT ANALYSIS RECIPE/);
  assert.match(directive, /Red flags/);
  assert.match(directive, /Negotiation suggestions/);
});

test('getProfessionalAnalysisDirective: returns general recipe for unknown type', () => {
  const directive = analyzer.getProfessionalAnalysisDirective('something_weird');
  assert.match(directive, /PROFESSIONAL DOCUMENT ANALYSIS RECIPE/);
});

test('getProfessionalAnalysisDirective: all built-in types have a directive', () => {
  const types = [
    'legal_contract', 'financial_statement', 'academic_paper', 'medical_clinical',
    'cv_resume', 'invoice', 'business_report', 'technical_spec',
    'spreadsheet_data', 'presentation_slides', 'email_message', 'book_literature',
    'image_document', 'general_document',
  ];
  for (const t of types) {
    const out = analyzer.getProfessionalAnalysisDirective(t);
    assert.ok(out && out.length > 200, `directive for ${t} too short`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// pickPrimaryType
// ──────────────────────────────────────────────────────────────────────────

test('pickPrimaryType: prefers high-confidence types over low', () => {
  const out = analyzer.pickPrimaryType([
    { type: 'general_document', confidence: 'low' },
    { type: 'legal_contract', confidence: 'high' },
    { type: 'spreadsheet_data', confidence: 'low' },
  ]);
  assert.equal(out, 'legal_contract');
});

test('pickPrimaryType: skips general_document when any specific type present', () => {
  const out = analyzer.pickPrimaryType([
    { type: 'general_document', confidence: 'medium' },
    { type: 'cv_resume', confidence: 'low' },
  ]);
  assert.equal(out, 'cv_resume');
});

test('pickPrimaryType: all general → returns general', () => {
  const out = analyzer.pickPrimaryType([
    { type: 'general_document', confidence: 'low' },
    { type: 'general_document', confidence: 'low' },
  ]);
  assert.equal(out, 'general_document');
});

test('pickPrimaryType: empty array safe', () => {
  assert.equal(analyzer.pickPrimaryType([]), 'general_document');
});

// ──────────────────────────────────────────────────────────────────────────
// tableToMiniMarkdown
// ──────────────────────────────────────────────────────────────────────────

test('tableToMiniMarkdown: uses stored markdown when present', () => {
  const md = analyzer._internal.tableToMiniMarkdown({
    markdown: '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n',
    columns: ['A', 'B'],
    preview: [],
  });
  assert.match(md, /\| A \| B \|/);
  assert.match(md, /\| 1 \| 2 \|/);
});

test('tableToMiniMarkdown: rebuilds from columns+preview when markdown missing', () => {
  const md = analyzer._internal.tableToMiniMarkdown({
    markdown: '',
    columns: ['name', 'price'],
    preview: [
      { name: 'Apple', price: 1.2 },
      { name: 'Banana', price: 0.5 },
    ],
  });
  assert.match(md, /\| name \| price \|/);
  assert.match(md, /\| Apple \| 1\.2 \|/);
  assert.match(md, /\| Banana \| 0\.5 \|/);
});

test('tableToMiniMarkdown: escapes pipes and newlines in cells', () => {
  const md = analyzer._internal.tableToMiniMarkdown({
    markdown: '',
    columns: ['col'],
    preview: [{ col: 'has|pipe' }, { col: 'has\nnewline' }],
  });
  assert.match(md, /has\\\|pipe/);
  assert.match(md, /has newline/); // newline replaced by space
  assert.ok(!/has\nnewline/.test(md.split('| col').slice(1).join('')));
});

test('tableToMiniMarkdown: handles array-of-arrays preview', () => {
  const md = analyzer._internal.tableToMiniMarkdown({
    markdown: '',
    columns: ['a', 'b'],
    preview: [[1, 2], [3, 4]],
  });
  assert.match(md, /\| 1 \| 2 \|/);
  assert.match(md, /\| 3 \| 4 \|/);
});

test('tableToMiniMarkdown: empty input returns empty string', () => {
  assert.equal(analyzer._internal.tableToMiniMarkdown(null), '');
  assert.equal(analyzer._internal.tableToMiniMarkdown({ markdown: '', columns: [], preview: [] }), '');
});

// ──────────────────────────────────────────────────────────────────────────
// buildEnrichedFileContext — end-to-end
// ──────────────────────────────────────────────────────────────────────────

test('buildEnrichedFileContext: empty processedFiles returns empty blocks', async () => {
  const out = await analyzer.buildEnrichedFileContext({ prisma: null, processedFiles: [] });
  assert.equal(out.profileBlock, '');
  assert.equal(out.directiveBlock, '');
  assert.equal(out.primaryDocType, 'general_document');
  assert.equal(out.perFileProfile.length, 0);
});

test('buildEnrichedFileContext: single CV without Prisma builds full blocks', async () => {
  const processedFiles = [{
    id: 'file_1',
    name: 'Juan_Perez_CV.pdf',
    originalName: 'Juan_Perez_CV.pdf',
    mimeType: 'application/pdf',
    size: 245_120,
    extractedText: `Juan Perez Senior Engineer
      EXPERIENCIA LABORAL
      Tech Lead @ Acme · 2020 - 2025
      EDUCACION
      MSc CompSci · 2018
      HABILIDADES
      JavaScript, Python, Go
      IDIOMAS
      Español: nativo · English: fluent
      LINKEDIN: /in/juanperez
      CERTIFICACIONES: AWS, GCP`,
  }];

  const out = await analyzer.buildEnrichedFileContext({ prisma: null, processedFiles });
  assert.match(out.profileBlock, /ATTACHED DOCUMENT PROFILE/);
  assert.match(out.profileBlock, /Juan_Perez_CV\.pdf/);
  assert.match(out.profileBlock, /detected=cv_resume/);
  assert.match(out.directiveBlock, /PROFESSIONAL ANALYSIS DIRECTIVE/);
  assert.match(out.directiveBlock, /CV \/ RESUME ANALYSIS RECIPE/);
  assert.equal(out.primaryDocType, 'cv_resume');
  assert.equal(out.perFileProfile.length, 1);
  assert.equal(out.perFileProfile[0].type, 'cv_resume');
});

test('buildEnrichedFileContext: hydrates analysis + tables from prisma stub', async () => {
  const processedFiles = [{
    id: 'file_xyz',
    name: 'sales-q1.xlsx',
    originalName: 'sales-q1.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 89_400,
    extractedText: 'Sheet: Q1\n' + 'Region\tRevenue\tCost\n' + 'EMEA\t1200\t800\n' + 'APAC\t900\t600\n',
  }];

  const fakeAnalysis = {
    id: 'analysis_xyz',
    fileId: 'file_xyz',
    status: 'ready',
    language: 'en',
    mimeType: processedFiles[0].mimeType,
    pageCount: null,
    sheetCount: 3,
    slideCount: null,
    charCount: 1200,
    chunkCount: 12,
    tableCount: 2,
    summary: 'Sales workbook with 3 sheets.',
    textCoverage: JSON.stringify({ charCount: 1200, extractionCoverage: 0.84 }),
    ocr: null,
    warnings: null,
    metadata: JSON.stringify({
      llmSummary: {
        tldr: 'Q1 sales across EMEA and APAC; EMEA leads in revenue.',
        keyPoints: [
          'EMEA generated USD 1,200 in revenue',
          'APAC generated USD 900 in revenue',
          'Combined gross profit USD 700',
        ],
      },
    }),
    updatedAt: new Date(),
  };

  const fakeTables = [{
    id: 't1',
    analysisId: 'analysis_xyz',
    fileId: 'file_xyz',
    ordinal: 1,
    sourceType: 'sheet',
    sourceLabel: 'Q1',
    sheetName: 'Q1',
    title: 'Q1 by region',
    columns: ['Region', 'Revenue', 'Cost'],
    rowCount: 2,
    preview: [
      { Region: 'EMEA', Revenue: 1200, Cost: 800 },
      { Region: 'APAC', Revenue: 900, Cost: 600 },
    ],
    markdown: '',
  }];

  const prismaStub = {
    documentAnalysis: { findMany: async () => [fakeAnalysis] },
    documentTable: { findMany: async () => fakeTables },
  };

  const out = await analyzer.buildEnrichedFileContext({ prisma: prismaStub, processedFiles });
  assert.equal(out.primaryDocType, 'spreadsheet_data');
  assert.match(out.profileBlock, /sales-q1\.xlsx/);
  assert.match(out.profileBlock, /3 sheets/);
  assert.match(out.profileBlock, /Language: English/);
  assert.match(out.profileBlock, /TL;DR \(cached\)/);
  assert.match(out.profileBlock, /EMEA generated USD 1,200/);
  assert.match(out.profileBlock, /Q1 by region/);
  assert.match(out.profileBlock, /Region \| Revenue \| Cost/);
  assert.match(out.directiveBlock, /SPREADSHEET \/ DATA ANALYSIS RECIPE/);
});

test('buildEnrichedFileContext: tolerates prisma errors and still builds blocks', async () => {
  const processedFiles = [{
    id: 'file_oops',
    name: 'contract.pdf',
    originalName: 'NDA-contract.pdf',
    mimeType: 'application/pdf',
    extractedText: 'WHEREAS the parties... Article 1. Confidentiality. signature',
  }];

  const prismaStub = {
    documentAnalysis: { findMany: async () => { throw new Error('db down'); } },
  };

  const out = await analyzer.buildEnrichedFileContext({ prisma: prismaStub, processedFiles });
  // Should NOT throw, and should fall back to type detection from text.
  assert.equal(out.primaryDocType, 'legal_contract');
  assert.match(out.directiveBlock, /LEGAL DOCUMENT ANALYSIS RECIPE/);
});

test('buildEnrichedFileContext: multi-file picks dominant type', async () => {
  const processedFiles = [
    {
      id: 'a',
      name: 'a.pdf',
      originalName: 'NDA-a.pdf',
      mimeType: 'application/pdf',
      extractedText: 'WHEREAS the Parties wish to exchange information. Article 1. Confidentiality. Article 7. Governing law.',
    },
    {
      id: 'b',
      name: 'b.pdf',
      originalName: 'contract-b.pdf',
      mimeType: 'application/pdf',
      extractedText: 'BETWEEN THE PARTIES. Clause 1. Liability. Clause 2. termination. signed by both.',
    },
    {
      id: 'c',
      name: 'random.txt',
      originalName: 'random.txt',
      mimeType: 'text/plain',
      extractedText: 'just some unrelated notes',
    },
  ];

  const out = await analyzer.buildEnrichedFileContext({ prisma: null, processedFiles });
  assert.equal(out.primaryDocType, 'legal_contract');
  assert.equal(out.perFileProfile.length, 3);
  assert.match(out.directiveBlock, /Multi-file note.*3 files attached/s);
});

test('buildEnrichedFileContext: profile block respects char budget', async () => {
  // 50 files with lots of text → block should be truncated cleanly.
  const processedFiles = Array.from({ length: 50 }, (_, i) => ({
    id: `f_${i}`,
    name: `file-${i}.txt`,
    originalName: `file-${i}.txt`,
    mimeType: 'text/plain',
    extractedText: 'x'.repeat(2000),
  }));
  const out = await analyzer.buildEnrichedFileContext({ prisma: null, processedFiles });
  assert.ok(out.profileBlock.length <= 6200, `profile too big: ${out.profileBlock.length}`);
  // Truncation message present when the budget was hit.
  assert.match(out.profileBlock, /truncated/);
});

test('buildEnrichedFileContext: each file profile lists size, identity, structure', async () => {
  const out = await analyzer.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [{
      id: 'fx',
      name: 'memo.md',
      originalName: 'q3-memo.md',
      mimeType: 'text/markdown',
      size: 5120,
      extractedText: 'just a memo',
    }],
  });
  assert.match(out.profileBlock, /### q3-memo\.md/);
  assert.match(out.profileBlock, /type=text\/markdown/);
  assert.match(out.profileBlock, /size=5\.0 KB/);
  assert.match(out.profileBlock, /Extraction: 11 chars/);
});
