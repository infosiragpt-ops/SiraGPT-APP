'use strict';

/**
 * One engine for every way users ask for a deck, and deck-aware follow-ups:
 *   - «haz / genérame / elabora / prepara / necesito / quiero una presentación»
 *     claim the AgentRunner like «crea / hazme» always did (the same request
 *     used to land on two different generators with two different designs);
 *   - definite-article wishes («quiero la presentación en azul») and chat
 *     stay out of the create claim;
 *   - whole-deck color follow-ups on a SiraGPT deck are classified apart from
 *     element / single-slide recolors;
 *   - the runner prompt carries the deck design rules and the add_slide tool;
 *   - (python-pptx + LibreOffice) «ahora en azul» on a deck this platform
 *     created restyles the whole design deterministically, and «agrega una
 *     lámina de gracias» appends the themed closing slide.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const PizZip = require('pizzip');

const agentRunner = require('../src/services/agent-runner');
const { buildAgentRunnerPrompt } = require('../src/services/agent-runner/prompt');
const tools = require('../src/services/agent-runner/tools');

const CREATE_PHRASES = [
  'haz una presentación sobre ventas',
  'genérame una ppt de marketing digital',
  'generame una presentacion de la empresa',
  'elabora una presentación sobre el cambio climático',
  'prepara una presentación ejecutiva para el directorio',
  'hazme 10 diapositivas sobre nutrición',
  'quiero 10 diapositivas sobre nutrición',
  'necesito una presentación sobre ventas para mañana',
  'quiero que me hagas una ppt del embarazo',
  'quiero una nueva presentación para el directorio',
  'crea una ppt del embarazo de color rosado',
  'hazme una presentación en powerpoint sobre ventas',
  'build a deck about our 2027 roadmap',
];

// Word / Excel / PDF keep the original claim («crea / genera / hazme + noun»);
// «prepara» alone never claims them: the multi-artifact SAV+Excel and Word+PDF
// turns belong to the agentic loop (agentic-chat-stream tests pin it).
const NOT_CREATE = [
  'quiero la presentación en azul',
  'necesito el word corregido para hoy',
  'prepara un word con el plan de trabajo',
  'Prepara el informe en Word y PDF',
  'Prepara un documento SPSS y un Excel con datos sintéticos',
  'prepara un documento de SPSS con una muestra de 20 de 20 preguntas y un Excel',
  'redacta un documento con las conclusiones',
  'para ya, no quiero el archivo',
  'dame un resumen del documento de SPSS y el Excel',
  'hola',
  'escríbeme un poema sobre el mar',
  '¿cuál es la capital de Francia?',
  'realiza un análisis del tema',
  'desarrolla el tema de la fotosíntesis',
];

test('create-deck phrasings claim the runner and are runner-only; chat and definite-article wishes are not creations', () => {
  for (const phrase of CREATE_PHRASES) {
    assert.equal(agentRunner.isCreateDocumentRequest(phrase), true, `create: "${phrase}"`);
    assert.equal(agentRunner.shouldRunAgentRunner({ text: phrase }), true, `claims: "${phrase}"`);
    assert.equal(agentRunner.isRunnerOnlyDocumentTurn(phrase), true, `runner-only: "${phrase}"`);
  }
  for (const phrase of NOT_CREATE) {
    assert.equal(agentRunner.isCreateDocumentRequest(phrase), false, `not a creation: "${phrase}"`);
  }
  for (const phrase of ['hola', 'escríbeme un poema sobre el mar', '¿cuál es la capital de Francia?', 'para ya, no quiero el archivo']) {
    assert.equal(agentRunner.shouldRunAgentRunner({ text: phrase, hasPriorArtifacts: true }), false, `never claims: "${phrase}"`);
  }
  assert.equal(agentRunner.shouldRunAgentRunner({ text: 'dame un resumen del documento de SPSS y el Excel' }), false);
  assert.equal(agentRunner.shouldRunAgentRunner({ text: 'investiga y prepara un paquete con un SAV y un Excel de una muestra de 20 con 20 preguntas' }), false);
  assert.equal(agentRunner.shouldRunAgentRunner({ text: 'Prepara un documento SPSS y un Excel con datos sintéticos' }), false);
});

test('isDeckColorRestyleRequest: whole-deck colors yes; elements, single slides and questions no', () => {
  for (const phrase of ['ahora en azul', 'ponla verde', 'cámbiala a #1E3A8A', 'ponlas todas rosadas', 'cambia las diapositivas a azul', 'hazla de color morado']) {
    assert.equal(agentRunner.isDeckColorRestyleRequest(phrase), true, phrase);
  }
  for (const phrase of ['pon el título en rojo', 'la gráfica en verde', 'la portada en azul', 'pinta la lámina 3 de azul', '¿qué color le queda mejor a la ppt?', 'hola', 'mueve la nota 2 mm a la derecha y ponla verde', 'cambia el color de tu respuesta']) {
    assert.equal(agentRunner.isDeckColorRestyleRequest(phrase), false, phrase);
  }
});

test('runner prompt and tool list carry the deck design rules and add_slide', () => {
  const prompt = buildAgentRunnerPrompt({ creatingNewFile: true });
  assert.match(prompt, /DECK DESIGN RULES/);
  assert.match(prompt, /never more than 2 consecutive bullet slides/);
  assert.match(prompt, /`notes` on EVERY slide/);
  assert.match(prompt, /designWarnings/);
  assert.match(prompt, /With an attached template/);
  // Other tests detect the redesign / template sections by these literals:
  // the always-on rules must never carry them.
  assert.equal(prompt.includes('DESIGN WORKFLOW'), false);
  assert.equal(prompt.includes('TEMPLATE WORKFLOW'), false);
  assert.match(prompt, /add_slide: add ONE designed slide/);
  const followup = buildAgentRunnerPrompt({ fileNames: ['plan.pptx'], priorArtifactNames: ['plan.pptx'] });
  assert.match(followup, /add_slide \(keeps the theme, renumbers the footer/);
  const names = tools.buildToolDefinitions({}).map((d) => d.function.name);
  assert.ok(names.includes('add_slide'), names.join(','));
  assert.ok(names.includes('create_presentation'));
  const create = tools.buildToolDefinitions({}).find((d) => d.function.name === 'create_presentation');
  assert.ok(create.function.parameters.properties.outline.items.properties.steps, 'outline schema exposes steps');
  assert.ok(create.function.parameters.properties.outline.items.properties.notes, 'outline schema exposes notes');
  assert.match(create.function.description, /designWarnings/);
});

// ── Runner wiring (real local sandbox) ───────────────────────────────────

const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
const HAS_OFFICE_PY = spawnSync('python3', ['-c', 'import pptx, lxml, PIL'], { stdio: 'ignore' }).status === 0;
const CAN_VERIFY = HAS_OFFICE_PY && has('soffice') && has('pdftoppm');
const SKIP_WIRING = !CAN_VERIFY && 'LibreOffice + poppler + python-pptx/lxml/Pillow requeridos';

async function siraDeck() {
  const files = new Map();
  const sandbox = {
    async exec() { return { stdout: '', stderr: '', exitCode: 0 }; },
    async readFile(p) { return files.get(p); },
    async writeFile(p, c) { files.set(p, Buffer.isBuffer(c) ? c : Buffer.from(String(c))); },
    async listFiles() { return []; },
  };
  const raw = await tools.makeToolExecutors(sandbox, { office: { enabled: false } }).create_presentation({
    topic: 'gestión administrativa', title: 'Gestión administrativa y sostenibilidad', filename: 'gestion.pptx',
    outline: [
      { title: 'Gestión administrativa', bullets: ['Planificación con metas medibles', 'Organización de procesos', 'Control con indicadores'] },
      { title: 'Indicadores clave', bullets: ['35% reducción de consumo', '98% cumplimiento normativo'] },
      { title: 'Gracias', bullets: [] },
    ],
  });
  assert.ok(!String(raw).startsWith('ERROR:'), raw);
  return files.get('outputs/gestion.pptx');
}

function capturingClient(script = []) {
  const calls = [];
  let i = 0;
  return {
    calls,
    chat: {
      completions: {
        create: async (req) => {
          calls.push(JSON.parse(JSON.stringify(req.messages || [])));
          const turn = i < script.length ? script[i] : { content: 'No produje archivo.' };
          i += 1;
          return { choices: [{ message: { content: turn.content } }] };
        },
      },
    },
  };
}

function slideXmls(buffer) {
  const zip = new PizZip(buffer);
  return Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]))
    .map((n) => zip.file(n).asText());
}

test('runAgentRunner: «ahora en azul» on a SiraGPT deck restyles the whole design with the color locked (no LLM call)', { skip: SKIP_WIRING, timeout: 600_000 }, async () => {
  const buffer = await siraDeck();
  const client = capturingClient([]);
  const result = await agentRunner.runAgentRunner({
    files: [{ name: 'gestion.pptx', buffer, isPriorArtifact: true }],
    instruction: 'ahora en azul',
    client,
    model: 'test',
    driver: 'local',
    maxIterations: 2,
  });
  assert.equal(result.stoppedReason, 'fast_path', `stopped: ${result.stoppedReason} — ${result.finalText}`);
  assert.equal(client.calls.length, 0, 'deterministic: the LLM is never called');
  const out = (result.outputs || []).find((o) => o.valid !== false && o.name === 'gestion-v2.pptx');
  assert.ok(out, `delivered gestion-v2.pptx (outputs: ${(result.outputs || []).map((o) => o.name)})`);
  const slides = slideXmls(out.buffer);
  assert.equal(slides.length, 4, 'same slide count');
  for (const xml of slides) assert.ok(xml.includes('1E3A8A'), 'every slide carries the requested blue');
  assert.ok(slides.join('\n').includes('Planificación con metas medibles'), 'content preserved');
  assert.ok(/SiraDeco\[user-color:1E3A8A\]/.test(slides.join('\n')), 'the deck now records the color-locked theme');
});

test('runAgentRunner: «agrega una lámina de gracias» on a SiraGPT deck appends the themed closing slide', { skip: SKIP_WIRING, timeout: 600_000 }, async () => {
  const buffer = await siraDeck();
  const client = capturingClient([]);
  const result = await agentRunner.runAgentRunner({
    files: [{ name: 'gestion.pptx', buffer, isPriorArtifact: true }],
    instruction: 'agrega una lámina de gracias al final',
    client,
    model: 'test',
    driver: 'local',
    maxIterations: 2,
  });
  assert.equal(result.stoppedReason, 'fast_path', `stopped: ${result.stoppedReason} — ${result.finalText}`);
  const out = (result.outputs || []).find((o) => o.valid !== false && o.name === 'gestion-v2.pptx');
  assert.ok(out, `delivered gestion-v2.pptx (outputs: ${(result.outputs || []).map((o) => o.name)})`);
  const slides = slideXmls(out.buffer);
  assert.equal(slides.length, 5);
  const last = slides[slides.length - 1];
  assert.ok(last.includes('Gracias') && last.includes('SiraDeco[aurora]'), 'closing slide in the deck theme');
  assert.ok(last.includes('05 / 05'), 'footer renumbered');
});
