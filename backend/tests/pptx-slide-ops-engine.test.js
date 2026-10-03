'use strict';

// sira_office.py — slide-level ops and build_from_template against the REAL
// fixture deck. Needs python3 + lxml (CI shard 1 has them); skipped honestly
// otherwise. Rendering through LibreOffice runs only when soffice works.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const PizZip = require('pizzip');

const lineage = require('../src/services/document-template-lineage');

const ENGINE = path.join(__dirname, '..', 'src', 'services', 'agent-runner', 'sira_office.py');
const FIXTURE = path.join(__dirname, 'fixtures', 'office', 'defensa_demo.pptx');
const HAS_PY = spawnSync('python3', ['-c', 'import lxml']).status === 0;
const skip = HAS_PY ? false : 'python3 + lxml no disponibles';

function engine(cmd, args, cwd) {
  const r = spawnSync('python3', [ENGINE, cmd, JSON.stringify(args)], { cwd, encoding: 'utf8' });
  const lines = String(r.stdout || '').trim().split('\n').filter(Boolean);
  try { return JSON.parse(lines[lines.length - 1]); } catch { throw new Error(`salida inválida: ${r.stdout}\n${r.stderr}`); }
}

function slideTexts(buffer) {
  const zip = new PizZip(buffer);
  return lineage._internal.orderedSlides(zip).map((part) => lineage._internal.allText(zip.file(part).asText()));
}

function packageIsCoherent(buffer) {
  const zip = new PizZip(buffer);
  const names = Object.keys(zip.files);
  const ct = zip.file('[Content_Types].xml').asText();
  const slides = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  for (const s of slides) {
    assert.ok(ct.includes(`PartName="/${s}"`), `content type for ${s}`);
    assert.match(zip.file(s.replace('slides/', 'slides/_rels/') + '.rels').asText(), /slideLayout/, `${s} links a layout`);
  }
  const pres = zip.file('ppt/presentation.xml').asText();
  const rels = zip.file('ppt/_rels/presentation.xml.rels').asText();
  const ids = [...pres.matchAll(/<p:sldId [^>]*r:id="([^"]+)"/g)].map((m) => m[1]);
  for (const id of ids) assert.ok(rels.includes(`Id="${id}"`), `presentation rel ${id}`);
  // Nothing in sldIdLst points at a removed part.
  for (const m of rels.matchAll(/Id="([^"]+)"[^>]*Target="(slides\/slide\d+\.xml)"/g)) {
    if (ids.includes(m[1])) assert.ok(zip.file(`ppt/${m[2]}`), `part ${m[2]} exists`);
  }
  return { slides: slides.length, listed: ids.length };
}

test('build_from_template builds the deck ON the fixture deck: its layouts, no sample slides, lineage verified', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-tpl-'));
  fs.copyFileSync(FIXTURE, path.join(dir, 'template.pptx'));
  const res = engine('build_from_template', {
    template: 'template.pptx', dst: 'out.pptx', title: 'Marketing digital 2026', subtitle: 'Plan trimestral',
    outline: [
      { title: 'Contexto', bullets: ['Mercado en crecimiento', 'Competencia fragmentada'] },
      { title: 'Objetivos', bullets: ['+20% leads', 'CAC -15%'], layout: 'Two Content' },
      { title: 'Cierre', role: 'section' },
    ],
    closing: { title: 'Gracias' },
  }, dir);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.removed_sample_slides, 3);
  assert.equal(res.slides, 5);
  assert.deepEqual(res.created.map((c) => c.layout), ['Title Slide', 'Title and Content', 'Two Content', 'Section Header', 'Title Slide']);
  assert.deepEqual(res.leftover_placeholder_text_on, []);
  const out = fs.readFileSync(path.join(dir, 'out.pptx'));
  const coherent = packageIsCoherent(out);
  assert.equal(coherent.listed, 5);
  const texts = slideTexts(out);
  assert.match(texts[0], /Marketing digital 2026/);
  assert.match(texts[0], /Plan trimestral/);
  assert.match(texts[1], /Contexto/);
  assert.match(texts[1], /Mercado en crecimiento/);
  assert.match(texts[4], /Gracias/);
  assert.doesNotMatch(texts.join(' '), /Adición de cal|Juan Pérez/, 'sample content is gone');
  const verdict = lineage.verifyTemplateLineage({ templateBuffer: fs.readFileSync(FIXTURE), outputBuffer: out });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.reasons));
  // The template's masters / layouts / theme are byte-identical.
  const tz = new PizZip(fs.readFileSync(FIXTURE));
  const oz = new PizZip(out);
  for (const name of Object.keys(tz.files).filter((n) => /^ppt\/(slideMasters|slideLayouts|theme)\//.test(n))) {
    assert.equal(oz.file(name).asText(), tz.file(name).asText(), `${name} untouched`);
  }
  // A .potx template is turned into a normal presentation.
  const potx = new PizZip(fs.readFileSync(FIXTURE));
  potx.file('[Content_Types].xml', potx.file('[Content_Types].xml').asText().replace('presentationml.presentation.main+xml', 'presentationml.template.main+xml'));
  fs.writeFileSync(path.join(dir, 'plantilla.potx'), potx.generate({ type: 'nodebuffer' }));
  const res2 = engine('build_from_template', { template: 'plantilla.potx', dst: 'out2.pptx', title: 'Ley de datos', outline: [{ title: 'Alcance', bullets: ['a'] }] }, dir);
  assert.equal(res2.ok, true, JSON.stringify(res2));
  const ct2 = new PizZip(fs.readFileSync(path.join(dir, 'out2.pptx'))).file('[Content_Types].xml').asText();
  assert.match(ct2, /presentationml\.presentation\.main\+xml/);
  assert.doesNotMatch(ct2, /presentationml\.template\.main\+xml/);
  // Nothing to build → honest error, no file.
  const res3 = engine('build_from_template', { template: 'template.pptx', dst: 'out3.pptx' }, dir);
  assert.equal(res3.ok, false);
  assert.ok(!fs.existsSync(path.join(dir, 'out3.pptx')));
});

test('office_edit slide ops: background on ONE slide, duplicate, add from layout, move, delete — surgical and coherent', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-ops-'));
  fs.copyFileSync(FIXTURE, path.join(dir, 'deck.pptx'));
  const res = engine('edit', {
    src: 'deck.pptx', dst: 'deck-editado.pptx',
    ops: [
      { op: 'set_slide_background', slide: 2, color: '1E3A8A' },
      { op: 'duplicate_slide', slide: 2, title: 'Copia de la 2' },
      { op: 'add_slide', title: 'Conclusiones', bullets: ['Uno', 'Dos', 'Tres'], position: 2 },
      { op: 'move_slide', slide: 1, position: 3 },
      { op: 'delete_slide', slide: 1 },
    ],
  }, dir);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.applied.map((a) => a.op), ['set_slide_background', 'duplicate_slide', 'add_slide', 'move_slide', 'delete_slide']);
  assert.equal(res.applied[2].layout, 'Title and Content');
  const out = fs.readFileSync(path.join(dir, 'deck-editado.pptx'));
  const coherent = packageIsCoherent(out);
  assert.equal(coherent.listed, 4);
  const texts = slideTexts(out);
  assert.match(texts[0], /Resultados/);
  assert.match(texts[1], /Adición de cal/);
  assert.match(texts[2], /Esquema del ensayo/);
  assert.match(texts[3], /Copia de la 2/);
  assert.match(texts[3], /CBR/, 'the duplicate keeps the body of the source slide');
  // Only slide «Resultados» got a background; the rest of the slide XML and the design parts are untouched.
  const tz = new PizZip(fs.readFileSync(FIXTURE));
  const oz = new PizZip(out);
  const bgSlides = Object.keys(oz.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n) && /<p:bg>/.test(oz.file(n).asText()));
  assert.equal(bgSlides.length, 1);
  assert.match(oz.file(bgSlides[0]).asText(), /srgbClr val="1E3A8A"/);
  for (const name of Object.keys(tz.files).filter((n) => /^ppt\/(slideMasters|slideLayouts|theme)\//.test(n))) {
    assert.equal(oz.file(name).asText(), tz.file(name).asText(), `${name} untouched`);
  }
  // Errors are honest and nothing is written.
  const bad = engine('edit', { src: 'deck.pptx', dst: 'deck-x.pptx', ops: [{ op: 'delete_slide', slide: 9 }] }, dir);
  assert.equal(bad.ok, false);
  assert.match(String(bad.error || JSON.stringify(bad.errors)), /no existe/);
  const noScope = engine('edit', { src: 'deck.pptx', dst: 'deck-y.pptx', ops: [{ op: 'set_slide_background', color: 'FF0000' }] }, dir);
  assert.equal(noScope.ok, false);
  assert.match(String(noScope.error || JSON.stringify(noScope.errors)), /slide|slides/);
});
