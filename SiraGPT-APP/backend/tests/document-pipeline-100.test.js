const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const {
  MIN_QUALITY_SCORE,
  MIN_TECHNICAL_SCORE,
  PIPELINE_VERSION,
  ROLES,
  runAdvancedDocumentPipeline,
} = require('../src/services/document-pipeline/advanced-document-pipeline');

const REPO_ROOT = path.join(__dirname, '../..');
const RUN_DIR = path.join(REPO_ROOT, 'backend/uploads/document-pipeline/test-runs/latest');
const FILES_DIR = path.join(RUN_DIR, 'files');
const TELEMETRY_DIR = path.join(RUN_DIR, 'telemetry');
const JSON_REPORT = path.join(RUN_DIR, 'document-pipeline-100-results.json');
const MARKDOWN_REPORT = path.join(REPO_ROOT, 'docs/document-generation-validation-report.md');

const CASES = [
  ...[
    'word simple',
    'word academico extenso con apa 7',
    'tesis con portada indice referencias y anexos',
    'informe con tablas complejas',
    'contrato legal con clausulas',
    'reporte con anexos tecnicos',
    'documento con imagen institucional',
    'documento bilingue espanol ingles',
    'documento con indice automatico',
    'documento con citas y referencias',
    'documento con caracteres especiales ninos gestion y analisis',
    'documento en espanol profesional',
    'documento en ingles executive summary',
    'documento largo de investigacion',
    'documento con tabla grande',
    'documento de contenido mixto',
    'documento con archivos de referencia descritos',
    'documento de estres alta complejidad',
    'documento educativo con rubrica',
    'documento empresarial premium',
  ].map((objective, index) => ({
    id: `DOCX-${String(index + 1).padStart(3, '0')}`,
    format: 'docx',
    template: index % 5 === 4 ? 'legal' : index % 3 === 0 ? 'business' : 'academic',
    complexity: index >= 7 ? 'high' : 'standard',
    objective,
  })),
  ...[
    'excel con formulas',
    'excel dashboard ejecutivo',
    'excel multiples hojas',
    'excel con graficos',
    'excel con formato condicional',
    'excel con validaciones de datos',
    'excel con filtros y paneles congelados',
    'excel matriz academica',
    'excel kpi financiero',
    'excel base literaria',
    'excel analisis cronbach simulado',
    'excel spearman estructura',
    'excel ventas mensual',
    'excel control de calidad',
    'excel tablero tesis',
    'excel inventario profesional',
    'excel pipeline multiagente',
    'excel estres con formulas y charts',
    'excel interpretacion automatica',
    'excel reporte final descargable',
  ].map((objective, index) => ({
    id: `XLSX-${String(index + 1).padStart(3, '0')}`,
    format: 'xlsx',
    template: index % 2 === 0 ? 'business' : 'academic',
    complexity: index >= 10 ? 'high' : 'standard',
    objective,
  })),
  ...[
    'powerpoint ejecutivo',
    'powerpoint academico',
    'powerpoint con imagenes',
    'powerpoint con graficos',
    'powerpoint con notas del presentador',
    'powerpoint de tesis',
    'powerpoint pitch comercial',
    'powerpoint reporte financiero',
    'powerpoint educativo',
    'powerpoint legal resumido',
    'powerpoint tecnologia ia',
    'powerpoint propuesta premium',
    'powerpoint roadmap producto',
    'powerpoint con agenda',
    'powerpoint conclusiones',
    'powerpoint analisis mercado',
    'powerpoint arquitectura conceptual',
    'powerpoint estres de ocho slides',
    'powerpoint multiagente',
    'powerpoint entrega final',
  ].map((objective, index) => ({
    id: `PPTX-${String(index + 1).padStart(3, '0')}`,
    format: 'pptx',
    template: index % 3 === 0 ? 'business' : index % 3 === 1 ? 'academic' : 'premium',
    complexity: index >= 8 ? 'high' : 'standard',
    objective,
  })),
  ...[
    'pdf informe complejo',
    'pdf academico con secciones',
    'pdf empresarial con tabla de control',
    'pdf legal profesional',
    'pdf educativo',
    'pdf reporte de investigacion',
    'pdf con caracteres especiales',
    'pdf bilingue',
    'pdf extenso de dos paginas',
    'pdf de supervision qa',
    'pdf con metadatos',
    'pdf entrega descargable',
  ].map((objective, index) => ({
    id: `PDF-${String(index + 1).padStart(3, '0')}`,
    format: 'pdf',
    template: index % 4 === 3 ? 'legal' : index % 2 === 0 ? 'business' : 'academic',
    complexity: index >= 4 ? 'high' : 'standard',
    objective,
  })),
  ...[
    'html semantico',
    'html con tabla',
    'html con enlace',
    'html reporte ejecutivo',
    'html academico',
    'html educativo',
    'html legal',
    'html dashboard',
    'html documento largo',
    'html validacion visual',
  ].map((objective, index) => ({
    id: `HTML-${String(index + 1).padStart(3, '0')}`,
    format: 'html',
    template: index % 2 === 0 ? 'business' : 'academic',
    complexity: index >= 5 ? 'high' : 'standard',
    objective,
  })),
  ...[
    'markdown estructurado',
    'markdown con tabla',
    'markdown con enlace',
    'markdown academico',
    'markdown empresarial',
    'markdown educativo',
    'markdown legal',
    'markdown largo',
    'markdown anexos',
    'markdown qa',
  ].map((objective, index) => ({
    id: `MD-${String(index + 1).padStart(3, '0')}`,
    format: 'md',
    template: index % 2 === 0 ? 'academic' : 'premium',
    complexity: index >= 5 ? 'high' : 'standard',
    objective,
  })),
  ...[
    'csv valido simple',
    'csv matriz academica',
    'csv dashboard source',
    'csv con caracteres especiales',
    'csv estructura reporte',
    'csv alta complejidad',
    'csv entrega final',
    'csv regresion de validacion',
  ].map((objective, index) => ({
    id: `CSV-${String(index + 1).padStart(3, '0')}`,
    format: 'csv',
    template: index % 2 === 0 ? 'business' : 'academic',
    complexity: index >= 4 ? 'high' : 'standard',
    objective,
  })),
];

function assertFormatSpecific(result) {
  const { format, checks } = result.validation;
  if (format === 'docx') {
    assert.equal(checks.documentXml, true);
    assert.equal(checks.table, true);
    assert.equal(checks.headerFooter, true);
  } else if (format === 'xlsx') {
    assert.equal(checks.formulas, true);
    assert.equal(checks.charts, true);
    assert.equal(checks.conditionalFormatting, true);
    assert.equal(checks.dataValidation, true);
  } else if (format === 'pptx') {
    assert.equal(checks.slides, true);
    assert.equal(checks.charts, true);
    assert.equal(checks.media, true);
    assert.equal(checks.notes, true);
  } else if (format === 'pdf') {
    assert.equal(checks.header, true);
    assert.equal(checks.eof, true);
    assert.equal(checks.minPages, true);
  } else if (format === 'html') {
    assert.equal(checks.structure, true);
    assert.equal(checks.table, true);
    assert.equal(checks.links, true);
  } else if (format === 'md') {
    assert.equal(checks.structure, true);
    assert.equal(checks.table, true);
    assert.equal(checks.links, true);
  } else if (format === 'csv') {
    assert.equal(checks.header, true);
    assert.equal(checks.rows, true);
    assert.equal(checks.table, true);
  }
}

function mdCell(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .slice(0, 240);
}

function renderReport({ startedAt, finishedAt, durationMs, rows, jsonReport }) {
  const passed = rows.filter((row) => row.result === 'PASS').length;
  const avgTechnical = Math.round(rows.reduce((sum, row) => sum + row.technicalScore, 0) / rows.length);
  const avgQuality = Math.round(rows.reduce((sum, row) => sum + row.qualityScore, 0) / rows.length);
  const avgOverall = Math.round(rows.reduce((sum, row) => sum + row.overallScore, 0) / rows.length);
  const byFormat = rows.reduce((acc, row) => {
    acc[row.format] = (acc[row.format] || 0) + 1;
    return acc;
  }, {});
  const table = rows.map((row) => (
    `| ${mdCell(row.id)} | ${mdCell(row.format)} | ${mdCell(row.complexity)} | ${mdCell(row.objective)} | ${mdCell(path.relative(REPO_ROOT, row.filePath))} | ${mdCell(row.validations)} | ${row.result} | ${row.technicalScore}/${row.qualityScore}/${row.overallScore} | ${mdCell(row.observations)} |`
  )).join('\n');

  return `# Advanced Document Generation Validation Report

Generated: ${finishedAt}

## Executive Summary

The advanced document pipeline was implemented as a deterministic, offline-capable multi-agent document generation guardrail for siraGPT. It is connected to the real backend document endpoint and validates every generated artifact before delivery.

- Pipeline version: ${PIPELINE_VERSION}
- Started: ${startedAt}
- Finished: ${finishedAt}
- Duration: ${durationMs} ms
- Tests executed: ${rows.length}
- Tests passed: ${passed}/${rows.length}
- Minimum technical score: ${MIN_TECHNICAL_SCORE}
- Minimum quality score: ${MIN_QUALITY_SCORE}
- Average technical score: ${avgTechnical}
- Average quality score: ${avgQuality}
- Average overall score: ${avgOverall}
- Results JSON: ${path.relative(REPO_ROOT, jsonReport)}
- Generated files folder: ${path.relative(REPO_ROOT, FILES_DIR)}

## Architecture Implemented

- Orchestrator role receives the prompt, detects format and coordinates the task.
- Research role flags prompts that require real external evidence before final content is trusted.
- Document design role selects template, palette, structure and quality targets.
- Content generation and code roles build real DOCX, XLSX, PPTX, PDF, CSV, HTML or Markdown files.
- File validation role inspects format internals using ZIP/XML parsers, PDF markers and text parsers.
- QA, supervision, security, performance and telemetry roles record checkpoints before delivery.
- Repair loop regenerates with a stronger plan when technical or quality thresholds are not met.
- Final delivery returns the same frontend artifact contract: type doc, dataUrl, filename, mime, size and metrics.

## Backend Integration

- Endpoint: POST /api/doc/generate
- Streaming contract: SSE stages plus final doc artifact
- Storage: backend/uploads/document-pipeline/files
- Telemetry: backend/uploads/document-pipeline/telemetry
- Report evidence: docs/document-generation-validation-report.md

## Test Matrix

| Format | Cases |
|---|---:|
${Object.entries(byFormat).map(([format, count]) => `| ${format} | ${count} |`).join('\n')}

## Commands To Reproduce

\`\`\`bash
node -c backend/src/services/document-pipeline/advanced-document-pipeline.js
node -c backend/src/routes/doc.js
node --test backend/tests/document-pipeline-100.test.js
\`\`\`

## Detailed Results

| ID | Type | Complexity | Objective | Generated file | Validations applied | Result | Scores T/Q/O | Observations |
|---|---|---|---|---|---|---|---|---|
${table}

## Remaining Risks

- This validation suite proves deterministic multi-format generation and delivery integrity. External academic research quality still depends on upstream research connectors when the user requests verified real sources or DOI-heavy content.
- Browser preview support for PPTX remains download-first because direct PPTX rendering in browsers is not stable enough for production without a conversion service.
`;
}

test('advanced document pipeline generates and validates 100 real files', async () => {
  assert.equal(CASES.length, 100);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  await fs.rm(RUN_DIR, { recursive: true, force: true });
  await fs.mkdir(FILES_DIR, { recursive: true });
  await fs.mkdir(TELEMETRY_DIR, { recursive: true });

  const rows = [];
  for (const testCase of CASES) {
    const prompt = `Crear ${testCase.format} profesional: ${testCase.objective}. Incluir estructura premium, tablas cuando aplique, elementos visuales, validacion tecnica y entrega descargable. Caso ${testCase.id}.`;
    const result = await runAdvancedDocumentPipeline({
      prompt,
      format: testCase.format,
      template: testCase.template,
      complexity: testCase.complexity,
      outputDir: FILES_DIR,
      telemetryDir: TELEMETRY_DIR,
      maxRepairAttempts: 1,
    });

    await fs.access(result.artifact.path);
    assert.equal(result.validation.passed, true, `${testCase.id} should pass validation`);
    assert.ok(result.artifact.size > 250, `${testCase.id} should generate non-empty file`);
    assert.ok(/^[a-f0-9]{64}$/.test(result.artifact.sha256), `${testCase.id} should have sha256`);
    assert.ok(result.validation.technicalScore >= MIN_TECHNICAL_SCORE, `${testCase.id} technical score`);
    assert.ok(result.validation.qualityScore >= MIN_QUALITY_SCORE, `${testCase.id} quality score`);
    assert.deepEqual(result.roles, ROLES, `${testCase.id} should expose all pipeline roles`);
    assert.ok(result.events.some((event) => event.role === 'supervision' && event.status === 'complete'), `${testCase.id} supervised`);
    assert.ok(result.telemetryPath, `${testCase.id} telemetry path`);
    await fs.access(result.telemetryPath);
    assertFormatSpecific(result);

    rows.push({
      id: testCase.id,
      format: result.plan.format,
      complexity: result.plan.complexity,
      objective: testCase.objective,
      filePath: result.artifact.path,
      filename: result.artifact.filename,
      size: result.artifact.size,
      sha256: result.artifact.sha256,
      technicalScore: result.validation.technicalScore,
      qualityScore: result.validation.qualityScore,
      overallScore: result.validation.overallScore,
      validations: Object.entries(result.validation.checks).filter(([, ok]) => ok).map(([name]) => name).join(', '),
      result: result.validation.passed ? 'PASS' : 'FAIL',
      observations: `${result.events.length} events, ${result.attempts.length} attempt(s)`,
    });
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - started;
  const report = {
    pipelineVersion: PIPELINE_VERSION,
    startedAt,
    finishedAt,
    durationMs,
    thresholds: { technical: MIN_TECHNICAL_SCORE, quality: MIN_QUALITY_SCORE },
    totals: {
      tests: rows.length,
      passed: rows.filter((row) => row.result === 'PASS').length,
    },
    rows,
  };
  await fs.mkdir(path.dirname(JSON_REPORT), { recursive: true });
  await fs.writeFile(JSON_REPORT, JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(MARKDOWN_REPORT, renderReport({ startedAt, finishedAt, durationMs, rows, jsonReport: JSON_REPORT }), 'utf8');

  assert.equal(report.totals.passed, 100);
});
