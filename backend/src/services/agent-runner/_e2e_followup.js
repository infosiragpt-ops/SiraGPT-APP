'use strict';
const assert = require('assert');
const { runAgentRunner } = require('./index');

async function makeDeck(slides) {
  const PptxGenJS = require('pptxgenjs');
  const pres = new PptxGenJS();
  const titles = ['Ciclo del agua', 'Evaporación', 'Condensación', 'Precipitación', 'Escorrentía', 'Infiltración'];
  for (let i = 0; i < slides; i += 1) {
    const s = pres.addSlide();
    s.background = { color: 'FF69B4' };
    s.addText(titles[i] || `Slide ${i + 1}`, { x: 0.5, y: 0.4, w: 9, h: 1, fontSize: 28, color: '111111' });
  }
  return pres.write('nodebuffer');
}

(async () => {
  const original = await makeDeck(6);
  const result = await runAgentRunner({
    files: [{ name: 'ciclo_del_agua.pptx', buffer: original, isPriorArtifact: true }],
    instruction: 'Cambia el fondo a verde #22C55E y agrega una séptima diapositiva de conclusiones.',
    client: { chat: { completions: { create: async () => { throw new Error('LLM must not be needed for this fast-path'); } } } },
    model: 'test',
    driver: 'local',
    maxIterations: 2,
  });
  const out = (result.outputs || []).find((o) => o.valid !== false && /\.pptx$/i.test(o.name));
  assert.ok(out, 'produced a pptx');
  assert.match(out.name, /editado/i);
  const helpers = require('./office-helpers');
  assert.equal(helpers.countSlides(out.buffer), 7);
  assert.ok(helpers.countHexInSlideXml(out.buffer, '22C55E') > 0, 'green present');
  assert.equal(helpers.countHexInSlideXml(out.buffer, 'FF69B4'), 0, 'pink gone');
  assert.ok(helpers.listSlideTexts(out.buffer).some((t) => /conclus/i.test(t)), 'Conclusiones');
  assert.equal(result.stoppedReason, 'fast_path');
  assert.match(result.finalText, /Listo/);
  console.log('E2E PASS', { name: out.name, slides: 7, reason: result.stoppedReason, text: result.finalText });
})().catch((err) => {
  console.error('E2E FAIL', err);
  process.exit(1);
});
