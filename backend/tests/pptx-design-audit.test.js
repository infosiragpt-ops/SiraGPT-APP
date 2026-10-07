'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PizZip = require('pizzip');
const PptxGenJS = require('pptxgenjs');
const { auditPptxDesign } = require('../src/services/document-pipeline/pptx-design-audit');

const NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const emu = (n) => Math.round(n * 914400);
const transform = (x, y, w, h, attrs = '') => `<a:xfrm ${attrs}><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm>`;
const fill = (color) => `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`;
function shape({ id = 2, x = 1, y = 1, w = 8, h = 1, size = 2400, color = '222222', background = null, text = 'Texto público', xfrm, runProps = '', bodyProps = '', extra = '', noText = false, rawProperties = '' } = {}) {
  const font = size == null ? '' : `sz="${size}"`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm === null ? '' : xfrm || transform(x, y, w, h)}<a:prstGeom prst="rect"/>${rawProperties || (background ? fill(background) : '<a:noFill/>')}</p:spPr>${noText ? '' : `<p:txBody><a:bodyPr>${bodyProps}</a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr ${font}>${color ? fill(color) : ''}${runProps}</a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody>`}${extra}</p:sp>`;
}
function group(content, { x = 0, y = 0, w = 10, h = 7.5, cx = 0, cy = 0, cw = 10, ch = 7.5, attrs = '' } = {}) {
  return `<p:grpSp><p:nvGrpSpPr/><p:grpSpPr><a:xfrm ${attrs}><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/><a:chOff x="${emu(cx)}" y="${emu(cy)}"/><a:chExt cx="${emu(cw)}" cy="${emu(ch)}"/></a:xfrm></p:grpSpPr>${content}</p:grpSp>`;
}
function deck(slides = [shape()], { background = 'FFFFFF', width = 13.333, height = 7.5, mutate } = {}) {
  const zip = new PizZip();
  zip.file('ppt/presentation.xml', `<p:presentation ${NS}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${emu(width)}" cy="${emu(height)}"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships>${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`);
  slides.forEach((content, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, `<p:sld ${NS}><p:cSld>${background ? `<p:bg><p:bgPr>${fill(background)}</p:bgPr></p:bg>` : ''}<p:spTree>${content}</p:spTree></p:cSld></p:sld>`);
    zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, '<Relationships><Relationship Id="layout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>');
  });
  zip.file('ppt/slideLayouts/slideLayout1.xml', `<p:sldLayout ${NS}><p:cSld><p:spTree/></p:cSld></p:sldLayout>`);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', '<Relationships><Relationship Id="master" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>');
  zip.file('ppt/slideMasters/slideMaster1.xml', `<p:sldMaster ${NS}><p:cSld><p:spTree/></p:cSld></p:sldMaster>`);
  mutate?.(zip);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}
const errors = (report) => report.issues.filter((issue) => issue.severity === 'error');

test('real generated deck: all three invisible off-canvas slides fail, with no private text in evidence', async () => {
  const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_WIDE';
  for (let i = 0; i < 3; i++) {
    const slide = pptx.addSlide(); slide.background = { color: 'FFFFFF' };
    slide.addText(`PRIVATE-MATERIAL-${i}`, { x: 18, y: 15, w: 2, h: 0.1, fontSize: 2, color: 'FFFFFF' });
  }
  const report = auditPptxDesign(await pptx.write({ outputType: 'nodebuffer' }));
  assert.equal(report.passed, false);
  assert.equal(report.coverage.slides, 3);
  assert.deepEqual(report.issues.filter((i) => i.code === 'PPTX_TEXT_OUTSIDE_SLIDE').map((i) => i.slide), [1, 2, 3]);
  assert.equal(report.issues.filter((i) => i.code === 'PPTX_TEXT_TOO_SMALL').length, 3);
  assert.equal(report.issues.filter((i) => i.code === 'PPTX_TEXT_INVISIBLE_CONTRAST').length, 3);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE-MATERIAL/);
});

test('readable native PPTX passes: real dimensions, explicit font sizes and dark-on-light text', async () => {
  const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_WIDE';
  const slide = pptx.addSlide(); slide.background = { color: 'FFFFFF' };
  slide.addText('Objetivo de la presentación', { x: 0.7, y: 0.6, w: 11, h: 0.8, fontSize: 32, color: '172233' });
  slide.addText('Evidencia y próximos pasos', { x: 0.7, y: 2, w: 11, h: 1, fontSize: 20, color: '334455' });
  const report = auditPptxDesign(await pptx.write({ outputType: 'nodebuffer' }));
  assert.equal(report.passed, true);
  assert.deepEqual(report.issues, []);
  assert.equal(report.coverage.geometryChecked, 2);
  assert.equal(report.coverage.fontRunsChecked, 2);
  assert.equal(report.coverage.contrastRunsChecked, 2);
  assert.equal(report.coverage.rendered, false);
});

test('normal autofit fontScale uses the effective point size', () => {
  const report = auditPptxDesign(deck([shape({ size: 1800, bodyProps: '<a:normAutofit fontScale="30000"/>' })]));
  assert.deepEqual(errors(report).map((i) => [i.code, i.fontSizePt]), [['PPTX_TEXT_TOO_SMALL', 5.4]]);
});

test('legible 8pt footnotes and intentionally small superscripts do not block', () => {
  const report = auditPptxDesign(deck([shape({ size: 800 }) + shape({ id: 3, y: 3, size: 300, runProps: '<a:latin typeface="Arial"/>' }).replace('sz="300"', 'sz="300" baseline="30000"')]));
  assert.equal(report.passed, true);
  assert.equal(report.coverage.fontRunsSkipped, 1);
});

test('a partial textbox crossing is advisory: the glyphs may still fit inside the slide', () => {
  const report = auditPptxDesign(deck([shape({ x: -0.1, w: 2 })]));
  assert.equal(report.passed, true);
  assert.deepEqual(report.issues.map((i) => [i.code, i.severity]), [['PPTX_TEXT_BOX_CROSSES_SLIDE', 'warning']]);
});

test('intentional non-text bleeds and large background decorations never produce geometry errors', () => {
  const report = auditPptxDesign(deck([shape({ x: -30, y: -30, w: 80, h: 80, noText: true, background: 'EEEEEE' }) + shape({ id: 3 })]));
  assert.equal(report.passed, true);
  assert.equal(report.coverage.textShapes, 1);
  assert.equal(report.coverage.nonTextShapes, 1);
});

test('custom slide dimensions are respected, not assumed to be widescreen', () => {
  const report = auditPptxDesign(deck([shape({ x: 8, y: 8, w: 3, h: 1 })], { width: 12, height: 12 }));
  assert.equal(report.passed, true);
  assert.equal(report.issues.length, 0);
});

test('nested group chOff/chExt transforms keep a large local coordinate visibly on-slide', () => {
  const inside = group(shape({ x: 100, y: 0, w: 4, h: 1 }), { x: 0, y: 0, w: 10, h: 7, cx: 100, cw: 10, ch: 7 });
  const report = auditPptxDesign(deck([group(inside, { x: 1, y: 1, w: 10, h: 6, cw: 10, ch: 7 })]));
  assert.equal(report.passed, true);
  assert.equal(report.coverage.geometryChecked, 1);
  assert.equal(report.coverage.fontRunsSkipped, 1, 'scaled group typography is not guessed');
});

test('a group translated fully outside the slide is rejected', () => {
  const report = auditPptxDesign(deck([group(shape(), { x: 30 })]));
  assert.equal(report.passed, false);
  assert.equal(report.issues[0].code, 'PPTX_TEXT_OUTSIDE_SLIDE');
});

test('rotation is applied before deciding whether the textbox is fully off-slide', () => {
  const report = auditPptxDesign(deck([shape({ xfrm: transform(-3, 1, 2, 8, 'rot="5400000"') })]));
  assert.equal(report.passed, true, 'rotating around the center makes this rectangle intersect the slide');
  assert.ok(report.issues.some((i) => i.severity === 'warning'));
});

test('unknown placeholder geometry and inherited theme font/color stay explicitly unchecked', () => {
  const report = auditPptxDesign(deck([shape({ xfrm: null, size: null, color: null, extra: '<p:style><a:fontRef idx="minor"><a:schemeClr val="tx1"/></a:fontRef></p:style>' })], { background: null }));
  assert.equal(report.passed, true);
  assert.equal(report.coverage.geometrySkipped, 1);
  assert.equal(report.coverage.fontRunsSkipped, 1);
  assert.equal(report.coverage.contrastRunsSkipped, 1);
});

test('an explicit opaque textbox fill proves invisible contrast even without a known slide background', () => {
  const report = auditPptxDesign(deck([shape({ background: 'FAFAFA', color: 'FAFAFA' })], { background: null }));
  assert.deepEqual(errors(report).map((i) => i.code), ['PPTX_TEXT_INVISIBLE_CONTRAST']);
});

test('an image underneath prevents an unjustified white-on-white contrast failure', () => {
  const pic = `<p:pic><p:spPr>${transform(0, 0, 13, 7)}</p:spPr></p:pic>`;
  const report = auditPptxDesign(deck([pic + shape({ color: 'FFFFFF' })]));
  assert.equal(report.passed, true);
  assert.equal(report.coverage.contrastRunsSkipped, 1);
});

test('an opaque known rectangle after an image restores provable contrast', () => {
  const pic = `<p:pic><p:spPr>${transform(0, 0, 13, 7)}</p:spPr></p:pic>`;
  const report = auditPptxDesign(deck([pic + shape({ id: 4, x: 0, y: 0, w: 12, h: 6, noText: true, background: 'FFFFFF' }) + shape({ color: 'FFFFFF' })]));
  assert.equal(report.passed, false);
  assert.ok(report.issues.some((i) => i.code === 'PPTX_TEXT_INVISIBLE_CONTRAST'));
});

test('inherited artwork, transparent fills, outlines and gradients are not assumed to be flat backgrounds', () => {
  const inherited = auditPptxDesign(deck([shape({ color: 'FFFFFF' })], { mutate: (zip) => zip.file('ppt/slideMasters/slideMaster1.xml', `<p:sldMaster ${NS}><p:cSld><p:spTree>${shape({ noText: true, background: '000000' })}</p:spTree></p:cSld></p:sldMaster>`) }));
  assert.equal(inherited.passed, true); assert.equal(inherited.coverage.contrastRunsSkipped, 1);
  for (const rawProperties of ['<a:gradFill/>', '<a:solidFill><a:srgbClr val="FFFFFF"><a:alpha val="50000"/></a:srgbClr></a:solidFill>']) {
    const report = auditPptxDesign(deck([shape({ color: 'FFFFFF', rawProperties })]));
    assert.equal(report.passed, true); assert.equal(report.coverage.contrastRunsSkipped, 1);
  }
  const outlined = auditPptxDesign(deck([shape({ color: 'FFFFFF', runProps: `<a:ln>${fill('000000')}</a:ln>` })]));
  assert.equal(outlined.passed, true); assert.equal(outlined.coverage.contrastRunsSkipped, 1);
});

test('table text is identified as uninspected rather than passed as measured text', () => {
  const report = auditPptxDesign(deck(['<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Tabla</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>']));
  assert.equal(report.passed, true);
  assert.equal(report.coverage.textShapes, 0);
  assert.equal(report.coverage.unsupportedTextContainers, 1);
});

test('invalid archive, XML, missing target slide and invalid dimensions fail with safe codes', () => {
  const inputs = [Buffer.from('not a pptx'), deck([shape()], { width: 0 }), deck([shape()], { mutate: (zip) => zip.remove('ppt/slides/slide1.xml') }), deck([shape()], { mutate: (zip) => zip.file('ppt/slides/slide1.xml', '<p:sld><invalid>') })];
  for (const input of inputs) {
    const report = auditPptxDesign(input);
    assert.equal(report.passed, false);
    assert.equal(report.coverage.complete, false);
    assert.ok(report.issues.some((i) => i.code === 'PPTX_DESIGN_AUDIT_INVALID_PACKAGE'));
  }
});

test('XML entities and oversized XML are rejected before parsing/inflation can consume unbounded resources', () => {
  const entity = deck([shape()], { mutate: (zip) => zip.file('ppt/presentation.xml', '<!DOCTYPE p [<!ENTITY v "PRIVATE-ENTITY">]><p:presentation/>') });
  assert.equal(auditPptxDesign(entity).passed, false);
  const huge = deck([shape()], { mutate: (zip) => zip.file('ppt/slides/slide1.xml', ' '.repeat(4 * 1024 * 1024 + 1)) });
  assert.equal(auditPptxDesign(huge).issues[0].code, 'PPTX_DESIGN_AUDIT_LIMIT');
});


test('hidden objects are excluded from presentation design errors', () => {
  const hidden = shape({ x: 30, size: 100, color: 'FFFFFF' }).replace('id="2" name="shape"', 'id="2" name="shape" hidden="1"');
  const report = auditPptxDesign(deck([hidden + shape({ id: 3 })]));
  assert.equal(report.passed, true);
  assert.equal(report.coverage.hiddenShapes, 1);
  assert.equal(report.coverage.textShapes, 1);
});

test('legal alternative XML namespace prefixes retain the same audit result', () => {
  const input = deck([shape({ x: 30 })], { mutate: (zip) => {
    for (const name of Object.keys(zip.files).filter((name) => name.endsWith('.xml'))) {
      zip.file(name, zip.file(name).asText().replace(/xmlns:p=/g, 'xmlns:presentation=').replace(/xmlns:a=/g, 'xmlns:drawing=').replace(/xmlns:r=/g, 'xmlns:relationship=').replace(/(<\/?|\s)p:/g, '$1presentation:').replace(/(<\/?|\s)a:/g, '$1drawing:').replace(/(<\/?|\s)r:/g, '$1relationship:'));
    }
  } });
  const report = auditPptxDesign(input);
  assert.equal(report.coverage.complete, true);
  assert.equal(report.issues[0].code, 'PPTX_TEXT_OUTSIDE_SLIDE');
});
