'use strict';

// previous-turn-document-context.js — «crea un word con esta información e incorpora
// esta gráfica»: the previous assistant turn (its text AND its chart) must
// reach the AgentRunner, on both document entry points (agent task + doc
// route). Before this module the runner only received the bare instruction
// and worked blind: it exhausted its steps without a verified file.
//
// What it does (best-effort, never throws):
//   1. Detects that the request points at the previous turn («esta
//      información», «esta gráfica», «el resultado anterior»…).
//   2. Loads the chat's latest assistant messages (owner-scoped).
//   3. Text: the previous answer (document-followup-context) plus a
//      description of the latest visualisation (title, explanation, data
//      table) so the model can write the body of the document.
//   4. Chart: the latest `viz` / `chart` file is rendered to a real PNG
//      (matplotlib data URL, a local chart image, or a recharts / chartjs /
//      plotly spec drawn with document-visual-embed + sharp), stored as an
//      owned File row and added to the turn's fileIds — the sandbox then
//      sees it under /workspace/uploads and python-docx can insert it.
//   5. Returns the enriched instruction (SOURCE_CONTENT block + a line that
//      names the attached figure) and the merged fileIds.

const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');

const {
  findPreviousAssistantContent,
  buildPreviousContentDocumentPrompt,
  cleanAssistantContentForDocument,
  normalizeForFollowup,
  INTERNAL: followupInternals,
} = require('./document-followup-context');

const MAX_ASSISTANT_MESSAGES = 16;
const MAX_TABLE_ROWS = 60;
const MAX_TABLE_SERIES = 8;
const MAX_SNIPPET_CHARS = 4_000;
const DEFAULT_UPLOADS_DIR = path.resolve(__dirname, '../../uploads/images');
const UPLOADS_ROOT = path.resolve(__dirname, '../../uploads');

// «esta / esa / la anterior / que generaste / de arriba…» — the request is
// about something already in the conversation, not a new topic.
const DEICTIC_RE = /\b(?:est[aeo]s?|es[aeo]s?|dich[ao]s?|mism[ao]s?|anterior(?:es)?|previ[ao]s?|de arriba|arriba|(?:que|lo que)\s+(?:generaste|hiciste|creaste|calculaste|mostraste|graficaste|acabas de (?:hacer|crear|generar))|ya (?:generad[ao]|hech[ao]|cread[ao])|reci[eé]n (?:generad[ao]|cread[ao]))\b/;
const VISUAL_RE = /\b(?:gr[aá]fic[ao]s?|gr[aá]fica?s?\b|chart|charts|visualizaci[oó]n(?:es)?|diagrama|figura|plot|curva|barras|pastel|imagen|ilustraci[oó]n)\b/;
const CONTENT_RE = /\b(?:informaci[oó]n|contenido|texto|resultados?|c[aá]lculos?|respuesta|datos|an[aá]lisis|proyecci[oó]n|tabla|resumen|explicaci[oó]n|desarrollo|todo lo (?:anterior|que))\b/;
// «ponlo / pásalo / insértala / expórtalo en un word»: the pronoun IS the
// previous answer (or its chart).
const PRONOUN_VERB_RE = /\b(?:pon|pas|coloc|met|insert|incorpor|export|conviert|convert|guard|descarg|prepar|transform|llev|agreg|añad|anad|inclu)(?:a|e|ga|ya)?l[oa]s?\b/;

function referencesPriorTurn(prompt = '') {
  const text = normalizeForFollowup(prompt);
  if (!text) return { content: false, visual: false };
  const pronounVerb = PRONOUN_VERB_RE.test(text);
  const deictic = DEICTIC_RE.test(text) || pronounVerb;
  const visual = deictic && VISUAL_RE.test(text);
  const content = (deictic && (CONTENT_RE.test(text) || visual)) || pronounVerb;
  return { content, visual };
}

function inferRequestedFormat(prompt = '') {
  const text = normalizeForFollowup(prompt);
  if (/\b(?:pdf)\b/.test(text)) return 'pdf';
  if (/\b(?:excel|xlsx|hoja de c[aá]lculo)\b/.test(text)) return 'xlsx';
  if (/\b(?:ppt|pptx|powerpoint|presentaci[oó]n|diapositivas?)\b/.test(text)) return 'pptx';
  return 'docx';
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.replace(/[^0-9.,+-]/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function labelOf(value, index) {
  if (value === null || value === undefined || value === '') return `Ítem ${index + 1}`;
  return String(value);
}

function isChartFile(file) {
  if (!file || typeof file !== 'object') return false;
  const type = String(file.type || '').toLowerCase();
  return type === 'viz' || type === 'chart';
}

/**
 * Normalise every renderer's payload into { kind, labels, series } where
 * series = [{ name, values }]. Returns null when the spec carries no data.
 */
function extractSeries(file) {
  if (!file || typeof file !== 'object') return null;
  const format = String(file.format || '').toLowerCase();

  if (format === 'recharts' && file.chart && typeof file.chart === 'object') {
    const chart = file.chart;
    const rows = Array.isArray(chart.data) ? chart.data.filter((row) => row && typeof row === 'object') : [];
    if (!rows.length) return null;
    const kind = String(chart.type || 'bar').toLowerCase();
    if (kind === 'pie') {
      const labels = rows.map((row, i) => labelOf(row.name ?? row.label ?? row[chart.xKey], i));
      const values = rows.map((row) => toNumber(row.value ?? row.y) ?? 0);
      return { kind: 'pie', labels, series: [{ name: file.title || 'Valor', values }] };
    }
    const xKey = chart.xKey || Object.keys(rows[0]).find((key) => typeof rows[0][key] === 'string') || Object.keys(rows[0])[0];
    const declared = Array.isArray(chart.series) ? chart.series.filter((s) => s && s.key) : [];
    const keys = declared.length
      ? declared.map((s) => ({ key: s.key, name: s.name || s.key }))
      : Object.keys(rows[0]).filter((key) => key !== xKey && toNumber(rows[0][key]) !== null).map((key) => ({ key, name: key }));
    if (!keys.length) return null;
    const labels = rows.map((row, i) => labelOf(row[xKey], i));
    const series = keys.slice(0, MAX_TABLE_SERIES).map((s) => ({ name: String(s.name), values: rows.map((row) => toNumber(row[s.key]) ?? 0) }));
    return { kind: kind === 'area' ? 'line' : kind, labels, series, stacked: Boolean(chart.stacked) };
  }

  if (format === 'chartjs' && file.config && typeof file.config === 'object') {
    const config = file.config;
    const data = config.data && typeof config.data === 'object' ? config.data : {};
    const datasets = Array.isArray(data.datasets) ? data.datasets.filter((d) => d && Array.isArray(d.data)) : [];
    if (!datasets.length) return null;
    const kind = String(config.type || 'bar').toLowerCase();
    const first = datasets[0].data;
    const labels = Array.isArray(data.labels) && data.labels.length
      ? data.labels.map((label, i) => labelOf(label, i))
      : first.map((point, i) => labelOf(point && typeof point === 'object' ? point.x : null, i));
    const series = datasets.slice(0, MAX_TABLE_SERIES).map((dataset, i) => ({
      name: String(dataset.label || `Serie ${i + 1}`),
      values: dataset.data.map((point) => toNumber(point && typeof point === 'object' ? point.y : point) ?? 0),
    }));
    const pie = kind === 'pie' || kind === 'doughnut';
    return { kind: pie ? 'pie' : kind === 'line' ? 'line' : 'bar', labels, series: pie ? series.slice(0, 1) : series };
  }

  if (format === 'plotly' && Array.isArray(file.data)) {
    const traces = file.data.filter((trace) => trace && typeof trace === 'object');
    if (!traces.length) return null;
    const pie = traces.find((trace) => String(trace.type || '').toLowerCase() === 'pie' && Array.isArray(trace.values));
    if (pie) {
      const labels = (Array.isArray(pie.labels) ? pie.labels : pie.values).map((label, i) => labelOf(label, i));
      return { kind: 'pie', labels, series: [{ name: pie.name || file.title || 'Valor', values: pie.values.map((v) => toNumber(v) ?? 0) }] };
    }
    const xy = traces.filter((trace) => Array.isArray(trace.y));
    if (!xy.length) return null;
    const base = xy[0];
    const labels = (Array.isArray(base.x) ? base.x : base.y).map((label, i) => labelOf(label, i));
    const series = xy.slice(0, MAX_TABLE_SERIES).map((trace, i) => ({ name: String(trace.name || `Serie ${i + 1}`), values: trace.y.map((v) => toNumber(v) ?? 0) }));
    const lineLike = xy.every((trace) => String(trace.type || 'scatter').toLowerCase() === 'scatter');
    return { kind: lineLike ? 'line' : 'bar', labels, series };
  }

  return null;
}

function markdownTable(series) {
  if (!series || !series.labels?.length || !series.series?.length) return '';
  const rows = series.labels.slice(0, MAX_TABLE_ROWS);
  const head = series.kind === 'pie' ? ['Categoría', 'Valor'] : ['Categoría', ...series.series.map((s) => s.name)];
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  rows.forEach((label, i) => {
    const values = series.kind === 'pie'
      ? [series.series[0].values[i]]
      : series.series.map((s) => s.values[i]);
    lines.push(`| ${[label, ...values.map((v) => (Number.isFinite(v) ? String(v) : ''))].join(' | ')} |`);
  });
  return lines.join('\n');
}

// Multi-series line chart: document-visual-embed only draws single-series
// lines, and a projection with several series drawn as grouped bars would
// not be «la misma gráfica».
function buildMultiLineSvg({ title, labels, series, theme }) {
  const width = 900;
  const height = 480;
  const padTop = title ? 60 : 32;
  const padBottom = 92;
  const padLeft = 72;
  const padRight = 32;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const allValues = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  const maxValue = Math.max(1, ...allValues);
  const minValue = Math.min(0, ...allValues);
  const range = maxValue - minValue || 1;
  const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const x = (i) => padLeft + (labels.length === 1 ? plotW / 2 : (plotW * i) / (labels.length - 1));
  const y = (v) => padTop + plotH - ((v - minValue) / range) * plotH;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${theme.bg}"/>`,
  ];
  if (title) parts.push(`<text x="${width / 2}" y="34" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="700" fill="${theme.text}">${esc(title)}</text>`);
  for (let i = 0; i <= 4; i += 1) {
    const gy = padTop + (plotH * i) / 4;
    const value = maxValue - (range * i) / 4;
    parts.push(`<line x1="${padLeft}" y1="${gy.toFixed(1)}" x2="${width - padRight}" y2="${gy.toFixed(1)}" stroke="${theme.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${padLeft - 10}" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="12" fill="${theme.axis}">${esc(Number.isInteger(value) ? value : value.toFixed(1))}</text>`);
  }
  labels.forEach((label, i) => {
    parts.push(`<text x="${x(i).toFixed(1)}" y="${(padTop + plotH + 22).toFixed(1)}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="12" fill="${theme.axis}">${esc(label)}</text>`);
  });
  series.forEach((s, si) => {
    const color = theme.palette[si % theme.palette.length];
    const points = s.values.map((v, i) => `${x(i).toFixed(1)},${y(Number.isFinite(v) ? v : minValue).toFixed(1)}`).join(' ');
    parts.push(`<polyline fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" points="${points}"/>`);
    s.values.forEach((v, i) => {
      parts.push(`<circle cx="${x(i).toFixed(1)}" cy="${y(Number.isFinite(v) ? v : minValue).toFixed(1)}" r="4" fill="${color}"/>`);
    });
  });
  const legendY = height - 34;
  let legendX = padLeft;
  series.forEach((s, si) => {
    const color = theme.palette[si % theme.palette.length];
    parts.push(`<rect x="${legendX}" y="${legendY - 10}" width="14" height="14" rx="3" fill="${color}"/>`);
    parts.push(`<text x="${legendX + 20}" y="${legendY + 2}" font-family="Arial, Helvetica, sans-serif" font-size="13" fill="${theme.text}">${esc(s.name)}</text>`);
    legendX += 40 + Math.min(220, s.name.length * 8);
  });
  parts.push('</svg>');
  return parts.join('');
}

function chartSpecFor(series, title) {
  if (!series) return null;
  if (series.kind === 'pie') {
    return { type: 'pie', title, data: series.labels.map((label, i) => ({ label, value: series.series[0].values[i] })), width: 800, height: 480 };
  }
  if (series.series.length === 1) {
    return {
      type: series.kind === 'line' ? 'line' : 'bar',
      title,
      data: series.labels.map((label, i) => ({ label, value: series.series[0].values[i] })),
      width: 900,
      height: 480,
    };
  }
  return {
    type: series.stacked ? 'stacked' : 'grouped',
    title,
    labels: series.labels,
    series: series.series.map((s) => ({ name: s.name, values: s.values })),
    width: 900,
    height: 480,
  };
}

function decodeDataUrl(value) {
  const match = String(value || '').match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return null;
  try {
    const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
    return buffer.length ? { buffer, ext: match[1].toLowerCase() === 'png' ? 'png' : match[1].toLowerCase().replace('jpeg', 'jpg') } : null;
  } catch {
    return null;
  }
}

async function readLocalUpload(url, { uploadsRoot = UPLOADS_ROOT } = {}) {
  let pathname = String(url || '').trim();
  if (!pathname) return null;
  try {
    pathname = new URL(pathname, 'https://siragpt.local').pathname;
  } catch {
    return null;
  }
  const match = pathname.match(/^\/(?:api\/)?uploads\/(.+)$/);
  if (!match) return null;
  const full = path.resolve(uploadsRoot, match[1]);
  if (!full.startsWith(uploadsRoot + path.sep)) return null;
  try {
    const buffer = await fs.readFile(full);
    return buffer.length ? { buffer, ext: path.extname(full).replace('.', '').toLowerCase() || 'png' } : null;
  } catch {
    return null;
  }
}

/**
 * Render the chart file to image bytes. Returns { buffer, ext } or null when
 * the renderer cannot be reproduced server-side (d3 HTML, mermaid.ink).
 */
async function materializeChartImage(file, { uploadsRoot, visualEmbed } = {}) {
  if (!isChartFile(file)) return null;
  const direct = decodeDataUrl(file.imageUrl || file.url);
  if (direct) return direct;
  if (file.imageUrl || file.url) {
    const local = await readLocalUpload(file.imageUrl || file.url, { uploadsRoot });
    if (local) return local;
  }
  const series = extractSeries(file);
  if (!series) return null;
  const embed = visualEmbed || require('./document-visual-embed');
  const theme = embed.INTERNAL?.resolveTheme ? embed.INTERNAL.resolveTheme('corporate') : null;
  const title = String(file.title || '').trim();
  let svg;
  if (series.kind === 'line' && series.series.length > 1 && theme) {
    svg = buildMultiLineSvg({ title, labels: series.labels, series: series.series, theme });
  } else {
    const spec = chartSpecFor(series, title);
    if (!spec) return null;
    svg = embed.buildChartSvg(spec);
  }
  const buffer = await embed.svgToPng(svg, { density: 144 });
  return buffer && buffer.length ? { buffer, ext: 'png' } : null;
}

function describeChartFile(file, series) {
  const lines = [];
  const title = String(file.title || '').trim();
  const format = String(file.format || file.type || '').trim();
  lines.push(`Gráfica del mensaje anterior${title ? `: «${title}»` : ''}${format ? ` (${format})` : ''}.`);
  const explanation = String(file.explanation || '').trim();
  if (explanation) lines.push(explanation);
  const table = markdownTable(series);
  if (table) {
    lines.push('', 'Datos de la gráfica:', table);
  } else if (file.code) {
    lines.push('', 'Definición del diagrama:', '```', String(file.code).slice(0, MAX_SNIPPET_CHARS), '```');
  } else if (file.pythonCode) {
    lines.push('', 'Código que generó la figura:', '```python', String(file.pythonCode).slice(0, MAX_SNIPPET_CHARS), '```');
  }
  return lines.join('\n');
}

function slugify(value) {
  return normalizeForFollowup(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

async function storeChartFile({ prisma, userId, image, title, uploadsDir = DEFAULT_UPLOADS_DIR, storage }) {
  const objectStorage = storage || require('./object-storage');
  const base = slugify(title) || 'grafica';
  const originalName = `grafica-${base}.${image.ext}`;
  const filename = `grafica-${base}-${crypto.randomBytes(4).toString('hex')}.${image.ext}`;
  await fs.mkdir(uploadsDir, { recursive: true });
  const localPath = path.join(uploadsDir, filename);
  await fs.writeFile(localPath, image.buffer, { flag: 'wx' });
  let stored;
  try {
    stored = await objectStorage.persistLocalFile({ localPath, key: `uploads/images/${filename}`, contentType: `image/${image.ext === 'jpg' ? 'jpeg' : image.ext}` });
  } catch {
    stored = { ref: localPath };
  }
  const record = await prisma.file.create({
    data: {
      userId,
      filename,
      originalName,
      mimeType: `image/${image.ext === 'jpg' ? 'jpeg' : image.ext}`,
      size: image.buffer.length,
      path: stored?.ref || localPath,
    },
  });
  return { fileId: record.id, filename: originalName, url: `/uploads/images/${filename}` };
}

async function loadRecentAssistantMessages(prisma, { userId, chatId }) {
  if (!prisma?.chat?.findFirst || !userId || !chatId) return [];
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, userId },
    select: {
      messages: {
        where: { deletedAt: null, role: 'ASSISTANT' },
        select: { role: true, content: true, files: true, timestamp: true },
        orderBy: { timestamp: 'desc' },
        take: MAX_ASSISTANT_MESSAGES,
      },
    },
  });
  return Array.isArray(chat?.messages) ? chat.messages : [];
}

function latestChartMessage(messages) {
  for (const message of messages) {
    const files = followupInternals.parseFiles(message?.files);
    const chart = files.find(isChartFile);
    if (chart) return { message, chart };
  }
  return null;
}

/**
 * Enrich a document instruction with the previous turn. Returns the original
 * instruction/fileIds (applied=false) when the request is not about the
 * previous turn or nothing usable was found. Never throws.
 */
async function collectPreviousTurnContext({
  prisma,
  userId,
  chatId,
  instruction,
  fileIds = [],
  uploadsDir,
  uploadsRoot,
  storage,
  visualEmbed,
  logger = console,
} = {}) {
  const prompt = String(instruction || '').trim();
  const baseIds = Array.isArray(fileIds) ? fileIds.filter((id) => typeof id === 'string' && id.trim()) : [];
  const untouched = { instruction: prompt, fileIds: baseIds, applied: false, sourceContent: null, chart: null, reason: 'not_referenced' };
  if (!prompt || !prisma || !userId || !chatId) return { ...untouched, reason: 'missing_context' };
  const refs = referencesPriorTurn(prompt);
  if (!refs.content && !refs.visual) return untouched;

  let messages;
  try {
    messages = await loadRecentAssistantMessages(prisma, { userId, chatId });
  } catch (err) {
    try { logger.warn?.('[document-turn-context] no pude leer el chat:', err?.message || err); } catch (_) { /* ignore */ }
    return { ...untouched, reason: 'chat_unreadable' };
  }
  if (!messages.length) return { ...untouched, reason: 'no_assistant_turns' };

  const chartHit = latestChartMessage(messages);
  const sections = [];
  let chart = null;
  let series = null;
  if (chartHit && (refs.visual || messages[0] === chartHit.message)) {
    series = extractSeries(chartHit.chart);
    sections.push(describeChartFile(chartHit.chart, series));
    try {
      const image = await materializeChartImage(chartHit.chart, { uploadsRoot, visualEmbed });
      if (image) {
        chart = await storeChartFile({ prisma, userId, image, title: chartHit.chart.title, uploadsDir, storage });
        chart.title = String(chartHit.chart.title || '').trim();
      }
    } catch (err) {
      try { logger.warn?.('[document-turn-context] no pude materializar la gráfica:', err?.message || err); } catch (_) { /* ignore */ }
    }
  }

  const previousText = findPreviousAssistantContent(messages);
  if (previousText) sections.push(previousText);
  if (!sections.length && chartHit) {
    // The chart message itself is the only content: its text is short but
    // still the best body we have.
    const cleaned = cleanAssistantContentForDocument(chartHit.message);
    if (cleaned) sections.push(cleaned);
  }
  if (!sections.length) return { ...untouched, reason: 'no_source_content' };

  const sourceContent = sections.join('\n\n');
  const format = inferRequestedFormat(prompt);
  let enriched = buildPreviousContentDocumentPrompt({ prompt, sourceContent, format });
  if (chart) {
    enriched += [
      '',
      '',
      `GRÁFICA ADJUNTA: el archivo «${chart.filename}» (en /workspace/uploads) es la gráfica${chart.title ? ` «${chart.title}»` : ''} del mensaje anterior, ya renderizada como imagen.`,
      'Insértala en el documento como imagen (ancho de página, centrada, con su título como pie de figura) en el lugar donde el texto la menciona; no la describas en lugar de insertarla y no generes otra distinta.',
    ].join('\n');
  } else if (chartHit && series) {
    enriched += [
      '',
      '',
      'La gráfica del mensaje anterior no pudo adjuntarse como imagen: recréala en el documento a partir de la tabla de datos incluida en el contenido fuente (misma serie, mismos valores, mismo título).',
    ].join('\n');
  }

  return {
    instruction: enriched,
    fileIds: chart ? [...baseIds, chart.fileId] : baseIds,
    applied: true,
    sourceContent,
    chart,
    reason: chart ? 'previous_content_and_chart' : 'previous_content',
  };
}

module.exports = {
  collectPreviousTurnContext,
  referencesPriorTurn,
  inferRequestedFormat,
  extractSeries,
  markdownTable,
  materializeChartImage,
  INTERNAL: {
    isChartFile,
    chartSpecFor,
    buildMultiLineSvg,
    decodeDataUrl,
    readLocalUpload,
    describeChartFile,
    storeChartFile,
    latestChartMessage,
    slugify,
  },
};
