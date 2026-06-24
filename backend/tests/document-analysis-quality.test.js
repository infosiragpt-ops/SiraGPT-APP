'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../src/services/document-analysis-quality');

const files = [
  { id: 'docx-1', name: 'TESIS 2 - JESSICA PATINO - 15JUN2026.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { id: 'pdf-1', name: 'articulo.pdf', mimeType: 'application/pdf' },
  { id: 'xlsx-1', name: 'resultados.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { id: 'txt-1', name: 'notas.txt', mimeType: 'text/plain' },
  'file-id-from-agent-task',
];

const analysisPrompts = [
  'dame un resumen en un solo parrafo',
  'dame un analisis en un solo parrafo',
  'resume este documento',
  'analiza el documento adjunto',
  'explica de que trata el archivo',
  'identifica el objetivo del estudio',
  'extrae los resultados principales',
  'dime las conclusiones',
  'cual es el metodo de investigacion',
  'que muestra usa la tesis',
  'identifica el instrumento aplicado',
  'dame autor ano objetivo metodo resultados y conclusiones',
  'cita este documento en APA 7',
  'cita este articulo en Vancouver',
  'haz una sintesis critica del PDF',
  'interpreta los hallazgos',
  'dime que dice el documento',
  'resume la metodologia y resultados',
  'analiza los anexos y conclusiones',
  'dame una evaluacion academica',
  'explica los resultados de la tabla',
  'identifica limitaciones del estudio',
  'dame el tema central y objetivos',
  'resume el marco teorico',
  'analiza las recomendaciones',
  'cuantas recomendaciones principales lista el informe',
  'suma el total de norte y sur',
  'cual es el valor del marcador de la hoja',
  'calcula el promedio trimestral de sur',
  'del contrato dime el proveedor y del informe el uptime',
  'multiplica ese importe por 2',
  'cual es el importe del contrato y el presupuesto de marketing del acta',
];

test('document-analysis-quality: prompt/file combinations activate deep analysis', async (t) => {
  let count = 0;
  for (const prompt of analysisPrompts) {
    for (const file of files) {
      count += 1;
      await t.test(`${count}: ${prompt} / ${typeof file === 'string' ? file : file.name}`, () => {
        const inputFiles = [file];
        assert.equal(policy.isDocumentAnalysisRequest(prompt, inputFiles), true);

        const block = policy.buildPromptBlock({
          prompt,
          files: inputFiles,
          language: 'es',
          source: 'test',
        });
        assert.match(block, /CONTRATO DE ANALISIS DOCUMENTAL PROFUNDO/);
        assert.match(block, /inicio\/titulo\/problema/);
        assert.match(block, /resultados, conclusiones/);
        assert.doesNotMatch(block, /portada, dedicatoria, indice, primer parrafo[^.]*\.$/);

        const upgraded = policy.upgradeComputeForDocumentAnalysis(
          { mode: 'direct', samples: 1, reasoningEffort: 'low', reflection: false },
          { prompt, files: inputFiles },
        );
        assert.equal(upgraded.upgraded, true);
        assert.deepEqual(upgraded.compute, {
          mode: 'self_consistency',
          samples: 3,
          reasoningEffort: 'high',
          reflection: true,
        });
      });
    }
  }
  assert.equal(count, analysisPrompts.length * files.length);
});

test('document-analysis-quality: single paragraph requests preserve format while requiring coverage', () => {
  const block = policy.buildPromptBlock({
    prompt: 'dame un resumen en un solo parrafo',
    files: [files[0]],
  });

  assert.match(block, /un solo parrafo/);
  assert.match(block, /cubra el documento completo/);
});

test('document-analysis-quality: exact extraction does not force deep synthesis by itself', () => {
  assert.equal(
    policy.isDocumentAnalysisRequest('cual es la primera palabra del word', [files[0]]),
    false,
  );
});

test('document-analysis-quality: image-only uploads do not activate document analysis', () => {
  const image = { id: 'img-1', name: 'captura.png', mimeType: 'image/png' };
  assert.equal(policy.isDocumentAnalysisRequest('analiza esta imagen', [image]), false);
  assert.equal(policy.buildPromptBlock({ prompt: 'analiza esta imagen', files: [image] }), '');
});

test('document-analysis-quality: best_of_n compute is preserved and strengthened', () => {
  const upgraded = policy.upgradeComputeForDocumentAnalysis(
    { mode: 'best_of_n', samples: 2, reasoningEffort: 'medium', reflection: false },
    { prompt: 'analiza este documento', files: [files[1]] },
  );
  assert.equal(upgraded.compute.mode, 'best_of_n');
  assert.equal(upgraded.compute.samples, 3);
  assert.equal(upgraded.compute.reasoningEffort, 'high');
  assert.equal(upgraded.compute.reflection, true);
});

test('document-analysis-quality: spreadsheet requests add table arithmetic guardrails', () => {
  const block = policy.buildPromptBlock({
    prompt: 'calcula el promedio trimestral de sur',
    files: [{ name: 'ventas_2025.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
  });

  assert.match(block, /hojas de calculo o tablas/);
  assert.match(block, /verifica la aritmetica/);
  assert.match(block, /empieza la respuesta con el valor final calculado/);
});

test('document-analysis-quality: marker lookups require literal identifiers', () => {
  const block = policy.buildPromptBlock({
    prompt: 'cual es el valor del marcador de la hoja',
    files: [{ name: 'ventas_2025.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
  });

  assert.match(block, /valor literal/);
  assert.match(block, /no lo sustituyas por totales/);
});

test('document-analysis-quality: multi-document field lookups must cover every requested file', () => {
  const block = policy.buildPromptBlock({
    prompt: 'del contrato dime el proveedor y del informe el uptime',
    files: [
      { name: 'contrato_servicios.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      { name: 'informe_seguridad.pdf', mimeType: 'application/pdf' },
    ],
  });

  assert.match(block, /Solicitud multi-documento/);
  assert.match(block, /no omitiste ningun archivo/);
});

test('document-analysis-quality: follow-up numeric references require recent-turn resolution', () => {
  const block = policy.buildPromptBlock({
    prompt: 'multiplica ese importe por 2. Solo el numero',
    files: [{ name: 'contrato_servicios.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }],
  });

  assert.match(block, /resuelve pronombres/);
  assert.match(block, /digitos simples sin separadores de miles/);
});

test('document-analysis-quality: spreadsheet follow-up resolves row before aggregate total', () => {
  const extractedText = [
    'Excel workbook — 1 sheet(s): Ventas2025',
    '',
    'Sheet: Ventas2025',
    'Columns (6): Region | Q1 | Q2 | Q3 | Q4 | Total',
    'Total data rows: 6',
    '---',
    'Norte\t120\t150\t130\t200\t600',
    'Sur\t90\t80\t110\t95\t375',
    'Este\t200\t210\t190\t220\t820',
    'Oeste\t60\t70\t65\t80\t275',
    'TOTAL\t470\t510\t495\t595\t2070',
  ].join('\n');

  const recovered = policy.buildSpreadsheetFollowUpAnswer({
    prompt: '¿Y cuál fue su total exacto? Solo el número.',
    response: 'El total exacto es 2070.',
    files: [{ name: 'ventas_2025.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extractedText }],
    history: [{ role: 'ASSISTANT', content: 'La región que tuvo el mayor total es **Este**.' }],
  });

  assert.equal(recovered.answer, '820');
  assert.equal(recovered.rowLabel, 'Este');
  assert.equal(recovered.column, 'Total');
});

test('document-analysis-quality: spreadsheet direct sum uses requested rows and total column', () => {
  const extractedText = [
    'Excel workbook — 1 sheet(s): Ventas2025',
    'Sheet: Ventas2025',
    'Columns (6): Region | Q1 | Q2 | Q3 | Q4 | Total',
    'Total data rows: 6',
    '---',
    'Norte\t120\t150\t130\t200\t600',
    'Sur\t90\t80\t110\t95\t375',
    'Este\t200\t210\t190\t220\t820',
    'TOTAL\t470\t510\t495\t595\t2070',
  ].join('\n');

  const recovered = policy.buildSpreadsheetDirectAnswer({
    prompt: 'Suma el total de Norte y Sur. Solo el número.',
    response: 'Norte 120 150 130 200 600. Sur 90 80 110 95 375.',
    files: [{ name: 'ventas_2025.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extractedText }],
  });

  assert.equal(recovered.answer, '975');
  assert.equal(recovered.operation, 'sum_rows');
});

test('document-analysis-quality: spreadsheet direct difference uses requested rows and total column', () => {
  const extractedText = [
    'Excel workbook — 1 sheet(s): Ventas2025',
    'Sheet: Ventas2025',
    'Columns (6): Region | Q1 | Q2 | Q3 | Q4 | Total',
    'Total data rows: 6',
    '---',
    'Este\t200\t210\t190\t220\t820',
    'Oeste\t60\t70\t65\t80\t275',
    'TOTAL\t260\t280\t255\t300\t1095',
  ].join('\n');

  const recovered = policy.buildSpreadsheetDirectAnswer({
    prompt: '¿Cuál es la diferencia entre el total del Este y el del Oeste? Solo el número.',
    response: 'Este 200 210 190 220 820. Oeste 60 70 65 80 275.',
    files: [{ name: 'ventas_2025.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extractedText }],
  });

  assert.equal(recovered.answer, '545');
  assert.equal(recovered.operation, 'difference_rows');
});

test('document-analysis-quality: spreadsheet direct count ignores total and marker rows', () => {
  const extractedText = [
    'Excel workbook — 1 sheet(s): Ventas2025',
    'Sheet: Ventas2025',
    'Columns (6): Region | Q1 | Q2 | Q3 | Q4 | Total',
    'Total data rows: 6',
    '---',
    'Norte\t120\t150\t130\t200\t600',
    'Sur\t90\t80\t110\t95\t375',
    'Este\t200\t210\t190\t220\t820',
    'Oeste\t60\t70\t65\t80\t275',
    'TOTAL\t470\t510\t495\t595\t2070',
    'Marcador\tXLSMARK-5521',
  ].join('\n');

  const recovered = policy.buildSpreadsheetDirectAnswer({
    prompt: '¿Cuántas regiones hay en la tabla, sin contar la fila TOTAL? Solo el número.',
    response: 'Hay 5 regiones.',
    files: [{ name: 'ventas_2025.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extractedText }],
  });

  assert.equal(recovered.answer, '4');
  assert.equal(recovered.operation, 'count_region_rows');
});

test('document-analysis-quality: spreadsheet direct max total row returns requested region', () => {
  const extractedText = [
    'Excel workbook — 1 sheet(s): Ventas2025',
    'Sheet: Ventas2025',
    'Columns (6): Region | Q1 | Q2 | Q3 | Q4 | Total',
    'Total data rows: 6',
    '---',
    'Norte\t120\t150\t130\t200\t600',
    'Sur\t90\t80\t110\t95\t375',
    'Este\t200\t210\t190\t220\t820',
    'Oeste\t60\t70\t65\t80\t275',
    'TOTAL\t470\t510\t495\t595\t2070',
  ].join('\n');

  const recovered = policy.buildSpreadsheetDirectAnswer({
    prompt: '¿Qué región tuvo el mayor total?',
    response: 'El total mayor es 2070.',
    files: [{ name: 'ventas_2025.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extractedText }],
  });

  assert.equal(recovered.answer, 'Este');
  assert.equal(recovered.operation, 'max_total_row');
});

test('document-analysis-quality: spreadsheet direct min total row returns requested region', () => {
  const extractedText = [
    'Excel workbook — 1 sheet(s): Ventas2025',
    'Sheet: Ventas2025',
    'Columns (6): Region | Q1 | Q2 | Q3 | Q4 | Total',
    'Total data rows: 6',
    '---',
    'Norte\t120\t150\t130\t200\t600',
    'Sur\t90\t80\t110\t95\t375',
    'Este\t200\t210\t190\t220\t820',
    'Oeste\t60\t70\t65\t80\t275',
    'TOTAL\t470\t510\t495\t595\t2070',
  ].join('\n');

  const recovered = policy.buildSpreadsheetDirectAnswer({
    prompt: '¿Qué región tuvo el menor total?',
    response: 'La fila TOTAL es 2070.',
    files: [{ name: 'ventas_2025.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extractedText }],
  });

  assert.equal(recovered.answer, 'Oeste');
  assert.equal(recovered.operation, 'min_total_row');
});

test('document-analysis-quality: spreadsheet direct max period ignores row total', () => {
  const extractedText = [
    'Excel workbook — 1 sheet(s): Ventas2025',
    'Sheet: Ventas2025',
    'Columns (6): Region | Q1 | Q2 | Q3 | Q4 | Total',
    'Total data rows: 6',
    '---',
    'Norte\t120\t150\t130\t200\t600',
    'Sur\t90\t80\t110\t95\t375',
  ].join('\n');

  const recovered = policy.buildSpreadsheetDirectAnswer({
    prompt: '¿En qué trimestre tuvo Norte su mayor venta y cuánto fue?',
    response: '600',
    files: [{ name: 'ventas_2025.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extractedText }],
  });

  assert.equal(recovered.answer, 'Q4 200');
  assert.equal(recovered.operation, 'max_period_for_row');
});

test('document-analysis-quality: spreadsheet follow-up does not override explicit max-period row question', () => {
  const extractedText = [
    'Excel workbook — 1 sheet(s): Ventas2025',
    'Sheet: Ventas2025',
    'Columns (6): Region | Q1 | Q2 | Q3 | Q4 | Total',
    'Total data rows: 6',
    '---',
    'Norte\t120\t150\t130\t200\t600',
  ].join('\n');

  const recovered = policy.buildSpreadsheetFollowUpAnswer({
    prompt: '¿En qué trimestre tuvo Norte su mayor venta y cuánto fue?',
    response: 'Q4 200',
    files: [{ name: 'ventas_2025.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extractedText }],
    history: [],
  });

  assert.equal(recovered, null);
});
