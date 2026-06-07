'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { Document, Packer, Paragraph } = require('docx');
const PizZip = require('pizzip');

const {
  buildChartSvg,
  svgToPng,
  embedImageIntoDocxBuffer,
  addChartToDocxBuffer,
  addVisualFromRequest,
  detectVisualRequest,
  parseInlineSeries,
  isVisualAvailable,
  INTERNAL,
} = require('../src/services/document-visual-embed');

async function makeDocxBuffer() {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph('Portada original UPN'),
        new Paragraph('Capítulo IV. Resultados de la investigación.'),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

const SAMPLE = { type: 'bar', title: 'Resultados por dimensión', data: { labels: ['Eficiencia', 'Calidad', 'Costo'], values: [42, 67, 28] }, theme: 'corporate' };

describe('document-visual-embed — chart SVG generation', () => {
  it('normalizes the three accepted data shapes into the same series', () => {
    const { normalizeData } = INTERNAL;
    const expected = [{ label: 'A', value: 1 }, { label: 'B', value: 2 }];
    assert.deepEqual(normalizeData({ labels: ['A', 'B'], values: [1, 2] }), expected);
    assert.deepEqual(normalizeData([{ label: 'A', value: 1 }, { label: 'B', value: 2 }]), expected);
    assert.deepEqual(normalizeData([1, 2]).map((p) => p.value), [1, 2]);
  });

  it('builds a valid bar chart SVG containing the data and labels', () => {
    const svg = buildChartSvg(SAMPLE);
    assert.match(svg, /^<svg /);
    assert.match(svg, /<\/svg>$/);
    assert.match(svg, /Resultados por dimensión/);
    assert.match(svg, /Eficiencia/);
    assert.match(svg, /<rect /); // bars
  });

  it('builds pie and line charts', () => {
    const pie = buildChartSvg({ ...SAMPLE, type: 'pie' });
    assert.match(pie, /<path /); // slices
    assert.match(pie, /%/); // legend percentages
    const line = buildChartSvg({ ...SAMPLE, type: 'line' });
    assert.match(line, /<polyline /);
  });

  it('escapes hostile text in titles and labels (no injection)', () => {
    const svg = buildChartSvg({ type: 'bar', title: '<script>x</script>', data: [{ label: '"<b>', value: 5 }] });
    assert.doesNotMatch(svg, /<script>x<\/script>/);
    assert.match(svg, /&lt;script&gt;/);
  });

  it('clamps oversized images to the usable page width', () => {
    const { fitEmu } = INTERNAL;
    const { cx, cy } = fitEmu(2000, 1000);
    assert.ok(cx <= 5486400, 'width clamped to page');
    assert.ok(cy < 1000 * 9525, 'height scaled down with width');
  });
});

describe('document-visual-embed — diagrams (process / timeline / organigram)', () => {
  it('builds a process flow with arrows between steps', () => {
    const svg = buildChartSvg({ type: 'process', title: 'Flujo metodológico', data: ['Diagnóstico', 'Diseño', 'Aplicación', 'Resultados'] });
    assert.match(svg, /Diagnóstico/);
    assert.match(svg, /marker-end="url\(#arrow\)"/);
    assert.match(svg, /<marker /);
  });

  it('builds a timeline with milestones and dates', () => {
    const svg = buildChartSvg({ type: 'timeline', title: 'Cronología', data: [{ label: 'Inicio', date: 'Sem 1' }, { label: 'Cierre', date: 'Sem 16' }] });
    assert.match(svg, /Inicio/);
    assert.match(svg, /Sem 16/);
    assert.match(svg, /<circle /);
  });

  it('builds a radar chart with axes, rings and a data polygon', () => {
    const svg = buildChartSvg({ type: 'radar', title: 'Perfil por dimensión', data: { labels: ['Eficacia', 'Eficiencia', 'Calidad', 'Innovación', 'Costo'], values: [80, 65, 90, 50, 70] } });
    assert.match(svg, /Eficacia/);
    assert.match(svg, /<polygon /); // rings + data polygon
    assert.equal(detectVisualRequest('haz un gráfico de radar de las dimensiones').type, 'radar');
  });

  it('builds an organigram from a nested tree and connects parents to children', () => {
    const svg = buildChartSvg({
      type: 'organigram',
      title: 'Estructura',
      tree: { label: 'Dirección', children: [{ label: 'Operaciones', children: [{ label: 'Logística' }] }, { label: 'Finanzas' }] },
    });
    assert.match(svg, /Dirección/);
    assert.match(svg, /Logística/);
    assert.match(svg, /Finanzas/);
    assert.match(svg, /<path /); // connectors
  });

  it('escapes hostile labels in diagrams', () => {
    const svg = buildChartSvg({ type: 'process', data: ['<img src=x onerror=1>'] });
    assert.doesNotMatch(svg, /<img src=x/);
    assert.match(svg, /&lt;img/);
  });
});

describe('document-visual-embed — DOCX image embedding', () => {
  it('embeds a PNG as an inline drawing, preserving the original document', async () => {
    const docx = await makeDocxBuffer();
    // 1x1 transparent PNG
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');
    const out = embedImageIntoDocxBuffer(docx, { png, widthPx: 640, heightPx: 400, name: 'Gráfico de resultados', title: 'Figura 1. Resultados' });

    const zip = new PizZip(out);
    const xml = zip.file('word/document.xml').asText();
    // original content preserved
    assert.match(xml, /Portada original UPN/);
    assert.match(xml, /Capítulo IV/);
    // image wired in
    assert.ok(zip.file('word/media/image1.png'), 'media png added');
    assert.match(zip.file('word/_rels/document.xml.rels').asText(), /relationships\/image/);
    assert.match(xml, /<w:drawing>/);
    assert.match(xml, /<a:blip r:embed="rId\d+"\/>/);
    assert.match(zip.file('[Content_Types].xml').asText(), /Extension="png"/);
    assert.match(xml, /Figura 1\. Resultados/); // caption
  });

  it('assigns unique media names and relationship ids for multiple images', async () => {
    const docx = await makeDocxBuffer();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');
    const once = embedImageIntoDocxBuffer(docx, { png });
    const twice = embedImageIntoDocxBuffer(once, { png });
    const zip = new PizZip(twice);
    assert.ok(zip.file('word/media/image1.png'), 'first image');
    assert.ok(zip.file('word/media/image2.png'), 'second image');
    const rels = zip.file('word/_rels/document.xml.rels').asText();
    const imageRels = [...rels.matchAll(/Type="[^"]*relationships\/image"/g)];
    assert.equal(imageRels.length, 2);
  });
});

describe('document-visual-embed — request → visual intent', () => {
  it('detects visual intent and infers the chart/diagram type', () => {
    assert.deepEqual(detectVisualRequest('agrega un gráfico de barras con los resultados'), { wantsVisual: true, type: 'bar' });
    assert.equal(detectVisualRequest('inserta un gráfico de pastel').type, 'pie');
    assert.equal(detectVisualRequest('haz un organigrama del área').type, 'organigram');
    assert.equal(detectVisualRequest('una línea de tiempo del proyecto').type, 'timeline');
    assert.equal(detectVisualRequest('diagrama de flujo del proceso').type, 'process');
    assert.equal(detectVisualRequest('completa el anexo 3').wantsVisual, false);
  });

  it('parses inline "label number" series from free text', () => {
    const series = parseInlineSeries('distribución: Lima 48, Arequipa 22, Cusco 18 y Trujillo 12');
    const byLabel = Object.fromEntries(series.map((s) => [s.label, s.value]));
    assert.equal(byLabel.Lima, 48);
    assert.equal(byLabel.Arequipa, 22);
    assert.equal(byLabel.Trujillo, 12);
  });

  it('embeds a chart parsed from the request when no model is available', async (t) => {
    if (!isVisualAvailable()) { t.skip('sharp not available'); return; }
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const docx = await makeDocxBuffer();
      const result = await addVisualFromRequest(docx, { requestText: 'agrega un gráfico de barras con Lima 48, Arequipa 22, Cusco 18' });
      assert.equal(result.added, true);
      assert.equal(result.spec.type, 'bar');
      const zip = new PizZip(result.buffer);
      assert.ok(zip.file('word/media/image1.png'));
      assert.match(zip.file('word/document.xml').asText(), /<w:drawing>/);
    } finally {
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedKey;
    }
  });

  it('is a no-op for non-visual requests and for visual requests without data', async () => {
    const docx = await makeDocxBuffer();
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const noIntent = await addVisualFromRequest(docx, { requestText: 'corrige la ortografía del documento' });
      assert.equal(noIntent.added, false);
      assert.equal(noIntent.reason, 'no_visual_intent');
      const noData = await addVisualFromRequest(docx, { requestText: 'agrega un gráfico bonito' });
      assert.equal(noData.added, false);
      assert.equal(noData.reason, 'no_data');
    } finally {
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedKey;
    }
  });
});

describe('document-visual-embed — end to end (sharp rasterization)', () => {
  it('renders a chart to PNG and embeds it into the DOCX', async (t) => {
    if (!isVisualAvailable()) {
      t.skip('sharp not available in this environment');
      return;
    }
    const png = await svgToPng(buildChartSvg(SAMPLE));
    assert.equal(png.slice(0, 4).toString('hex'), '89504e47', 'PNG magic bytes');

    const docx = await makeDocxBuffer();
    const out = await addChartToDocxBuffer(docx, { ...SAMPLE, caption: 'Figura 1. Resultados por dimensión' });
    const zip = new PizZip(out);
    assert.ok(zip.file('word/media/image1.png'), 'chart embedded');
    assert.match(zip.file('word/document.xml').asText(), /<w:drawing>/);
    assert.match(zip.file('word/document.xml').asText(), /Portada original UPN/);
  });
});
