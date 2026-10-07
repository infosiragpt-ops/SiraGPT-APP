'use strict';

/**
 * Follow-up edits of an existing Office document (incident 2026-09-28).
 *
 * Turn 1 generated gestion-administrativa-sostenibilidad.pptx. Turn 2 —
 * «en la misma ppt ## gestion-administrativa-sostenibilidad.pptx puede
 * agregarle un poco mas de diseño» — never reached the AgentRunner (WORK_RE
 * missed «agregarle» / «diseño») and the chat loop answered with an .html
 * preview and a «generar_pptxpy.py» script instead of the deck.
 *
 * Pins:
 *   - the runner gate claims design upgrades and clitic edit follow-ups when
 *     the chat holds a document (and never ordinary chat);
 *   - a design upgrade is runner-only (honest error, never substitutes);
 *   - the runner prompt switches to the DESIGN WORKFLOW with theme tokens;
 *   - the design tokens keep the requested color's hue;
 *   - first-generation decks (create_presentation) use the design system;
 *   - sira_design.py restyles pptx / docx / xlsx keeping every text, value
 *     and slide (runs when python-pptx / python-docx / openpyxl exist);
 *   - end to end: restyle + verify_visual deliver <stem>-v2.pptx (runs when
 *     LibreOffice + poppler + the office engine's python libs exist).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const PizZip = require('pizzip');

const agentRunner = require('../src/services/agent-runner');
const { buildAgentRunnerPrompt } = require('../src/services/agent-runner/prompt');
const designTheme = require('../src/services/agent-runner/design-theme');
const { makeToolExecutors } = require('../src/services/agent-runner/tools');

const INCIDENT = 'en la misma ppt ## gestion-administrativa-sostenibilidad.pptx puede agregarle un poco mas de diseño';

// [prompt, format of the chat's latest artifact]
const DESIGN_FOLLOWUPS = [
  [INCIDENT, 'pptx'],
  ['agrégale más diseño a la ppt', 'pptx'],
  ['mejora el diseño de la presentación', 'pptx'],
  ['mejóralo con más diseño', 'pptx'],
  ['hazla más profesional', 'pptx'],
  ['dale más diseño', 'pptx'],
  ['rediseña la ppt', 'pptx'],
  ['embellece la presentación', 'pptx'],
  ['que se vea más profesional la presentación', 'pptx'],
  ['mejora el formato del excel', 'xlsx'],
  ['hazlo más bonito y profesional el word', 'docx'],
  ['dale formato profesional al excel', 'xlsx'],
  ['ponle un diseño más moderno', 'pptx'],
  ['mejora el diseño sin cambiar el contenido', 'docx'],
  ['¿puedes agregarle más diseño a la ppt?', 'pptx'],
];

const NOT_DOCUMENT_WORK = [
  'hola',
  '¿cuál es la capital de Francia?',
  'agrégale más detalle a tu explicación',
  'explica el diseño metodológico del word',
  'qué es el diseño gráfico',
  'cuál es mejor, el word o el pdf',
  '¿qué dice la ppt?',
  'reescribe este correo y hazlo más profesional',
];

// ── Gate ─────────────────────────────────────────────────────────────────

test('gate: every design follow-up claims the runner when the chat\'s latest artifact is an Office file', () => {
  for (const [text, format] of DESIGN_FOLLOWUPS) {
    assert.equal(agentRunner.isDesignUpgradeRequest(text, { officeTarget: format }), true, `design upgrade: ${text}`);
    assert.equal(agentRunner.shouldRunAgentRunner({ hasPriorArtifacts: true, priorArtifactFormat: format, text }), true, `claim: ${text}`);
    assert.equal(agentRunner.isRunnerOnlyDocumentTurn(text, { priorArtifactFormat: format }), true, `runner-only: ${text}`);
  }
});

test('gate: callers that only know «the chat has an artifact» still claim a redesign that names its file', () => {
  for (const text of [INCIDENT, 'agrégale más diseño a la ppt', 'rediseña la ppt', 'mejora el formato del excel', 'dale formato profesional al excel']) {
    assert.equal(agentRunner.shouldRunAgentRunner({ hasPriorArtifacts: true, text }), true, text);
  }
  // No file named and no format known: nothing proves an Office target.
  assert.equal(agentRunner.shouldRunAgentRunner({ hasPriorArtifacts: true, text: 'hazla más profesional' }), false);
});

test('gate: clitic edit follow-ups aimed at a document also claim it', () => {
  for (const text of [
    'agrégale una diapositiva de conclusiones a la ppt',
    'quítale la lámina 3 a la misma ppt',
    'añádele una tabla de costos al word',
    'insértale una hoja de resumen al excel',
  ]) {
    assert.equal(agentRunner.isFollowupDocumentEdit(text), true, text);
    assert.equal(agentRunner.shouldRunAgentRunner({ hasPriorArtifacts: true, text }), true, text);
  }
  assert.equal(agentRunner.isFollowupDocumentEdit('agrégale más detalle a tu explicación'), false);
});

test('gate: questions, advice and edits of the chat reply are never file edits', () => {
  for (const text of [
    '¿qué le agregarías al informe?',
    '¿qué debería quitar de la presentación?',
    '¿crees que debo agregar más diapositivas?',
    'revisa el documento y dime qué corregir',
    'quita lo del documento de tu explicación',
    'el documento dice que hay que agregar más, ¿qué opinas?',
    // «libro» alone is a book, not a workbook.
    'actualiza la información del libro',
  ]) {
    assert.equal(agentRunner.isFollowupDocumentEdit(text), false, text);
  }
  for (const text of [
    '¿cómo puedo mejorar el diseño de mi presentación?',
    'dame consejos para mejorar el diseño de mis diapositivas',
  ]) {
    assert.equal(agentRunner.isDesignUpgradeRequest(text, { officeTarget: 'pptx' }), false, text);
    assert.equal(agentRunner.shouldRunAgentRunner({ hasPriorArtifacts: true, priorArtifactFormat: 'pptx', text }), false, text);
  }
  assert.equal(agentRunner.isFollowupDocumentEdit('actualiza el libro de excel con los datos de marzo'), true);
});

test('gate: ordinary chat never enters the runner, even with a prior document', () => {
  for (const text of NOT_DOCUMENT_WORK) {
    assert.equal(agentRunner.shouldRunAgentRunner({ hasPriorArtifacts: true, priorArtifactFormat: 'pptx', text }), false, `no claim: ${text}`);
    assert.equal(agentRunner.shouldRunAgentRunner({ text }), false, `no claim without prior: ${text}`);
  }
});

test('gate: without a prior artifact or an upload there is nothing to redesign', () => {
  for (const [text] of DESIGN_FOLLOWUPS) {
    assert.equal(agentRunner.shouldRunAgentRunner({ hasPriorArtifacts: false, text }), false, text);
  }
  // An uploaded deck is enough — even for tone-only phrasing.
  assert.equal(agentRunner.shouldRunAgentRunner({ files: [{ name: 'deck.pptx' }], text: 'hazlo más profesional' }), true);
  // An upload of unknown type needs a visual word (a Word file + «más
  // profesional» asks for better writing, not a redesign).
  assert.equal(agentRunner.shouldRunAgentRunner({ fileIds: ['f1'], text: 'mejora el diseño' }), true);
  assert.equal(agentRunner.shouldRunAgentRunner({ fileIds: ['f1'], text: 'hazlo más profesional' }), false);
  // An attached picture is not a document to redesign.
  assert.equal(agentRunner.shouldRunAgentRunner({
    files: [{ name: 'foto.png', mimeType: 'image/png' }],
    text: 'hazlo más profesional',
  }), false);
});

test('gate: a prior html page, script or image is not an Office target (the chat loop edits it)', () => {
  for (const text of [
    'reescribe esta carta y hazla más profesional',
    'mejora el estilo de redacción',
    'hazlo más visual con ejemplos',
    'hazla más bonita',
    'la introducción, hazla más elegante',
    'mejora la estética del poema',
    'hazlo con más estilo',
  ]) {
    for (const format of ['html', 'png', 'py', 'csv']) {
      assert.equal(agentRunner.shouldRunAgentRunner({ hasPriorArtifacts: true, priorArtifactFormat: format, text }), false, `${format}: ${text}`);
      assert.equal(agentRunner.isRunnerOnlyDocumentTurn(text, { priorArtifactFormat: format }), false, `${format}: ${text}`);
    }
  }
});

test('gate: recall — tone and «looks» phrasings on a generated deck are design turns', () => {
  for (const text of [
    'hazlo más profesional',
    'hazlo más bonito',
    'mejora la presentación',
    'mejora la ppt',
    'mejora las diapositivas',
    'haz que se vea mejor',
  ]) {
    assert.equal(agentRunner.shouldRunAgentRunner({ hasPriorArtifacts: true, priorArtifactFormat: 'pptx', text }), true, text);
    assert.equal(agentRunner.isRunnerOnlyDocumentTurn(text, { priorArtifactFormat: 'pptx' }), true, text);
  }
  // A Word document + a tone word asks for better WRITING (professional_edit).
  assert.equal(agentRunner.isDesignUpgradeRequest('hazlo más profesional', { officeTarget: 'docx' }), false);
});

test('design class: content changes are never a redesign (the design workflow freezes the text)', () => {
  for (const text of [
    'Edita profesionalmente este documento, mejora el contenido y hazlo más interesante.',
    'mejora mi tesis de forma profesional',
    'mejora la redacción del documento y hazlo más profesional',
    'mejora el estilo de redacción del documento',
    'traduce el documento y hazlo más profesional',
    'corrige y mejora el estilo del documento',
    'traduce el documento al inglés y dale un formato profesional',
    'resume la ppt y hazla más bonita',
    'reescribe el word y hazlo más profesional',
  ]) {
    for (const format of ['docx', 'pptx', null]) {
      assert.equal(agentRunner.isDesignUpgradeRequest(text, { officeTarget: format }), false, `${format}: ${text}`);
    }
    assert.equal(agentRunner.isRunnerOnlyDocumentTurn(text, { priorArtifactFormat: 'docx' }), false, text);
  }
});

test('design class: adding slides / charts / images is structural, not a redesign', () => {
  for (const text of [
    'agrega una lámina con gráficos sobre ventas',
    'agrega una diapositiva con imágenes',
    'agrega gráficos a la ppt con los datos de ventas',
    'agrégale imágenes a la ppt',
    'agrega una lámina de conclusiones y mejora el diseño',
    'add a slide with charts to the deck',
  ]) {
    assert.equal(agentRunner.isDesignUpgradeRequest(text, { officeTarget: 'pptx' }), false, text);
  }
  // A counted unit far from the verb is context, not the object.
  assert.equal(agentRunner.isDesignUpgradeRequest('agrégale más diseño a la ppt que tiene 5 láminas'), true);
});

test('design class: precise targets and number formats stay surgical edits', () => {
  for (const text of [
    'dale formato de moneda a la columna C',
    'dale formato condicional a la columna ventas',
    'mejora el formato de la tabla 2 del word',
    'ponle colores a la tabla del excel',
    'cambia el estilo del título 3',
    'pon la ppt en formato pdf',
  ]) {
    assert.equal(agentRunner.isDesignUpgradeRequest(text, { officeTarget: 'xlsx' }), false, text);
  }
});

test('design class: academic documents go to the template transform, never a corporate restyle', () => {
  for (const text of ['mejora el formato de mi tesis', 'ponle formato de tesis', 'dale formato de tesis al word', 'mejora el diseño de mi monografía']) {
    assert.equal(agentRunner.isDesignUpgradeRequest(text, { officeTarget: 'docx' }), false, text);
  }
});

test('gate: English phrasings of a redesign claim it too; questions about design do not', () => {
  for (const text of ['improve the design of the ppt', 'make the deck look more professional', 'redesign the presentation', 'give it more style']) {
    assert.equal(agentRunner.shouldRunAgentRunner({ hasPriorArtifacts: true, priorArtifactFormat: 'pptx', text }), true, text);
  }
  for (const text of ['what is design thinking?', 'explain the design of the study in the word']) {
    assert.equal(agentRunner.shouldRunAgentRunner({ hasPriorArtifacts: true, priorArtifactFormat: 'pptx', text }), false, text);
  }
});

test('gate: citation styles / institutional templates stay with the template transform', () => {
  for (const text of ['dale formato APA al word', 'aplica la plantilla UPN al word', 'pásalo al formato de la universidad con normas APA']) {
    assert.equal(agentRunner.isDesignUpgradeRequest(text), false, text);
  }
});

test('runner-only: a design upgrade of a named or prior Office document ends in an honest error, never the loop', () => {
  assert.equal(agentRunner.isRunnerOnlyDocumentTurn('mejora el diseño de la ppt'), true);
  assert.equal(agentRunner.isRunnerOnlyDocumentTurn(INCIDENT), true);
  assert.equal(agentRunner.isRunnerOnlyDocumentTurn('hazla más profesional', { priorArtifactFormat: 'pptx' }), true);
  assert.equal(agentRunner.isRunnerOnlyDocumentTurn('hazla más profesional'), false, 'no document named, no prior');
  // Existing contract untouched: plain edits keep the surgical loop.
  assert.equal(agentRunner.isRunnerOnlyDocumentTurn('cambia el título de la lámina 2 a Resultados', { priorArtifactFormat: 'pptx' }), false);
  assert.equal(agentRunner.isRunnerOnlyDocumentTurn('crea una ppt del embarazo de color celeste'), true);
});

// ── Prompt ───────────────────────────────────────────────────────────────

test('prompt: designUpgrade swaps the surgical rules for the DESIGN WORKFLOW (with theme tokens)', () => {
  const theme = designTheme.resolveDesignTheme({ prompt: INCIDENT });
  const design = buildAgentRunnerPrompt({
    priorArtifactNames: ['deck.pptx'], officeEngine: true, designUpgrade: true, designTheme: theme,
  });
  assert.match(design, /DESIGN WORKFLOW/);
  assert.match(design, /THEME TOKENS/);
  assert.match(design, /sira_design/);
  assert.match(design, /-v2\./);
  assert.ok(design.includes(`"bg":"${theme.palette.bg}"`));
  assert.equal(design.includes('never "improve" what was not asked'), false);
  assert.match(design, /Preserve ALL the content/);

  const surgical = buildAgentRunnerPrompt({ priorArtifactNames: ['deck.pptx'], officeEngine: true });
  assert.equal(surgical, buildAgentRunnerPrompt({ priorArtifactNames: ['deck.pptx'], officeEngine: true, designUpgrade: false }));
  assert.match(surgical, /never "improve" what was not asked/);
  assert.equal(surgical.includes('DESIGN WORKFLOW'), false);
  // No Office source (new file) → the flag cannot switch anything on.
  const create = buildAgentRunnerPrompt({ officeEngine: true, creatingNewFile: true, designUpgrade: true });
  assert.equal(create.includes('DESIGN WORKFLOW'), false);
});

// ── Design tokens ────────────────────────────────────────────────────────

test('design-theme: a requested color is the background and the accents keep its hue', () => {
  const green = designTheme.themeFromColor('#86EFAC');
  assert.equal(green.palette.bg, '86EFAC');
  assert.equal(green.coverStyle, 'light');
  assert.notEqual(green.palette.accent, 'BE185D', 'a green deck never gets pink accents');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(green.palette.accent.slice(i, i + 2), 16));
  assert.ok(g > r && g > b, `accent stays green: ${green.palette.accent}`);
  const navy = designTheme.themeFromColor('1E3A8A');
  assert.equal(navy.coverStyle, 'dark');
  assert.equal(navy.palette.ink, 'F8FAFC');
  assert.equal(designTheme.themeFromColor('nope'), null);
});

test('design-theme: style words pick a professional theme; fonts render everywhere', () => {
  assert.equal(designTheme.resolveDesignTheme({ prompt: 'hazla más elegante y oscura' }).id, 'boardroom');
  assert.equal(designTheme.resolveDesignTheme({ prompt: 'rediseña la ppt minimalista' }).id, 'minimal');
  assert.equal(designTheme.resolveDesignTheme({ prompt: INCIDENT }).id, 'aurora');
  assert.equal(designTheme.resolveDesignTheme({ prompt: 'x', colorHex: 'F97316' }).id, 'user-color:F97316');
  assert.deepEqual(designTheme.resolveDesignTheme({ prompt: INCIDENT }).fonts, { display: 'Arial', body: 'Arial' });
  assert.equal(agentRunner.designThemeForTask('rediseña la ppt en naranja').palette.bg, 'F97316');
});

test('design-theme: every requested color gives readable text (WCAG contrast floors)', () => {
  const { NAMED_COLORS } = require('../src/services/agent-runner/tools');
  const c = designTheme.contrastRatio;
  const colors = [...new Set(Object.values(NAMED_COLORS)), 'FF69B4', '00FF00', 'FF7F50', '808080', 'FFFF00'];
  for (const hex of colors) {
    const { palette: p } = designTheme.themeFromColor(hex);
    assert.ok(c(p.ink, p.bg) >= 4.5, `${hex} ink on bg ${c(p.ink, p.bg).toFixed(2)}`);
    assert.ok(c(p.body, p.surface) >= 4.5, `${hex} body on card ${c(p.body, p.surface).toFixed(2)}`);
    assert.ok(c(p.body, p.bg) >= 4.5, `${hex} body on bg ${c(p.body, p.bg).toFixed(2)}`);
    assert.ok(c(p.muted, p.bg) >= 4.5, `${hex} footer on bg ${c(p.muted, p.bg).toFixed(2)}`);
    assert.ok(c(p.accent, p.surface) >= 3, `${hex} KPI value on card ${c(p.accent, p.surface).toFixed(2)}`);
    assert.ok(c(p.accent, p.bg) >= 3, `${hex} eyebrow on bg ${c(p.accent, p.bg).toFixed(2)}`);
    assert.ok(c(p.sectionInk, p.sectionBg) >= 4.5, `${hex} divider title ${c(p.sectionInk, p.sectionBg).toFixed(2)}`);
    assert.ok(c(designTheme.textOn(p.accent), p.accent) >= 3, `${hex} chip number`);
  }
  // Coral used to get near-white ink at 2.4:1.
  assert.equal(designTheme.themeFromColor('FF7F50').palette.ink, '111827');
  assert.equal(designTheme.themeFromColor('FF7F50').colorLocked, true);
});

test('deck-builder: KPI tiles only for real metrics — numbered outlines and counts stay text', () => {
  const { kpiParts } = require('../src/services/agent-runner/deck-builder');
  for (const text of ['1. Planificación', '2) Organización', '5 estrategias para crecer', '2025 año clave', '35%: reducción de consumo']) {
    assert.equal(kpiParts(text), null, text);
  }
  assert.deepEqual(kpiParts('35% reducción de consumo'), { value: '35%', label: 'reducción de consumo' });
  assert.deepEqual(kpiParts('$2,4 M en ahorro anual'), { value: '$2,4 M', label: 'en ahorro anual' });
  assert.deepEqual(kpiParts('1.250 proveedores activos'), { value: '1.250', label: 'proveedores activos' });
});

// ── First-generation decks ───────────────────────────────────────────────

async function createDeck(args) {
  const files = new Map();
  const sandbox = {
    async exec() { return { stdout: '', stderr: '', exitCode: 0 }; },
    async readFile(p) { return files.get(p); },
    async writeFile(p, c) { files.set(p, Buffer.isBuffer(c) ? c : Buffer.from(String(c))); },
    async listFiles() { return []; },
  };
  const result = JSON.parse(await makeToolExecutors(sandbox, { office: { enabled: false } }).create_presentation(args));
  const out = [...files.keys()].find((k) => k.startsWith('outputs/'));
  return { result, zip: new PizZip(files.get(out)) };
}

function slideXml(zip) {
  return Object.keys(zip.files)
    .filter((n) => /ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]))
    .map((n) => zip.file(n).asText());
}

const OUTLINE = [
  { title: 'Gestión administrativa', bullets: ['Planificación estratégica con metas medibles', 'Organización de procesos', 'Control con indicadores'] },
  { title: 'Indicadores clave', bullets: ['35% reducción de consumo energético', '12 proveedores certificados', '98% cumplimiento normativo'] },
  { title: 'Gracias', bullets: [] },
];

test('create_presentation: first-generation decks use the design system (cover, cards, KPI, footer)', async () => {
  const { result, zip } = await createDeck({
    topic: 'gestión administrativa', title: 'Gestión administrativa y sostenibilidad', outline: OUTLINE, filename: 'gestion.pptx',
  });
  assert.equal(result.ok, true);
  assert.equal(result.theme, 'aurora');
  assert.equal(result.color, '#F8FAFC');
  assert.equal(result.slides, 4);
  const slides = slideXml(zip);
  assert.equal(slides.length, 4);
  const all = slides.join('\n');
  // «12 proveedores certificados» is a count, not a metric: its card keeps
  // the full text; «35%» / «98%» become KPI tiles.
  for (const text of ['Gestión administrativa y sostenibilidad', 'Planificación estratégica con metas medibles', '12 proveedores certificados', 'Gracias']) {
    assert.ok(all.includes(text), `content kept: ${text}`);
  }
  assert.ok(all.includes('2563EB'), 'aurora accent');
  assert.ok(/roundRect/.test(slides[1]), 'bullets become cards');
  assert.ok(slides[2].includes('>35%<'), 'figures become KPI tiles');
  assert.ok(slides[1].includes('02 / 04'), 'footer page numbers');
  assert.equal(all.includes('FFC0CB'), false, 'never pink without a request');
  assert.equal(all.includes('Puntos clave'), false, 'no filler text');
});

test('create_presentation: a numbered agenda is cards, never KPI tiles with «1.» as the figure', async () => {
  const { zip } = await createDeck({
    topic: 'plan', title: 'Plan', filename: 'agenda.pptx',
    outline: [{ title: 'Agenda', bullets: ['1. Planificación', '2. Organización', '3. Dirección', '4. Control'] }],
  });
  const agenda = slideXml(zip)[1];
  assert.equal(/SiraKpi/.test(agenda), false, 'no KPI tiles');
  assert.ok(agenda.includes('1. Planificación'), 'the item text is intact');
});

test('create_presentation: long KPI labels fall back to cards instead of overflowing the tiles', async () => {
  const long = 'reducción del consumo energético en todas las sedes regionales durante el ejercicio fiscal completo con auditoría externa';
  const { zip } = await createDeck({
    topic: 'kpi', title: 'Resultados', filename: 'kpi.pptx',
    outline: [{ title: 'Resultados', bullets: [`35% ${long}`, `42% ${long}`, `18% ${long}`, `27% ${long}`, `55% ${long}`, `61% ${long}`] }],
  });
  const xml = slideXml(zip)[1];
  assert.equal(/SiraKpi/.test(xml), false, 'labels that cannot fit a tile are not squeezed into one');
  assert.ok(xml.includes(`35% ${long}`), 'every item keeps its full text');
});

test('create_presentation: a requested color stays the background of EVERY slide', async () => {
  const { result, zip } = await createDeck({
    topic: 'embarazo', title: 'Embarazo saludable', color: 'rosado', outline: OUTLINE, filename: 'rosado.pptx',
  });
  assert.equal(result.color, '#FFC0CB');
  assert.equal(result.defaultColor, false);
  for (const xml of slideXml(zip)) assert.ok(xml.includes('FFC0CB'), 'every slide painted with the requested color');
});

test('create_presentation: the optional theme parameter selects a named theme', async () => {
  const { result, zip } = await createDeck({
    topic: 'directorio', title: 'Informe al directorio', theme: 'boardroom', outline: OUTLINE, filename: 'board.pptx',
  });
  assert.equal(result.theme, 'boardroom');
  assert.equal(result.color, '#0B1220');
  assert.ok(slideXml(zip)[1].includes('0B1220'));
});

// ── Runner wiring (real local sandbox, scripted LLM) ─────────────────────

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
          if (turn.toolCalls) {
            return {
              choices: [{
                message: {
                  content: null,
                  tool_calls: turn.toolCalls.map((c, idx) => ({
                    id: `call_${i}_${idx}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) },
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

async function plainDeck() {
  const PptxGenJS = require('pptxgenjs');
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_WIDE';
  const titles = ['Gestión administrativa y sostenibilidad', 'Gestión administrativa', 'Indicadores clave', 'Sostenibilidad'];
  titles.forEach((title, index) => {
    const s = pres.addSlide();
    s.background = { color: 'FFFFFF' };
    s.addText(title, { x: 0.7, y: index === 0 ? 2.6 : 0.55, w: 12, h: 1.1, fontSize: index === 0 ? 40 : 26, bold: true, color: '111111' });
    if (index > 0) {
      s.addText(
        ['Planificación con metas medibles', 'Procesos y responsables', 'Indicadores mensuales'].map((text, i) => ({
          text, options: { bullet: true, breakLine: i < 2 },
        })),
        { x: 0.85, y: 1.9, w: 11.2, h: 4.6, fontSize: 18, color: '111111' },
      );
    }
  });
  return { buffer: await pres.write('nodebuffer'), titles };
}

test('runAgentRunner: a design follow-up gets the DESIGN WORKFLOW, the theme file and the restyle helper', async () => {
  const { buffer } = await plainDeck();
  const client = capturingClient([
    { toolCalls: [{ name: 'execute_bash', args: { command: 'ls /workspace/tmp && cat /workspace/tmp/sira_theme.json' } }] },
  ]);
  await agentRunner.runAgentRunner({
    files: [{ name: 'gestion-administrativa-sostenibilidad.pptx', buffer, isPriorArtifact: true }],
    instruction: INCIDENT,
    client,
    model: 'test',
    driver: 'local',
    maxIterations: 3,
  });
  assert.ok(client.calls.length >= 2, 'the LLM loop ran');
  const system = client.calls[0][0].content;
  assert.match(system, /DESIGN WORKFLOW/);
  assert.match(system, /gestion-administrativa-sostenibilidad\.pptx {2}<- LAST EDITED VERSION/);
  const toolResult = client.calls[1].map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  assert.match(toolResult, /sira_design\.py/, 'the restyle helper is installed next to office_helpers.py');
  assert.match(toolResult, /"accent"/, 'theme tokens saved for the helper');
});

test('runAgentRunner: «rediséñala con fondo azul» is a redesign, not the repaint fast path', async () => {
  const { buffer } = await plainDeck();
  const client = capturingClient([]);
  const result = await agentRunner.runAgentRunner({
    files: [{ name: 'deck.pptx', buffer }],
    instruction: 'rediséñala con fondo azul la misma ppt',
    client,
    model: 'test',
    driver: 'local',
    maxIterations: 2,
  });
  assert.notEqual(result.stoppedReason, 'fast_path');
  assert.ok(client.calls.length >= 1, 'the loop restyles the whole deck');
  assert.match(client.calls[0][0].content, /DESIGN WORKFLOW/);
  assert.match(client.calls[0][0].content, /"bg":"1E3A8A"/);
});

test('runAgentRunner: a precise edit on the same deck keeps the surgical workflow', async () => {
  const { buffer } = await plainDeck();
  const client = capturingClient([]);
  await agentRunner.runAgentRunner({
    files: [{ name: 'deck.pptx', buffer, isPriorArtifact: true }],
    instruction: 'cambia el texto «Procesos y responsables» por «Procesos clave» en la diapositiva 2',
    client,
    model: 'test',
    driver: 'local',
    maxIterations: 2,
  });
  assert.ok(client.calls.length >= 1);
  assert.equal(client.calls[0][0].content.includes('DESIGN WORKFLOW'), false);
});

test('runAgentRunner: content rewrites and structural adds keep the surgical workflow (never «CONTENT must not change»)', async () => {
  const { buffer } = await plainDeck();
  for (const instruction of [
    'mejora la redacción de la presentación y hazla más profesional',
    'traduce la ppt al inglés y dale un formato profesional',
    'agrega una lámina con gráficos sobre ventas a la misma ppt',
  ]) {
    const client = capturingClient([]);
    await agentRunner.runAgentRunner({
      files: [{ name: 'deck.pptx', buffer, isPriorArtifact: true }],
      instruction,
      client,
      model: 'test',
      driver: 'local',
      maxIterations: 1,
    });
    assert.ok(client.calls.length >= 1, instruction);
    assert.equal(client.calls[0][0].content.includes('DESIGN WORKFLOW'), false, instruction);
  }
});

// ── sira_design.py (needs python-pptx / python-docx / openpyxl) ──────────

const HELPER = path.join(__dirname, '../src/services/agent-runner/sira_design.py');
const HAS_OFFICE_PY = spawnSync('python3', ['-c', 'import pptx, docx, openpyxl'], { stdio: 'ignore' }).status === 0;
const SKIP_PY = !HAS_OFFICE_PY && 'python-pptx + python-docx + openpyxl requeridos';

function runHelper(cwd, args) {
  const r = spawnSync('python3', [HELPER, ...args], { cwd, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, `sira_design failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

function python(cwd, code) {
  const r = spawnSync('python3', ['-c', code], { cwd, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('sira_design: pptx restyle keeps every title and slide, adds the theme, versions the name', { skip: SKIP_PY }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-design-'));
  try {
    const { buffer, titles } = await plainDeck();
    fs.writeFileSync(path.join(dir, 'gestion.pptx'), buffer);
    const report = runHelper(dir, ['gestion.pptx']);
    assert.equal(report.ok, true, JSON.stringify(report.warnings));
    assert.equal(path.basename(report.output), 'gestion-v2.pptx');
    assert.equal(report.slides, 4);
    assert.equal(report.slides_after, 4);
    assert.deepEqual(report.titles_after, titles);
    assert.ok(report.changes.some((c) => c.cards === 3), 'bullets became cards');
    const zip = new PizZip(fs.readFileSync(path.join(dir, 'gestion-v2.pptx')));
    const xml = slideXml(zip).join('\n');
    assert.ok(xml.includes('2563EB'), 'theme accent applied');
    for (const text of ['Planificación con metas medibles', 'Procesos y responsables', 'Indicadores mensuales']) {
      assert.ok(xml.includes(text), `text kept: ${text}`);
    }
    // A second pass (v2 → v3) keeps the cards and the content.
    const again = runHelper(dir, ['gestion-v2.pptx']);
    assert.equal(path.basename(again.output), 'gestion-v3.pptx');
    assert.deepEqual(again.titles_after, titles);
    const v3 = slideXml(new PizZip(fs.readFileSync(path.join(dir, 'gestion-v3.pptx')))).join('\n');
    assert.ok(v3.includes('Procesos y responsables'));
    // Never overwrite the source, never change the format.
    const same = spawnSync('python3', [HELPER, 'gestion.pptx', 'gestion.pptx'], { cwd: dir, encoding: 'utf8' });
    assert.equal(same.status, 1);
    const other = spawnSync('python3', [HELPER, 'gestion.pptx', 'gestion.html'], { cwd: dir, encoding: 'utf8' });
    assert.equal(other.status, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sira_design: docx restyle keeps paragraphs and tables, styles headings, numbers pages', { skip: SKIP_PY }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-design-'));
  try {
    python(dir, `
from docx import Document
d = Document()
d.add_paragraph('Informe de gestión 2026', style='Title')
d.add_paragraph('Resumen ejecutivo', style='Heading 1')
d.add_paragraph('La empresa redujo su consumo energético.')
t = d.add_table(rows=3, cols=2)
for i, row in enumerate([['Indicador', 'Valor'], ['Energía', '35%'], ['Proveedores', '12']]):
    for j, v in enumerate(row):
        t.cell(i, j).text = v
d.save('informe.docx')
`);
    const report = runHelper(dir, ['informe.docx']);
    assert.equal(report.ok, true, JSON.stringify(report.warnings));
    assert.equal(path.basename(report.output), 'informe-v2.docx');
    assert.equal(report.paragraphs_after, report.paragraphs);
    assert.equal(report.tables_styled, 1);
    assert.equal(report.footers_numbered, 1);
    assert.deepEqual(report.titles, ['Informe de gestión 2026', 'Resumen ejecutivo']);
    const zip = new PizZip(fs.readFileSync(path.join(dir, 'informe-v2.docx')));
    const documentXml = zip.file('word/document.xml').asText();
    assert.match(documentXml, /w:fill="2563EB"/, 'table header row filled with the accent');
    assert.ok(documentXml.includes('La empresa redujo su consumo energético.'));
    assert.match(zip.file('word/styles.xml').asText(), /2563EB/, 'heading color from the theme');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sira_design: xlsx restyle keeps every value and formula, styles the header, adds a chart', { skip: SKIP_PY }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-design-'));
  try {
    python(dir, `
from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = 'Presupuesto'
ws.append(['Concepto', 'Cantidad', 'Precio unitario', 'Total'])
rows = [('Cemento', 120, 28.5), ('Arena', 40, 55.0), ('Acero', 15, 1250.75), ('Ladrillo', 3000, 0.85)]
for i, (c, q, p) in enumerate(rows, start=2):
    ws.append([c, q, p, f'=B{i}*C{i}'])
ws.append(['Total', None, None, '=SUM(D2:D5)'])
wb.save('presupuesto.xlsx')
`);
    const report = runHelper(dir, ['presupuesto.xlsx']);
    assert.equal(report.ok, true, JSON.stringify(report.warnings));
    assert.equal(report.values_preserved, true);
    assert.equal(path.basename(report.output), 'presupuesto-v2.xlsx');
    assert.equal(report.sheets[0].header_row, 1);
    assert.equal(report.sheets[0].chart, true);
    assert.equal(report.sheets[0].data_bar, 'D2:D5', 'the main measure is the Total column');
    const out = python(dir, `
from openpyxl import load_workbook
ws = load_workbook('presupuesto-v2.xlsx').active
print(ws['A1'].fill.fgColor.rgb, ws['D6'].value, ws['D2'].value, ws.freeze_panes, ws['C2'].number_format)
`).trim().split(' ');
    assert.match(out[0], /2563EB$/);
    assert.equal(out[1], '=SUM(D2:D5)');
    assert.equal(out[2], '=B2*C2');
    assert.equal(out[3], 'A2');
    assert.equal(out[4], '#,##0.00');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sira_design: a second «más diseño» on a redesigned deck switches theme instead of an identical -v3', { skip: SKIP_PY }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-design-'));
  try {
    const { buffer } = await plainDeck();
    fs.writeFileSync(path.join(dir, 'deck.pptx'), buffer);
    const first = runHelper(dir, ['deck.pptx']);
    assert.equal(first.theme, 'aurora');
    const second = runHelper(dir, ['deck-v2.pptx']);
    assert.equal(path.basename(second.output), 'deck-v3.pptx');
    assert.equal(second.theme_rotated_from, 'aurora');
    assert.notEqual(second.theme, 'aurora');
    // A first-generation SiraGPT deck (themed by create_presentation) counts too.
    const { zip } = await createDeck({ topic: 'x', title: 'Deck', outline: OUTLINE, filename: 'gen.pptx' });
    fs.writeFileSync(path.join(dir, 'gen.pptx'), zip.generate({ type: 'nodebuffer' }));
    assert.equal(runHelper(dir, ['gen.pptx']).theme_rotated_from, 'aurora');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sira_design: a requested color stays the background of EVERY restyled slide', { skip: SKIP_PY }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-design-'));
  try {
    const { buffer } = await plainDeck();
    fs.writeFileSync(path.join(dir, 'deck.pptx'), buffer);
    for (const hex of ['16A34A', 'FFC0CB']) {
      fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(designTheme.themeFromColor(hex)));
      const report = runHelper(dir, ['deck.pptx', `deck-${hex}.pptx`, 'theme.json']);
      assert.equal(report.ok, true);
      const bgs = python(dir, `
from pptx import Presentation
print(' '.join(str(s.background.fill.fore_color.rgb) for s in Presentation('deck-${hex}.pptx').slides))
`).trim().split(' ');
      assert.equal(bgs.length, 4);
      assert.deepEqual([...new Set(bgs)], [hex], `every slide painted ${hex}: ${bgs}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sira_design: charts stay readable on dark themes; layout-centred titles get a centred rule; photo overlays stay', { skip: SKIP_PY }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-design-'));
  try {
    python(dir, `
from pptx import Presentation
from pptx.util import Inches
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.dml.color import RGBColor
from pptx.oxml.ns import qn
from lxml import etree
prs = Presentation()
s = prs.slides.add_slide(prs.slide_layouts[0]); s.shapes.title.text = 'Plan'
s = prs.slides.add_slide(prs.slide_layouts[5]); s.shapes.title.text = 'Emisiones'
cd = CategoryChartData(); cd.categories = ['2023', '2024']; cd.add_series('tCO2e', (1200, 900))
g = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(2), Inches(8), Inches(4.5), cd)
g.chart.has_title = True; g.chart.chart_title.text_frame.text = 'tCO2e'
s = prs.slides.add_slide(prs.slide_layouts[5]); s.shapes.title.text = 'Foto'
o = s.shapes.add_shape(1, 0, 0, prs.slide_width, prs.slide_height)
o.fill.solid(); o.fill.fore_color.rgb = RGBColor(0, 0, 0)
a = etree.SubElement(o._element.find(qn('p:spPr')).find(qn('a:solidFill'))[0], qn('a:alpha')); a.set('val', '50000')
s.shapes.add_textbox(Inches(1), Inches(3), Inches(6), Inches(1)).text_frame.text = 'Texto sobre la foto'
prs.save('plan.pptx')
`);
    const report = runHelper(dir, ['plan.pptx', 'plan-v2.pptx', 'boardroom']);
    assert.equal(report.ok, true);
    assert.ok(report.warnings.some((w) => /kept/.test(w)), 'the overlay is reported, not deleted');
    const out = JSON.parse(python(dir, `
import json
from pptx import Presentation
p = Presentation('plan-v2.pptx')
s = p.slides[1]
chart = [sh for sh in s.shapes if getattr(sh, 'has_chart', False) and sh.has_chart][0].chart
t = s.shapes.title
rule = [sh for sh in s.shapes if sh.name.endswith('Title rule')][0]
print(json.dumps({
  'chart_font': str(chart.font.color.rgb),
  'axis': str(chart.category_axis.tick_labels.font.color.rgb),
  'rule_offset': abs((rule.left + rule.width / 2) - (t.left + t.width / 2)) / 914400,
  'title_size_forced': any(r.font.size is not None for par in t.text_frame.paragraphs for r in par.runs),
  'overlay_kept': any(sh.name == 'Rectangle 2' for sh in p.slides[2].shapes),
}))
`));
    assert.equal(out.chart_font, 'F8FAFC', 'chart text uses the dark theme ink');
    assert.notEqual(out.axis, 'None');
    assert.ok(out.rule_offset < 0.05, `rule centred under the layout-centred title (${out.rule_offset} in)`);
    assert.equal(out.title_size_forced, false, 'inherited placeholder sizes are left alone');
    assert.equal(out.overlay_kept, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sira_design: docx keeps explicit line spacing and symbol / code fonts; theses get the academic profile', { skip: SKIP_PY }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-design-'));
  try {
    python(dir, `
from docx import Document
d = Document()
d.styles['Normal'].paragraph_format.line_spacing = 1.0
d.add_paragraph('Informe', style='Title')
p = d.add_paragraph('Fórmula: ')
r = p.add_run('+'); r.font.name = 'Symbol'
r = p.add_run('print(1)'); r.font.name = 'Consolas'
r = p.add_run(' texto'); r.font.name = 'Times New Roman'
d.save('informe.docx')
t = Document()
t.styles['Normal'].paragraph_format.line_spacing = 2.0
t.styles['Normal'].font.name = 'Times New Roman'
t.add_paragraph('Tesis de grado', style='Title')
t.add_paragraph('Marco teórico', style='Heading 1')
t.add_paragraph('Referencias bibliográficas', style='Heading 1')
t.save('tesis.docx')
`);
    const report = runHelper(dir, ['informe.docx']);
    assert.equal(report.profile, 'professional');
    const out = python(dir, `
from docx import Document
d = Document('informe-v2.docx')
print(d.styles['Normal'].paragraph_format.line_spacing, '|'.join(r.font.name or '-' for r in d.paragraphs[1].runs))
`).trim().split(' ');
    assert.equal(Number(out[0]), 1, 'explicit single spacing kept');
    assert.deepEqual(out[1].split('|').slice(1), ['Symbol', 'Consolas', 'Calibri'], 'only the proportional text font changes');
    const thesis = runHelper(dir, ['tesis.docx']);
    assert.equal(thesis.profile, 'academic');
    const t = python(dir, `
from docx import Document
d = Document('tesis-v2.docx')
print(d.styles['Normal'].paragraph_format.line_spacing, d.styles['Normal'].font.name.replace(' ', '_'), d.styles['Heading 1'].font.color.rgb)
`).trim().split(' ');
    assert.deepEqual(t, ['2.0', 'Times_New_Roman', '000000'], 'fonts, spacing and black headings of the norm kept');
    const styles = new PizZip(fs.readFileSync(path.join(dir, 'tesis-v2.docx'))).file('word/styles.xml').asText();
    assert.equal(styles.includes('2563EB'), false, 'no theme-coloured rule or heading');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sira_design: xlsx formats per column, title row, fit to page, chart right of existing images', { skip: SKIP_PY }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-design-'));
  try {
    python(dir, `
from openpyxl import Workbook
from openpyxl.drawing.image import Image as XImage
from PIL import Image
Image.new('RGB', (200, 80), (200, 30, 30)).save('logo.png')
wb = Workbook(); ws = wb.active; ws.title = 'Ventas'
ws['A1'] = 'Reporte de ventas 2026'; ws.merge_cells('A1:D1')
ws.append([]); ws.append(['Producto', 'Unidades', 'Precio', 'Monto'])
for i, (n, u, pr) in enumerate([('A', 120, 2.5), ('B', 300, 1.25), ('C', 315, 3.75)], start=4):
    ws.append([n, u, pr, f'=B{i}*C{i}'])
ws.append(['Total', '=SUM(B4:B6)', None, '=SUM(D4:D6)'])
ws.add_image(XImage('logo.png'), 'F1')
wb.save('ventas.xlsx')
`);
    const report = runHelper(dir, ['ventas.xlsx']);
    assert.equal(report.ok, true);
    assert.equal(report.values_preserved, true);
    assert.equal(report.sheets[0].title_row, 1);
    const out = JSON.parse(python(dir, `
import json
from openpyxl import load_workbook
ws = load_workbook('ventas-v2.xlsx').active
img = ws._images[0].anchor._from.col
print(json.dumps({
  'units_total': ws['B7'].number_format, 'money_total': ws['D7'].number_format,
  'title_bold': bool(ws['A1'].font.b), 'fit': bool(ws.sheet_properties.pageSetUpPr.fitToPage),
  'fit_w': ws.page_setup.fitToWidth, 'chart_col': ws._charts[0].anchor._from.col, 'image_col': img,
  'images': len(ws._images),
}))
`));
    assert.equal(out.units_total, 'General', 'an integer total never shows «735.00»');
    assert.equal(out.money_total, '#,##0.00');
    assert.equal(out.title_bold, true);
    assert.equal(out.fit, true);
    assert.equal(out.fit_w, 1);
    assert.equal(out.images, 1, 'the logo is kept');
    assert.ok(out.chart_col >= out.image_col + 3, `chart (col ${out.chart_col}) placed right of the logo (col ${out.image_col})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── End to end: restyle + verify_visual through the runner ───────────────

const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
const CAN_VERIFY = HAS_OFFICE_PY
  && spawnSync('python3', ['-c', 'import lxml, PIL'], { stdio: 'ignore' }).status === 0
  && has('soffice') && has('pdftoppm');
const SKIP_E2E = !CAN_VERIFY && 'LibreOffice + poppler + python-pptx/lxml/Pillow requeridos';

test('E2E: «agrégale más diseño» on a 4-slide deck → gestion-v2.pptx, VERIFICADO, same titles and count', { skip: SKIP_E2E, timeout: 600_000 }, async () => {
  const { buffer, titles } = await plainDeck();
  const client = capturingClient([
    {
      toolCalls: [{
        name: 'execute_python',
        args: { code: "import sys, json; sys.path.insert(0, '/workspace/tmp'); import sira_design as sd; print(json.dumps(sd.restyle('uploads/gestion.pptx')))" },
      }],
    },
    { toolCalls: [{ name: 'inspect_document', args: { path: 'outputs/gestion-v2.pptx' } }] },
    {
      toolCalls: [{
        name: 'verify_visual',
        args: {
          before: 'uploads/gestion.pptx',
          after: 'outputs/gestion-v2.pptx',
          checklist: ['mismo contenido y mismo orden', 'diseño visiblemente más profesional', 'sin texto desbordado'],
          expect: { contains: titles, same_page_count: true },
        },
      }],
    },
    { content: 'Listo. Rediseñé la presentación en gestion-v2.pptx conservando las 4 diapositivas y su contenido.' },
  ]);
  const verifies = [];
  const result = await agentRunner.runAgentRunner({
    files: [{ name: 'gestion.pptx', buffer, isPriorArtifact: true }],
    instruction: 'en la misma ppt ## gestion.pptx agrégale más diseño',
    client,
    model: 'test',
    driver: 'local',
    maxIterations: 6,
    onEvent: (ev) => { if (ev && ev.tool === 'verify_visual' && ev.type === 'tool_result') verifies.push(ev); },
  });
  const out = (result.outputs || []).find((o) => o.valid !== false && o.name === 'gestion-v2.pptx');
  assert.ok(out, `delivered gestion-v2.pptx (stopped: ${result.stoppedReason}, outputs: ${(result.outputs || []).map((o) => o.name)})`);
  // verify_visual answers «VEREDICTO: VERIFICADO» or an ERROR (ok:false).
  assert.ok(verifies.some((ev) => ev.ok === true), 'verify_visual passed');
  assert.ok((result.steps || []).some((step) => step.tool === 'verify_visual' && step.ok === true));
  assert.equal(result.stoppedReason, 'final');
  const slides = slideXml(new PizZip(out.buffer));
  assert.equal(slides.length, 4, 'same slide count');
  const xml = slides.join('\n');
  for (const title of titles) assert.ok(xml.includes(title), `title kept: ${title}`);
  assert.ok(xml.includes('2563EB'), 'theme accent present');
  assert.equal((result.outputs || []).some((o) => /\.(html|py)$/i.test(o.name)), false, 'no html / py substitutes');
});

function restyleScript(source, output, verifyArgs) {
  return capturingClient([
    {
      toolCalls: [{
        name: 'execute_python',
        args: { code: `import sys, json; sys.path.insert(0, '/workspace/tmp'); import sira_design as sd; print(json.dumps(sd.restyle('uploads/${source}')))` },
      }],
    },
    { toolCalls: [{ name: 'inspect_document', args: { path: `outputs/${output}` } }] },
    { toolCalls: [{ name: 'verify_visual', args: { before: `uploads/${source}`, after: `outputs/${output}`, ...verifyArgs } }] },
    { content: `Listo. Mejoré el formato en ${output} conservando el contenido.` },
  ]);
}

function buildWithPython(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-design-src-'));
  try {
    python(dir, code);
    const name = fs.readdirSync(dir)[0];
    return { name, buffer: fs.readFileSync(path.join(dir, name)) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('E2E: «mejora el formato del word» → informe-v2.docx, verified, headings kept', { skip: SKIP_E2E, timeout: 600_000 }, async () => {
  const source = buildWithPython(`
from docx import Document
d = Document()
d.add_paragraph('Informe de gestión 2026', style='Title')
d.add_paragraph('Resumen ejecutivo', style='Heading 1')
d.add_paragraph('La empresa redujo su consumo energético durante el periodo.')
t = d.add_table(rows=3, cols=2)
for i, row in enumerate([['Indicador', 'Valor'], ['Energía', '35%'], ['Proveedores', '12']]):
    for j, v in enumerate(row):
        t.cell(i, j).text = v
d.save('informe.docx')
`);
  const client = restyleScript('informe.docx', 'informe-v2.docx', {
    checklist: ['mismo contenido y mismo orden', 'formato visiblemente más profesional'],
    expect: { contains: ['Informe de gestión 2026', 'Resumen ejecutivo', 'Indicador'] },
  });
  const result = await agentRunner.runAgentRunner({
    files: [{ name: source.name, buffer: source.buffer, isPriorArtifact: true }],
    instruction: 'mejora el formato del word',
    client,
    model: 'test',
    driver: 'local',
    maxIterations: 6,
  });
  assert.match(client.calls[0][0].content, /DESIGN WORKFLOW/);
  const out = (result.outputs || []).find((o) => o.valid !== false && o.name === 'informe-v2.docx');
  assert.ok(out, `delivered informe-v2.docx (stopped: ${result.stoppedReason})`);
  assert.equal(result.stoppedReason, 'final');
  assert.ok((result.steps || []).some((step) => step.tool === 'verify_visual' && step.ok === true));
  const documentXml = new PizZip(out.buffer).file('word/document.xml').asText();
  for (const text of ['Informe de gestión 2026', 'Resumen ejecutivo', 'La empresa redujo su consumo energético durante el periodo.']) {
    assert.ok(documentXml.includes(text), `kept: ${text}`);
  }
});

test('E2E: a multi-page single-spaced Word redesign verifies with same_page_count=false (docx pagination may move)', { skip: SKIP_E2E, timeout: 600_000 }, async () => {
  const source = buildWithPython(`
from docx import Document
d = Document()
d.styles['Normal'].paragraph_format.line_spacing = 1.0
d.add_paragraph('Memoria anual 2026', style='Title')
for s in range(1, 7):
    d.add_paragraph('Sección %d' % s, style='Heading 1')
    for k in range(9):
        d.add_paragraph('Párrafo %d.%d: la organización consolidó sus procesos administrativos, redujo el consumo energético y fortaleció el control interno con indicadores mensuales verificables.' % (s, k))
d.save('memoria.docx')
`);
  const prompt = buildAgentRunnerPrompt({ priorArtifactNames: ['memoria.docx'], officeEngine: true, designUpgrade: true });
  assert.match(prompt, /DOCX and XLSX: expect\.same_page_count=false/);
  const client = restyleScript('memoria.docx', 'memoria-v2.docx', {
    checklist: ['mismo contenido y mismo orden', 'formato visiblemente más profesional'],
    expect: { contains: ['Memoria anual 2026', 'Sección 1', 'Sección 6'], same_page_count: false },
  });
  const result = await agentRunner.runAgentRunner({
    files: [{ name: source.name, buffer: source.buffer, isPriorArtifact: true }],
    instruction: 'mejora el formato del word',
    client,
    model: 'test',
    driver: 'local',
    maxIterations: 6,
  });
  const out = (result.outputs || []).find((o) => o.valid !== false && o.name === 'memoria-v2.docx');
  assert.ok(out, `delivered memoria-v2.docx (stopped: ${result.stoppedReason})`);
  assert.equal(result.stoppedReason, 'final');
  assert.ok((result.steps || []).some((step) => step.tool === 'verify_visual' && step.ok === true), 'verify_visual passed');
});

test('E2E: «dale formato profesional al excel» → presupuesto-v2.xlsx, verified, values and formulas kept', { skip: SKIP_E2E, timeout: 600_000 }, async () => {
  const source = buildWithPython(`
from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = 'Presupuesto'
ws.append(['Concepto', 'Cantidad', 'Precio unitario', 'Total'])
for i, (c, q, p) in enumerate([('Cemento', 120, 28.5), ('Arena', 40, 55.0), ('Acero', 15, 1250.75)], start=2):
    ws.append([c, q, p, f'=B{i}*C{i}'])
ws.append(['Total', None, None, '=SUM(D2:D4)'])
wb.save('presupuesto.xlsx')
`);
  const client = restyleScript('presupuesto.xlsx', 'presupuesto-v2.xlsx', {
    checklist: ['mismos valores y fórmulas', 'formato visiblemente más profesional'],
    expect: { contains: ['Concepto', 'Cemento', 'Total'] },
  });
  const result = await agentRunner.runAgentRunner({
    files: [{ name: source.name, buffer: source.buffer, isPriorArtifact: true }],
    instruction: 'dale formato profesional al excel',
    client,
    model: 'test',
    driver: 'local',
    maxIterations: 6,
  });
  assert.match(client.calls[0][0].content, /DESIGN WORKFLOW/);
  const out = (result.outputs || []).find((o) => o.valid !== false && o.name === 'presupuesto-v2.xlsx');
  assert.ok(out, `delivered presupuesto-v2.xlsx (stopped: ${result.stoppedReason})`);
  assert.equal(result.stoppedReason, 'final');
  const sheet = new PizZip(out.buffer).file('xl/worksheets/sheet1.xml').asText();
  assert.match(sheet, /<f>B2\*C2<\/f>/, 'formula kept');
  assert.match(sheet, /<f>SUM\(D2:D4\)<\/f>/, 'total formula kept');
});
