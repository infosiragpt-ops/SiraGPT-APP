'use strict';

// «Crea una ppt con este formato» + Plantilla.pptx — the runner side:
//   - the claim (shouldRunAgentRunner) accepts «haz una presentación como esta»;
//   - the prompt swaps the surgical / from-scratch rules for the TEMPLATE WORKFLOW;
//   - create_presentation with `template` builds ON the file through the engine;
//   - a delivered deck that does not descend from the template is NOT delivered;
//   - «fondo azul solo en la 2» never takes the whole-deck fast path.

const test = require('node:test');
const assert = require('node:assert/strict');
const PizZip = require('pizzip');

const runner = require('../src/services/agent-runner');
const { buildAgentRunnerPrompt, templateWorkflow } = require('../src/services/agent-runner/prompt');
const { makeToolExecutors, TOOL_DEFINITIONS } = require('../src/services/agent-runner/tools');
const office = require('../src/services/agent-runner/tools.office');

async function makeDeck({ slides = 2, text = 'Texto de ejemplo' } = {}) {
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  for (let i = 1; i <= slides; i += 1) {
    pptx.addSlide().addText(`${text} ${i}`, { x: 0.5, y: 0.5, w: 8, h: 1, fontSize: 24 });
  }
  return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
}

function brandTemplate(buffer) {
  const zip = new PizZip(buffer);
  zip.file('ppt/theme/theme1.xml', zip.file('ppt/theme/theme1.xml').asText()
    .replace(/<a:accent1>[\s\S]*?<\/a:accent1>/, '<a:accent1><a:srgbClr val="7A1F1F"/></a:accent1>'));
  for (const name of Object.keys(zip.files)) {
    if (/^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name)) {
      zip.file(name, zip.file(name).asText().replace(/<p:cSld\b([^>]*)\bname="[^"]*"/, '<p:cSld$1name="Portada UPN"'));
    }
  }
  return zip.generate({ type: 'nodebuffer' });
}

/** Template fill emulation: sample slides out, one new slide on the template's layout. */
function fillTemplate(templateBuffer, title) {
  const zip = new PizZip(templateBuffer);
  const sample = zip.file('ppt/slides/slide1.xml').asText();
  const sampleRels = zip.file('ppt/slides/_rels/slide1.xml.rels').asText();
  for (const n of Object.keys(zip.files).filter((x) => /^ppt\/slides\/(?:_rels\/)?slide\d+\.xml(?:\.rels)?$/.test(x))) zip.remove(n);
  zip.file('ppt/slides/slide1.xml', sample.replace(/<a:t>[^<]*<\/a:t>/g, `<a:t>${title}</a:t>`));
  zip.file('ppt/slides/_rels/slide1.xml.rels', sampleRels);
  zip.file('ppt/presentation.xml', zip.file('ppt/presentation.xml').asText().replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, '<p:sldIdLst><p:sldId id="256" r:id="rIdS1"/></p:sldIdLst>'));
  zip.file('ppt/_rels/presentation.xml.rels', zip.file('ppt/_rels/presentation.xml.rels').asText()
    .replace(/<Relationship\b[^>]*Type="[^"]*\/slide"[^>]*\/>/g, '')
    .replace('</Relationships>', '<Relationship Id="rIdS1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'));
  zip.file('[Content_Types].xml', zip.file('[Content_Types].xml').asText().replace(/<Override PartName="\/ppt\/slides\/slide\d+\.xml"[^>]*\/>/g, '')
    .replace('</Types>', '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'));
  return zip.generate({ type: 'nodebuffer' });
}

test('claim: a format to follow + a deliverable noun is runner work without a WORK_RE verb', () => {
  assert.equal(runner.shouldRunAgentRunner({ fileIds: ['f1'], text: 'haz una presentación como esta sobre nuestros resultados' }), true);
  assert.equal(runner.shouldRunAgentRunner({ fileIds: ['f1'], text: 'usa esta plantilla para una ppt de 6 láminas sobre resultados Q3' }), true);
  assert.equal(runner.shouldRunAgentRunner({ fileIds: [], text: 'usa esta plantilla para una ppt de 6 láminas' }), false, 'no file, nothing to build on');
  assert.equal(runner.shouldRunAgentRunner({ fileIds: ['f1'], text: '¿qué opinas de esta plantilla?' }), false);
});

test('prompt: a template fill replaces the surgical and from-scratch rules with the TEMPLATE WORKFLOW', () => {
  const fill = { file: 'Plantilla-UPN.pptx', format: 'pptx', summary: 'PLANTILLA OBLIGATORIA: uploads/Plantilla-UPN.pptx\n- Layouts (2):\n  · [0] «Portada UPN»' };
  const p = buildAgentRunnerPrompt({ fileNames: ['Plantilla-UPN.pptx'], creatingNewFile: true, templateFill: fill });
  assert.match(p, /TEMPLATE WORKFLOW — the user attached a FORMAT to follow \(mandatory\)/);
  assert.match(p, /create_presentation with template="uploads\/Plantilla-UPN\.pptx"/);
  assert.match(p, /NEVER build the deck with pptxgenjs/);
  assert.match(p, /«Portada UPN»/);
  assert.doesNotMatch(p, /OFFICE FILES \(docx\/xlsx\/pptx\) — MANDATORY WORKFLOW/);
  assert.match(p, /a from-scratch file is a failure even if it looks similar/);
  // Even without a create verb (creatingNewFile=false) the template wins over the surgical workflow.
  const p2 = buildAgentRunnerPrompt({ fileNames: ['Plantilla.potx'], creatingNewFile: false, templateFill: { file: 'Plantilla.potx', format: 'pptx' } });
  assert.match(p2, /TEMPLATE WORKFLOW/);
  assert.doesNotMatch(p2, /OFFICE FILES \(docx\/xlsx\/pptx\) — MANDATORY WORKFLOW/);
  // docx templates get the python-docx recipe.
  const d = templateWorkflow({ templateFile: 'plantilla-tesis.docx', templateFormat: 'docx' });
  assert.match(d, /Document\('uploads\/plantilla-tesis\.docx'\)/);
  assert.match(d, /NEVER create Document\(\) from scratch/);
  // No template → the prompt is byte-identical to before.
  assert.equal(buildAgentRunnerPrompt({ fileNames: ['deck.pptx'] }), buildAgentRunnerPrompt({ fileNames: ['deck.pptx'], templateFill: null }));
});

test('create_presentation(template=) runs build_from_template in the engine and never themes the deck', async () => {
  const files = new Map();
  const execs = [];
  const sandbox = {
    async exec(command) {
      execs.push(command);
      if (/build_from_template --args-file/.test(command)) {
        const argsPath = /--args-file \/workspace\/(\S+)/.exec(command)[1];
        const args = JSON.parse(files.get(argsPath).toString('utf8'));
        files.set(args.dst, Buffer.from('pptx-bytes'));
        return { stdout: `${JSON.stringify({ ok: true, dst: args.dst, slides: args.outline.length + 1, removed_sample_slides: 3, created: args.outline.map((o) => ({ layout: o.layout || 'Title and Content' })), leftover_placeholder_text_on: [], warnings: [] })}\n`, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async readFile(p) { return files.get(p); },
    async writeFile(p, c) { files.set(p, Buffer.isBuffer(c) ? c : Buffer.from(String(c))); },
    async listFiles() { return []; },
  };
  const exec = makeToolExecutors(sandbox, { office: { enabled: false } });
  const raw = await exec.create_presentation({
    topic: 'Marketing digital', title: 'Marketing digital 2026', template: 'uploads/Plantilla-UPN.pptx', theme: 'boardroom', color: 'azul',
    outline: [{ title: 'Contexto', bullets: ['a', 'b'], layout: 'Portada UPN' }, { title: 'Objetivos', bullets: ['c'] }],
  });
  const res = JSON.parse(raw);
  assert.equal(res.ok, true);
  assert.equal(res.template, 'uploads/Plantilla-UPN.pptx');
  assert.equal(res.theme, 'template');
  assert.equal(res.slides, 3);
  assert.deepEqual(res.layoutsUsed, ['Portada UPN', 'Title and Content']);
  assert.ok(files.has('outputs/Marketing-digital.pptx'), 'the engine wrote the deck under outputs/');
  const argsFile = [...files.keys()].find((k) => k.startsWith('tmp/sira-args-'));
  const args = JSON.parse(files.get(argsFile).toString('utf8'));
  assert.equal(args.template, 'uploads/Plantilla-UPN.pptx');
  assert.equal(args.outline[0].layout, 'Portada UPN');
  assert.equal(args.keep_sample_slides, false);
  assert.ok(execs.some((c) => /sira_office\.py build_from_template/.test(c)));
  // A docx template is refused here (python-docx path), traversal is refused.
  assert.match(await exec.create_presentation({ topic: 'x', template: 'uploads/plantilla.docx' }), /^ERROR: template must be a \.pptx\/\.potx/);
  assert.match(await exec.create_presentation({ topic: 'x', template: '../etc/x.pptx' }), /^ERROR: template must be a path under/);
  const def = TOOL_DEFINITIONS.find((d) => d.function.name === 'create_presentation');
  assert.ok(def.function.parameters.properties.template, 'template parameter is declared to the model');
  assert.ok(def.function.parameters.properties.outline.items.properties.layout);
});

test('office_edit exposes the slide ops (add/duplicate/delete/move/background/list_layouts)', () => {
  for (const op of ['add_slide', 'duplicate_slide', 'delete_slide', 'move_slide', 'set_slide_background', 'list_layouts']) {
    assert.ok(office.OFFICE_OPS.includes(op), op);
  }
  const def = office.OFFICE_TOOL_DEFINITIONS.find((d) => d.function.name === 'office_edit');
  assert.match(def.function.description, /duplicate_slide\{slide/);
  assert.match(def.function.description, /set_slide_background\{slide\|slides/);
});

test('lineage gate: a from-scratch deck is not delivered on a template turn; a deck built on the template is', async () => {
  const template = brandTemplate(await makeDeck({ slides: 2 }));
  const fresh = await makeDeck({ slides: 3, text: 'Contenido nuevo' });
  const derived = fillTemplate(template, 'Resultados Q3');
  const events = [];
  const sandbox = (buffer) => ({ collectOutputs: async () => [{ name: 'deck.pptx', buffer }], putFile: async () => {}, exec: async () => ({ exitCode: 0 }) });
  const editContext = { files: [{ name: 'Plantilla.pptx', buffer: template }], instruction: 'crea una ppt con este formato', isEdit: false,
    templateFill: { file: 'Plantilla.pptx', format: 'pptx', buffer: template } };
  const rejected = await runner.collectValidOutputs(sandbox(fresh), (e) => events.push(e), editContext);
  assert.equal(rejected[0].valid, false);
  assert.equal(rejected[0].validation.reason, 'template_not_followed');
  assert.equal(rejected[0].validation.engine, 'template_lineage');
  assert.ok(events.some((e) => e.type === 'output_invalid' && e.reason === 'template_not_followed'));
  const accepted = await runner.collectValidOutputs(sandbox(derived), () => {}, editContext);
  assert.equal(accepted[0].valid, true);
  assert.equal(accepted[0].validation.templateLineage.ok, true);
  // Kill switch.
  const prev = process.env.SIRAGPT_TEMPLATE_LINEAGE;
  process.env.SIRAGPT_TEMPLATE_LINEAGE = '0';
  try {
    const off = await runner.collectValidOutputs(sandbox(fresh), () => {}, editContext);
    assert.equal(off[0].valid, true);
  } finally {
    if (prev === undefined) delete process.env.SIRAGPT_TEMPLATE_LINEAGE; else process.env.SIRAGPT_TEMPLATE_LINEAGE = prev;
  }
  // Without a template fill the gate is inert (an ordinary creation).
  const plain = await runner.collectValidOutputs(sandbox(fresh), () => {}, { files: [], instruction: 'crea una ppt', isEdit: false });
  assert.equal(plain[0].valid, true);
});

test('slide scope: «solo en la 2» names one slide, «todas» none, «la última» is unresolved', () => {
  assert.deepEqual(runner.extractSlideScope('pon el fondo azul oscuro solo en la diapositiva 2'), { numbers: [2], unresolved: false });
  assert.deepEqual(runner.extractSlideScope('cambia el fondo de las diapositivas 2, 3 y 5 a gris'), { numbers: [2, 3, 5], unresolved: false });
  assert.deepEqual(runner.extractSlideScope('fondo negro en la segunda lámina'), { numbers: [2], unresolved: false });
  assert.deepEqual(runner.extractSlideScope('pinta de la 2 a la 4 en celeste'), { numbers: [2, 3, 4], unresolved: false });
  assert.equal(runner.extractSlideScope('ponlas todas rosadas'), null);
  assert.equal(runner.extractSlideScope('pon el fondo azul'), null);
  assert.equal(runner.extractSlideScope('fondo rojo en la última lámina').unresolved, true);
});
