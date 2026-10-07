'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PptxGenJS = require('pptxgenjs');
const PizZip = require('pizzip');
process.env.NODE_ENV = 'test';
const runner = require('../src/services/agent-runner');

async function makeDeck({ bad = false, title = 'Objetivo', count = 3 } = {}) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  for (let index = 0; index < count; index++) {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addText(title, bad
      ? { x: 18, y: 15, w: 2, h: 0.1, fontSize: 2, color: 'FFFFFF' }
      : { x: 0.7, y: 0.6, w: 11, h: 0.8, fontSize: 32, color: '172233' });
  }
  return pptx.write({ outputType: 'nodebuffer' });
}

const collect = (outputs, events = [], context = {}) => runner.collectValidOutputs({
  collectOutputs: async () => outputs.map((out) => ({ ...out })),
}, (event) => events.push(event), context);

test('a readable generated presentation passes with explicit static-only coverage', async () => {
  const buffer = await makeDeck();
  const [out] = await collect([{ name: 'deck.pptx', buffer }]);
  assert.equal(out.valid, true);
  assert.equal(out.validation.passed, true);
  assert.equal(out.validation.pptxDesignAudit.coverage.slides, 3);
  assert.equal(out.validation.pptxDesignAudit.coverage.rendered, false);
  assert.equal(out.buffer, buffer);
});

test('an OOXML-valid but unreadable three-slide deck is rejected with slide and shape repair locations', async () => {
  const events = [];
  const [out] = await collect([{ name: 'deck.pptx', buffer: await makeDeck({ bad: true, title: 'PRIVATE CONTENT' }) }], events);
  assert.equal(out.valid, false);
  assert.equal(out.validation.reason, 'pptx_design_failed');
  assert.equal(out.validation.engine, 'pptx_design_preflight');
  const errors = out.validation.pptxDesignAudit.issues;
  assert.deepEqual(errors.filter((error) => error.code === 'PPTX_TEXT_OUTSIDE_SLIDE').map((error) => error.slide), [1, 2, 3]);
  assert.ok(errors.every((error) => /^\d+$/.test(error.shapeId)));
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'pptx_design_failed');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE CONTENT/);
});

test('a readable edit retains the independent source-change proof', async () => {
  const source = await makeDeck({ title: 'Antes' });
  const edited = await makeDeck({ title: 'Después' });
  const [out] = await collect([{ name: 'deck.pptx', buffer: edited }], [], {
    isEdit: true, instruction: 'Actualiza el contenido del documento',
    files: [{ name: 'deck.pptx', buffer: source }],
  });
  assert.equal(out.valid, true);
  assert.equal(out.validation.engine, 'agent_runner_edit_delta');
  assert.equal(out.validation.pptxDesignAudit.passed, true);
});

test('non-PPTX formats retain their existing behavior and invalid Office packages stay rejected', async () => {
  const docx = new PizZip();
  docx.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  docx.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Documento</w:t></w:r></w:p></w:body></w:document>');
  const outputs = await collect([
    { name: 'notes.txt', buffer: Buffer.from('Notas') },
    { name: 'document.docx', buffer: docx.generate({ type: 'nodebuffer' }) },
    { name: 'broken.pptx', buffer: Buffer.from('broken') },
  ]);
  for (const name of ['notes.txt', 'document.docx']) {
    const out = outputs.find((output) => output.name === name);
    assert.equal(out.valid, true, name);
    assert.equal(out.validation?.pptxDesignAudit, undefined, name);
  }
  assert.equal(outputs.find((output) => output.name === 'broken.pptx').valid, false);
});

// Replace only the sandbox transport and model loop. The real runner, OOXML
// parser, quality audit, retry policy and delivery classification remain live.
function isolateRunner(t, onLoop) {
  const sandboxModule = require('../src/services/doc-agent/sandbox');
  const loopModule = require('../src/services/agent-runner/loop');
  const originalCreateSandbox = sandboxModule.createSandbox;
  const originalRunLoop = loopModule.runAgentLoop;
  const indexPath = require.resolve('../src/services/agent-runner');
  const originalIndex = require.cache[indexPath];
  const state = { outputs: [], calls: [], events: [], destroyed: false };
  const sandbox = {
    driver: 'local', persistent: false,
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    writeFile: async () => {}, putFile: async () => {},
    readFile: async () => Buffer.from(''),
    listFiles: async () => [],
    collectOutputs: async () => state.outputs.map((output) => ({ ...output })),
    destroy: async () => { state.destroyed = true; },
  };
  sandboxModule.createSandbox = async () => sandbox;
  loopModule.runAgentLoop = async (options) => {
    state.calls.push({ messages: options.messages.map((message) => ({ ...message })), maxIterations: options.maxIterations });
    await onLoop(state, options);
    return { stoppedReason: 'final', finalText: 'Listo, presentación entregada.', steps: [], iterations: 1 };
  };
  delete require.cache[indexPath];
  let isolated;
  try { isolated = require(indexPath); } finally {
    sandboxModule.createSandbox = originalCreateSandbox;
    loopModule.runAgentLoop = originalRunLoop;
  }
  t.after(() => { require.cache[indexPath] = originalIndex; });
  return {
    state,
    run: () => isolated.runAgentRunner({
      instruction: 'Crea una presentación PPTX profesional y un archivo de notas',
      client: {}, driver: 'local', persistMemory: false, maxIterations: 5, onEvent: (event) => state.events.push(event),
    }),
  };
}

test('the existing repair loop receives locations and repairs PPTX even alongside a valid text file', async (t) => {
  const bad = await makeDeck({ bad: true, title: 'PRIVATE CONTENT' });
  const good = await makeDeck();
  const notes = { name: 'notes.txt', buffer: Buffer.from('Notas') };
  const harness = isolateRunner(t, async (state) => {
    state.outputs = [notes, { name: 'deck.pptx', buffer: state.calls.length === 1 ? bad : good }];
  });
  const result = await harness.run();
  assert.equal(harness.state.calls.length, 2);
  const correction = harness.state.calls[1].messages.at(-1).content;
  assert.match(correction, /PPTX_TEXT_OUTSIDE_SLIDE/);
  assert.match(correction, /"slide":1/);
  assert.match(correction, /"shapeId":"\d+"/);
  assert.match(correction, /preserve other valid outputs/);
  assert.doesNotMatch(correction, /PRIVATE CONTENT/);
  assert.equal(result.stoppedReason, 'final');
  assert.equal(result.outputs.find((out) => out.name === 'deck.pptx').valid, true);
  assert.equal(result.outputs.find((out) => out.name === 'notes.txt').valid, true);
  assert.equal(harness.state.destroyed, true);
});

test('the bounded repair loop never delivers persistent PPTX defects or claims success', async (t) => {
  const bad = await makeDeck({ bad: true });
  const harness = isolateRunner(t, async (state) => {
    state.outputs = [{ name: 'deck.pptx', buffer: bad }];
  });
  const result = await harness.run();
  assert.equal(harness.state.calls.length, 3, 'the existing retry ceiling stays unchanged');
  assert.equal(result.stoppedReason, 'verification_failed');
  assert.equal(result.outputs[0].valid, false);
  assert.match(result.finalText, /No pude entregar la presentación/);
  assert.doesNotMatch(result.finalText, /Listo/);
});

test('a persistent PPTX failure does not discard another valid output', async (t) => {
  const bad = await makeDeck({ bad: true });
  const harness = isolateRunner(t, async (state) => {
    state.outputs = [{ name: 'deck.pptx', buffer: bad }, { name: 'notes.txt', buffer: Buffer.from('Notas') }];
  });
  const result = await harness.run();
  assert.equal(harness.state.calls.length, 3);
  assert.equal(result.outputs.find((out) => out.name === 'deck.pptx').valid, false);
  assert.equal(result.outputs.find((out) => out.name === 'notes.txt').valid, true);
  assert.match(result.finalText, /Los demás archivos válidos se conservan/);
  assert.deepEqual(harness.state.events.find((event) => event.type === 'outputs'), { type: 'outputs', count: 1, names: ['notes.txt'], label: 'Incompleto' });
});


test('create_presentation uses the same gate on its real themed-deck output', async () => {
  const { makeToolExecutors } = require('../src/services/agent-runner/tools');
  const outputs = [];
  const executors = makeToolExecutors({
    writeFile: async (name, buffer) => outputs.push({ name: name.replace(/^outputs\//, ''), buffer }),
  });
  const response = JSON.parse(await executors.create_presentation({
    title: 'Resultados', filename: 'resultados.pptx',
    outline: [
      { title: 'Resultados', bullets: ['Resumen del trabajo'] },
      { title: 'Objetivo', bullets: ['Evaluar la intervención', 'Comunicar la evidencia'] },
      { title: 'Próximos pasos', bullets: ['Validar resultados', 'Implementar mejoras'] },
    ],
  }));
  assert.equal(response.ok, true);
  const [output] = await collect(outputs);
  assert.equal(output.valid, true, JSON.stringify(output.validation));
  assert.equal(output.validation.pptxDesignAudit.coverage.slides, response.slides);
  assert.ok(response.theme, 'the themed builder produced the tested file');
});


async function surgicalFixture() {
  const good = await makeDeck({ count: 2 });
  const bad = new PizZip(await makeDeck({ bad: true, count: 2 }));
  bad.file('ppt/slides/slide2.xml', new PizZip(good).file('ppt/slides/slide2.xml').asNodeBuffer());
  const source = bad.generate({ type: 'nodebuffer' });
  const edit = { kind: 'set_slide_title', slideNumber: 2, title: 'Título final' };
  const { setSlideTitle } = require('../src/services/document-editing/pptx-adapter');
  const output = setSlideTitle({ buffer: source, ...edit }).buffer;
  return { source, output, edit };
}

test('a title edit preserves proven pre-existing defects on another unchanged slide as warnings', async () => {
  const { source, output } = await surgicalFixture();
  const [out] = await collect([{ name: 'deck.pptx', buffer: output }], [], {
    isEdit: true,
    instruction: 'En la diapositiva 2 cambia el título a "Título final" y conserva el diseño',
    files: [{ name: 'deck.pptx', buffer: source }],
  });
  assert.equal(out.valid, true, JSON.stringify(out.validation));
  assert.equal(out.validation.scope, 'requested_slide_title_and_unchanged_other_parts');
  const audit = out.validation.pptxDesignAudit;
  assert.equal(audit.passed, true);
  assert.deepEqual(audit.preservation.unchangedSlides, [1]);
  assert.ok(audit.issues.length >= 2);
  assert.ok(audit.issues.every((issue) => issue.inherited && issue.severity === 'warning' && issue.originalSeverity === 'error'));
  assert.equal(audit.coverage.rendered, false);
});

test('an existing defect on the edited slide is never exempted', async () => {
  const { source } = await surgicalFixture();
  const edit = { kind: 'set_slide_title', slideNumber: 1, title: 'Título final' };
  const { setSlideTitle } = require('../src/services/document-editing/pptx-adapter');
  const output = setSlideTitle({ buffer: source, ...edit }).buffer;
  const [out] = await collect([{ name: 'deck.pptx', buffer: output }], [], {
    isEdit: true,
    instruction: 'En la diapositiva 1 cambia el título a "Título final" y conserva el diseño',
    files: [{ name: 'deck.pptx', buffer: source }],
  });
  assert.equal(out.valid, false);
  assert.equal(out.validation.reason, 'pptx_design_failed');
  assert.ok(out.validation.pptxDesignAudit.issues.some((issue) => issue.severity === 'error' && issue.slide === 1));
  assert.equal(out.validation.pptxDesignAudit.preservation, undefined);
});

test('new or worsened defects cannot claim preservation of the source', async () => {
  const { preserveUnchangedPptxSourceIssues } = require('../src/services/document-pipeline/pptx-design-preservation');
  const { auditPptxDesign } = require('../src/services/document-pipeline/pptx-design-audit');
  const { source, output, edit } = await surgicalFixture();
  for (const slideNumber of [1, 2]) {
    const zip = new PizZip(output);
    const part = `ppt/slides/slide${slideNumber}.xml`;
    const xml = zip.file(part).asText();
    zip.file(part, xml.replace(/sz="\d+"/g, 'sz="100"'));
    const changed = zip.generate({ type: 'nodebuffer' });
    const audit = preserveUnchangedPptxSourceIssues({
      sourceBuffer: source, outputBuffer: changed, edit, audit: auditPptxDesign(changed),
    });
    assert.equal(audit.passed, false);
    assert.equal(audit.preservation, undefined);
    assert.ok(audit.issues.some((issue) => issue.severity === 'error' && issue.slide === slideNumber));
  }
});

test('changes in shared styles or slide dimensions invalidate any source-defect exemption', async () => {
  const { preserveUnchangedPptxSourceIssues } = require('../src/services/document-pipeline/pptx-design-preservation');
  const { auditPptxDesign } = require('../src/services/document-pipeline/pptx-design-audit');
  const { source, output, edit } = await surgicalFixture();
  for (const part of ['ppt/theme/theme1.xml', 'ppt/presentation.xml']) {
    const zip = new PizZip(output);
    const xml = zip.file(part).asText();
    zip.file(part, part.includes('theme')
      ? xml.replace(/typeface="[^"]*"/, 'typeface="Changed font"')
      : xml.replace(/(<p:sldSz[^>]*cx=")\d+/, '$19000000'));
    const changed = zip.generate({ type: 'nodebuffer' });
    const audit = preserveUnchangedPptxSourceIssues({
      sourceBuffer: source, outputBuffer: changed, edit, audit: auditPptxDesign(changed),
    });
    assert.equal(audit.passed, false, part);
    assert.equal(audit.preservation, undefined, part);
  }
});

test('generation and redesign retain the strict gate even with a defective source attached', async () => {
  const { source, output } = await surgicalFixture();
  for (const context of [
    { isEdit: false, instruction: 'Crea una presentación nueva' },
    { isEdit: true, instruction: 'Rediseña toda la presentación con un diseño profesional' },
  ]) {
    const [out] = await collect([{ name: 'deck.pptx', buffer: output }], [], {
      ...context, files: [{ name: 'deck.pptx', buffer: source }],
    });
    assert.equal(out.valid, false);
    assert.equal(out.validation.reason, 'pptx_design_failed');
    assert.equal(out.validation.pptxDesignAudit.preservation, undefined);
  }
});
