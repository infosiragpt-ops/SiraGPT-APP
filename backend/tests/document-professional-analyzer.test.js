'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const analyzer = require('../src/services/document-professional-analyzer');

// ──────────────────────────────────────────────────────────────────────────
// detectDocumentType — type classifier
// ──────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────
// Extended catalogue — new types added in v2026.5.x
// ──────────────────────────────────────────────────────────────────────────

test('detectDocumentType: source code TypeScript file', () => {
  const file = { originalName: 'service.ts', mimeType: 'text/x-typescript' };
  const text = `import { z } from "zod"\n\nexport interface User { id: string; name: string }\n\nexport const userSchema = z.object({ id: z.string(), name: z.string() })\n\nexport function parseUser(input: unknown): User {\n  return userSchema.parse(input)\n}`;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'source_code');
});

test('detectDocumentType: source code Python file', () => {
  const file = { originalName: 'compute.py', mimeType: 'text/x-python' };
  const text = `import json\n\ndef compute_total(items):\n    return sum(i["price"] for i in items)\n\nclass Service:\n    def run(self):\n        return compute_total([])\n\nif __name__ == "__main__":\n    Service().run()`;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'source_code');
});

test('detectDocumentType: configuration file (docker-compose YAML)', () => {
  const file = { originalName: 'docker-compose.yml', mimeType: 'application/yaml' };
  const text = `version: "3.9"\nservices:\n  web:\n    image: nginx:alpine\n    ports:\n      - "80:80"\n  db:\n    image: postgres:15\n    environment:\n      POSTGRES_PASSWORD: example\nvolumes:\n  data:`;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'configuration_file');
});

test('detectDocumentType: configuration file (Dockerfile)', () => {
  const file = { originalName: 'Dockerfile', mimeType: 'text/plain' };
  const text = `FROM node:20-alpine\nWORKDIR /app\nCOPY package.json ./\nRUN npm ci --only=production\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]`;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'configuration_file');
});

test('detectDocumentType: log file by body content', () => {
  const file = { originalName: 'app.log', mimeType: 'text/plain' };
  const text = `2026-05-12T10:00:01Z [INFO] startup complete\n2026-05-12T10:00:02Z [INFO] listening on :3000\n2026-05-12T10:00:05Z [WARN] slow query 1240ms\n2026-05-12T10:00:09Z [ERROR] db connection lost\n2026-05-12T10:00:10Z [INFO] reconnecting...`;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'log_file');
});

test('detectDocumentType: log file with stack trace', () => {
  const file = { originalName: 'crash.txt', mimeType: 'text/plain' };
  const text = `Traceback (most recent call last):\n  File "/app/main.py", line 42, in handle\n    result = compute(payload)\n  File "/app/svc.py", line 17, in compute\n    return data["missing"]\nKeyError: 'missing'\nCaused by: Connection refused\n  at module.connect (server.js:120:5)\n  at module.start (server.js:200:8)`;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'log_file');
});

test('detectDocumentType: meeting transcript with speaker labels', () => {
  const file = { originalName: 'transcript-q3-review.txt', mimeType: 'text/plain' };
  const text = `[00:00:05] Carla: Buenos días, comencemos con la revisión del Q3.\n[00:00:18] Marco: De acuerdo. Los KPIs muestran un crecimiento del 22%.\n[00:01:02] Carla: Action item: Marco prepara el deck para el viernes.\n[00:02:15] Marco: Next steps: alinear con el equipo de marketing.\nAttendees: Carla, Marco, Sofia.\nMinutes prepared by Sofia.`;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'meeting_transcript');
});

test('detectDocumentType: regulatory compliance document (GDPR DPA)', () => {
  const file = { originalName: 'gdpr-dpa.pdf', mimeType: 'application/pdf' };
  const text = `DATA PROCESSING ADDENDUM (GDPR)\nThis Addendum forms part of the Agreement between the Controller and the Processor.\nArticle 28(3) of the GDPR requires the following terms.\nThe data subject shall have the right to access, rectification, and erasure.\nControl 5.7 — Personal data is encrypted in transit using TLS 1.2.\nAudit attestation under SOC 2 Type II is provided annually.\nRisk register updated quarterly.`;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'regulatory_compliance');
});

test('detectDocumentType: research proposal', () => {
  const file = { originalName: 'grant-proposal-2026.pdf', mimeType: 'application/pdf' };
  const text = `RESEARCH PROPOSAL — IA APLICADA A EDUCACIÓN\n\nProblem statement: Los estudiantes carecen de retroalimentación inmediata.\n\nObjectives:\n1. Desarrollar un asistente que evalúe redacciones.\n2. Validar la mejora de aprendizaje en un grupo piloto.\n\nDeliverables: Prototipo, dataset, reporte final.\nMilestones: M1 (mes 3), M2 (mes 6), M3 (mes 9).\nBudget: $250,000 USD distribuido entre personal, equipo y viajes.\n\nExpected outcomes: 15% mejora en métricas de aprendizaje.\nTeam: PI Dr. Ana López, 2 investigadores asociados.`;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'research_proposal');
});

test('getProfessionalAnalysisDirective: returns recipe for new types', () => {
  const newTypes = ['source_code', 'configuration_file', 'log_file', 'meeting_transcript', 'regulatory_compliance', 'research_proposal'];
  for (const t of newTypes) {
    const directive = analyzer.getProfessionalAnalysisDirective(t);
    assert.ok(directive && directive.length > 200, `directive for ${t} should be substantial`);
    assert.match(directive, /RECIPE/i, `directive for ${t} should mention RECIPE`);
  }
});

test('buildEnrichedFileContext: emits insightsBlock with detected entities', async () => {
  const out = await analyzer.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [{
      id: 'fa',
      name: 'memo.txt',
      originalName: 'memo.txt',
      mimeType: 'text/plain',
      extractedText: 'La Dra. Ana López revisará el contrato con Acme Corp el 2026-06-01. Presupuesto: $50,000 USD. ¿Quién aprobará el cambio? Riesgo crítico: vendor lock-in.',
    }],
  });
  assert.ok(out.insightsBlock && typeof out.insightsBlock === 'string', 'insightsBlock present');
  assert.match(out.insightsBlock, /EXTRACTED INSIGHTS/);
  assert.match(out.insightsBlock, /Ana López/);
  assert.match(out.insightsBlock, /\$50,000/);
  assert.match(out.insightsBlock, /2026-06-01/);
});

test('buildEnrichedFileContext: insightsBlock has aggregate + per-file for multi-file', async () => {
  const out = await analyzer.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [
      { id: 'a', name: 'a.txt', originalName: 'a.txt', mimeType: 'text/plain', extractedText: 'Acme Corp contractó a Dr. Juan Pérez. Presupuesto $10,000 USD. Fecha: 2026-05-10.' },
      { id: 'b', name: 'b.txt', originalName: 'b.txt', mimeType: 'text/plain', extractedText: 'Globex Inc colaboró con Dr. Ana López. Presupuesto $20,000 USD. Fecha: 2026-05-20.' },
    ],
  });
  assert.match(out.insightsBlock, /AGGREGATE/);
  assert.match(out.insightsBlock, /Per-file highlights/);
  assert.match(out.insightsBlock, /a\.txt/);
  assert.match(out.insightsBlock, /b\.txt/);
});

test('buildEnrichedFileContext: insightsBlock empty when no extracted text', async () => {
  const out = await analyzer.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [{ id: 'x', name: 'x.txt', originalName: 'x.txt', mimeType: 'text/plain' }],
  });
  assert.equal(out.insightsBlock, '');
});

test('buildEnrichedFileContext: comparisonBlock fires only with 2+ files', async () => {
  const single = await analyzer.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [{ id: 'a', name: 'a.txt', originalName: 'a.txt', mimeType: 'text/plain', extractedText: 'Acme Corp pagó $100,000 USD el 2026-05-10.' }],
  });
  assert.equal(single.comparisonBlock, '', 'single file should produce no comparison block');

  const multi = await analyzer.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [
      { id: 'a', name: 'a.txt', originalName: 'a.txt', mimeType: 'text/plain', extractedText: 'Acme Corp pagó $100,000 USD el 2026-05-10.' },
      { id: 'b', name: 'b.txt', originalName: 'b.txt', mimeType: 'text/plain', extractedText: 'Acme Corp pagó $150,000 USD el 2026-06-15.' },
    ],
  });
  assert.match(multi.comparisonBlock, /CROSS-DOCUMENT SYNTHESIS/);
});

test('buildEnrichedFileContext: glossaryBlock includes detected acronyms', async () => {
  const out = await analyzer.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [{
      id: 'g',
      name: 'spec.md',
      originalName: 'spec.md',
      mimeType: 'text/markdown',
      extractedText: 'The Service Level Agreement (SLA) defines the Recovery Time Objective (RTO). The SLA also specifies the Recovery Point Objective (RPO).',
    }],
  });
  assert.match(out.glossaryBlock, /## DOCUMENT GLOSSARY/);
  assert.match(out.glossaryBlock, /SLA/);
  assert.match(out.glossaryBlock, /RTO/);
});

test('buildEnrichedFileContext: piiSafetyBlock fires on credit card detection', async () => {
  // Constructed at runtime so source code does not contain the literal
  // string GitHub's secret-scanning push protection flags as a Stripe key.
  const fakeStripeKey = ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_');
  const out = await analyzer.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [{
      id: 'p',
      name: 'leak.txt',
      originalName: 'leak.txt',
      mimeType: 'text/plain',
      extractedText: `Customer card on file: 4111 1111 1111 1111. Stripe key: ${fakeStripeKey}`,
    }],
  });
  assert.match(out.piiSafetyBlock, /## PII & SECURITY FLAGS/);
  assert.match(out.piiSafetyBlock, /credit_card/);
  assert.match(out.piiSafetyBlock, /stripe_secret/);
  // Critical guarantee: raw card or key MUST NOT appear in the rendered block
  assert.doesNotMatch(out.piiSafetyBlock, /4111111111111111/);
  assert.doesNotMatch(out.piiSafetyBlock, new RegExp(fakeStripeKey));
});

test('buildEnrichedFileContext: piiSafetyBlock empty for clean documents', async () => {
  const out = await analyzer.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [{
      id: 'q',
      name: 'clean.txt',
      originalName: 'clean.txt',
      mimeType: 'text/plain',
      extractedText: 'Este es un documento narrativo sin datos sensibles, solo prosa.',
    }],
  });
  assert.equal(out.piiSafetyBlock, '');
});

test('buildEnrichedFileContext: consistencyBlock fires when intra-doc conflict present', async () => {
  const out = await analyzer.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [{
      id: 'cc',
      name: 'inv.txt',
      originalName: 'inv.txt',
      mimeType: 'text/plain',
      extractedText: 'Plazo desde 2026-12-15 hasta 2026-03-01. El cronograma se ajustará si es necesario.',
    }],
  });
  assert.match(out.consistencyBlock, /## INTERNAL CONSISTENCY CHECK/);
  assert.match(out.consistencyBlock, /inverted date range/);
});

test('buildEnrichedFileContext: consistencyBlock empty for coherent documents', async () => {
  const out = await analyzer.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [{
      id: 'cd',
      name: 'plain.txt',
      originalName: 'plain.txt',
      mimeType: 'text/plain',
      extractedText: 'Este documento describe un proceso lineal sin contradicciones internas.',
    }],
  });
  assert.equal(out.consistencyBlock, '');
});

test('buildEnrichedFileContext: outlineBlock includes detected sections', async () => {
  const out = await analyzer.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [{
      id: 'oo',
      name: 'spec.md',
      originalName: 'spec.md',
      mimeType: 'text/markdown',
      extractedText: '# Introduction\nIntro body here.\n\n# Methods\nMethods body here.\n\n## Sampling\nSampling description.\n\n# Results\nResults body.',
    }],
  });
  assert.match(out.outlineBlock, /## DOCUMENT OUTLINE/);
  assert.match(out.outlineBlock, /Introduction/);
  assert.match(out.outlineBlock, /Methods/);
});

test('buildEnrichedFileContext: outlineBlock empty when no headings', async () => {
  const out = await analyzer.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [{
      id: 'oe',
      name: 'plain.txt',
      originalName: 'plain.txt',
      mimeType: 'text/plain',
      extractedText: 'A flat paragraph with no structural markers at all.',
    }],
  });
  assert.equal(out.outlineBlock, '');
});

test('buildEnrichedFileContext: readabilityBlock surfaces verdict and CEFR', async () => {
  const out = await analyzer.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [{
      id: 'rr',
      name: 'plain.md',
      originalName: 'plain.md',
      mimeType: 'text/markdown',
      extractedText: 'The cat sat on the mat. It looked at me. I gave it food. The cat ate fast. Then it slept happily on the warm rug.',
    }],
  });
  assert.match(out.readabilityBlock, /## READABILITY/);
  assert.match(out.readabilityBlock, /CEFR/);
  assert.match(out.readabilityBlock, /Tone hint/);
});

test('buildEnrichedFileContext: readabilityBlock empty for empty extracted text', async () => {
  const out = await analyzer.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [{ id: 're', name: 're.txt', originalName: 're.txt', mimeType: 'text/plain' }],
  });
  assert.equal(out.readabilityBlock, '');
});

// ──────────────────────────────────────────────────────────────────────────
// Original test suite
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

// ──────────────────────────────────────────────────────────────────────────
// New document types — v2026.5.12
// ──────────────────────────────────────────────────────────────────────────

test('detectDocumentType: patent application', () => {
  const file = { originalName: 'US20240123456-patent.pdf', mimeType: 'application/pdf' };
  const text = `UNITED STATES PATENT APPLICATION
Patent No. US 11,123,456 B2
Inventor: John Smith
Applicant: Acme Corp.

ABSTRACT
A system and method for processing requests…

BACKGROUND
The prior art teaches a method of X, however it fails to handle Y. The present invention addresses these shortcomings.

CLAIMS:
1. A method comprising:
   receiving a request;
   processing said request using a hardware processor;
   returning a result.
2. The method of claim 1, wherein the processor is an FPGA.

DRAWINGS
FIG. 1 shows a block diagram of the preferred embodiment.`;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'patent', `got ${out.type} with signals ${out.signals}`);
});

test('detectDocumentType: employment contract', () => {
  const file = { originalName: 'employment-agreement.pdf', mimeType: 'application/pdf' };
  const text = `EMPLOYMENT AGREEMENT
This Employment Agreement is made between Acme Corp. ("Employer") and Jane Doe ("Employee").

1. POSITION. Employee shall serve as Senior Software Engineer and report to the VP of Engineering.
2. COMPENSATION. Employer shall pay Employee a base salary of $150,000 per year, payable in bi-weekly installments.
3. VACATION. Employee shall be entitled to twenty (20) days of paid vacation per year.
4. PROBATIONARY PERIOD. The first 90 days shall be probationary.
5. TERMINATION. Either party may terminate this agreement with 30 days written notice.
6. NON-COMPETE. Employee agrees not to engage in competing business for 12 months after termination.
7. CONFIDENTIALITY. Employee shall keep all proprietary information confidential.`;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'employment_contract');
});

test('detectDocumentType: bank statement', () => {
  const file = { originalName: 'bank_statement_april_2026.pdf', mimeType: 'application/pdf' };
  const text = `BANK STATEMENT
Account Number: ****1234
Statement Period: April 1 - April 30, 2026

Opening Balance: $5,200.00
Closing Balance: $4,875.42

TRANSACTIONS:
04/02  DEPOSIT - Salary               +$3,500.00
04/05  WITHDRAWAL - ATM                 -$200.00
04/08  TRANSFER - Rent                -$1,800.00
04/15  CARD PURCHASE - Grocery          -$245.30
04/22  CARD PURCHASE - Restaurant        -$78.50
04/28  INTEREST CREDIT                   +$0.22
04/30  FEE - Monthly maintenance         -$5.00`;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'bank_statement');
});

test('detectDocumentType: insurance policy', () => {
  const file = { originalName: 'auto-insurance-policy.pdf', mimeType: 'application/pdf' };
  const text = `AUTO INSURANCE POLICY
Policy Number: AUTO-2026-12345
Insurer: SafeDrive Insurance Co.
Insured: John Doe
Policy Period: 01/01/2026 - 12/31/2026

PREMIUM: $1,200 annual, payable monthly.
DEDUCTIBLE: $500 per claim.

COVERAGE:
- Liability: $100,000/$300,000 bodily injury
- Property damage: $50,000 per accident
- Comprehensive: actual cash value, minus deductible

EXCLUSIONS:
- Acts of war
- Intentional damage
- Use in commercial activities (rideshare)

CLAIM PROCESS:
Report claims within 30 days of incident. Call 1-800-CLAIM-IT.`;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'insurance_policy');
});

test('detectDocumentType: incident postmortem', () => {
  const file = { originalName: 'postmortem-2026-04-12-api-outage.md', mimeType: 'text/markdown' };
  const text = `# Incident Postmortem — API Outage (SEV-2)

## Timeline (UTC)
- 14:32 — p99 latency alert fires
- 14:35 — on-call engineer paged
- 14:38 — root cause identified: deploy script regression
- 14:42 — rollback initiated
- 14:51 — service restored

## Root Cause
The deploy script set MAX_CONNECTIONS to 0 due to an environment variable typo, causing all connection pools to reject requests.

## Impact
- Customer impact: 12% of requests failed for 19 minutes
- SLO breach: yes, monthly error budget consumed

## Action Items
1. Fix env-var validation in deploy pipeline (Owner: Platform team, Due: 2026-04-19)
2. Add MAX_CONNECTIONS to canary smoke test (Owner: SRE, Due: 2026-04-26)
3. Update runbook with rollback procedure (Owner: On-call lead, Due: 2026-04-22)

## 5 Whys
1. Why did the API fail? → Connection pools rejected all requests.
2. Why? → MAX_CONNECTIONS was 0.
3. Why? → Env-var typo in deploy script.
4. Why? → No validation step in pipeline.
5. Why? → Pipeline was never audited for env-var sanity.`;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'incident_postmortem');
});

test('detectDocumentType: pitch deck content', () => {
  const file = { originalName: 'siraGPT-seed-pitch.pdf', mimeType: 'application/pdf' };
  const text = `siraGPT — Seed Round Pitch Deck
Founders: Luis Carrera, Ada Martínez

TAM: $50B (global AI document workflows)
SAM: $8B (LATAM + SMB segment)
SOM: $400M (first 5 years)

TRACTION:
- MRR: $25K, growing 30% MoM
- 1,200 active users
- 92% net dollar retention

BUSINESS MODEL: SaaS, $99/seat/month
GTM: Product-led growth + outbound to SMB

COMPETITION: ChatGPT, Claude, Codex.
Our moat: domain-tuned document analysis for LATAM Spanish + regulatory compliance.

THE ASK: $2M seed round at $15M pre-money valuation.
USE OF FUNDS: 60% engineering, 30% GTM, 10% runway extension.
Runway after round: 22 months.`;
  const out = analyzer.detectDocumentType(file, text);
  assert.equal(out.type, 'pitch_deck');
});

test('getProfessionalAnalysisDirective: new types return their recipes', () => {
  for (const t of ['patent', 'employment_contract', 'bank_statement', 'insurance_policy', 'incident_postmortem', 'pitch_deck']) {
    const directive = analyzer.getProfessionalAnalysisDirective(t);
    assert.ok(typeof directive === 'string' && directive.length > 200, `${t}: missing or short directive`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Table column profiling
// ──────────────────────────────────────────────────────────────────────────

test('profileTableColumns: infers types for date / currency / text columns', () => {
  const table = {
    columns: ['Date', 'Amount', 'Description'],
    preview: [
      ['2026-04-02', '$3,500.00', 'Salary deposit'],
      ['2026-04-05', '-$200.00', 'ATM withdrawal'],
      ['2026-04-08', '-$1,800.00', 'Rent transfer'],
      ['2026-04-15', '-$245.30', 'Grocery purchase'],
      ['2026-04-22', '-$78.50', 'Restaurant'],
    ],
  };
  const profile = analyzer.profileTableColumns(table);
  assert.ok(profile, 'profile should not be null');
  assert.equal(profile.types[0].type, 'date');
  assert.equal(profile.types[1].type, 'currency');
  assert.equal(profile.types[2].type, 'text');
});

test('profileTableColumns: computes numeric summary stats (sum, mean, min, max)', () => {
  const table = {
    columns: ['Quarter', 'Revenue'],
    preview: [
      ['Q1', '120000'],
      ['Q2', '145000'],
      ['Q3', '162000'],
      ['Q4', '188000'],
    ],
  };
  const profile = analyzer.profileTableColumns(table);
  const revSum = profile.columnSummaries.find(c => c.column === 'Revenue').summary;
  assert.equal(revSum.sum, 615000);
  assert.equal(revSum.min, 120000);
  assert.equal(revSum.max, 188000);
  assert.equal(revSum.count, 4);
});

test('profileTableColumns: detects labelled totals row and excludes it from stats', () => {
  const table = {
    columns: ['Item', 'Qty', 'Price', 'Subtotal'],
    preview: [
      ['Widget A', '2', '50.00', '100.00'],
      ['Widget B', '3', '30.00', '90.00'],
      ['Widget C', '1', '120.00', '120.00'],
      ['TOTAL', '', '', '310.00'],
    ],
  };
  const profile = analyzer.profileTableColumns(table);
  assert.ok(profile.totalsRow, 'totals row should be detected');
  assert.equal(profile.totalsRow.rowIndex, 3);
  const subtotal = profile.columnSummaries.find(c => c.column === 'Subtotal').summary;
  assert.equal(subtotal.sum, 310);
  assert.equal(subtotal.count, 3);
});

test('profileTableColumns: detects arithmetic-verified totals row without explicit label', () => {
  const table = {
    columns: ['Month', 'Revenue', 'Expense'],
    preview: [
      ['Jan', '100', '50'],
      ['Feb', '120', '60'],
      ['Mar', '140', '70'],
      ['Apr', '160', '80'],
      ['',    '520', '260'],
    ],
  };
  const profile = analyzer.profileTableColumns(table);
  assert.ok(profile.totalsRow);
  assert.equal(profile.totalsRow.basis, 'arithmetic');
});

test('profileTableColumns: date column yields earliest/latest range', () => {
  const table = {
    columns: ['Date', 'Event'],
    preview: [
      ['2026-01-15', 'Kickoff'],
      ['2026-03-22', 'Beta launch'],
      ['2026-04-05', 'GA'],
    ],
  };
  const profile = analyzer.profileTableColumns(table);
  const dateSummary = profile.columnSummaries.find(c => c.column === 'Date').summary;
  assert.equal(dateSummary.earliest, '2026-01-15');
  assert.equal(dateSummary.latest, '2026-04-05');
});

test('profileTableColumns: returns null for empty or column-less tables', () => {
  assert.equal(analyzer.profileTableColumns(null), null);
  assert.equal(analyzer.profileTableColumns({ columns: [], preview: [] }), null);
  assert.equal(analyzer.profileTableColumns({ columns: ['a'], preview: [] }), null);
});

test('table preview footer is appended under tables in per-file profile', async () => {
  const fakePrisma = {
    documentAnalysis: {
      findMany: async () => ([{
        id: 'a1',
        fileId: 'f1',
        status: 'ready',
        language: 'en',
        mimeType: 'application/pdf',
        pageCount: 1,
        textCoverage: null,
      }]),
    },
    documentTable: {
      findMany: async () => ([{
        id: 't1',
        analysisId: 'a1',
        fileId: 'f1',
        ordinal: 1,
        title: 'Monthly revenue',
        columns: ['Month', 'Revenue'],
        rowCount: 3,
        preview: [
          ['Jan', '100000'],
          ['Feb', '120000'],
          ['Mar', '140000'],
        ],
        markdown: '',
      }]),
    },
  };
  const out = await analyzer.buildEnrichedFileContext({
    prisma: fakePrisma,
    processedFiles: [{ id: 'f1', name: 'report.pdf', mimeType: 'application/pdf', extractedText: 'x'.repeat(50) }],
  });
  assert.match(out.profileBlock, /Column types:/);
  assert.match(out.profileBlock, /Summary:/);
});
