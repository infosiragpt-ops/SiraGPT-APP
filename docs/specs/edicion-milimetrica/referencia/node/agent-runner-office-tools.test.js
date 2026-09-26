'use strict';

/**
 * Tools Office del AgentRunner (inspect_document, office_edit, render_preview v2,
 * verify_visual) contra el sandbox REAL (driver local) y el motor sira_office.py.
 *
 * Destino: backend/tests/agent-runner-office-tools.test.js
 * Correr:  cd backend && node --test tests/agent-runner-office-tools.test.js
 * Los casos que renderizan se saltan con honestidad si no hay soffice/pdftoppm
 * (en CI corren en el shard 1, que instala LibreOffice + poppler + fuentes).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { createSandbox } = require('../src/services/doc-agent/sandbox');
const office = require('../src/services/agent-runner/tools.office');
const { makeVisionVerifier, parseJsonLoose } = require('../src/services/agent-runner/multimodal/visual-verifier');

const FIXTURES = path.join(__dirname, 'fixtures', 'office');
const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
const HAS_PY = spawnSync('python3', ['-c', 'import lxml, PIL']).status === 0;
const HAS_RENDER = has('soffice') && has('pdftoppm');

async function freshSandbox() {
  const sandbox = await createSandbox({ driver: 'local' });
  await sandbox.exec('mkdir -p /workspace/uploads /workspace/outputs /workspace/previews /workspace/tmp', { timeoutMs: 10_000 });
  assert.equal(await office.installOfficeEngine(sandbox), true, 'sira_office.py debe estar junto a tools.office.js');
  for (const name of ['tesis_demo.docx', 'presupuesto_demo.xlsx', 'defensa_demo.pptx']) {
    await sandbox.putFile(`uploads/${name}`, fs.readFileSync(path.join(FIXTURES, name)));
  }
  return sandbox;
}

function fakeVisionClient(reply) {
  const calls = [];
  return {
    calls,
    chat: { completions: { create: async (payload) => { calls.push(payload); return { choices: [{ message: { content: reply } }] }; } } },
  };
}

test('definiciones: 4 tools, description opcional y additionalProperties cerrado', () => {
  const names = office.OFFICE_TOOL_DEFINITIONS.map((d) => d.function.name);
  assert.deepEqual(names, ['inspect_document', 'office_edit', 'render_preview', 'verify_visual']);
  for (const d of office.OFFICE_TOOL_DEFINITIONS) {
    assert.equal(d.function.parameters.additionalProperties, false);
    assert.ok(d.function.parameters.properties.description, `${d.function.name} debe aceptar description`);
  }
});

test('rutas: traversal y absolutas fuera de /workspace se rechazan; dst por defecto versiona', () => {
  assert.equal(office.toRel('../../etc/passwd'), null);
  assert.equal(office.toRel('/etc/passwd'), null);
  assert.equal(office.toRel('/workspace/uploads/a.docx'), 'uploads/a.docx');
  assert.equal(office.defaultDst('uploads/tesis.docx'), 'outputs/tesis-editado.docx');
  assert.equal(office.defaultDst('outputs/tesis-editado.docx'), 'outputs/tesis-editado-v2.docx');
  assert.equal(office.defaultDst('outputs/tesis-editado-v2.docx'), 'outputs/tesis-editado-v3.docx');
});

test('inspect_document ubica el texto con query', { skip: !HAS_PY && 'python3 + lxml + Pillow requeridos' }, async () => {
  const sandbox = await freshSandbox();
  try {
    const ex = office.makeOfficeToolExecutors(sandbox);
    const out = await ex.inspect_document({ path: 'uploads/tesis_demo.docx', query: '2024' });
    assert.ok(!out.startsWith('ERROR'), out);
    const json = JSON.parse(out);
    assert.equal(json.paragraphs[0].i, 8);
    assert.deepEqual(json.paragraphs[0].runs.map((r) => r.t), ['Lima, 20', '24']);
    assert.equal(json.paragraphs[0].runs[1].color, 'C00000');
    assert.match(await ex.inspect_document({ path: '../x.docx' }), /^ERROR/);
  } finally { await sandbox.destroy(); }
});

test('office_edit: quirúrgico, atómico y con argumentos seguros', { skip: !HAS_PY && 'python3 + lxml + Pillow requeridos' }, async () => {
  const sandbox = await freshSandbox();
  try {
    const ex = office.makeOfficeToolExecutors(sandbox);
    const ok = JSON.parse(await ex.office_edit({
      src: 'uploads/tesis_demo.docx',
      ops: [{ op: 'replace_text', paragraph: 8, find: '2024', replace: '2025' },
        { op: 'set_paragraph_text', paragraph: 12, text: 'Investigaciones anteriores indican que la cal disminuye el índice de plasticidad de las arcillas (García, 2020) y facilita su manejo en obra.' }],
    }));
    assert.equal(ok.ok, true);
    assert.equal(ok.dst, 'outputs/tesis_demo-editado.docx');
    assert.deepEqual(ok.changed_parts, ['word/document.xml']);
    const files = (await sandbox.listFiles('outputs')).map((f) => f.path);
    assert.ok(files.some((p) => p.endsWith('tesis_demo-editado.docx')));
    // atómico: una op mala → nada escrito
    const bad = await ex.office_edit({ src: 'uploads/presupuesto_demo.xlsx', dst: 'outputs/p.xlsx',
      ops: [{ op: 'set_cell', sheet: 'Presupuesto', ref: 'B4', value: 15 }, { op: 'set_cell', sheet: 'NoExiste', ref: 'A1', value: 1 }] });
    assert.match(bad, /^ERROR/);
    assert.match(bad, /no se escribió/i);
    assert.ok(!(await sandbox.listFiles('outputs')).some((f) => f.path.endsWith('p.xlsx')));
    // comillas, $() y saltos de línea no llegan al shell (viajan en un archivo JSON)
    const tricky = JSON.parse(await ex.office_edit({ src: 'uploads/defensa_demo.pptx',
      ops: [{ op: 'set_shape_text', slide: 2, shape: 'Nota', text: 'Cumple "MTC" $(rm -rf /) `x`\nsegunda línea' }] }));
    assert.equal(tricky.ok, true);
    assert.match(await ex.office_edit({ src: 'uploads/tesis_demo.docx', dst: '../fuera.docx', ops: [{ op: 'delete_paragraph', paragraph: 1 }] }), /^ERROR/);
  } finally { await sandbox.destroy(); }
});

test('render_preview v2: todas las páginas + campos de compatibilidad', { skip: (!HAS_PY || !HAS_RENDER) && 'requiere soffice + pdftoppm' }, async () => {
  const sandbox = await freshSandbox();
  try {
    const ex = office.makeOfficeToolExecutors(sandbox, { thumbs: true });
    const out = await ex.render_preview({ path: 'uploads/defensa_demo.pptx', dpi: 60 });
    assert.equal(typeof out, 'object', 'con thumbs=true devuelve { text, __thumbs }');
    const json = JSON.parse(out.text);
    assert.equal(json.page_count, 3);
    assert.equal(json.frames.length, 3);
    assert.equal(typeof json.frames[0].mean_brightness, 'number');
    assert.equal(out.__thumbs[0].mediaType, 'image/jpeg');
    assert.equal(out.__f7Image, undefined, 'sin attachImages no se adjunta imagen al loop');
  } finally { await sandbox.destroy(); }
});

test('verify_visual: verificado con visión OK; falla con check roto o visión en contra', { skip: (!HAS_PY || !HAS_RENDER) && 'requiere soffice + pdftoppm' }, async () => {
  const sandbox = await freshSandbox();
  try {
    const plain = office.makeOfficeToolExecutors(sandbox);
    await plain.office_edit({ src: 'uploads/tesis_demo.docx', ops: [{ op: 'replace_text', paragraph: 8, find: '2024', replace: '2025' }] });
    const client = fakeVisionClient('```json\n{"veredicto":"ok","items":[{"requisito":"Año 2025 en la portada","cumple":true,"evidencia":"pág. 1, línea Lima"}],"problemas":[]}\n```');
    const ex = office.makeOfficeToolExecutors(sandbox, { visionVerifier: makeVisionVerifier({ client, model: 'deepseek-flash' }), attachImages: true });
    const good = await ex.verify_visual({
      before: 'uploads/tesis_demo.docx', after: 'outputs/tesis_demo-editado.docx',
      checklist: ['Año 2025 en la portada', 'No cambia nada más'],
      expect: { contains: [{ text: 'Lima, 2025', page: 1 }], only_pages: [1], allowed_parts: ['word/document.xml'] },
    });
    assert.equal(typeof good, 'object');
    assert.match(good.text, /VEREDICTO: VERIFICADO/);
    assert.equal(good.__f7Image.mediaType, 'image/png');
    assert.equal(client.calls[0].model, 'deepseek-flash');
    assert.equal(client.calls[0].messages[1].content.filter((p) => p.type === 'image_url').length, 1);
    const broken = await plain.verify_visual({ before: 'uploads/tesis_demo.docx', after: 'outputs/tesis_demo-editado.docx',
      checklist: ['Año 2026'], expect: { contains: [{ text: '2026', page: 1 }] } });
    assert.match(broken, /^ERROR: verificación fallida/);
    const nay = fakeVisionClient('{"veredicto":"fallo","items":[{"requisito":"Título en negrita","cumple":false,"evidencia":"sigue normal"}]}');
    const exNay = office.makeOfficeToolExecutors(sandbox, { visionVerifier: makeVisionVerifier({ client: nay }) });
    const vetoed = await exNay.verify_visual({ before: 'uploads/tesis_demo.docx', after: 'outputs/tesis_demo-editado.docx', checklist: ['Título en negrita'] });
    assert.match(vetoed, /^ERROR: verificación fallida/);
    assert.match(vetoed, /✗ Título en negrita/);
    assert.match(await plain.verify_visual({ after: 'outputs/tesis_demo-editado.docx' }), /^ERROR: `checklist`/);
  } finally { await sandbox.destroy(); }
});

test('visual-verifier: JSON con cercas o texto alrededor; sin JSON → ok:null', async () => {
  assert.deepEqual(parseJsonLoose('bla ```json\n{"a":1}\n``` fin'), { a: 1 });
  assert.equal(parseJsonLoose('sin json'), null);
  const v = makeVisionVerifier({ client: fakeVisionClient('no puedo ver la imagen') });
  const r = await v({ images: [], checklist: ['x'], summary: '' });
  assert.equal(r.ok, null);
  const failing = makeVisionVerifier({ client: { chat: { completions: { create: async () => { throw new Error('400 bad request'); } } } } });
  const r2 = await failing({ images: [], checklist: ['x'] });
  assert.equal(r2.ok, null);
  assert.match(r2.text, /visión no disponible/);
  assert.equal(makeVisionVerifier({ client: null }), null);
});

test('outputsFingerprint cambia solo cuando cambian los archivos de outputs/', { skip: !HAS_PY && 'python3 requerido' }, async () => {
  const sandbox = await createSandbox({ driver: 'local' });
  try {
    await sandbox.exec('mkdir -p /workspace/outputs', { timeoutMs: 10_000 });
    const a = await office.outputsFingerprint(sandbox);
    await sandbox.exec('ls /workspace/outputs', { timeoutMs: 10_000 });
    assert.equal(await office.outputsFingerprint(sandbox), a);
    await sandbox.writeFile('outputs/x.txt', 'hola');
    assert.notEqual(await office.outputsFingerprint(sandbox), a);
  } finally { await sandbox.destroy(); }
});
