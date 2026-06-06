'use strict';

// document-visual-embed.js — design tooling for the source-preserving editor.
//
// Generates professional chart/diagram SVGs, rasterizes them to PNG with sharp,
// and embeds the image into an existing DOCX (Open XML: media + relationship +
// inline <w:drawing>) WITHOUT altering the rest of the document. This is the
// building block for "insert a chart/diagram into my document" requests.

const PizZip = require('pizzip');

let sharpModule = null;
function getSharp() {
  if (sharpModule === null) {
    try {
      // eslint-disable-next-line global-require
      sharpModule = require('sharp');
    } catch {
      sharpModule = false;
    }
  }
  return sharpModule || null;
}

const EMU_PER_PIXEL = 9525; // 96 dpi
const MAX_CONTENT_WIDTH_EMU = 5486400; // ~6 in usable page width

const THEMES = {
  corporate: { palette: ['#2563eb', '#0ea5e9', '#14b8a6', '#6366f1', '#8b5cf6', '#0891b2', '#1d4ed8'], axis: '#475569', grid: '#e2e8f0', text: '#0f172a', bg: '#ffffff' },
  vivid: { palette: ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#a855f7', '#ec4899', '#22d3ee'], axis: '#334155', grid: '#e5e7eb', text: '#111827', bg: '#ffffff' },
  slate: { palette: ['#0f172a', '#334155', '#64748b', '#94a3b8', '#cbd5e1', '#475569', '#1e293b'], axis: '#475569', grid: '#e2e8f0', text: '#0f172a', bg: '#ffffff' },
  forest: { palette: ['#166534', '#15803d', '#22c55e', '#4ade80', '#84cc16', '#10b981', '#059669'], axis: '#3f6212', grid: '#dcfce7', text: '#14532d', bg: '#ffffff' },
};

function resolveTheme(name) {
  return THEMES[String(name || '').toLowerCase()] || THEMES.corporate;
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

// Normalize {labels, values} | [{label,value}] | [numbers] into a clean series.
function normalizeData(data) {
  if (!data) return [];
  if (Array.isArray(data)) {
    return data
      .map((item, index) => {
        if (item && typeof item === 'object') {
          return { label: String(item.label ?? item.name ?? `Ítem ${index + 1}`), value: toNumber(item.value ?? item.y ?? item.count, 0) };
        }
        return { label: `Ítem ${index + 1}`, value: toNumber(item, 0) };
      })
      .filter((point) => Number.isFinite(point.value));
  }
  if (typeof data === 'object' && Array.isArray(data.labels) && Array.isArray(data.values)) {
    return data.labels.map((label, index) => ({ label: String(label), value: toNumber(data.values[index], 0) }));
  }
  return [];
}

function svgHeader(width, height, theme) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">`
    + `<rect x="0" y="0" width="${width}" height="${height}" fill="${theme.bg}"/>`;
}

function svgTitle(title, width, theme) {
  if (!title) return '';
  return `<text x="${width / 2}" y="30" text-anchor="middle" font-size="18" font-weight="700" fill="${theme.text}">${xmlEscape(title)}</text>`;
}

function buildBarChartSvg({ data, title, width, height, theme, horizontal = false }) {
  const points = normalizeData(data);
  const padTop = title ? 56 : 28;
  const padBottom = 64;
  const padLeft = 56;
  const padRight = 24;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const maxValue = Math.max(1, ...points.map((p) => p.value));
  const parts = [svgHeader(width, height, theme), svgTitle(title, width, theme)];

  // gridlines (4 steps)
  for (let i = 0; i <= 4; i += 1) {
    const y = padTop + (plotH * i) / 4;
    parts.push(`<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}" stroke="${theme.grid}" stroke-width="1"/>`);
    const labelValue = (maxValue * (4 - i)) / 4;
    parts.push(`<text x="${padLeft - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${theme.axis}">${labelValue.toFixed(maxValue >= 10 ? 0 : 1)}</text>`);
  }

  const slot = plotW / Math.max(1, points.length);
  const barW = Math.max(6, slot * 0.6);
  points.forEach((point, index) => {
    const color = theme.palette[index % theme.palette.length];
    const barH = (point.value / maxValue) * plotH;
    const x = padLeft + slot * index + (slot - barW) / 2;
    const y = padTop + plotH - barH;
    parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, barH).toFixed(1)}" rx="3" fill="${color}"/>`);
    parts.push(`<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="600" fill="${theme.text}">${xmlEscape(String(point.value))}</text>`);
    parts.push(`<text x="${(x + barW / 2).toFixed(1)}" y="${(height - padBottom + 18).toFixed(1)}" text-anchor="middle" font-size="11" fill="${theme.axis}">${xmlEscape(point.label.slice(0, 14))}</text>`);
  });
  parts.push(`<line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${padTop + plotH}" stroke="${theme.axis}" stroke-width="1.5"/>`);
  parts.push(`<line x1="${padLeft}" y1="${padTop + plotH}" x2="${width - padRight}" y2="${padTop + plotH}" stroke="${theme.axis}" stroke-width="1.5"/>`);
  parts.push('</svg>');
  return parts.join('');
}

function buildLineChartSvg({ data, title, width, height, theme }) {
  const points = normalizeData(data);
  const padTop = title ? 56 : 28;
  const padBottom = 64;
  const padLeft = 56;
  const padRight = 24;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const maxValue = Math.max(1, ...points.map((p) => p.value));
  const color = theme.palette[0];
  const parts = [svgHeader(width, height, theme), svgTitle(title, width, theme)];

  for (let i = 0; i <= 4; i += 1) {
    const y = padTop + (plotH * i) / 4;
    parts.push(`<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}" stroke="${theme.grid}" stroke-width="1"/>`);
  }
  const stepX = plotW / Math.max(1, points.length - 1);
  const coords = points.map((point, index) => {
    const x = padLeft + stepX * index;
    const y = padTop + plotH - (point.value / maxValue) * plotH;
    return { x, y, point };
  });
  if (coords.length > 1) {
    parts.push(`<polyline fill="none" stroke="${color}" stroke-width="2.5" points="${coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')}"/>`);
  }
  coords.forEach((c) => {
    parts.push(`<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3.5" fill="${color}"/>`);
    parts.push(`<text x="${c.x.toFixed(1)}" y="${(height - padBottom + 18).toFixed(1)}" text-anchor="middle" font-size="11" fill="${theme.axis}">${xmlEscape(c.point.label.slice(0, 12))}</text>`);
  });
  parts.push(`<line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${padTop + plotH}" stroke="${theme.axis}" stroke-width="1.5"/>`);
  parts.push(`<line x1="${padLeft}" y1="${padTop + plotH}" x2="${width - padRight}" y2="${padTop + plotH}" stroke="${theme.axis}" stroke-width="1.5"/>`);
  parts.push('</svg>');
  return parts.join('');
}

function buildPieChartSvg({ data, title, width, height, theme, donut = false }) {
  const points = normalizeData(data).filter((p) => p.value > 0);
  const parts = [svgHeader(width, height, theme), svgTitle(title, width, theme)];
  const total = points.reduce((sum, p) => sum + p.value, 0) || 1;
  const cx = width * 0.36;
  const cy = (title ? 56 : 28) + (height - (title ? 56 : 28) - 24) / 2;
  const radius = Math.min(cx - 24, cy - (title ? 56 : 28) - 4, height / 2.4);
  let angle = -Math.PI / 2;
  points.forEach((point, index) => {
    const slice = (point.value / total) * Math.PI * 2;
    const x1 = cx + radius * Math.cos(angle);
    const y1 = cy + radius * Math.sin(angle);
    angle += slice;
    const x2 = cx + radius * Math.cos(angle);
    const y2 = cy + radius * Math.sin(angle);
    const large = slice > Math.PI ? 1 : 0;
    const color = theme.palette[index % theme.palette.length];
    parts.push(`<path d="M ${cx.toFixed(1)} ${cy.toFixed(1)} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${radius.toFixed(1)} ${radius.toFixed(1)} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${color}"/>`);
  });
  if (donut) {
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(radius * 0.55).toFixed(1)}" fill="${theme.bg}"/>`);
  }
  // legend
  const legendX = width * 0.66;
  let legendY = (title ? 64 : 36);
  points.forEach((point, index) => {
    const color = theme.palette[index % theme.palette.length];
    const pct = ((point.value / total) * 100).toFixed(1);
    parts.push(`<rect x="${legendX}" y="${legendY}" width="12" height="12" rx="2" fill="${color}"/>`);
    parts.push(`<text x="${legendX + 18}" y="${legendY + 11}" font-size="12" fill="${theme.text}">${xmlEscape(point.label.slice(0, 20))} — ${pct}%</text>`);
    legendY += 22;
  });
  parts.push('</svg>');
  return parts.join('');
}

// Public: build a chart SVG string for the given spec.
function buildChartSvg(spec = {}) {
  const width = Math.max(200, Math.min(1200, toNumber(spec.width, 640)));
  const height = Math.max(160, Math.min(900, toNumber(spec.height, 400)));
  const theme = resolveTheme(spec.theme);
  const title = spec.title ? String(spec.title) : '';
  const type = String(spec.type || 'bar').toLowerCase();
  const params = { data: spec.data, title, width, height, theme };
  if (type === 'pie') return buildPieChartSvg(params);
  if (type === 'donut') return buildPieChartSvg({ ...params, donut: true });
  if (type === 'line') return buildLineChartSvg(params);
  if (type === 'hbar' || type === 'horizontal-bar') return buildBarChartSvg({ ...params, horizontal: true });
  return buildBarChartSvg(params);
}

async function svgToPng(svg, { density = 144 } = {}) {
  const sharp = getSharp();
  if (!sharp) throw new Error('sharp no está disponible para rasterizar el gráfico.');
  return sharp(Buffer.from(String(svg), 'utf8'), { density }).png().toBuffer();
}

function pixelsToEmu(px) {
  return Math.round(px * EMU_PER_PIXEL);
}

function fitEmu(widthPx, heightPx) {
  let cx = pixelsToEmu(widthPx);
  let cy = pixelsToEmu(heightPx);
  if (cx > MAX_CONTENT_WIDTH_EMU) {
    const scale = MAX_CONTENT_WIDTH_EMU / cx;
    cx = MAX_CONTENT_WIDTH_EMU;
    cy = Math.round(cy * scale);
  }
  return { cx, cy };
}

function buildInlineImageParagraphXml({ rId, cx, cy, docPrId, name, altText, title }) {
  const captionRun = title
    ? `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="60" w:after="160"/></w:pPr><w:r><w:rPr><w:i/><w:sz w:val="18"/><w:color w:val="475569"/></w:rPr><w:t xml:space="preserve">${xmlEscape(title)}</w:t></w:r></w:p>`
    : '';
  const safeName = xmlEscape(name || 'Imagen');
  const drawing = `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="160" w:after="40"/></w:pPr><w:r><w:drawing>`
    + `<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">`
    + `<wp:extent cx="${cx}" cy="${cy}"/>`
    + '<wp:effectExtent l="0" t="0" r="0" b="0"/>'
    + `<wp:docPr id="${docPrId}" name="${safeName}" descr="${xmlEscape(altText || name || '')}"/>`
    + '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>'
    + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + `<pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${safeName}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + '</pic:pic></a:graphicData></a:graphic></wp:inline>'
    + '</w:drawing></w:r></w:p>';
  return `${drawing}${captionRun}`;
}

function ensurePngContentType(zip) {
  const file = zip.file('[Content_Types].xml');
  if (!file) return;
  let xml = file.asText();
  if (/Extension="png"/i.test(xml)) return;
  xml = xml.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>');
  zip.file('[Content_Types].xml', xml);
}

function addImageRelationship(zip, target) {
  const relsPath = 'word/_rels/document.xml.rels';
  let rels = zip.file(relsPath)?.asText();
  if (!rels) {
    rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  }
  const usedIds = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  const newId = `rId${(usedIds.length ? Math.max(...usedIds) : 0) + 1}`;
  const relationship = `<Relationship Id="${newId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>`;
  rels = rels.replace('</Relationships>', `${relationship}</Relationships>`);
  zip.file(relsPath, rels);
  return newId;
}

function insertParagraphBeforeBodyEnd(documentXml, paragraphXml) {
  const bodyEnd = documentXml.lastIndexOf('</w:body>');
  if (bodyEnd < 0) throw new Error('DOCX inválido: no se encontró el cuerpo del documento.');
  const before = documentXml.slice(0, bodyEnd);
  const after = documentXml.slice(bodyEnd);
  const sectPrMatch = before.match(/<w:sectPr\b[\s\S]*<\/w:sectPr>\s*$/);
  if (sectPrMatch?.index != null) {
    return `${before.slice(0, sectPrMatch.index)}${paragraphXml}${before.slice(sectPrMatch.index)}${after}`;
  }
  return `${before}${paragraphXml}${after}`;
}

// Embed a PNG into a DOCX buffer as a centered inline image, preserving the
// rest of the document. `widthPx`/`heightPx` describe the source image.
function embedImageIntoDocxBuffer(buffer, { png, widthPx = 640, heightPx = 400, name = 'Gráfico', altText = '', title = '' } = {}) {
  if (!Buffer.isBuffer(png) || png.length === 0) throw new Error('Se requiere un PNG válido para embeber.');
  const zip = new PizZip(buffer);
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('DOCX inválido: falta word/document.xml.');

  ensurePngContentType(zip);

  const existing = Object.keys(zip.files).filter((n) => /^word\/media\/image\d+\.png$/i.test(n));
  const imageIndex = existing.length + 1;
  zip.file(`word/media/image${imageIndex}.png`, png);

  const rId = addImageRelationship(zip, `media/image${imageIndex}.png`);
  const { cx, cy } = fitEmu(widthPx, heightPx);
  const paragraph = buildInlineImageParagraphXml({ rId, cx, cy, docPrId: imageIndex, name, altText, title });
  zip.file('word/document.xml', insertParagraphBeforeBodyEnd(documentFile.asText(), paragraph));

  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// One-shot: render a chart spec and embed it into the DOCX.
async function addChartToDocxBuffer(buffer, spec = {}) {
  const width = Math.max(200, Math.min(1200, toNumber(spec.width, 640)));
  const height = Math.max(160, Math.min(900, toNumber(spec.height, 400)));
  const svg = buildChartSvg({ ...spec, width, height });
  const png = await svgToPng(svg);
  return embedImageIntoDocxBuffer(buffer, {
    png,
    widthPx: width,
    heightPx: height,
    name: spec.title || 'Gráfico',
    altText: spec.title || `${spec.type || 'bar'} chart`,
    title: spec.caption || '',
  });
}

function isVisualAvailable() {
  return Boolean(getSharp());
}

module.exports = {
  buildChartSvg,
  svgToPng,
  embedImageIntoDocxBuffer,
  addChartToDocxBuffer,
  isVisualAvailable,
  INTERNAL: {
    normalizeData,
    resolveTheme,
    fitEmu,
    pixelsToEmu,
    buildInlineImageParagraphXml,
    insertParagraphBeforeBodyEnd,
    THEMES,
  },
};
