'use strict';

// «crea un word con esta información e incorpora esta gráfica»: the previous
// answer and its chart (as a real PNG in the turn's files) must reach the
// AgentRunner on both document entry points.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  collectPreviousTurnContext,
  referencesPriorTurn,
  inferRequestedFormat,
  extractSeries,
  markdownTable,
  materializeChartImage,
  INTERNAL,
} = require('../src/services/previous-turn-document-context');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const rechartsProjection = {
  type: 'viz',
  format: 'recharts',
  title: 'Proyección financiera a 5 años (2025–2029)',
  explanation: 'Ingresos y utilidad neta proyectados con crecimiento anual del 12 %.',
  chart: {
    type: 'line',
    xKey: 'anio',
    data: [
      { anio: '2025', ingresos: 120, utilidad: 18 },
      { anio: '2026', ingresos: 134, utilidad: 22 },
      { anio: '2027', ingresos: 150, utilidad: 27 },
      { anio: '2028', ingresos: 168, utilidad: 33 },
      { anio: '2029', ingresos: 188, utilidad: 40 },
    ],
    series: [
      { key: 'ingresos', name: 'Ingresos (M$)', color: '#2563eb' },
      { key: 'utilidad', name: 'Utilidad neta (M$)', color: '#10b981' },
    ],
  },
};

function fakePrisma({ messages = [], chat = { id: 'chat-1' }, failChat = false } = {}) {
  const created = [];
  return {
    created,
    chat: {
      findFirst: async ({ where }) => {
        if (failChat) throw new Error('db down');
        if (!chat || where.id !== chat.id) return null;
        return { ...chat, messages };
      },
    },
    file: {
      create: async ({ data }) => {
        const row = { id: `file-${created.length + 1}`, ...data };
        created.push(row);
        return row;
      },
    },
  };
}

function assistant(content, files = null, minutesAgo = 0) {
  return {
    role: 'ASSISTANT',
    content,
    files: files ? JSON.stringify(files) : null,
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  };
}

const storage = { persistLocalFile: async ({ localPath }) => ({ key: null, ref: localPath, storage: 'local' }) };

let uploadsDir;
beforeEach(() => {
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-turn-context-'));
});
afterEach(() => {
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});

describe('referencesPriorTurn / inferRequestedFormat', () => {
  test('detects requests that point at the previous answer and its chart', () => {
    assert.deepEqual(referencesPriorTurn('crea un word con esta información e incorpora esta gráfica en un word en una pagina'), { content: true, visual: true });
    assert.deepEqual(referencesPriorTurn('incorpora esta gráfica en un word'), { content: true, visual: true });
    assert.deepEqual(referencesPriorTurn('hazme un documento con el resultado anterior'), { content: true, visual: false });
    assert.deepEqual(referencesPriorTurn('ponlo en un word'), { content: true, visual: false });
    assert.deepEqual(referencesPriorTurn('insértala en un pdf'), { content: true, visual: false });
  });

  test('a new topic is never treated as a follow-up', () => {
    assert.deepEqual(referencesPriorTurn('crea un word sobre la revolución francesa'), { content: false, visual: false });
    assert.deepEqual(referencesPriorTurn('crea una gráfica de ventas'), { content: false, visual: false });
    assert.deepEqual(referencesPriorTurn(''), { content: false, visual: false });
  });

  test('requested format follows the words of the prompt', () => {
    assert.equal(inferRequestedFormat('crea un word con esta información'), 'docx');
    assert.equal(inferRequestedFormat('pásalo a pdf'), 'pdf');
    assert.equal(inferRequestedFormat('ponlo en un excel'), 'xlsx');
    assert.equal(inferRequestedFormat('hazme una presentación con esto'), 'pptx');
  });
});

describe('extractSeries / markdownTable', () => {
  test('recharts multi-series line → labels + series + table', () => {
    const series = extractSeries(rechartsProjection);
    assert.equal(series.kind, 'line');
    assert.deepEqual(series.labels, ['2025', '2026', '2027', '2028', '2029']);
    assert.deepEqual(series.series.map((s) => s.name), ['Ingresos (M$)', 'Utilidad neta (M$)']);
    assert.deepEqual(series.series[1].values, [18, 22, 27, 33, 40]);
    const table = markdownTable(series);
    assert.match(table, /^\| Categoría \| Ingresos \(M\$\) \| Utilidad neta \(M\$\) \|/);
    assert.match(table, /\| 2029 \| 188 \| 40 \|/);
  });

  test('chartjs doughnut and plotly bar traces are normalised too', () => {
    const pie = extractSeries({ type: 'viz', format: 'chartjs', config: { type: 'doughnut', data: { labels: ['A', 'B'], datasets: [{ label: 'Cuota', data: [60, 40] }] } } });
    assert.equal(pie.kind, 'pie');
    assert.match(markdownTable(pie), /\| Categoría \| Valor \|[\s\S]*\| B \| 40 \|/);
    const bars = extractSeries({ type: 'viz', format: 'plotly', data: [{ type: 'bar', name: 'Ventas', x: ['Q1', 'Q2'], y: [10, 12] }] });
    assert.equal(bars.kind, 'bar');
    assert.deepEqual(bars.labels, ['Q1', 'Q2']);
    assert.deepEqual(bars.series[0].values, [10, 12]);
    assert.equal(extractSeries({ type: 'viz', format: 'd3', html: '<html></html>' }), null);
  });
});

describe('materializeChartImage', () => {
  test('renders a recharts spec to a real PNG', async () => {
    const image = await materializeChartImage(rechartsProjection);
    assert.equal(image.ext, 'png');
    assert.deepEqual(image.buffer.subarray(0, 8), PNG_SIGNATURE);
    assert.ok(image.buffer.length > 2_000, 'a drawn chart is not a blank image');
  });

  test('decodes a matplotlib data URL and reads a local chart upload', async () => {
    const fromDataUrl = await materializeChartImage({ type: 'viz', format: 'matplotlib', imageUrl: `data:image/png;base64,${TINY_PNG}` });
    assert.deepEqual(fromDataUrl.buffer, Buffer.from(TINY_PNG, 'base64'));
    fs.mkdirSync(path.join(uploadsDir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, 'images', 'chart-1.png'), Buffer.from(TINY_PNG, 'base64'));
    const local = await materializeChartImage({ type: 'chart', imageUrl: 'http://localhost:5000/uploads/images/chart-1.png' }, { uploadsRoot: uploadsDir });
    assert.deepEqual(local.buffer, Buffer.from(TINY_PNG, 'base64'));
    const escaped = await INTERNAL.readLocalUpload('/uploads/../.env', { uploadsRoot: uploadsDir });
    assert.equal(escaped, null);
    assert.equal(await materializeChartImage({ type: 'viz', format: 'd3', html: '<html></html>' }), null);
  });
});

describe('collectPreviousTurnContext', () => {
  test('the bug scenario: previous answer + Recharts chart reach the runner as text and a PNG file', async () => {
    const prisma = fakePrisma({
      messages: [
        assistant('**Proyección financiera a 5 años (2025–2029)**\n\nIngresos y utilidad neta proyectados.', [rechartsProjection], 1),
        assistant('## Proyección financiera\n\nLa empresa proyecta ingresos de 120 M$ en 2025 con un crecimiento anual del 12 %.\n\n- Margen neto: 15 %\n- Punto de equilibrio: 2026', null, 5),
      ],
    });
    const out = await collectPreviousTurnContext({
      prisma,
      userId: 'u1',
      chatId: 'chat-1',
      instruction: 'crea un word con esta información e incorpora esta gráfica en un word en una pagina',
      fileIds: ['upload-1'],
      uploadsDir,
      storage,
    });
    assert.equal(out.applied, true);
    assert.equal(out.reason, 'previous_content_and_chart');
    assert.deepEqual(out.fileIds, ['upload-1', 'file-1']);
    assert.equal(out.chart.fileId, 'file-1');
    assert.equal(out.chart.filename, 'grafica-proyeccion-financiera-a-5-anos-2025-2029.png');
    // The File row is owned by the user and points at the PNG on disk.
    const row = prisma.created[0];
    assert.equal(row.userId, 'u1');
    assert.equal(row.mimeType, 'image/png');
    assert.equal(row.originalName, out.chart.filename);
    assert.ok(row.path.startsWith(uploadsDir));
    assert.deepEqual(fs.readFileSync(row.path).subarray(0, 8), PNG_SIGNATURE);
    assert.equal(row.size, fs.statSync(row.path).size);
    // The instruction carries the user's words, the previous body, the data
    // and an explicit order to insert the attached figure.
    assert.ok(out.instruction.startsWith('crea un word con esta información'));
    assert.match(out.instruction, /Formato requerido: docx\./);
    assert.match(out.instruction, /<SIRAGPT_SOURCE_CONTENT>[\s\S]*Punto de equilibrio: 2026[\s\S]*<\/SIRAGPT_SOURCE_CONTENT>/);
    assert.match(out.instruction, /Gráfica del mensaje anterior: «Proyección financiera a 5 años \(2025–2029\)» \(recharts\)/);
    assert.match(out.instruction, /\| 2025 \| 120 \| 18 \|/);
    assert.match(out.instruction, /GRÁFICA ADJUNTA: el archivo «grafica-proyeccion-financiera-a-5-anos-2025-2029\.png» \(en \/workspace\/uploads\)/);
    assert.match(out.instruction, /Insértala en el documento como imagen/);
  });

  test('a chart that cannot be rendered still ships its data and asks to recreate it', async () => {
    const prisma = fakePrisma({
      messages: [assistant('**Embudo**\n\nEtapas.', [{ type: 'viz', format: 'd3', title: 'Embudo', html: '<html></html>' }], 1)],
    });
    const out = await collectPreviousTurnContext({ prisma, userId: 'u1', chatId: 'chat-1', instruction: 'incorpora esta gráfica en un word', uploadsDir, storage });
    assert.equal(out.applied, true);
    assert.equal(out.chart, null);
    assert.equal(prisma.created.length, 0);
    assert.match(out.instruction, /Gráfica del mensaje anterior: «Embudo» \(d3\)/);
    assert.doesNotMatch(out.instruction, /GRÁFICA ADJUNTA/);
  });

  test('«ponlo en un word» exports the previous text without touching files', async () => {
    const prisma = fakePrisma({ messages: [assistant('El cálculo da 42 unidades, con un margen del 15 % sobre el costo base de 36.', null, 1)] });
    const out = await collectPreviousTurnContext({ prisma, userId: 'u1', chatId: 'chat-1', instruction: 'ponlo en un word', uploadsDir, storage });
    assert.equal(out.applied, true);
    assert.equal(out.reason, 'previous_content');
    assert.deepEqual(out.fileIds, []);
    assert.match(out.instruction, /<SIRAGPT_SOURCE_CONTENT>\nEl cálculo da 42 unidades/);
  });

  test('a new topic, a missing chat or a database error leave the instruction untouched', async () => {
    const newTopic = await collectPreviousTurnContext({ prisma: fakePrisma({ messages: [assistant('algo', [rechartsProjection])] }), userId: 'u1', chatId: 'chat-1', instruction: 'crea un word sobre la revolución francesa', uploadsDir, storage });
    assert.deepEqual(newTopic, { instruction: 'crea un word sobre la revolución francesa', fileIds: [], applied: false, sourceContent: null, chart: null, reason: 'not_referenced' });
    const otherChat = await collectPreviousTurnContext({ prisma: fakePrisma({ messages: [assistant('algo')] }), userId: 'u1', chatId: 'chat-9', instruction: 'ponlo en un word', uploadsDir, storage });
    assert.equal(otherChat.applied, false);
    assert.equal(otherChat.reason, 'no_assistant_turns');
    const broken = await collectPreviousTurnContext({ prisma: fakePrisma({ failChat: true }), userId: 'u1', chatId: 'chat-1', instruction: 'ponlo en un word', uploadsDir, storage, logger: { warn() {} } });
    assert.equal(broken.applied, false);
    assert.equal(broken.reason, 'chat_unreadable');
    assert.equal(broken.instruction, 'ponlo en un word');
  });
});
