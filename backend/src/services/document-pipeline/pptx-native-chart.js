'use strict';

// A bounded, shared contract for the existing PowerPoint writers. PptxGenJS
// writes native charts and their editable embedded workbook; never rasterize.
const TYPES = ['column', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter'];
const MAX_POINTS = 200;
const MAX_SERIES = 12;
const HEX = /^#?([0-9a-f]{6})$/i;
const PALETTE = ['2563EB', 'F97316', '10B981', '8B5CF6', 'E11D48', '0891B2'];
const numberArray = { type: 'array', minItems: 1, maxItems: MAX_POINTS, items: { type: ['number', 'null'] } };
const colorSchema = { type: 'string', pattern: '^#?[0-9A-Fa-f]{6}$' };
const CHART_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: 'Native editable PowerPoint chart. Preserve all source values and requested type/colors. Up to 200 points and 12 series; use execute_python for other chart types or larger data, never truncate.',
  properties: {
    type: { type: 'string', enum: TYPES }, title: { type: 'string', maxLength: 200 },
    labels: { type: 'array', minItems: 1, maxItems: MAX_POINTS, items: { type: 'string', maxLength: 200 } },
    values: numberArray,
    xValues: { ...numberArray, description: 'Required numeric shared X coordinates for scatter; no nulls.' },
    series: { type: 'array', minItems: 1, maxItems: MAX_SERIES, items: {
      type: 'object', additionalProperties: false, required: ['name', 'values'],
      properties: { name: { type: 'string', maxLength: 200 }, values: numberArray, color: colorSchema },
    } },
    colors: { type: 'array', minItems: 1, maxItems: MAX_POINTS, items: colorSchema, description: 'Exact palette: one color per series, or per slice for pie/doughnut.' },
    pointColors: { type: 'array', minItems: 1, maxItems: MAX_POINTS, items: colorSchema, description: 'One color per point; pie/doughnut or single-series column/bar only.' },
    position: { type: 'object', additionalProperties: false, required: ['x', 'y', 'w', 'h'], properties: Object.fromEntries(['x', 'y', 'w', 'h'].map((k) => [k, { type: 'number' }])) },
    showTitle: { type: 'boolean' }, showLegend: { type: 'boolean' }, legendPosition: { type: 'string', enum: ['bottom', 'left', 'right', 'top', 'top-right'] },
    showValue: { type: 'boolean' }, showLabel: { type: 'boolean', description: 'Show category names as slice labels (pie/doughnut only); axes already show categories on other chart types.' }, showPercent: { type: 'boolean' },
    grouping: { type: 'string', enum: ['clustered', 'stacked', 'percentStacked'] },
    xAxisTitle: { type: 'string', maxLength: 200 }, yAxisTitle: { type: 'string', maxLength: 200 },
    source: { type: 'string', maxLength: 500 }, unit: { type: 'string', maxLength: 80 }, asOf: { type: 'string', maxLength: 80 },
  },
};

function invalid(reason) {
  const error = new Error(`E_PARAMS: Gráfica PowerPoint: ${reason}. Conserva los datos y usa execute_python si el diseño requiere otra capacidad; no sustituyas ni recortes la gráfica.`);
  error.code = 'E_PARAMS';
  error.pptxChartRequirement = true;
  throw error;
}

function requestsChart(text) {
  const value = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const requested = value
    .replace(/\b(?:diseno|tarjetas?|artes?|novelas?|interfaces?|comunicacion|lenguaje)\s+grafic[oa]s?\b|\bgrafic[oa]s?\s+(?:por|de)\s+computadora\b/g, '')
    .replace(/\b(?:sin|without|no\s+(?:incluyas?|agregues?|quiero|necesito)|do\s+not\s+(?:include|add))\s+(?:ningun[oa]?s?\s+|any\s+)?(?:grafic[oa]s?|charts?)\b/g, '');
  const chart = '(?:grafic[oa]s?|charts?)';
  const modifiers = '(?:(?:un[oa]?s?|el|la|los|las|esta?s?|estos?|esa?s?|esos?|a|an|the|this|these|native|nativ[oa]s?|editable?s?)\\s+){0,4}';
  return new RegExp(`\\b(?:con|with|incluye|incluya|incluyan|incluyas|include|includes|contenga|contengan|agrega|agregue|anade|crea|crear|genera|generar|incorpora|incorporar|inserta|insertar|add|create|insert|quiero|necesito|usa|usar)\\s+${modifiers}${chart}\\b`).test(requested)
    || new RegExp(`^\\s*${modifiers}${chart}\\b`).test(requested);
}

function assertChartPresent(prompt, slides) {
  if (!requestsChart(prompt) || (Array.isArray(slides) && slides.some((s) => s.layout === 'chart' && s.chart))) return;
  const error = new Error('E_PARAMS: No se creó la presentación porque falta la gráfica solicitada. Proporciona sus categorías, valores y fuente, o aclara el tipo de gráfica; no se entregó un archivo incompleto.');
  error.code = 'E_PARAMS';
  error.pptxChartRequirement = true;
  throw error;
}
function label(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(value)) invalid(`${field} inválido`);
  return value;
}
function hex(value) {
  const match = typeof value === 'string' && value.match(HEX);
  if (!match) invalid('color inválido, usa #RRGGBB');
  return match[1].toUpperCase();
}
function vector(values, length, { gaps = true } = {}) {
  if (!Array.isArray(values) || values.length !== length || !values.some(Number.isFinite)
    || !values.every((v) => (gaps && v === null) || (typeof v === 'number' && Number.isFinite(v)))) invalid('valores incompletos o no numéricos');
  return values.slice();
}

function normalizeNativeChart(raw, { defaultType = 'column' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('especificación inválida');
  const type = raw.type === undefined ? defaultType : raw.type;
  if (!TYPES.includes(type)) invalid(`tipo no admitido: ${String(type).slice(0, 40)}`);
  const scatter = type === 'scatter';
  const circular = type === 'pie' || type === 'doughnut';
  const count = scatter ? raw.xValues?.length : raw.labels?.length;
  if (!Number.isInteger(count) || count < 1 || count > MAX_POINTS) invalid(`se requieren 1–${MAX_POINTS} puntos completos`);
  const chart = { type, title: raw.title === undefined ? 'Datos' : label(raw.title, 'título') };
  if (scatter) {
    chart.xValues = vector(raw.xValues, count, { gaps: false });
    if (raw.labels !== undefined) invalid('scatter usa xValues; etiquetas por punto requieren execute_python');
  } else chart.labels = raw.labels.map((v) => label(v, 'etiqueta'));
  const series = raw.series === undefined ? [{ name: chart.title, values: raw.values }] : raw.series;
  if (!Array.isArray(series) || series.length < 1 || series.length > MAX_SERIES || (circular && series.length !== 1)) invalid(`se requieren 1–${MAX_SERIES} series (una en pie/doughnut)`);
  chart.series = series.map((s) => {
    if (!s || typeof s !== 'object') invalid('serie inválida');
    const out = { name: label(s.name, 'nombre de serie'), values: vector(s.values, count, { gaps: !circular }) };
    if (circular && (out.values.some((v) => v < 0) || !out.values.some((v) => v > 0))) invalid('pie/doughnut requiere valores no negativos y total positivo');
    if (s.color !== undefined) out.color = hex(s.color);
    return out;
  });
  // Keep the established single-series shape for preview/provenance consumers.
  if (chart.series.length === 1) chart.values = chart.series[0].values.slice();
  if (raw.values !== undefined && raw.series !== undefined
    && (chart.series.length !== 1 || JSON.stringify(raw.values) !== JSON.stringify(chart.values))) invalid('values y series contienen datos distintos');
  for (const key of ['colors', 'pointColors']) {
    if (raw[key] === undefined) continue;
    const expected = key === 'pointColors' || circular ? count : series.length;
    if (!Array.isArray(raw[key]) || raw[key].length !== expected) invalid(`${key} debe cubrir todos los ${expected} elementos`);
    chart[key] = raw[key].map(hex);
  }
  if (chart.pointColors && !(circular || ((type === 'column' || type === 'bar') && series.length === 1))) invalid('colores por punto no admitidos en este tipo de gráfica');
  if (chart.colors && chart.pointColors && JSON.stringify(chart.colors) !== JSON.stringify(chart.pointColors)) invalid('paletas de colores contradictorias');
  if (chart.colors && !circular && chart.series.some((s, i) => s.color && s.color !== chart.colors[i])) invalid('colores de serie contradictorios');
  if (raw.position !== undefined) {
    const p = raw.position;
    if (!p || !['x', 'y', 'w', 'h'].every((k) => typeof p[k] === 'number' && Number.isFinite(p[k]))
      || p.x < 0 || p.y < 0 || p.w <= 0 || p.h <= 0 || p.x + p.w > 13.334 || p.y + p.h > 7.5) invalid('posición fuera de la diapositiva de 13.333 × 7.5 pulgadas');
    chart.position = { x: p.x, y: p.y, w: p.w, h: p.h };
  }
  for (const key of ['showTitle', 'showLegend', 'showValue', 'showLabel', 'showPercent']) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'boolean') invalid(`${key} debe ser booleano`);
      chart[key] = raw[key];
    }
  }
  if (chart.showPercent && !circular) invalid('porcentajes visibles solo admitidos en pie/doughnut');
  if (chart.showLabel && !circular) invalid('etiquetas por punto solo admitidas en pie/doughnut; usa showValue para mostrar valores');
  if (raw.legendPosition !== undefined) {
    if (!['bottom', 'left', 'right', 'top', 'top-right'].includes(raw.legendPosition)) invalid('posición de leyenda inválida');
    chart.legendPosition = raw.legendPosition;
  }
  if (raw.grouping !== undefined) {
    if (!(['column', 'bar'].includes(type) && ['clustered', 'stacked', 'percentStacked'].includes(raw.grouping))
      && !(type === 'area' && raw.grouping === 'stacked')) invalid('agrupación no admitida');
    chart.grouping = raw.grouping;
  }
  for (const [key, max] of [['xAxisTitle', 200], ['yAxisTitle', 200], ['source', 500], ['unit', 80], ['asOf', 80]]) {
    if (raw[key] !== undefined && raw[key] !== '') chart[key] = label(raw[key], key, max);
  }
  return chart;
}

function addNativeChart(slide, pptx, raw, { position, colors = PALETTE, fontFace = 'Calibri', defaultType = 'column' } = {}) {
  const chart = normalizeNativeChart(raw, { defaultType });
  const circular = chart.type === 'pie' || chart.type === 'doughnut';
  const palette = Array.isArray(colors) && colors.length ? colors : PALETTE;
  const chartColors = chart.pointColors || chart.colors || (circular && !chart.series[0].color
    ? chart.labels.map((_, i) => palette[i % palette.length])
    : chart.series.map((s, i) => s.color || palette[i % palette.length]));
  // Installed PptxGenJS writes workbook cells with `value || ''`, which loses
  // numeric zero although the chart cache keeps it. The truthy numeric XML
  // literal fixes that writer boundary only: cells remain numeric (<v>0</v>,
  // no string cell type). Null stays blank and public data stays number/null.
  const writerValues = (values) => values.map((value) => value === 0 ? '0' : value);
  const data = chart.series.map((s) => ({ name: s.name, ...(chart.labels ? { labels: chart.labels.slice() } : {}), values: writerValues(s.values) }));
  if (chart.type === 'scatter') data.unshift({ name: chart.xAxisTitle || 'X', values: writerValues(chart.xValues) });
  const opts = {
    ...(position || { x: 0.75, y: 1.8, w: 11.8, h: 4.9 }), ...chart.position,
    catAxisLabelFontFace: fontFace, valAxisLabelFontFace: fontFace, dataLabelFontFace: fontFace,
    chartColors, title: chart.title, showTitle: chart.showTitle ?? true, showLegend: chart.showLegend ?? (chart.series.length > 1 || circular),
    showValue: chart.showValue ?? false, showLabel: chart.showLabel ?? false, showPercent: chart.showPercent ?? false,
    legendPos: { bottom: 'b', left: 'l', right: 'r', top: 't', 'top-right': 'tr' }[chart.legendPosition || 'bottom'],
    displayBlanksAs: 'gap', dataLabelFontSize: 12,
    ...(chart.type === 'column' || chart.type === 'bar' ? { barDir: chart.type === 'column' ? 'col' : 'bar' } : {}),
    ...(chart.grouping ? { barGrouping: chart.grouping } : {}),
    ...(chart.xAxisTitle ? { catAxisTitle: chart.xAxisTitle, showCatAxisTitle: true } : {}),
    ...(chart.yAxisTitle ? { valAxisTitle: chart.yAxisTitle, showValAxisTitle: true } : {}),
  };
  // Actual option names are kept here, not accepted as arbitrary caller input.
  slide.addChart(pptx.ChartType[chart.type === 'column' ? 'bar' : chart.type], data, opts);
  return chart;
}

module.exports = { CHART_SCHEMA, MAX_POINTS, MAX_SERIES, normalizeNativeChart, addNativeChart, assertChartPresent, requestsChart };
