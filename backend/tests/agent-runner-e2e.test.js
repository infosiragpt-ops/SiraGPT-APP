'use strict';

/**
 * End-to-end AgentRunner tests with the REAL local sandbox and a scripted
 * LLM. Phrases from production:
 *   - "crea una ppt del embarazo de color rosado la ppt"
 *   - "uniformisa el color de la ppts todas de color blanco"
 *   - "ponlas todas rosadas"
 *   - "agrega una lámina de gracias al final"
 *   - "cámbialas al hex #1E3A8A"
 *
 * XML is always inspected. PNG is inspected when LibreOffice is installed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('child_process');
const { promisify } = require('util');
const PizZip = require('pizzip');
const { runAgentRunner } = require('../src/services/agent-runner');
const { TOOL_DEFINITIONS } = require('../src/services/agent-runner/tools');

const pexec = promisify(execFile);

async function makeDeck({ slides = 2, bg } = {}) {
  const PptxGenJS = require('pptxgenjs');
  const pres = new PptxGenJS();
  for (let i = 0; i < slides; i += 1) {
    const s = pres.addSlide();
    if (bg) s.addShape(pres.shapes.RECTANGLE, {
      x: 0, y: 0, w: '100%', h: '100%', fill: { color: bg },
    });
    s.addText(i === 0 ? 'Embarazo' : `Slide ${i + 1}`, {
      x: 0.5, y: 0.4, w: 9, h: 1, fontSize: 28, color: '111111',
    });
  }
  return pres.write('nodebuffer');
}

function scriptedClient(script) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          if (i >= script.length) throw new Error('scripted client exhausted');
          const turn = script[i++];
          if (turn.toolCalls) {
            return {
              choices: [{
                message: {
                  content: null,
                  tool_calls: turn.toolCalls.map((c, idx) => ({
                    id: `call_${i}_${idx}`,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.args) },
                  })),
                },
              }],
            };
          }
          return { choices: [{ message: { content: turn.content } }] };
        },
      },
    },
  };
}

function slideXmlHasHex(buffer, hex) {
  const zip = new PizZip(buffer);
  const needle = String(hex).replace(/^#/, '').toUpperCase();
  const names = Object.keys(zip.files).filter((n) => /ppt\/slides\/slide\d+\.xml$/.test(n));
  assert.ok(names.length >= 1, 'pptx has slides');
  for (const n of names) {
    const xml = zip.file(n).asText();
    assert.ok(
      xml.toUpperCase().includes(needle),
      `${n} should contain ${needle}`,
    );
  }
  return names.length;
}

function zipHasText(buffer, text) {
  const zip = new PizZip(buffer);
  const blob = Object.keys(zip.files)
    .filter((n) => n.endsWith('.xml'))
    .map((n) => zip.file(n).asText())
    .join('\n');
  return blob.includes(text);
}

function slideCount(buffer) {
  const zip = new PizZip(buffer);
  return Object.keys(zip.files).filter((n) => /ppt\/slides\/slide\d+\.xml$/.test(n)).length;
}

async function sofficeAvailable() {
  try {
    await pexec('soffice', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    try {
      await pexec('libreoffice', ['--version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}

test('E2E: "ponlas todas rosadas" paints every slide FFC0CB (XML)', async () => {
  const original = await makeDeck({ slides: 3, bg: '111111' });
  const client = scriptedClient([
    { toolCalls: [{ name: 'set_slide_background', args: { path: 'uploads/deck.pptx', color: 'rosado' } }] },
    { toolCalls: [{ name: 'render_preview', args: { path: 'outputs/deck-editado.pptx' } }] },
    { content: 'Listo. Fondos rosados en todas las diapositivas.' },
  ]);
  const result = await runAgentRunner({
    files: [{ name: 'deck.pptx', buffer: original }],
    instruction: 'ponlas todas rosadas',
    client,
    model: 'test',
    driver: 'local',
    maxIterations: 8,
  });
  const out = (result.outputs || []).find((o) => o.valid !== false && /\.pptx$/i.test(o.name));
  assert.ok(out, 'produced a pptx');
  slideXmlHasHex(out.buffer, 'FFC0CB');
});

test('E2E: "uniformisa … blanco" paints FFFFFF', async () => {
  const original = await makeDeck({ slides: 2, bg: '1A1A2E' });
  const client = scriptedClient([
    { toolCalls: [{ name: 'set_slide_background', args: { path: 'uploads/deck.pptx', color: 'blanco' } }] },
    { content: 'Listo. Fondos blancos.' },
  ]);
  const result = await runAgentRunner({
    files: [{ name: 'deck.pptx', buffer: original }],
    instruction: 'uniformisa el color de la ppts todas de color blanco',
    client,
    model: 'test',
    driver: 'local',
    maxIterations: 6,
  });
  const out = (result.outputs || []).find((o) => o.valid !== false);
  assert.ok(out);
  slideXmlHasHex(out.buffer, 'FFFFFF');
});

test('E2E: hex #1E3A8A is written into slide XML', async () => {
  const original = await makeDeck({ slides: 2, bg: 'FFFFFF' });
  const client = scriptedClient([
    { toolCalls: [{ name: 'set_slide_background', args: { path: 'uploads/deck.pptx', color: '#1E3A8A' } }] },
    { content: 'Listo. Azul #1E3A8A.' },
  ]);
  const result = await runAgentRunner({
    files: [{ name: 'deck.pptx', buffer: original }],
    instruction: 'cámbialas al hex #1E3A8A',
    client,
    model: 'test',
    driver: 'local',
    maxIterations: 6,
  });
  const out = (result.outputs || []).find((o) => o.valid !== false);
  assert.ok(out);
  slideXmlHasHex(out.buffer, '1E3A8A');
});

test('E2E: "agrega una lámina de gracias al final" adds a Gracias slide (XML)', async () => {
  const original = await makeDeck({ slides: 2, bg: 'FFFFFF' });
  const client = scriptedClient([
    { content: 'Listo. Agregué la lámina de gracias.' },
  ]);
  const result = await runAgentRunner({
    files: [{ name: 'deck.pptx', buffer: original }],
    instruction: 'agrega una lámina de gracias al final',
    client,
    model: 'test',
    driver: 'local',
    maxIterations: 8,
  });
  const out = (result.outputs || []).find((o) => o.valid !== false && /\.pptx$/i.test(o.name));
  assert.ok(out, 'produced a pptx');
  assert.equal(slideCount(out.buffer), 3);
  assert.ok(zipHasText(out.buffer, 'Gracias'), 'final file must contain Gracias');
});

test('E2E: follow-up uses prior artifact bytes, not the original upload', async () => {
  const original = await makeDeck({ slides: 2, bg: '000000' });
  const prior = await makeDeck({ slides: 2, bg: 'FFFFFF' });
  const client = scriptedClient([
    { toolCalls: [{ name: 'set_slide_background', args: { path: 'uploads/deck-editado.pptx', color: 'rosado' } }] },
    { content: 'Listo. Ahora rosadas.' },
  ]);
  const result = await runAgentRunner({
    files: [
      { name: 'deck-editado.pptx', buffer: prior, isPriorArtifact: true },
      { name: 'original.pptx', buffer: original },
    ],
    instruction: 'ahora ponlas rosadas',
    client,
    model: 'test',
    driver: 'local',
    maxIterations: 6,
  });
  const out = (result.outputs || []).find((o) => o.valid !== false);
  assert.ok(out);
  slideXmlHasHex(out.buffer, 'FFC0CB');
});

test('E2E: "crea una ppt del embarazo de color rosado" — LLM outline drives content, FFC0CB paints every slide', async () => {
  // NO fast-path for create+color: the deck below only exists if the LLM loop
  // ran and the model passed its own outline (topic-specific slide copy).
  const client = scriptedClient([
    {
      toolCalls: [{
        name: 'create_presentation',
        args: {
          topic: 'embarazo',
          title: 'Embarazo saludable',
          color: 'rosado',
          outline: [
            { title: 'Primer trimestre', bullets: ['Controles prenatales mensuales', 'Ácido fólico diario'] },
            { title: 'Segundo trimestre', bullets: ['Ecografía morfológica (semana 20)'] },
            { title: 'Señales de alerta', bullets: ['Sangrado o dolor intenso: acudir a urgencias'] },
            { title: 'Gracias', bullets: [] },
          ],
          filename: 'embarazo-rosado.pptx',
        },
      }],
    },
    { toolCalls: [{ name: 'render_preview', args: { path: 'outputs/embarazo-rosado.pptx' } }] },
    { content: 'Listo. Presentación del embarazo en rosado: embarazo-rosado.pptx' },
  ]);
  const result = await runAgentRunner({
    files: [],
    instruction: 'crea una ppt del embarazo de color rosado la ppt',
    client,
    model: 'test',
    driver: 'local',
    maxIterations: 8,
  });
  const out = (result.outputs || []).find((o) => o.valid !== false && /\.pptx$/i.test(o.name));
  assert.ok(out, 'produced a pptx');
  assert.notEqual(result.stoppedReason, 'fast_path', 'new decks must go through the LLM loop');
  slideXmlHasHex(out.buffer, 'FFC0CB');
  assert.ok(zipHasText(out.buffer, 'Embarazo') || zipHasText(out.buffer, 'embarazo'));
  assert.ok(zipHasText(out.buffer, 'trimestre'), 'content must be pregnancy-specific, not filler');
  assert.equal(zipHasText(out.buffer, 'Puntos clave'), false, 'no boilerplate filler');
});

test('E2E: "crea una ppt … #1E3A8A" must NOT come out pink', async () => {
  const client = scriptedClient([
    {
      toolCalls: [{
        name: 'create_presentation',
        args: {
          topic: 'plan comercial',
          title: 'Plan comercial 2027',
          color: '#1E3A8A',
          outline: [{ title: 'Metas del trimestre', bullets: ['Crecer 15% en ventas'] }],
          filename: 'plan-azul.pptx',
        },
      }],
    },
    { toolCalls: [{ name: 'render_preview', args: { path: 'outputs/plan-azul.pptx' } }] },
    { content: 'Listo. Plan comercial en azul #1E3A8A.' },
  ]);
  const result = await runAgentRunner({
    files: [],
    instruction: 'crea una ppt del plan comercial de color #1E3A8A',
    client,
    model: 'test',
    driver: 'local',
    maxIterations: 8,
  });
  const out = (result.outputs || []).find((o) => o.valid !== false && /\.pptx$/i.test(o.name));
  assert.ok(out, 'produced a pptx');
  slideXmlHasHex(out.buffer, '1E3A8A');
  assert.equal(zipHasText(out.buffer, 'FFC0CB'), false, 'pink must not leak into a blue deck');
});

test('E2E: create+color with a model that produces nothing yields NO stub deck', async () => {
  // Before Phase 1 the color fast-path fabricated an 8-slide filler deck for
  // any "crea una ppt + color". Now: if the LLM does not actually create the
  // file, there is no file — an honest failure instead of a stub.
  const client = scriptedClient([
    { content: 'No pude crear la presentación.' },
    { content: 'No pude crear la presentación.' },
    { content: 'No pude crear la presentación.' },
  ]);
  const result = await runAgentRunner({
    files: [],
    instruction: 'crea una ppt del embarazo de color rosado la ppt',
    client,
    model: 'test',
    driver: 'local',
    maxIterations: 4,
  });
  const valid = (result.outputs || []).filter((o) => o.valid !== false);
  assert.equal(valid.length, 0, 'no stub deck may be fabricated');
  assert.notEqual(result.stoppedReason, 'fast_path');
});

test('E2E PNG brightness is high after painting white (when soffice exists)', async () => {
  if (!(await sofficeAvailable())) return;
  const original = await makeDeck({ slides: 1, bg: '101010' });
  const client = scriptedClient([
    { toolCalls: [{ name: 'set_slide_background', args: { path: 'uploads/deck.pptx', color: 'blanco' } }] },
    { toolCalls: [{ name: 'render_preview', args: { path: 'outputs/deck-editado.pptx' } }] },
    { content: 'Listo.' },
  ]);
  const events = [];
  const result = await runAgentRunner({
    files: [{ name: 'deck.pptx', buffer: original }],
    instruction: 'uniformisa el color de la ppts todas de color blanco',
    client,
    model: 'test',
    driver: 'local',
    maxIterations: 8,
    onEvent: (ev) => events.push(ev),
  });
  assert.ok(result.outputs.some((o) => o.valid !== false));
  const preview = events.filter((e) => e.tool === 'render_preview' && e.type === 'tool_result');
  assert.ok(preview.length >= 1);
  const blob = preview.map((e) => String(e.preview || '')).join('\n');
  const brightness = blob.match(/"mean_brightness"\s*:\s*([0-9.]+)/);
  assert.ok(brightness, 'installed renderer must produce a measured PNG, not an unverified preview');
  assert.ok(Number(brightness[1]) > 180, `white slide should be bright, got ${brightness[1]}`);
});

void TOOL_DEFINITIONS;
