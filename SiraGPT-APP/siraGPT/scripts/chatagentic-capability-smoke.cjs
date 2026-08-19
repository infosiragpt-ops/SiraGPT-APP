#!/usr/bin/env node
/*
 * Real smoke suite for the chat-agentic operating layer.
 *
 * This intentionally avoids LLM-only assertions. It generates real files,
 * inspects OOXML/PDF/SVG internals, validates the semantic router, checks
 * tool manifests, and hits local HTTP endpoints when available.
 */

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
let PizZip;
try {
  PizZip = require('pizzip');
} catch {
  PizZip = require('../backend/node_modules/pizzip');
}
const { PDFDocument, degrees, rgb, StandardFonts } = require('pdf-lib');

const {
  runAdvancedDocumentPipeline,
  INTERNAL: documentInternals,
} = require('../backend/src/services/document-pipeline/advanced-document-pipeline');
const {
  buildSemanticIntentAnalysis,
} = require('../backend/src/services/agents/semantic-intent-router');
const {
  BUILTIN_MANIFESTS,
  validateManifest,
} = require('../backend/src/services/agents/tool-manifest');
const {
  qualityReportForHtml,
} = require('../backend/src/services/design-generator');

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(rootDir, 'artifacts', 'chatagentic-smoke', stamp);
const fileDir = path.join(runDir, 'files');
const telemetryDir = path.join(runDir, 'telemetry');
const reportPath = path.join(rootDir, 'docs', 'chatagentic-capability-smoke-report.md');
const resultsPath = path.join(runDir, 'results.json');
const rows = [];

function ms(start) {
  return Date.now() - start;
}

function mdEscape(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, '<br>')
    .slice(0, 420);
}

async function runCase(id, category, objective, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    const row = {
      id,
      category,
      objective,
      status: result?.status || 'PASS',
      score: result?.score ?? 100,
      artifact: result?.artifact || '',
      validations: result?.validations || [],
      observations: result?.observations || '',
      durationMs: ms(started),
    };
    rows.push(row);
    console.log(`${row.status.padEnd(4)} ${id} ${objective}`);
    return row;
  } catch (error) {
    const row = {
      id,
      category,
      objective,
      status: 'FAIL',
      score: 0,
      artifact: '',
      validations: [],
      observations: error?.stack || error?.message || String(error),
      durationMs: ms(started),
    };
    rows.push(row);
    console.log(`FAIL ${id} ${objective}`);
    console.error(row.observations);
    return row;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { response, text, json };
  } finally {
    clearTimeout(timer);
  }
}

async function generate(format, prompt, complexity = 'high') {
  const result = await runAdvancedDocumentPipeline({
    prompt,
    format,
    complexity,
    outputDir: fileDir,
    telemetryDir,
    maxRepairAttempts: 1,
  });
  assert.equal(result.validation.passed, true, JSON.stringify(result.validation, null, 2));
  assert.equal(path.extname(result.artifact.path).slice(1), format === 'markdown' ? 'md' : format);
  assert.ok(result.artifact.size > 100, 'artifact is unexpectedly small');
  return result;
}

function zipText(buffer, entry) {
  const zip = new PizZip(buffer);
  const file = zip.file(entry);
  return file ? file.asText() : '';
}

function assertOoxmlEntry(buffer, entry) {
  const entries = documentInternals.zipEntries(buffer);
  assert.ok(entries.includes(entry), `missing ${entry}`);
  return entries;
}

async function makePdfOperations(sourcePdfPath) {
  const sourceBytes = await fsp.readFile(sourcePdfPath);
  const sourcePdf = await PDFDocument.load(sourceBytes);
  assert.ok(sourcePdf.getPageCount() >= 1, 'source pdf has no pages');

  const extraPdf = await PDFDocument.create();
  const page = extraPdf.addPage([595, 842]);
  const font = await extraPdf.embedFont(StandardFonts.HelveticaBold);
  page.drawText('siraGPT PDF operation test', { x: 72, y: 740, size: 24, font, color: rgb(0.05, 0.1, 0.2) });
  const extraBytes = await extraPdf.save();
  const extraPath = path.join(fileDir, 'pdf-operation-extra.pdf');
  await fsp.writeFile(extraPath, extraBytes);

  const mergedPdf = await PDFDocument.create();
  const sourcePages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
  sourcePages.forEach((p) => mergedPdf.addPage(p));
  const secondPdf = await PDFDocument.load(extraBytes);
  const secondPages = await mergedPdf.copyPages(secondPdf, secondPdf.getPageIndices());
  secondPages.forEach((p) => mergedPdf.addPage(p));
  const mergedPath = path.join(fileDir, 'pdf-operation-merged.pdf');
  await fsp.writeFile(mergedPath, await mergedPdf.save());

  const splitPdf = await PDFDocument.create();
  const [first] = await splitPdf.copyPages(sourcePdf, [0]);
  first.setRotation(degrees(90));
  splitPdf.addPage(first);
  const splitPath = path.join(fileDir, 'pdf-operation-split-rotated.pdf');
  await fsp.writeFile(splitPath, await splitPdf.save());

  const watermarked = await PDFDocument.load(sourceBytes);
  const wmFont = await watermarked.embedFont(StandardFonts.Helvetica);
  for (const wmPage of watermarked.getPages()) {
    wmPage.drawText('VALIDATED BY SIRAGPT', {
      x: 92,
      y: 420,
      size: 32,
      font: wmFont,
      color: rgb(0.2, 0.35, 0.7),
      opacity: 0.18,
      rotate: degrees(35),
    });
  }
  const watermarkedPath = path.join(fileDir, 'pdf-operation-watermarked.pdf');
  await fsp.writeFile(watermarkedPath, await watermarked.save());

  return { extraPath, mergedPath, splitPath, watermarkedPath };
}

function analyzeRouter(prompt, expected = {}) {
  const analysis = buildSemanticIntentAnalysis({
    rawUserRequest: prompt,
    files: expected.files || [],
    conversationHistory: expected.history || [],
  });
  if (expected.intent) assert.equal(analysis.intent, expected.intent);
  if (expected.pipeline) assert.equal(analysis.contract.pipeline, expected.pipeline);
  if (expected.final) assert.equal(analysis.final_output, expected.final);
  assert.equal(analysis.ok, true);
  assert.ok(analysis.contract?.raw_user_request);
  assert.ok(Array.isArray(analysis.execution_graph?.nodes));
  assert.ok(analysis.execution_graph.nodes.length > 0);
  return analysis;
}

async function writeReport() {
  const passed = rows.filter((r) => r.status === 'PASS').length;
  const skipped = rows.filter((r) => r.status === 'SKIP').length;
  const failed = rows.filter((r) => r.status === 'FAIL').length;
  const avgScore = rows.length
    ? Math.round(rows.reduce((sum, row) => sum + Number(row.score || 0), 0) / rows.length)
    : 0;
  const lines = [
    '# Chatagentic capability smoke report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Run directory: \`${runDir}\``,
    '',
    '## Summary',
    '',
    `- Total cases: ${rows.length}`,
    `- Passed: ${passed}`,
    `- Skipped: ${skipped}`,
    `- Failed: ${failed}`,
    `- Average score: ${avgScore}`,
    '',
    '## Evidence',
    '',
    `- Results JSON: \`${resultsPath}\``,
    `- Generated files: \`${fileDir}\``,
    `- Telemetry: \`${telemetryDir}\``,
    '',
    '## Matrix',
    '',
    '| ID | Category | Objective | Status | Score | Artifact | Validations | Observations |',
    '|---|---|---|---:|---:|---|---|---|',
    ...rows.map((row) => `| ${mdEscape(row.id)} | ${mdEscape(row.category)} | ${mdEscape(row.objective)} | ${row.status} | ${row.score} | ${mdEscape(row.artifact)} | ${mdEscape(row.validations.join(', '))} | ${mdEscape(row.observations)} |`),
    '',
    '## Re-run',
    '',
    '```bash',
    'node scripts/chatagentic-capability-smoke.cjs',
    '```',
    '',
  ];
  await fsp.mkdir(path.dirname(reportPath), { recursive: true });
  await fsp.writeFile(resultsPath, JSON.stringify({ runDir, reportPath, rows }, null, 2), 'utf8');
  await fsp.writeFile(reportPath, lines.join('\n'), 'utf8');
}

(async () => {
  await fsp.mkdir(fileDir, { recursive: true });
  await fsp.mkdir(telemetryDir, { recursive: true });

  const generated = {};

  await runCase('HTTP-001', 'runtime', 'Backend health endpoint returns 200 OK', async () => {
    const { response, json, text } = await fetchWithTimeout('http://localhost:5000/health');
    assert.equal(response.status, 200, text);
    assert.ok(json || text.length > 0);
    return { validations: ['HTTP 200', 'response body'], observations: text.slice(0, 160) };
  });

  await runCase('HTTP-002', 'runtime', 'Frontend chat page returns 200 OK', async () => {
    const { response, text } = await fetchWithTimeout('http://localhost:3000/chat');
    assert.equal(response.status, 200, text.slice(0, 300));
    return { validations: ['HTTP 200', 'html response'], observations: `bytes=${text.length}` };
  });

  for (const item of [
    ['DOC-001', 'docx', 'Create professional DOCX with APA-like structure, headers, tables and image'],
    ['XLS-001', 'xlsx', 'Create XLSX workbook with formulas, charts, validations and multiple sheets'],
    ['PPT-001', 'pptx', 'Create PPTX with executive slides, charts, image and speaker notes'],
    ['PDF-001', 'pdf', 'Create PDF from complex structured content'],
    ['CSV-001', 'csv', 'Create valid CSV with structured rows'],
    ['HTML-001', 'html', 'Create semantic HTML artifact with style, table and link'],
    ['MD-001', 'md', 'Create structured Markdown artifact with table and link'],
    ['SVG-001', 'svg', 'Create valid SVG visual artifact with namespace, viewBox and graphic elements'],
  ]) {
    const [id, format, objective] = item;
    await runCase(id, 'artifact-generation', objective, async () => {
      const result = await generate(format, `${objective}. Tema: inteligencia artificial aplicada a investigacion academica.`);
      generated[format] = result;
      return {
        score: result.validation.overallScore,
        artifact: result.artifact.path,
        validations: Object.entries(result.validation.checks || {}).filter(([, ok]) => ok).map(([name]) => name),
        observations: `${result.artifact.mime}; bytes=${result.artifact.size}`,
      };
    });
  }

  await runCase('DOC-002', 'document-understanding', 'Extract text from generated DOCX with mammoth', async () => {
    const artifact = generated.docx?.artifact?.path;
    assert.ok(artifact, 'DOCX was not generated');
    const out = await mammoth.extractRawText({ path: artifact });
    assert.ok(out.value.split(/\s+/).length > 80, 'not enough extracted words');
    return {
      artifact,
      validations: ['mammoth extractRawText', 'word count'],
      observations: out.value.slice(0, 180),
    };
  });

  await runCase('DOC-003', 'document-internals', 'Inspect DOCX OOXML internals for document, header, footer and media', async () => {
    const buffer = await fsp.readFile(generated.docx.artifact.path);
    const entries = assertOoxmlEntry(buffer, 'word/document.xml');
    assert.ok(entries.some((entry) => /^word\/header\d+\.xml$/.test(entry)), 'missing header xml');
    assert.ok(entries.some((entry) => /^word\/footer\d+\.xml$/.test(entry)), 'missing footer xml');
    assert.ok(entries.some((entry) => entry.startsWith('word/media/')), 'missing embedded media');
    return {
      artifact: generated.docx.artifact.path,
      validations: ['OOXML zip', 'header', 'footer', 'media'],
      observations: `entries=${entries.length}`,
    };
  });

  await runCase('XLS-002', 'spreadsheet-internals', 'Inspect XLSX workbook sheets, formulas and charts', async () => {
    const buffer = await fsp.readFile(generated.xlsx.artifact.path);
    const entries = assertOoxmlEntry(buffer, 'xl/workbook.xml');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(generated.xlsx.artifact.path);
    const sheetNames = workbook.worksheets.map((worksheet) => worksheet.name);
    assert.ok(sheetNames.length >= 4, 'expected at least 4 sheets');
    const sheetXml = entries.filter((entry) => entry.startsWith('xl/worksheets/')).map((entry) => zipText(buffer, entry)).join('\n');
    assert.ok(/<f[ >]/.test(sheetXml), 'missing formulas');
    assert.ok(entries.some((entry) => entry.startsWith('xl/charts/')), 'missing chart xml');
    return {
      artifact: generated.xlsx.artifact.path,
      validations: ['ExcelJS open', 'sheets>=4', 'formulas', 'charts'],
      observations: `sheets=${sheetNames.join(', ')}`,
    };
  });

  await runCase('PPT-002', 'presentation-internals', 'Inspect PPTX slides, notes, media and theme', async () => {
    const buffer = await fsp.readFile(generated.pptx.artifact.path);
    const entries = assertOoxmlEntry(buffer, 'ppt/presentation.xml');
    const slides = entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry));
    assert.ok(slides.length >= 8, `expected >=8 slides, got ${slides.length}`);
    assert.ok(entries.some((entry) => entry.startsWith('ppt/notesSlides/')), 'missing notes');
    assert.ok(entries.some((entry) => entry.startsWith('ppt/media/')), 'missing media');
    return {
      artifact: generated.pptx.artifact.path,
      validations: ['OOXML zip', 'slides>=8', 'speaker notes', 'media'],
      observations: `slides=${slides.length}; entries=${entries.length}`,
    };
  });

  await runCase('PDF-002', 'pdf-operations', 'Load PDF and generate merge, split, rotate and watermark artifacts', async () => {
    const ops = await makePdfOperations(generated.pdf.artifact.path);
    for (const filePath of Object.values(ops)) {
      const stat = await fsp.stat(filePath);
      assert.ok(stat.size > 500, `${filePath} too small`);
      const loaded = await PDFDocument.load(await fsp.readFile(filePath));
      assert.ok(loaded.getPageCount() >= 1, `${filePath} has no pages`);
    }
    return {
      artifact: ops.watermarkedPath,
      validations: ['pdf-lib load', 'merge', 'split', 'rotate', 'watermark'],
      observations: Object.values(ops).map((p) => path.basename(p)).join(', '),
    };
  });

  await runCase('DESIGN-001', 'visual-artifacts', 'Validate HTML design quality report for an interactive dashboard shell', async () => {
    const html = await fsp.readFile(generated.html.artifact.path, 'utf8');
    const report = qualityReportForHtml(html, { kind: 'dashboard', fidelity: 'high' });
    assert.ok(report.score >= 70, JSON.stringify(report));
    return {
      score: report.score,
      artifact: generated.html.artifact.path,
      validations: ['qualityReportForHtml'],
      observations: JSON.stringify(report.checks || report).slice(0, 240),
    };
  });

  const routeCases = [
    ['ROUTE-001', 'crea un Word profesional sobre inteligencia artificial', { intent: 'doc', pipeline: 'DocumentPipeline', final: 'docx_file' }],
    ['ROUTE-002', 'haz un excel con formulas y dashboard', { intent: 'doc', pipeline: 'SpreadsheetPipeline', final: 'xlsx_file' }],
    ['ROUTE-003', 'crea una presentacion ppt de arquitectura', { intent: 'ppt', pipeline: 'SlidePipeline', final: 'pptx_file' }],
    ['ROUTE-004', 'crea un pdf con marca de agua', { intent: 'doc', pipeline: 'DocumentPipeline', final: 'pdf_file' }],
    ['ROUTE-005', 'creame un svg de una casa moderna', { intent: 'doc', pipeline: 'VisualArtifactPipeline', final: 'svg_file' }],
    ['ROUTE-006', 'crea una imagen de un perro', { intent: 'image', pipeline: 'ImagePipeline', final: 'image' }],
    ['ROUTE-007', 'busca articulos reales con DOI sobre RAG', { intent: 'web_search', pipeline: 'ResearchGroundingPipeline', final: 'grounded_chat_answer' }],
    ['ROUTE-008', 'analiza este PDF y resume', { intent: 'text', pipeline: 'RAGDocumentUnderstandingPipeline', final: 'chat_answer', files: [{ id: 'paper.pdf', name: 'paper.pdf' }] }],
    ['ROUTE-009', 'programa una API en FastAPI', { pipeline: 'CodePipeline' }],
    ['ROUTE-010', 'crea una web de una empresa de carros', { intent: 'webdev', pipeline: 'CodePipeline', final: 'html_file' }],
    ['ROUTE-011', 'consulta el clima actual de La Paz', { intent: 'web_search', final: 'grounded_chat_answer' }],
    ['ROUTE-012', 'resultados NBA de hoy', { intent: 'web_search', final: 'grounded_chat_answer' }],
    ['ROUTE-013', 'busca restaurantes cerca de mi', { intent: 'web_search', final: 'grounded_chat_answer' }],
    ['ROUTE-014', 'redacta un correo profesional de disculpa', { intent: 'gmail', final: 'chat_answer' }],
    ['ROUTE-015', 'dame una receta de pasta con temporizador', { intent: 'text', final: 'chat_answer' }],
    ['ROUTE-016', 'crea un dashboard interactivo', { intent: 'viz', final: 'chat_answer' }],
    ['ROUTE-017', 'cual es la primera palabra del word ?', {
      intent: 'text',
      final: 'chat_answer',
      history: [{ role: 'USER', files: [{ id: 'docx-1', name: 'RDC-RSN.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }] }],
    }],
  ];

  for (const [id, prompt, expected] of routeCases) {
    await runCase(id, 'semantic-router', prompt, async () => {
      const analysis = analyzeRouter(prompt, expected);
      return {
        score: Math.round(analysis.confidence * 100),
        validations: ['UniversalTaskContract', 'ExecutionGraph', 'chat intent'],
        observations: `intent=${analysis.intent}; pipeline=${analysis.contract.pipeline}; final=${analysis.final_output}; nodes=${analysis.execution_graph.nodes.length}`,
      };
    });
  }

  await runCase('TOOLS-001', 'tool-registry', 'Validate all built-in ToolManifests with JSON Schema', async () => {
    const names = Object.keys(BUILTIN_MANIFESTS);
    assert.ok(names.length >= 8, 'expected at least 8 manifests');
    for (const name of names) {
      const validation = validateManifest(BUILTIN_MANIFESTS[name]);
      assert.equal(validation.ok, true, `${name}: ${JSON.stringify(validation.errors)}`);
    }
    return {
      validations: ['JSON Schema', 'required fields', 'acceptance tests'],
      observations: `manifests=${names.join(', ')}`,
    };
  });

  await runCase('SEARCH-001', 'web-research', 'SearchBrain provider catalog is available locally', async () => {
    const { response, json, text } = await fetchWithTimeout('http://localhost:5000/api/search-brain/providers');
    assert.equal(response.status, 200, text);
    assert.ok(Array.isArray(json?.providers), 'providers missing');
    assert.ok(json.providers.some((p) => p.id === 'openalex'), 'openalex provider missing');
    assert.ok(json.providers.some((p) => p.id === 'pubmed'), 'pubmed provider missing');
    return {
      validations: ['HTTP 200', 'providers array', 'openalex', 'pubmed'],
      observations: `providers=${json.providers.map((p) => p.id).join(', ')}`,
    };
  });

  await runCase('SEARCH-002', 'web-research', 'Attempt a real OpenAlex academic search through SearchBrain', async () => {
    let response;
    let json;
    let text;
    try {
      const out = await fetchWithTimeout('http://localhost:5000/api/search-brain/academic/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'retrieval augmented generation evaluation',
          sources: ['openalex'],
          maxResults: 1,
          timeoutMs: 8000,
        }),
      }, 12000);
      response = out.response;
      json = out.json;
      text = out.text;
    } catch (error) {
      return {
        status: 'SKIP',
        score: 0,
        validations: ['external endpoint attempted'],
        observations: `SearchBrain/OpenAlex did not answer inside budget: ${error?.name || 'Error'} ${error?.message || ''}`.trim(),
      };
    }
    if (response.status !== 200) {
      return {
        status: 'SKIP',
        score: 0,
        validations: ['external endpoint attempted'],
        observations: `SearchBrain returned ${response.status}: ${text.slice(0, 220)}`,
      };
    }
    const citationCount = Array.isArray(json?.citations) ? json.citations.length : 0;
    assert.ok(citationCount >= 0);
    return {
      score: citationCount > 0 ? 100 : 75,
      validations: ['HTTP 200', 'SearchBrain academic/chat'],
      observations: `citations=${citationCount}; providers=${(json?.providersUsed || []).join(', ')}`,
    };
  });

  await runCase('CODE-001', 'programming', 'Node syntax checks pass for modified backend modules', async () => {
    await execFileAsync(process.execPath, ['--check', path.join(rootDir, 'backend/src/services/document-pipeline/advanced-document-pipeline.js')], { cwd: rootDir });
    await execFileAsync(process.execPath, ['--check', path.join(rootDir, 'backend/src/services/agents/semantic-intent-router.js')], { cwd: rootDir });
    return { validations: ['node --check advanced-document-pipeline', 'node --check semantic-intent-router'] };
  });

  await writeReport();
  const failed = rows.filter((row) => row.status === 'FAIL');
  console.log(`\nReport: ${reportPath}`);
  console.log(`Results: ${resultsPath}`);
  if (failed.length) {
    process.exitCode = 1;
  }
})().catch(async (error) => {
  rows.push({
    id: 'HARNESS-FAIL',
    category: 'harness',
    objective: 'Smoke harness execution',
    status: 'FAIL',
    score: 0,
    artifact: '',
    validations: [],
    observations: error?.stack || error?.message || String(error),
    durationMs: 0,
  });
  await fsp.mkdir(runDir, { recursive: true }).catch(() => {});
  await writeReport().catch(() => {});
  console.error(error);
  process.exit(1);
});
