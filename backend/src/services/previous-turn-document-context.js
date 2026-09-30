'use strict';

// Materialize figures from the SAME bounded source selected by the canonical
// conversation context. User instructions never contain previous source text.

const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');

const { normalizeForFollowup } = require('./document-followup-context');
const {
  refersToConversation, sourceFromMessages, rechartsData,
  MAX_SOURCE_MESSAGES, MAX_CHART_ROWS, MAX_CONTEXT_CHARS,
} = require('./agent-runner/conversation-context');

const MAX_TABLE_SERIES = 12;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILES_CHARS = 8 * 1024 * 1024;
const DEFAULT_UPLOADS_DIR = path.resolve(__dirname, '../../uploads/images');
const UPLOADS_ROOT = path.resolve(__dirname, '../../uploads');

const VISUAL_RE = /\b(?:gr[aá]fic[ao]s?|gr[aá]fica?s?\b|chart|charts|visualizaci[oó]n(?:es)?|diagrama|figura|plot|curva|barras|pastel|imagen|ilustraci[oó]n)\b/;

function referencesPriorTurn(prompt = '') {
  const content = refersToConversation(prompt);
  return { content, visual: content && VISUAL_RE.test(normalizeForFollowup(prompt)) };
}

function inferRequestedFormat(prompt = '') {
  const text = normalizeForFollowup(prompt);
  if (/\b(?:pdf)\b/.test(text)) return 'pdf';
  if (/\b(?:excel|xlsx|hoja de c[aá]lculo)\b/.test(text)) return 'xlsx';
  if (/\b(?:ppt|pptx|powerpoint|presentaci[oó]n|diapositivas?)\b/.test(text)) return 'pptx';
  return 'docx';
}

function toNumber(value) {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function labelOf(value) {
  return (typeof value === 'string' && value.length <= 500
    || typeof value === 'number' && Number.isFinite(value)) ? String(value) : null;
}

function safeColor(value) {
  return typeof value === 'string' && /^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value) ? value : undefined;
}

function boundedSeries(result) {
  if (!result || !result.labels.length || result.labels.length > MAX_CHART_ROWS
    || result.labels.some((label) => label === null)
    || !result.series.length || result.series.length > MAX_TABLE_SERIES
    || result.series.some((series) => typeof series.name !== 'string' || series.name.length > 200
      || series.values.length !== result.labels.length || series.values.some((value) => value === undefined))) return null;
  return JSON.stringify(result).length <= 18_000 ? result : null;
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
    const chart = rechartsData(file.chart);
    if (!chart) return null;
    const rows = chart.data;
    const kind = chart.type;
    if (kind === 'pie') {
      const labels = rows.map((row) => labelOf(row.name));
      const values = rows.map((row) => toNumber(row.value));
      return boundedSeries({ kind: 'pie', labels, series: [{ name: chart.series[0]?.name || 'Valor', values }] });
    }
    const labels = rows.map((row) => labelOf(row[chart.xKey]));
    const series = chart.series.map((s) => ({
      name: s.name || s.key, values: rows.map((row) => toNumber(row[s.key])),
      ...(safeColor(s.color) ? { color: safeColor(s.color) } : {}),
    }));
    return boundedSeries({ kind, labels, series, stacked: Boolean(chart.stacked) });
  }

  if (format === 'chartjs' && file.config && typeof file.config === 'object') {
    const config = file.config;
    const data = config.data && typeof config.data === 'object' ? config.data : {};
    const datasets = Array.isArray(data.datasets) ? data.datasets : [];
    if (!datasets.length || datasets.length > MAX_TABLE_SERIES || datasets.some((d) => !d || !Array.isArray(d.data))) return null;
    const kind = String(config.type || 'bar').toLowerCase();
    if (!['line', 'bar', 'pie', 'doughnut'].includes(kind) || datasets.some((d) => d.type && d.type !== kind)) return null;
    const first = datasets[0].data;
    if (!first.length || first.length > MAX_CHART_ROWS
      || datasets.some((dataset) => dataset.data.length !== first.length)) return null;
    const labels = Array.isArray(data.labels) && data.labels.length
      ? data.labels.map(labelOf)
      : first.map((point) => labelOf(point && typeof point === 'object' ? point.x : null));
    if (datasets.some((dataset) => dataset.data.some((point, i) => point && typeof point === 'object'
      && Object.hasOwn(point, 'x') && labelOf(point.x) !== labels[i]))) return null;
    const series = datasets.map((dataset, i) => ({
      name: String(dataset.label || `Serie ${i + 1}`),
      values: dataset.data.map((point) => toNumber(point && typeof point === 'object' ? point.y : point)),
      ...(safeColor(dataset.borderColor) ? { color: safeColor(dataset.borderColor) } : {}),
    }));
    const pie = kind === 'pie' || kind === 'doughnut';
    if (pie && series.length !== 1) return null;
    return boundedSeries({ kind: kind === 'doughnut' ? 'donut' : kind, labels, series,
      stacked: Boolean(config.options?.scales?.x?.stacked || config.options?.scales?.y?.stacked) });
  }

  if (format === 'plotly' && Array.isArray(file.data)) {
    const traces = file.data;
    if (!traces.length || traces.length > MAX_TABLE_SERIES || traces.some((t) => !t || typeof t !== 'object')) return null;
    const pie = traces.find((trace) => String(trace.type || '').toLowerCase() === 'pie' && Array.isArray(trace.values));
    if (pie) {
      if (traces.length !== 1 || !Array.isArray(pie.labels) || pie.values.length > MAX_CHART_ROWS) return null;
      return boundedSeries({ kind: 'pie', labels: pie.labels.map(labelOf), series: [{ name: pie.name || 'Valor', values: pie.values.map(toNumber) }] });
    }
    const xy = traces;
    if (xy.some((t) => !Array.isArray(t.y) || t.y.length > MAX_CHART_ROWS || !Array.isArray(t.x) || t.x.length !== t.y.length)) return null;
    const base = xy[0];
    const labels = base.x.map(labelOf);
    if (xy.some((t) => JSON.stringify(t.x.map(labelOf)) !== JSON.stringify(labels))) return null;
    const series = xy.map((trace, i) => ({ name: String(trace.name || `Serie ${i + 1}`), values: trace.y.map(toNumber), ...(safeColor(trace.line?.color || trace.marker?.color) ? { color: safeColor(trace.line?.color || trace.marker?.color) } : {}) }));
    const lineLike = xy.every((trace) => String(trace.type || 'scatter').toLowerCase() === 'scatter');
    if (!lineLike && !xy.every((t) => t.type === 'bar')) return null;
    const kind = lineLike ? (xy.some((t) => t.mode && !String(t.mode).includes('lines')) ? 'scatter' : 'line') : 'bar';
    return boundedSeries({ kind, labels, series });
  }

  return null;
}

function markdownTable(series) {
  if (!series || !series.labels?.length || !series.series?.length) return '';
  if (!boundedSeries(series)) return '';
  const rows = series.labels;
  const pie = series.kind === 'pie' || series.kind === 'donut';
  const head = ['Categoría', ...series.series.map((s) => s.name)];
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  rows.forEach((label, i) => {
    const values = pie
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
    const color = safeColor(s.color) || theme.palette[si % theme.palette.length];
    const points = s.values.map((v, i) => `${x(i).toFixed(1)},${y(Number.isFinite(v) ? v : minValue).toFixed(1)}`).join(' ');
    parts.push(`<polyline fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" points="${points}"/>`);
    s.values.forEach((v, i) => {
      parts.push(`<circle cx="${x(i).toFixed(1)}" cy="${y(Number.isFinite(v) ? v : minValue).toFixed(1)}" r="4" fill="${color}"/>`);
    });
  });
  const legendY = height - 34;
  let legendX = padLeft;
  series.forEach((s, si) => {
    const color = safeColor(s.color) || theme.palette[si % theme.palette.length];
    parts.push(`<rect x="${legendX}" y="${legendY - 10}" width="14" height="14" rx="3" fill="${color}"/>`);
    parts.push(`<text x="${legendX + 20}" y="${legendY + 2}" font-family="Arial, Helvetica, sans-serif" font-size="13" fill="${theme.text}">${esc(s.name)}</text>`);
    legendX += 40 + Math.min(220, s.name.length * 8);
  });
  parts.push('</svg>');
  return parts.join('');
}

function chartSpecFor(series, title) {
  if (!series) return null;
  if (series.kind === 'pie' || series.kind === 'donut') {
    return { type: series.kind, title, data: series.labels.map((label, i) => ({ label, value: series.series[0].values[i] })), width: 800, height: 480 };
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
  // Bound the encoded input before allocating decoded bytes. Do not let
  // Buffer.from silently ignore invalid characters or misplaced padding.
  if (typeof value !== 'string' || value.length > 64 + 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) return null;
  const match = value.match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match || match[2].length % 4 !== 0) return null;
  try {
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES || buffer.toString('base64') !== match[2]) return null;
    const ext = match[1].toLowerCase().replace('jpeg', 'jpg');
    const validSignature = ext === 'png'
      ? buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        && buffer.toString('ascii', 12, 16) === 'IHDR'
      : ext === 'jpg'
        ? buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
        : buffer.length >= 16 && buffer.toString('ascii', 0, 4) === 'RIFF'
          && buffer.toString('ascii', 8, 12) === 'WEBP';
    return validSignature ? { buffer, ext } : null;
  } catch {
    return null;
  }
}

async function readLocalUpload(url, { uploadsRoot = UPLOADS_ROOT, prisma, userId } = {}) {
  if (typeof url !== 'string' || url.length > 4096 || !userId || !prisma?.file?.findFirst) return null;
  // A foreign URL with an uploads-shaped pathname is not a local file ref.
  // Keep the path unnormalised until traversal and encoded separators are
  // rejected; URL() would otherwise remove dot segments before validation.
  const match = url.trim().match(/^\/(?:api\/)?uploads\/([^?#]+)(?:[?#].*)?$/);
  if (!match || /%(?:2f|5c)/i.test(match[1])) return null;
  let relative;
  try {
    relative = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const segments = relative.split('/');
  if (/[\\\x00-\x1f\x7f]/.test(relative) || segments.some((part) => !part || part === '.' || part === '..')) return null;
  const root = path.resolve(uploadsRoot);
  const full = path.resolve(root, relative);
  if (!full.startsWith(root + path.sep)) return null;
  let handle;
  try {
    // Ownership must be established by the exact stored path before any
    // bytes are read. A path in a chat message is never ownership evidence.
    const record = await prisma.file.findFirst({
      where: { userId, path: full },
      select: { id: true, userId: true, path: true, mimeType: true, size: true },
    });
    if (!record || record.userId !== userId || record.path !== full
      || !/^image\/(?:png|jpeg|webp)$/i.test(String(record.mimeType || ''))
      || !Number.isSafeInteger(record.size) || record.size <= 0 || record.size > MAX_IMAGE_BYTES) return null;
    const rootReal = await fs.realpath(root);
    let cursor = root;
    for (const part of segments) {
      cursor = path.join(cursor, part);
      if ((await fs.lstat(cursor)).isSymbolicLink()) return null;
    }
    const real = await fs.realpath(full);
    if (real !== path.join(rootReal, relative) || !real.startsWith(rootReal + path.sep)) return null;
    const before = await fs.lstat(full);
    if (!before.isFile() || before.size !== record.size) return null;
    const { O_RDONLY, O_NOFOLLOW } = require('fs').constants;
    handle = await fs.open(full, O_RDONLY | O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== record.size) return null;
    const current = await fs.lstat(full);
    if (current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino
      || await fs.realpath(full) !== real) return null;
    // Read at most the approved size plus one byte, including when a file
    // grows concurrently. The open descriptor remains bound to this inode.
    const bytes = Buffer.alloc(opened.size + 1);
    let read = 0;
    while (read < bytes.length) {
      const result = await handle.read(bytes, read, bytes.length - read, read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    if (read !== opened.size || (await handle.stat()).size !== opened.size) return null;
    return decodeDataUrl(`data:${record.mimeType.toLowerCase()};base64,${bytes.subarray(0, read).toString('base64')}`);
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Render the chart file to image bytes. Returns { buffer, ext } or null when
 * the renderer cannot be reproduced server-side (d3 HTML, mermaid.ink).
 */
async function materializeChartImage(file, { uploadsRoot, visualEmbed, prisma, userId } = {}) {
  if (!isChartFile(file)) return null;
  const structured = ['recharts', 'chartjs', 'plotly'].includes(file.format);
  if (!structured) {
    const image = decodeDataUrl(file.imageUrl || file.url)
      || await readLocalUpload(file.imageUrl || file.url, { uploadsRoot, prisma, userId });
    if (image) {
      try {
        const meta = await require('sharp')(image.buffer, { limitInputPixels: 40_000_000 }).metadata();
        if (meta.width > 0 && meta.height > 0 && meta.width * meta.height <= 40_000_000
          && ['png', 'jpeg', 'webp'].includes(meta.format)) return image;
      } catch { /* invalid or excessively large raster */ }
    }
  }
  const series = extractSeries(file);
  // The existing SVG renderer coerces missing values to zero. Leave complete
  // structured data to the document agent when it cannot render faithfully.
  if (!series || !['line', 'bar', 'pie', 'donut'].includes(series.kind)
    || series.series.some((s) => s.values.some((value) => !Number.isFinite(value)))) return null;
  // These fixed-size SVG layouts neither wrap labels nor paginate legends.
  // Do not attach a lossy picture: the complete canonical data remains
  // available to the document agent for a faithful rendering instead.
  if (series.kind === 'bar') {
    const grouped = series.series.length > 1;
    if (series.series.some((s) => s.values.some((value) => value < 0))
      || series.labels.some((label) => label.length > (grouped ? 12 : 14))
      || grouped && (series.series.some((s) => s.name.length > 18)
        || series.series.reduce((width, s) => width + 40 + s.name.length * 7, 56) > 876)) return null;
  }
  if (series.kind === 'pie' || series.kind === 'donut') {
    const legendTop = file.title ? 64 : 36;
    if (series.labels.length < 2
      || series.labels.some((label) => label.length > 20)
      || series.series[0].values.some((value) => value <= 0)
      || legendTop + (series.labels.length - 1) * 22 + 14 > 480) return null;
  }
  if (series.kind === 'line') {
    const longestLabel = Math.max(...series.labels.map((label) => label.length));
    if (series.series.some((s) => s.name.length > 27)
      || series.series.reduce((width, s) => width + 40 + s.name.length * 8, 72) > 868
      || longestLabel * 8 > 796 / Math.max(1, series.labels.length - 1)
      || series.labels.at(-1).length * 4 > 32) return null;
  }
  const embed = visualEmbed || require('./document-visual-embed');
  const theme = embed.INTERNAL?.resolveTheme ? embed.INTERNAL.resolveTheme('corporate') : null;
  if (series.kind === 'line' && !theme) return null;
  const title = String(file.title || '').trim().slice(0, 400);
  let svg;
  if (series.kind === 'line' && theme) {
    svg = buildMultiLineSvg({ title, labels: series.labels, series: series.series, theme });
  } else {
    const spec = chartSpecFor(series, title);
    if (!spec) return null;
    svg = embed.buildChartSvg(spec);
    if (theme && series.kind === 'bar') {
      // The shared renderer accepts named themes. Replace only color
      // attributes, not source labels, to retain explicit series colors.
      svg = svg.replace(/(fill|stroke)="(#[a-f\d]+)"/gi, (match, attr, color) => {
        const index = theme.palette.findIndex((candidate) => candidate.toLowerCase() === color.toLowerCase());
        return index >= 0 && safeColor(series.series[index]?.color)
          ? `${attr}="${series.series[index].color}"` : match;
      });
    }
  }
  const buffer = await embed.svgToPng(svg, { density: 144 });
  return buffer && buffer.length && buffer.length <= MAX_IMAGE_BYTES ? { buffer, ext: 'png' } : null;
}

function slugify(value) {
  return normalizeForFollowup(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

async function storeChartFile({ prisma, userId, image, title, nameIndex = 1, uploadsDir = DEFAULT_UPLOADS_DIR, storage }) {
  const objectStorage = storage || require('./object-storage');
  const base = slugify(title) || 'grafica';
  const originalName = `grafica-${base}${nameIndex > 1 ? `-${nameIndex}` : ''}.${image.ext}`;
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
        select: { id: true, role: true, content: true, files: true, metadata: true },
        orderBy: { timestamp: 'desc' },
        take: MAX_SOURCE_MESSAGES,
      },
    },
  });
  return Array.isArray(chat?.messages) ? chat.messages : [];
}

function sourceFiles(value) {
  if (!value) return { files: [], incomplete: false };
  try {
    if (typeof value === 'string' && value.length > MAX_FILES_CHARS) return { files: [], incomplete: true };
    const files = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(files)
      ? { files: files.slice(0, 8), incomplete: files.length > 8 }
      : { files: [], incomplete: true };
  } catch { return { files: [], incomplete: true }; }
}

function canonicalChartFile(file) {
  if (!isChartFile(file)) return file;
  const basic = { type: 'viz', format: file.format, title: file.title, explanation: file.explanation };
  if (file.format === 'recharts') return { ...basic, chart: file.chart };
  const series = extractSeries(file);
  if (!series) return basic;
  const pie = series.kind === 'pie' || series.kind === 'donut';
  return {
    ...basic, format: 'recharts',
    chart: {
      type: pie ? 'pie' : series.kind,
      xKey: pie ? undefined : 'category',
      series: series.series.map((s, index) => ({ key: pie ? 'value' : `series_${index}`, name: s.name, ...(s.color ? { color: s.color } : {}) })),
      data: series.labels.map((label, row) => pie
        ? { name: label, value: series.series[0].values[row] }
        : Object.fromEntries([['category', label], ...series.series.map((s, index) => [`series_${index}`, s.values[row]])])),
      stacked: series.stacked === true,
    },
  };
}

function fitContext(context) {
  const size = () => JSON.stringify(context).replace(/[<>&]/g, '\\u0000').length;
  while (size() > MAX_CONTEXT_CHARS && context.content.length) {
    context.content = context.content.slice(0, Math.max(0, context.content.length - 1000));
    context.incomplete = true;
  }
  while (size() > MAX_CONTEXT_CHARS && context.visualizations.length) {
    context.visualizations.pop();
    context.incomplete = true;
  }
  return context;
}

/**
 * Keep the active instruction unchanged; prior content is an untrusted data
 * snapshot. Materialize only figures belonging to that exact source message.
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
  const prompt = String(instruction || '');
  const baseIds = Array.isArray(fileIds) ? fileIds.filter((id) => typeof id === 'string' && id.trim()) : [];
  const untouched = { instruction: prompt, fileIds: baseIds, applied: false, sourceContent: null, conversationContext: null, chart: null, reason: 'not_referenced' };
  if (!prompt.trim() || !prisma || !userId || !chatId) return { ...untouched, reason: 'missing_context' };
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

  const selected = sourceFromMessages(messages, prompt);
  // IDs come from the ownership-scoped query, never from a client selection.
  const sourceMessage = selected?.sourceMessageId
    ? messages.find((message) => message.id === selected.sourceMessageId) : null;
  if (!sourceMessage) return { ...untouched, reason: 'no_source_content' };
  const parsed = sourceFiles(sourceMessage.files);
  const context = sourceFromMessages([{ ...sourceMessage, files: parsed.files.map(canonicalChartFile) }], prompt);
  if (!context) return { ...untouched, reason: 'no_source_content' };
  context.incomplete ||= parsed.incomplete;
  const attached = [];
  let chart = null;
  for (const file of parsed.files.filter(isChartFile)) {
    if (attached.length >= 2) { context.incomplete = true; break; }
    try {
      const image = await materializeChartImage(file, { uploadsRoot, visualEmbed, prisma, userId });
      if (image) {
        const stored = await storeChartFile({ prisma, userId, image, title: file.title, nameIndex: attached.length + 1, uploadsDir, storage });
        chart ||= { ...stored, title: String(file.title || '').slice(0, 400) };
        attached.push({
          fileId: String(stored.fileId).slice(0, 120),
          filename: stored.filename,
          sourceMessageId: context.sourceMessageId,
          title: String(file.title || '').slice(0, 400),
          format: 'image',
        });
      }
    } catch (err) {
      try { logger.warn?.('[document-turn-context] no pude materializar la gráfica:', err?.message || err); } catch (_) { /* ignore */ }
    }
  }

  if (attached.length) context.attachedVisualizations = attached;
  fitContext(context);

  return {
    instruction: prompt,
    fileIds: [...new Set([...baseIds, ...attached.map((image) => image.fileId)])],
    applied: true,
    sourceContent: context.content,
    conversationContext: context,
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
    storeChartFile,
    slugify,
  },
};
