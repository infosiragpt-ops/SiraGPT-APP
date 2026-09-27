'use strict';

/**
 * Edición milimétrica — Fase F: the graders of the 10 SPEC eval scenarios
 * (src/services/agent-runner/evals/office-scenarios.js) are trustworthy:
 * the golden edit of each scenario (made with the same engine the agent
 * uses) PASSES, and a plausible wrong edit FAILS.
 *
 * Needs python3 + lxml + Pillow (skips honestly without them). Page-level
 * checks and recalculated totals need soffice + pdftoppm: they run in CI
 * shard 1 (LibreOffice installed) and are skipped locally without them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { createSandbox } = require('../src/services/doc-agent/sandbox');
const office = require('../src/services/agent-runner/tools.office');
const { SCENARIOS, scenarioById } = require('../src/services/agent-runner/evals/office-scenarios');
const { gradeOfficeOutput } = require('../src/services/agent-runner/evals/office-grader');

const FIXTURES = path.join(__dirname, 'fixtures', 'office');
const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
const HAS_PY = spawnSync('python3', ['-c', 'import lxml, PIL']).status === 0;
const RENDER = has('soffice') && has('pdftoppm');
const SKIP = !HAS_PY && 'python3 + lxml + Pillow requeridos';

// The edit a careful agent makes for each scenario (engine ops).
const GOLDEN = {
  'docx-portada-anio': { ops: [{ op: 'replace_text', paragraph: 8, find: '2024', replace: '2025' }] },
  'docx-parafraseo-cita': { ops: [{ op: 'set_paragraph_text', paragraph: 12, text: 'Investigaciones anteriores indican que la cal disminuye el índice de plasticidad de las arcillas (García, 2020) y facilita su manejo en obra.' }] },
  'docx-negrita-fragmento': { ops: [{ op: 'set_format', paragraph: 10, find: 'baja capacidad portante', bold: true }] },
  'docx-sangria-justificado': { ops: [10, 11, 12, 13].map((paragraph) => ({ op: 'set_paragraph_format', paragraph, first_line_mm: 12.5, align: 'justify' })) },
  'docx-tabla-control-cambios': { ops: [{ op: 'replace_text', find: '14,6', replace: '15,1' }], track_changes: true },
  'xlsx-cantidad-resaltado': { ops: [
    { op: 'set_cell', sheet: 'Presupuesto', ref: 'B4', value: 15 },
    { op: 'set_cell_style', sheet: 'Presupuesto', range: 'B4', fill: 'FFF2CC', bold: true },
  ] },
  'xlsx-fila-imprevistos': { ops: [
    { op: 'set_cell', sheet: 'Presupuesto', ref: 'A7', value: 'Imprevistos (5 %)' },
    { op: 'set_cell', sheet: 'Presupuesto', ref: 'D7', formula: '=D6*0.05' },
  ] },
  'pptx-portada-anio': { ops: [{ op: 'replace_text', slide: 1, find: '2024', replace: '2025' }] },
  'pptx-nota-mover-verde': { ops: [
    { op: 'set_geometry', slide: 2, shape: 'Nota', dx_mm: 2 },
    { op: 'set_fill', slide: 2, shape: 'Nota', color: '2E7D32' },
  ] },
  'docx-larga-subtitulo': { ops: [{ op: 'replace_text', paragraph: 73, find: 'DESARROLLO 5', replace: 'ANÁLISIS DE RESULTADOS' }] },
};

// Plausible mistakes the graders must catch.
const WRONG = {
  'docx-portada-anio': { ops: [
    { op: 'replace_text', paragraph: 8, find: '2024', replace: '2025' },
    { op: 'replace_text', paragraph: 0, find: 'EJEMPLO', replace: 'EJEMPLOS' },
  ], why: 'también tocó el encabezado de la portada' },
  'docx-negrita-fragmento': { ops: [{ op: 'set_format', paragraph: 10, bold: true }], why: 'todo el párrafo en negrita' },
  'docx-tabla-control-cambios': { ops: [{ op: 'replace_text', find: '14,6', replace: '15,1' }], why: 'sin control de cambios' },
  'pptx-nota-mover-verde': { ops: [
    { op: 'set_geometry', slide: 2, shape: 'Nota', dx_mm: 3 },
    { op: 'set_fill', slide: 2, shape: 'Nota', color: '2E7D32' },
  ], why: '3 mm en vez de 2' },
  'xlsx-fila-imprevistos': { ops: [{ op: 'set_cell', sheet: 'Presupuesto', ref: 'A7', value: 'Imprevistos' }], why: 'sin fórmula' },
};

async function edited(sandbox, scenario, spec, dst) {
  const res = await office.runEngine(sandbox, 'edit', {
    src: `uploads/${scenario.fixture}`,
    dst,
    ops: spec.ops,
    track_changes: Boolean(spec.track_changes),
  });
  assert.equal(res && res.ok, true, `la edición de referencia falló: ${JSON.stringify(res && (res.errors || res.error))}`);
  return sandbox.readFile(dst);
}

async function freshSandbox() {
  const sandbox = await createSandbox({ driver: 'local' });
  await sandbox.exec('mkdir -p /workspace/uploads /workspace/outputs /workspace/tmp', { timeoutMs: 10_000 });
  assert.equal(await office.installOfficeEngine(sandbox), true);
  for (const name of new Set(SCENARIOS.map((s) => s.fixture))) {
    await sandbox.putFile(`uploads/${name}`, fs.readFileSync(path.join(FIXTURES, name)));
  }
  return sandbox;
}

test('the 10 SPEC scenarios are declared once, on versioned fixtures', () => {
  assert.equal(SCENARIOS.length, 10);
  assert.deepEqual(SCENARIOS.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  for (const s of SCENARIOS) {
    assert.ok(fs.existsSync(path.join(FIXTURES, s.fixture)), `${s.fixture} versionado`);
    assert.ok(s.prompt && s.expectation, s.id);
    assert.ok(GOLDEN[s.id], `edición de referencia para ${s.id}`);
  }
  assert.equal(scenarioById('nope'), null);
});

test('every grader PASSES the golden edit of its scenario', { skip: SKIP, timeout: 900_000 }, async () => {
  const sandbox = await freshSandbox();
  try {
    for (const scenario of SCENARIOS) {
      const after = await edited(sandbox, scenario, GOLDEN[scenario.id], `outputs/golden-${scenario.id}${path.extname(scenario.fixture)}`);
      const before = fs.readFileSync(path.join(FIXTURES, scenario.fixture));
      const graded = await gradeOfficeOutput({ sandbox, scenarioId: scenario.id, before, after, render: RENDER });
      const failed = graded.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
      assert.equal(graded.ok, true, `${scenario.id}: ${failed.join(' | ')}`);
      assert.ok(graded.checks.length >= 2, `${scenario.id} tiene varios checks`);
    }
  } finally {
    await sandbox.destroy();
  }
});

test('graders FAIL plausible wrong edits (they never trust the agent)', { skip: SKIP, timeout: 600_000 }, async () => {
  const sandbox = await freshSandbox();
  try {
    for (const [id, spec] of Object.entries(WRONG)) {
      const scenario = scenarioById(id);
      const after = await edited(sandbox, scenario, spec, `outputs/wrong-${id}${path.extname(scenario.fixture)}`);
      const before = fs.readFileSync(path.join(FIXTURES, scenario.fixture));
      const graded = await gradeOfficeOutput({ sandbox, scenarioId: id, before, after, render: RENDER });
      assert.equal(graded.ok, false, `${id} (${spec.why}) debe fallar`);
    }
    // No file delivered, or the untouched original, never passes.
    const s1 = scenarioById('docx-portada-anio');
    const original = fs.readFileSync(path.join(FIXTURES, s1.fixture));
    assert.equal((await gradeOfficeOutput({ sandbox, scenarioId: s1.id, before: original, after: null })).ok, false);
    assert.equal((await gradeOfficeOutput({ sandbox, scenarioId: s1.id, before: original, after: original, render: RENDER })).ok, false);
  } finally {
    await sandbox.destroy();
  }
});

test('every SPEC scenario prompt reaches an edit path on /generate (never a media question)', () => {
  const agentRunner = require('../src/services/agent-runner');
  const { isDocumentEditRequest } = require('../src/services/agents/agentic-trigger');
  for (const scenario of SCENARIOS) {
    const files = [{ name: scenario.fixture }];
    const claimed = agentRunner.shouldRunAgentRunner({ files, text: scenario.prompt });
    assert.ok(claimed || isDocumentEditRequest(scenario.prompt), `${scenario.id}: «${scenario.prompt}» no llega a ningún editor`);
  }
  // Highlight verbs alone stay answers; a concrete spot makes them edits.
  const docx = [{ name: 'tesis.docx' }];
  assert.equal(agentRunner.shouldRunAgentRunner({ files: docx, text: 'resalta los puntos clave del documento' }), false);
  assert.equal(agentRunner.shouldRunAgentRunner({ files: docx, text: 'subraya el título en amarillo' }), true);
  // «Cambia 2024 por 2025 en la portada.» with a Word attached was answered
  // with «¿Quieres que genere una imagen…?»: the RLCD media question now
  // yields to a document edit turn.
  const ai = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  assert.match(ai, /__documentEditTurn = \(typeof processedFiles !== 'undefined'[\s\S]{0,200}isDocumentEditRequest\(prompt\)/);
  assert.match(ai, /if \(!__documentEditTurn && req\._rlcdMedia\.ask && req\._rlcdMedia\.question/);
});
