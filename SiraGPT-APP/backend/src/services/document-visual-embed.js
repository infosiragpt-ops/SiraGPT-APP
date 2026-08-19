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

// Label-oriented normalizer for diagrams where array items are labels (not
// numeric values like in charts).
function normalizeLabels(data) {
  if (!data) return [];
  if (Array.isArray(data)) {
    return data.map((item, index) => {
      if (item && typeof item === 'object') return String(item.label ?? item.name ?? item.text ?? `Paso ${index + 1}`);
      return String(item);
    }).filter((label) => label.trim());
  }
  if (data && typeof data === 'object' && Array.isArray(data.labels)) return data.labels.map(String);
  return [];
}

function buildProcessFlowSvg({ data, title, width, height, theme }) {
  const steps = normalizeLabels(data);
  const parts = [svgHeader(width, height, theme), svgTitle(title, width, theme)];
  const top = title ? 70 : 36;
  const gap = 22;
  const boxH = Math.min(90, height - top - 40);
  const boxW = Math.max(60, (width - 48 - gap * Math.max(0, steps.length - 1)) / Math.max(1, steps.length));
  const y = top + (height - top - 40 - boxH) / 2;
  steps.forEach((label, index) => {
    const x = 24 + index * (boxW + gap);
    const color = theme.palette[index % theme.palette.length];
    parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${boxW.toFixed(1)}" height="${boxH.toFixed(1)}" rx="10" fill="${color}" opacity="0.92"/>`);
    parts.push(`<text x="${(x + boxW / 2).toFixed(1)}" y="${(y + boxH / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="600" fill="#ffffff">${xmlEscape(label.slice(0, 22))}</text>`);
    if (index < steps.length - 1) {
      const ax = x + boxW;
      const ay = y + boxH / 2;
      parts.push(`<path d="M ${ax.toFixed(1)} ${ay.toFixed(1)} l ${gap.toFixed(1)} 0" stroke="${theme.axis}" stroke-width="2.5" marker-end="url(#arrow)"/>`);
    }
  });
  parts.push(`<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="${theme.axis}"/></marker></defs>`);
  parts.push('</svg>');
  return parts.join('');
}

function buildTimelineSvg({ data, title, width, height, theme }) {
  const items = (Array.isArray(data) ? data : normalizeData(data)).map((item, index) => {
    if (item && typeof item === 'object') return { label: String(item.label ?? item.name ?? `Hito ${index + 1}`), sub: String(item.date ?? item.sub ?? item.value ?? '') };
    return { label: String(item), sub: '' };
  });
  const parts = [svgHeader(width, height, theme), svgTitle(title, width, theme)];
  const axisY = (title ? 70 : 40) + (height - (title ? 70 : 40)) / 2;
  const padX = 40;
  parts.push(`<line x1="${padX}" y1="${axisY}" x2="${width - padX}" y2="${axisY}" stroke="${theme.axis}" stroke-width="2.5"/>`);
  const step = (width - padX * 2) / Math.max(1, items.length - 1 || 1);
  items.forEach((item, index) => {
    const x = items.length === 1 ? width / 2 : padX + step * index;
    const color = theme.palette[index % theme.palette.length];
    const above = index % 2 === 0;
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${axisY}" r="7" fill="${color}" stroke="#ffffff" stroke-width="2"/>`);
    const labelY = above ? axisY - 22 : axisY + 34;
    const subY = above ? axisY - 38 : axisY + 50;
    if (item.sub) parts.push(`<text x="${x.toFixed(1)}" y="${subY.toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="${color}">${xmlEscape(item.sub.slice(0, 16))}</text>`);
    parts.push(`<text x="${x.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-size="11" fill="${theme.text}">${xmlEscape(item.label.slice(0, 18))}</text>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

function normalizeTree(spec) {
  if (spec.tree && typeof spec.tree === 'object') return spec.tree;
  const data = spec.data;
  if (Array.isArray(data)) {
    return { label: spec.title || 'Organización', children: data.map((item) => (item && typeof item === 'object' ? item : { label: String(item) })) };
  }
  if (data && typeof data === 'object' && (data.label || data.children)) return data;
  return { label: spec.title || 'Organización', children: [] };
}

function buildOrganigramSvg({ spec, title, width, height, theme }) {
  const root = normalizeTree(spec);
  const boxW = 150;
  const boxH = 46;
  const hGap = 20;
  const vGap = 56;
  let leaf = 0;
  let maxDepth = 0;
  const nodes = [];
  const edges = [];
  (function assign(node, depth, parent) {
    maxDepth = Math.max(maxDepth, depth);
    const children = Array.isArray(node.children) ? node.children : [];
    if (!children.length) {
      node._x = leaf * (boxW + hGap);
      leaf += 1;
    } else {
      children.forEach((child) => assign(child, depth + 1, node));
      node._x = (children[0]._x + children[children.length - 1]._x) / 2;
    }
    node._y = depth * (boxH + vGap);
    nodes.push({ node, depth });
    if (parent) edges.push([parent, node]);
  }(root, 0, null));

  const contentW = Math.max(boxW, leaf * (boxW + hGap) - hGap);
  const offsetX = (width - contentW) / 2;
  const top = title ? 60 : 24;
  const parts = [svgHeader(width, height, theme), svgTitle(title, width, theme)];
  const cx = (node) => offsetX + node._x + boxW / 2;
  const cyTop = (node) => top + node._y;

  edges.forEach(([parent, child]) => {
    const x1 = cx(parent);
    const y1 = top + parent._y + boxH;
    const x2 = cx(child);
    const y2 = top + child._y;
    const midY = (y1 + y2) / 2;
    parts.push(`<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x1.toFixed(1)} ${midY.toFixed(1)} L ${x2.toFixed(1)} ${midY.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${theme.axis}" stroke-width="1.5"/>`);
  });
  nodes.forEach(({ node, depth }) => {
    const x = offsetX + node._x;
    const y = cyTop(node);
    const color = theme.palette[depth % theme.palette.length];
    parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${boxW}" height="${boxH}" rx="8" fill="${color}"/>`);
    parts.push(`<text x="${(x + boxW / 2).toFixed(1)}" y="${(y + boxH / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="600" fill="#ffffff">${xmlEscape(String(node.label || '').slice(0, 20))}</text>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

function buildRadarChartSvg({ data, title, width, height, theme }) {
  const points = normalizeData(data);
  const parts = [svgHeader(width, height, theme), svgTitle(title, width, theme)];
  const top = title ? 60 : 28;
  const cx = width / 2;
  const cy = top + (height - top - 24) / 2;
  const radius = Math.max(40, Math.min(cx - 90, (height - top - 48) / 2));
  const n = Math.max(3, points.length);
  const maxValue = Math.max(1, ...points.map((p) => p.value));
  const angleAt = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const pointAt = (i, r) => ({ x: cx + r * Math.cos(angleAt(i)), y: cy + r * Math.sin(angleAt(i)) });

  // concentric grid rings
  for (let ring = 1; ring <= 4; ring += 1) {
    const r = (radius * ring) / 4;
    const poly = points.map((_, i) => { const p = pointAt(i, r); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(' ');
    parts.push(`<polygon points="${poly}" fill="none" stroke="${theme.grid}" stroke-width="1"/>`);
  }
  // axes + labels
  points.forEach((point, i) => {
    const edge = pointAt(i, radius);
    parts.push(`<line x1="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${edge.x.toFixed(1)}" y2="${edge.y.toFixed(1)}" stroke="${theme.grid}" stroke-width="1"/>`);
    const lbl = pointAt(i, radius + 16);
    const anchor = Math.abs(lbl.x - cx) < 6 ? 'middle' : (lbl.x > cx ? 'start' : 'end');
    parts.push(`<text x="${lbl.x.toFixed(1)}" y="${(lbl.y + 4).toFixed(1)}" text-anchor="${anchor}" font-size="11" fill="${theme.text}">${xmlEscape(point.label.slice(0, 16))}</text>`);
  });
  // data polygon
  const color = theme.palette[0];
  const dataPoly = points.map((point, i) => { const p = pointAt(i, (point.value / maxValue) * radius); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(' ');
  parts.push(`<polygon points="${dataPoly}" fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="2.5"/>`);
  points.forEach((point, i) => { const p = pointAt(i, (point.value / maxValue) * radius); parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="${color}"/>`); });
  parts.push('</svg>');
  return parts.join('');
}

function normalizeSeries(spec) {
  if (Array.isArray(spec.series) && spec.series.length) {
    const labels = Array.isArray(spec.labels)
      ? spec.labels.map(String)
      : (spec.data && Array.isArray(spec.data.labels) ? spec.data.labels.map(String) : []);
    const series = spec.series.map((entry, index) => ({
      name: String(entry.name ?? entry.label ?? `Serie ${index + 1}`),
      values: (Array.isArray(entry.values) ? entry.values : []).map((value) => toNumber(value, 0)),
    }));
    const span = labels.length || Math.max(0, ...series.map((s) => s.values.length));
    const filledLabels = Array.from({ length: span }, (_, i) => labels[i] || `Cat ${i + 1}`);
    return { labels: filledLabels, series };
  }
  const points = normalizeData(spec.data);
  return { labels: points.map((p) => p.label), series: [{ name: spec.title || 'Serie 1', values: points.map((p) => p.value) }] };
}

function buildGroupedBarChartSvg({ spec, title, width, height, theme }) {
  const { labels, series } = normalizeSeries(spec);
  const parts = [svgHeader(width, height, theme), svgTitle(title, width, theme)];
  const padTop = title ? 56 : 28;
  const padBottom = 78;
  const padLeft = 56;
  const padRight = 24;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const maxValue = Math.max(1, ...series.flatMap((s) => s.values));
  const groups = Math.max(1, labels.length);
  const perGroup = Math.max(1, series.length);
  const slot = plotW / groups;
  const groupInner = slot * 0.8;
  const barW = groupInner / perGroup;

  for (let i = 0; i <= 4; i += 1) {
    const y = padTop + (plotH * i) / 4;
    parts.push(`<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}" stroke="${theme.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${padLeft - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="${theme.axis}">${((maxValue * (4 - i)) / 4).toFixed(maxValue >= 10 ? 0 : 1)}</text>`);
  }
  labels.forEach((label, g) => {
    const groupX = padLeft + slot * g + (slot - groupInner) / 2;
    series.forEach((s, si) => {
      const value = toNumber(s.values[g], 0);
      const barH = (value / maxValue) * plotH;
      const x = groupX + barW * si;
      const y = padTop + plotH - barH;
      parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW * 0.92).toFixed(1)}" height="${Math.max(0, barH).toFixed(1)}" rx="2" fill="${theme.palette[si % theme.palette.length]}"/>`);
    });
    parts.push(`<text x="${(padLeft + slot * g + slot / 2).toFixed(1)}" y="${(padTop + plotH + 16).toFixed(1)}" text-anchor="middle" font-size="10" fill="${theme.axis}">${xmlEscape(String(label).slice(0, 12))}</text>`);
  });
  let lx = padLeft;
  const ly = height - 20;
  series.forEach((s, si) => {
    parts.push(`<rect x="${lx}" y="${ly}" width="11" height="11" rx="2" fill="${theme.palette[si % theme.palette.length]}"/>`);
    parts.push(`<text x="${lx + 16}" y="${ly + 10}" font-size="11" fill="${theme.text}">${xmlEscape(s.name.slice(0, 18))}</text>`);
    lx += 16 + 8 + Math.min(150, s.name.length * 7 + 16);
  });
  parts.push(`<line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${padTop + plotH}" stroke="${theme.axis}" stroke-width="1.5"/>`);
  parts.push(`<line x1="${padLeft}" y1="${padTop + plotH}" x2="${width - padRight}" y2="${padTop + plotH}" stroke="${theme.axis}" stroke-width="1.5"/>`);
  parts.push('</svg>');
  return parts.join('');
}

function buildScatterChartSvg({ spec, title, width, height, theme }) {
  const raw = Array.isArray(spec.points) ? spec.points : (Array.isArray(spec.data) ? spec.data : []);
  const points = raw
    .map((p) => (p && typeof p === 'object' ? { x: toNumber(p.x, NaN), y: toNumber(p.y, NaN) } : null))
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  const parts = [svgHeader(width, height, theme), svgTitle(title, width, theme)];
  const padTop = title ? 56 : 28;
  const padBottom = 48;
  const padLeft = 56;
  const padRight = 24;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const xMax = Math.max(1, ...points.map((p) => p.x));
  const yMax = Math.max(1, ...points.map((p) => p.y));
  const color = theme.palette[0];

  for (let i = 0; i <= 4; i += 1) {
    const y = padTop + (plotH * i) / 4;
    parts.push(`<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}" stroke="${theme.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${padLeft - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="${theme.axis}">${((yMax * (4 - i)) / 4).toFixed(yMax >= 10 ? 0 : 1)}</text>`);
  }
  points.forEach((p) => {
    const cx = padLeft + (p.x / xMax) * plotW;
    const cy = padTop + plotH - (p.y / yMax) * plotH;
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4" fill="${color}" fill-opacity="0.75"/>`);
  });
  parts.push(`<line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${padTop + plotH}" stroke="${theme.axis}" stroke-width="1.5"/>`);
  parts.push(`<line x1="${padLeft}" y1="${padTop + plotH}" x2="${width - padRight}" y2="${padTop + plotH}" stroke="${theme.axis}" stroke-width="1.5"/>`);
  parts.push('</svg>');
  return parts.join('');
}

function normalizeKpiData(data) {
  if (Array.isArray(data)) {
    return data.map((item, index) => {
      if (item && typeof item === 'object') {
        return { label: String(item.label ?? item.name ?? `KPI ${index + 1}`), value: String(item.value ?? item.y ?? item.count ?? ''), sub: item.sub ? String(item.sub) : '' };
      }
      return { label: '', value: String(item), sub: '' };
    });
  }
  if (data && typeof data === 'object' && Array.isArray(data.labels)) {
    return data.labels.map((label, i) => ({ label: String(label), value: String((data.values || [])[i] ?? ''), sub: '' }));
  }
  return [];
}

// Executive "stat cards": big numbers with labels — common in report summaries.
function buildKpiCardsSvg({ spec, title, width, height, theme }) {
  const cards = normalizeKpiData(spec.data).slice(0, 8);
  const parts = [svgHeader(width, height, theme), svgTitle(title, width, theme)];
  const top = title ? 64 : 28;
  const margin = 24;
  const gap = 16;
  const perRow = Math.min(Math.max(1, cards.length), 4);
  const rows = Math.max(1, Math.ceil(cards.length / perRow));
  const cardW = (width - margin * 2 - gap * (perRow - 1)) / perRow;
  const cardH = Math.min(130, Math.max(70, (height - top - margin - gap * (rows - 1)) / rows));
  cards.forEach((card, i) => {
    const r = Math.floor(i / perRow);
    const col = i % perRow;
    const x = margin + col * (cardW + gap);
    const y = top + r * (cardH + gap);
    const color = theme.palette[i % theme.palette.length];
    parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cardW.toFixed(1)}" height="${cardH.toFixed(1)}" rx="10" fill="#f8fafc" stroke="${theme.grid}" stroke-width="1"/>`);
    parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cardW.toFixed(1)}" height="6" rx="3" fill="${color}"/>`);
    parts.push(`<text x="${(x + cardW / 2).toFixed(1)}" y="${(y + cardH * 0.5).toFixed(1)}" text-anchor="middle" font-size="28" font-weight="800" fill="${color}">${xmlEscape(card.value.slice(0, 14))}</text>`);
    parts.push(`<text x="${(x + cardW / 2).toFixed(1)}" y="${(y + cardH * 0.74).toFixed(1)}" text-anchor="middle" font-size="12" fill="${theme.text}">${xmlEscape(card.label.slice(0, 22))}</text>`);
    if (card.sub) parts.push(`<text x="${(x + cardW / 2).toFixed(1)}" y="${(y + cardH * 0.9).toFixed(1)}" text-anchor="middle" font-size="10" fill="${theme.axis}">${xmlEscape(card.sub.slice(0, 26))}</text>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

function buildStackedBarChartSvg({ spec, title, width, height, theme }) {
  const { labels, series } = normalizeSeries(spec);
  const parts = [svgHeader(width, height, theme), svgTitle(title, width, theme)];
  const padTop = title ? 56 : 28;
  const padBottom = 78;
  const padLeft = 56;
  const padRight = 24;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const groups = Math.max(1, labels.length);
  const totals = labels.map((_, g) => series.reduce((sum, s) => sum + toNumber(s.values[g], 0), 0));
  const maxTotal = Math.max(1, ...totals);
  const slot = plotW / groups;
  const barW = Math.max(8, slot * 0.6);
  for (let i = 0; i <= 4; i += 1) {
    const y = padTop + (plotH * i) / 4;
    parts.push(`<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}" stroke="${theme.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${padLeft - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="${theme.axis}">${((maxTotal * (4 - i)) / 4).toFixed(maxTotal >= 10 ? 0 : 1)}</text>`);
  }
  labels.forEach((label, g) => {
    const x = padLeft + slot * g + (slot - barW) / 2;
    let yCursor = padTop + plotH;
    series.forEach((s, si) => {
      const value = toNumber(s.values[g], 0);
      const segH = (value / maxTotal) * plotH;
      yCursor -= segH;
      if (segH > 0) parts.push(`<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${barW.toFixed(1)}" height="${segH.toFixed(1)}" fill="${theme.palette[si % theme.palette.length]}"/>`);
    });
    parts.push(`<text x="${(x + barW / 2).toFixed(1)}" y="${(padTop + plotH + 16).toFixed(1)}" text-anchor="middle" font-size="10" fill="${theme.axis}">${xmlEscape(String(label).slice(0, 12))}</text>`);
  });
  let lx = padLeft;
  const ly = height - 20;
  series.forEach((s, si) => {
    parts.push(`<rect x="${lx}" y="${ly}" width="11" height="11" rx="2" fill="${theme.palette[si % theme.palette.length]}"/>`);
    parts.push(`<text x="${lx + 16}" y="${ly + 10}" font-size="11" fill="${theme.text}">${xmlEscape(s.name.slice(0, 18))}</text>`);
    lx += 16 + 8 + Math.min(150, s.name.length * 7 + 16);
  });
  parts.push(`<line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${padTop + plotH}" stroke="${theme.axis}" stroke-width="1.5"/>`);
  parts.push(`<line x1="${padLeft}" y1="${padTop + plotH}" x2="${width - padRight}" y2="${padTop + plotH}" stroke="${theme.axis}" stroke-width="1.5"/>`);
  parts.push('</svg>');
  return parts.join('');
}

function buildHistogramSvg({ spec, data, title, width, height, theme }) {
  const raw = Array.isArray(spec?.values) ? spec.values
    : (spec?.data && Array.isArray(spec.data.values) ? spec.data.values : (Array.isArray(data) ? data : []));
  const nums = raw.map((v) => toNumber(v, NaN)).filter(Number.isFinite);
  const parts = [svgHeader(width, height, theme), svgTitle(title, width, theme)];
  const padTop = title ? 56 : 28;
  const padBottom = 56;
  const padLeft = 56;
  const padRight = 24;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  if (!nums.length) { parts.push('</svg>'); return parts.join(''); }
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const binCount = Math.max(3, Math.min(12, toNumber(spec?.bins, Math.ceil(Math.sqrt(nums.length)))));
  const span = (max - min) || 1;
  const binWidth = span / binCount;
  const counts = new Array(binCount).fill(0);
  nums.forEach((n) => { let idx = Math.floor((n - min) / binWidth); if (idx >= binCount) idx = binCount - 1; if (idx < 0) idx = 0; counts[idx] += 1; });
  const maxCount = Math.max(1, ...counts);
  const barW = plotW / binCount;
  for (let i = 0; i <= 4; i += 1) {
    const y = padTop + (plotH * i) / 4;
    parts.push(`<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}" stroke="${theme.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${padLeft - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="${theme.axis}">${Math.round((maxCount * (4 - i)) / 4)}</text>`);
  }
  counts.forEach((c, i) => {
    const h = (c / maxCount) * plotH;
    const x = padLeft + barW * i;
    const y = padTop + plotH - h;
    parts.push(`<rect x="${(x + 0.5).toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - 1).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" fill="${theme.palette[0]}"/>`);
    if (i % Math.ceil(binCount / 6) === 0) {
      const edge = min + binWidth * i;
      parts.push(`<text x="${x.toFixed(1)}" y="${(padTop + plotH + 16).toFixed(1)}" text-anchor="middle" font-size="9" fill="${theme.axis}">${(Math.round(edge * 10) / 10)}</text>`);
    }
  });
  parts.push(`<line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${padTop + plotH}" stroke="${theme.axis}" stroke-width="1.5"/>`);
  parts.push(`<line x1="${padLeft}" y1="${padTop + plotH}" x2="${width - padRight}" y2="${padTop + plotH}" stroke="${theme.axis}" stroke-width="1.5"/>`);
  parts.push('</svg>');
  return parts.join('');
}

// Public: build a chart/diagram SVG string for the given spec.
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
  if (type === 'process' || type === 'flow' || type === 'flujo') return buildProcessFlowSvg(params);
  if (type === 'timeline' || type === 'linea-de-tiempo' || type === 'cronologia') return buildTimelineSvg(params);
  if (type === 'organigram' || type === 'organigrama' || type === 'orgchart' || type === 'org') return buildOrganigramSvg({ spec, title, width, height, theme });
  if (type === 'radar' || type === 'spider' || type === 'arana') return buildRadarChartSvg(params);
  if (type === 'grouped' || type === 'grouped-bar' || type === 'multibar' || type === 'comparativo' || type === 'agrupado') return buildGroupedBarChartSvg({ spec, title, width, height, theme });
  if (type === 'scatter' || type === 'dispersion' || type === 'xy' || type === 'nube') return buildScatterChartSvg({ spec, title, width, height, theme });
  if (type === 'kpi' || type === 'cards' || type === 'stats' || type === 'tarjetas' || type === 'indicadores') return buildKpiCardsSvg({ spec, title, width, height, theme });
  if (type === 'stacked' || type === 'stacked-bar' || type === 'apilada' || type === 'apiladas') return buildStackedBarChartSvg({ spec, title, width, height, theme });
  if (type === 'histogram' || type === 'histograma') return buildHistogramSvg({ spec, data: spec.data, title, width, height, theme });
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

// ---------------------------------------------------------------------------
// Request → visual: detect when the user wants a chart/diagram, infer the type,
// extract the data (LLM when available, deterministic inline parser otherwise),
// and embed it. Lets the document editor add a visual with a one-line hook.
// ---------------------------------------------------------------------------

function normalizeText(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

const VISUAL_INTENT_RE = /\b(grafico\w*|grafica\w*|diagrama\w*|organigrama\w*|linea de tiempo|cronolog\w*|timeline|flujograma|diagrama de flujo|flujo|chart|pastel|dona|donut|barras?|histograma\w*|radar|arana|spider|dispersion|scatter|correlacion|comparativ\w*|agrupad\w*|apilad\w*|kpi\w*|tarjetas?|indicadores?)\b/;

function inferVisualType(norm) {
  if (/\bhistograma\w*|distribucion de frecuencias?\b/.test(norm)) return 'histogram';
  if (/\bapilad\w*|stacked\b/.test(norm)) return 'stacked';
  if (/\bkpi\w*|tarjetas?|indicadores?|stat cards?\b/.test(norm)) return 'kpi';
  if (/\bdispersion|scatter|correlacion|nube de puntos\b/.test(norm)) return 'scatter';
  if (/\bcomparativ\w*|agrupad\w*|multibar|por grupos?\b/.test(norm)) return 'grouped';
  if (/\bradar|arana|spider\b/.test(norm)) return 'radar';
  if (/\borganigrama\w*|orgchart|organization\b/.test(norm)) return 'organigram';
  if (/\btimeline|linea de tiempo|cronolog\w*\b/.test(norm)) return 'timeline';
  if (/\bflujograma|diagrama de flujo|\bflujo\b|proceso\b/.test(norm)) return 'process';
  if (/\bdona|donut\b/.test(norm)) return 'donut';
  if (/\bpastel|circular|\bpie\b|porcentaj\w*\b/.test(norm)) return 'pie';
  if (/\blinea\b|\blineal\b|tendencia\b|\bline\b/.test(norm)) return 'line';
  return 'bar';
}

function detectVisualRequest(text) {
  const norm = normalizeText(text);
  const wantsVisual = VISUAL_INTENT_RE.test(norm);
  return { wantsVisual, type: wantsVisual ? inferVisualType(norm) : null };
}

// Pull "Label 48", "Label: 48", "Label (48)", "Label 48%" pairs out of free text.
function parseInlineSeries(text) {
  const out = [];
  const seen = new Set();
  const re = /([A-Za-zÁÉÍÓÚÜáéíóúüÑñ][\wÁÉÍÓÚÜáéíóúüÑñ .'\/-]{1,32}?)\s*[:=(]?\s*(\d+(?:[.,]\d+)?)\s*%?\)?/g;
  let match;
  while ((match = re.exec(text)) && out.length < 12) {
    const label = match[1].trim().replace(/\s+/g, ' ').replace(/[\s,;:-]+$/, '').replace(/^(?:y|e|o|u)\s+/i, '').trim();
    const value = Number(String(match[2]).replace(',', '.'));
    const key = label.toLowerCase();
    if (label.length >= 2 && Number.isFinite(value) && !/^(de|del|la|el|los|las|un|una|y|en|con|por)$/i.test(label) && !seen.has(key)) {
      seen.add(key);
      out.push({ label, value });
    }
  }
  return out;
}

async function extractVisualSpecWithLLM({ requestText, sourceText, fallbackType, signal }) {
  let resolveContentClient;
  try {
    // eslint-disable-next-line global-require
    ({ resolveContentClient } = require('./document-pipeline/content/llm-client'));
  } catch {
    return null;
  }
  const resolved = resolveContentClient();
  if (!resolved) return null;
  try {
    const client = resolved.client;
    const completion = await client.chat.completions.create({
      model: resolved.model,
      messages: [
        {
          role: 'system',
          content: [
            'Extraes la especificación de un gráfico/diagrama a partir de la petición del usuario y el contexto del documento.',
            'No inventes cifras: usa solo datos presentes en la petición o el contexto. Si no hay datos numéricos ni elementos claros, devuelve data vacía.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            `Petición: ${requestText}`,
            'Contexto del documento (puede estar vacío):',
            String(sourceText || '').slice(0, 6000),
            '',
            'Responde SOLO JSON:',
            '{"type":"bar|pie|donut|line|radar|process|timeline|organigram|grouped|scatter","title":"...","data":[{"label":"...","value":0}],"steps":["..."],"tree":{"label":"...","children":[]},"labels":["..."],"series":[{"name":"...","values":[0]}],"points":[{"x":0,"y":0}]}',
            'Usa "data" para bar/pie/donut/line/radar; "steps" para process; "data" con {label,date} para timeline; "tree" para organigram; "labels"+"series" para grouped (comparativo); "points" {x,y} para scatter. Incluye solo los campos del type.',
          ].join('\n'),
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }, { signal, timeout: 25_000 });
    const raw = completion?.choices?.[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const type = ['bar', 'pie', 'donut', 'line', 'radar', 'process', 'timeline', 'organigram', 'grouped', 'scatter', 'stacked', 'histogram'].includes(parsed.type) ? parsed.type : fallbackType;
    const spec = { type, title: parsed.title ? String(parsed.title) : '' };
    if (type === 'organigram' && parsed.tree) spec.tree = parsed.tree;
    else if (type === 'scatter' && Array.isArray(parsed.points)) spec.points = parsed.points;
    else if (type === 'histogram' && Array.isArray(parsed.values)) spec.values = parsed.values;
    else if ((type === 'grouped' || type === 'stacked') && Array.isArray(parsed.series)) { spec.series = parsed.series; if (Array.isArray(parsed.labels)) spec.labels = parsed.labels; }
    else if (type === 'process' && Array.isArray(parsed.steps)) spec.data = parsed.steps;
    else if (Array.isArray(parsed.data) && parsed.data.length) spec.data = parsed.data;
    else if (Array.isArray(parsed.steps) && parsed.steps.length) spec.data = parsed.steps;
    return spec;
  } catch {
    return null;
  }
}

function visualSpecHasContent(spec) {
  if (!spec) return false;
  if (spec.type === 'organigram') return Boolean(spec.tree && (spec.tree.label || (Array.isArray(spec.tree.children) && spec.tree.children.length)));
  if (spec.type === 'scatter') {
    const pts = Array.isArray(spec.points) ? spec.points : (Array.isArray(spec.data) ? spec.data : []);
    return pts.some((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)));
  }
  if (spec.type === 'histogram') {
    const vals = Array.isArray(spec.values) ? spec.values
      : (spec.data && Array.isArray(spec.data.values) ? spec.data.values : (Array.isArray(spec.data) ? spec.data : []));
    return vals.some((v) => Number.isFinite(Number(v)));
  }
  if (Array.isArray(spec.series) && spec.series.some((s) => Array.isArray(s.values) && s.values.length)) return true;
  return Array.isArray(spec.data) && spec.data.length > 0;
}

// Detect a visual request, build its spec (LLM or inline), and embed it.
// Returns { added, buffer, spec, reason }. Never throws on "no visual".
// Next APA-style number for a caption word ("Figura"/"Tabla"), based on captions
// already present in the document (so chained edits keep incrementing).
function nextCaptionNumber(buffer, word) {
  try {
    const xml = new PizZip(buffer).file('word/document.xml')?.asText() || '';
    const text = (xml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join(' ');
    const nums = [...text.matchAll(new RegExp(`\\b${word}\\s+(\\d+)`, 'gi'))].map((m) => Number(m[1])).filter(Number.isFinite);
    return (nums.length ? Math.max(...nums) : 0) + 1;
  } catch {
    return 1;
  }
}

async function addVisualFromRequest(buffer, { requestText = '', sourceText = '', signal, theme = 'corporate' } = {}) {
  const detection = detectVisualRequest(requestText);
  if (!detection.wantsVisual) return { added: false, buffer, reason: 'no_visual_intent' };

  let spec = await extractVisualSpecWithLLM({ requestText, sourceText, fallbackType: detection.type, signal });
  if (!visualSpecHasContent(spec)) {
    const inline = parseInlineSeries(requestText);
    if (inline.length) spec = { type: detection.type === 'organigram' || detection.type === 'process' ? 'bar' : detection.type, data: inline, title: spec?.title || '' };
  }
  if (!visualSpecHasContent(spec)) return { added: false, buffer, reason: 'no_data' };

  if (!isVisualAvailable()) return { added: false, buffer, reason: 'renderer_unavailable', spec };
  spec.theme = spec.theme || theme;
  const figure = nextCaptionNumber(buffer, 'Figura');
  const baseTitle = String(spec.title || '').trim();
  spec.caption = baseTitle ? `Figura ${figure}. ${baseTitle}` : `Figura ${figure}`;
  const out = await addChartToDocxBuffer(buffer, spec);
  return { added: true, buffer: out, spec: { ...spec, caption: spec.caption } };
}

module.exports = {
  buildChartSvg,
  svgToPng,
  embedImageIntoDocxBuffer,
  addChartToDocxBuffer,
  addVisualFromRequest,
  detectVisualRequest,
  parseInlineSeries,
  isVisualAvailable,
  INTERNAL: {
    normalizeData,
    normalizeLabels,
    resolveTheme,
    fitEmu,
    pixelsToEmu,
    buildInlineImageParagraphXml,
    insertParagraphBeforeBodyEnd,
    inferVisualType,
    visualSpecHasContent,
    THEMES,
  },
};
