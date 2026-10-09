'use strict';

// A conservative OOXML preflight, not a substitute for rendering every slide.
// Only explicit, provable defects block delivery. Unknown theme/layout styles,
// complex paint effects and unsupported text containers are counted as unchecked.
const path = require('node:path');
const PizZip = require('pizzip');
const { XMLParser } = require('fast-xml-parser');

const EMU = 914400;
const TOLERANCE = 0.02 * EMU;
const MIN_FONT_PT = 6;
const MAX_XML_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_XML_BYTES = 32 * 1024 * 1024;
const MAX_SLIDES = 200;
const IDENTITY = [1, 0, 0, 1, 0, 0];
const parser = new XMLParser({ ignoreAttributes: false, preserveOrder: true, trimValues: false, parseTagValue: false, processEntities: false });
const children = (node, name) => (node?.children || []).filter((item) => item.name === name);
const child = (node, name) => children(node, name)[0];
const at = (node, ...names) => names.reduce((current, name) => child(current, name), node);
const number = (value) => value == null || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
const truthy = (value) => value === '1' || value === 'true';
const own = (obj, name) => Object.prototype.hasOwnProperty.call(obj || {}, name);

const NAMESPACES = {
  'http://schemas.openxmlformats.org/presentationml/2006/main': 'p',
  'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://schemas.openxmlformats.org/package/2006/relationships': '',
  'http://purl.oclc.org/ooxml/presentationml/main': 'p',
  'http://purl.oclc.org/ooxml/drawingml/main': 'a',
  'http://purl.oclc.org/ooxml/officeDocument/relationships': 'r',
};
function tree(items, inheritedNamespaces = {}) {
  return items.flatMap((item) => {
    const originalName = Object.keys(item).find((key) => key !== ':@');
    if (!originalName || originalName[0] === '?') return [];
    if (originalName === '#text') return [{ name: originalName, text: String(item[originalName]), children: [], attrs: {} }];
    const rawAttrs = Object.fromEntries(Object.entries(item[':@'] || {}).map(([key, value]) => [key.replace(/^@_/, ''), value]));
    const namespaces = { ...inheritedNamespaces };
    for (const [key, value] of Object.entries(rawAttrs)) {
      if (key === 'xmlns') namespaces[''] = value;
      else if (key.startsWith('xmlns:')) namespaces[key.slice(6)] = value;
    }
    const canonical = (name, attribute = false) => {
      if (attribute && !name.includes(':')) return name;
      const [prefix, local] = name.includes(':') ? name.split(':') : ['', name];
      const replacement = NAMESPACES[namespaces[prefix]];
      return replacement == null ? name : `${replacement ? `${replacement}:` : ''}${local}`;
    };
    return [{ name: canonical(originalName), attrs: Object.fromEntries(Object.entries(rawAttrs).map(([key, value]) => [canonical(key, true), value])), children: tree(Array.isArray(item[originalName]) ? item[originalName] : [], namespaces) }];
  });
}
function hasText(node) {
  return !!node && (node.name === 'a:t' ? node.children.some((item) => /\S/.test(item.text || '')) : node.children.some(hasText));
}
function descendants(node, name) {
  return (node?.children || []).flatMap((item) => [...(item.name === name ? [item] : []), ...descendants(item, name)]);
}
function multiply(a, b) {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
const translate = (x, y) => [1, 0, 0, 1, x, y];
function transform(node, group = false) {
  if (!node) return null;
  const off = child(node, 'a:off')?.attrs, ext = child(node, 'a:ext')?.attrs;
  const x = number(off?.x), y = number(off?.y), w = number(ext?.cx), h = number(ext?.cy);
  if ([x, y, w, h].some((v) => v == null) || w <= 0 || h <= 0) return null;
  const rotation = number(node.attrs.rot) || 0;
  const angle = rotation / 60000 * Math.PI / 180;
  let matrix = multiply(translate(x + w / 2, y + h / 2), [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0]);
  matrix = multiply(matrix, [truthy(node.attrs.flipH) ? -1 : 1, 0, 0, truthy(node.attrs.flipV) ? -1 : 1, 0, 0]);
  if (group) {
    const co = child(node, 'a:chOff')?.attrs, ce = child(node, 'a:chExt')?.attrs;
    const cx = number(co?.x), cy = number(co?.y), cw = number(ce?.cx), ch = number(ce?.cy);
    if ([cx, cy, cw, ch].some((v) => v == null) || cw <= 0 || ch <= 0) return null;
    matrix = multiply(matrix, [w / cw, 0, 0, h / ch, 0, 0]);
    matrix = multiply(matrix, translate(-cx - cw / 2, -cy - ch / 2));
  } else matrix = multiply(matrix, translate(-w / 2, -h / 2));
  return { matrix, w, h };
}
function rectangle(matrix, w, h) {
  const points = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]);
  return { left: Math.min(...points.map((p) => p[0])), top: Math.min(...points.map((p) => p[1])), right: Math.max(...points.map((p) => p[0])), bottom: Math.max(...points.map((p) => p[1])) };
}
const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const encloses = (a, b) => a.left <= b.left && a.right >= b.right && a.top <= b.top && a.bottom >= b.bottom;
const axisAligned = (matrix) => Math.abs(matrix[1]) < 1e-8 && Math.abs(matrix[2]) < 1e-8;
function solidRgb(parent) {
  const fill = child(parent, 'a:solidFill');
  const rgb = child(fill, 'a:srgbClr');
  if (!rgb || !/^[a-f0-9]{6}$/i.test(rgb.attrs.val || '')) return null;
  if (rgb.children.some((item) => item.name !== 'a:alpha' || Number(item.attrs.val) !== 100000)) return null;
  return rgb.attrs.val.toUpperCase();
}
function hasPaintEffects(node) {
  return !!node && (['a:effectLst', 'a:effectDag', 'a:scene3d', 'a:sp3d', 'a:highlight', 'a:ln'].some((name) => children(node, name).some((item) => item.children.length > 0)));
}
function explicitRunProperty(runProps, defaultProps, key) {
  return own(runProps?.attrs, key) ? number(runProps.attrs[key]) : number(defaultProps?.attrs[key]);
}
function foreground(runProps, defaultProps) {
  const fillKinds = ['a:solidFill', 'a:noFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill'];
  const selected = fillKinds.some((name) => child(runProps, name)) ? runProps : defaultProps;
  return solidRgb(selected);
}
function shapeId(shape) {
  const id = descendants(shape, 'p:cNvPr')[0]?.attrs.id;
  return /^\d{1,10}$/.test(String(id)) ? String(id) : null;
}
function relPart(part) { return `${path.posix.dirname(part)}/_rels/${path.posix.basename(part)}.rels`; }
function resolvePart(part, target) {
  if (!target || target.includes('\\') || /^[a-z]+:/i.test(target)) return null;
  const result = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(part), target));
  return result.startsWith('ppt/') && !result.includes('../') ? result : null;
}

function auditPptxDesign(buffer) {
  const issues = [];
  const coverage = { slides: 0, textShapes: 0, geometryChecked: 0, geometrySkipped: 0, fontRunsChecked: 0, fontRunsSkipped: 0, contrastRunsChecked: 0, contrastRunsSkipped: 0, nonTextShapes: 0, unsupportedTextContainers: 0, hiddenShapes: 0, mode: 'static-explicit-properties', complete: false, rendered: false };
  const result = () => ({ passed: !issues.some((issue) => issue.severity === 'error'), issues, coverage });
  const issue = (code, severity, slide = null, id = null, extra = {}) => issues.push({ code, severity, slide, shapeId: id, ...extra });
  try {
    const zip = new PizZip(buffer);
    const cache = new Map(); let totalBytes = 0;
    const read = (part, required = true) => {
      if (cache.has(part)) return cache.get(part);
      const file = zip.file(part);
      if (!file) { if (required) throw new Error('invalid_package'); return null; }
      const declared = number(file._data?.uncompressedSize);
      if (declared != null && (declared > MAX_XML_BYTES || totalBytes + declared > MAX_TOTAL_XML_BYTES)) throw new Error('audit_limit');
      const bytes = file.asNodeBuffer(); totalBytes += bytes.length;
      if (bytes.length > MAX_XML_BYTES || totalBytes > MAX_TOTAL_XML_BYTES) throw new Error('audit_limit');
      const xml = bytes.toString('utf8');
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('invalid_package');
      const root = tree(parser.parse(xml, true))[0];
      cache.set(part, root); return root;
    };
    const relationships = (part) => children(read(relPart(part), false), 'Relationship');
    const related = (part, suffix) => {
      const rel = relationships(part).find((r) => r.attrs.Type?.endsWith(`/${suffix}`) && r.attrs.TargetMode !== 'External');
      return rel ? resolvePart(part, rel.attrs.Target) : null;
    };
    const hasInheritedPaint = (part) => {
      const layoutPart = related(part, 'slideLayout');
      if (!layoutPart) return true;
      const layout = read(layoutPart, false);
      const masterPart = related(layoutPart, 'slideMaster');
      const master = masterPart ? read(masterPart, false) : null;
      if (!layout || !master) return true;
      return [layout, master].some((root) => (at(root, 'p:cSld', 'p:spTree')?.children || []).some((item) => ['p:sp', 'p:pic', 'p:grpSp', 'p:graphicFrame', 'p:cxnSp', 'mc:AlternateContent'].includes(item.name)));
    };
    const presentation = read('ppt/presentation.xml');
    const size = child(presentation, 'p:sldSz')?.attrs;
    const width = number(size?.cx), height = number(size?.cy);
    if (!width || !height || width <= 0 || height <= 0) throw new Error('invalid_package');
    const rels = relationships('ppt/presentation.xml');
    const refs = children(child(presentation, 'p:sldIdLst'), 'p:sldId');
    if (!refs.length) throw new Error('invalid_package');
    if (refs.length > MAX_SLIDES) throw new Error('audit_limit');
    for (const [index, ref] of refs.entries()) {
      const slideNumber = index + 1;
      const rel = rels.find((r) => r.attrs.Id === ref.attrs['r:id'] && r.attrs.Type?.endsWith('/slide') && r.attrs.TargetMode !== 'External');
      const part = rel && resolvePart('ppt/presentation.xml', rel.attrs.Target);
      if (!part) throw new Error('invalid_package');
      const slide = read(part); coverage.slides += 1;
      if (slide?.name !== 'p:sld') throw new Error('invalid_package');
      const inheritedPaint = hasInheritedPaint(part);
      const baseColor = inheritedPaint ? null : solidRgb(at(slide, 'p:cSld', 'p:bg', 'p:bgPr'));
      const layers = [];
      const visit = (container, parentMatrix, fontScaleKnown = true) => {
        for (const shape of container?.children || []) {
          const nonVisual = ['p:nvSpPr', 'p:nvGrpSpPr', 'p:nvPicPr', 'p:nvGraphicFramePr', 'p:nvCxnSpPr'].map((name) => child(shape, name)).find(Boolean);
          if (truthy(child(nonVisual, 'p:cNvPr')?.attrs.hidden)) { coverage.hiddenShapes += 1; continue; }
          if (shape.name === 'p:grpSp') {
            const tr = transform(at(shape, 'p:grpSpPr', 'a:xfrm'), true);
            const matrix = parentMatrix && tr ? multiply(parentMatrix, tr.matrix) : null;
            // Group scaling changes font rendering; only unit-scale groups are
            // measured for font size. Geometry still uses the full affine map.
            const unit = tr && Math.abs(Math.hypot(tr.matrix[0], tr.matrix[1]) - 1) < 1e-8 && Math.abs(Math.hypot(tr.matrix[2], tr.matrix[3]) - 1) < 1e-8;
            visit(shape, matrix, fontScaleKnown && !!unit); continue;
          }
          if (!['p:sp', 'p:pic', 'p:graphicFrame', 'p:cxnSp', 'mc:AlternateContent'].includes(shape.name)) continue;
          const props = child(shape, 'p:spPr');
          const tr = transform(child(props, 'a:xfrm'));
          const matrix = parentMatrix && tr ? multiply(parentMatrix, tr.matrix) : null;
          const bounds = matrix ? rectangle(matrix, tr.w, tr.h) : null;
          const body = child(shape, 'p:txBody');
          const text = hasText(body);
          const effects = hasPaintEffects(props) || !!child(shape, 'p:style');
          const rectangular = child(props, 'a:prstGeom')?.attrs.prst === 'rect' && matrix && axisAligned(matrix);
          const fill = !effects && rectangular ? solidRgb(props) : null;
          const noFill = !!child(props, 'a:noFill');
          if (text) {
            coverage.textShapes += 1;
            const id = shapeId(shape);
            if (!bounds) coverage.geometrySkipped += 1;
            else {
              coverage.geometryChecked += 1;
              if (bounds.right < -TOLERANCE || bounds.bottom < -TOLERANCE || bounds.left > width + TOLERANCE || bounds.top > height + TOLERANCE) issue('PPTX_TEXT_OUTSIDE_SLIDE', 'error', slideNumber, id);
              else if (bounds.left < -TOLERANCE || bounds.top < -TOLERANCE || bounds.right > width + TOLERANCE || bounds.bottom > height + TOLERANCE) issue('PPTX_TEXT_BOX_CROSSES_SLIDE', 'warning', slideNumber, id);
            }
            let background = fill;
            if (!background && noFill && bounds && !effects) {
              background = baseColor;
              for (const layer of layers) {
                if (!layer.bounds || intersects(layer.bounds, bounds)) background = layer.fill && layer.bounds && encloses(layer.bounds, bounds) ? layer.fill : null;
              }
            }
            const bodyProps = child(body, 'a:bodyPr');
            const autofit = child(bodyProps, 'a:normAutofit');
            const rawScale = autofit && own(autofit.attrs, 'fontScale') ? number(autofit.attrs.fontScale) : 100000;
            const scale = rawScale != null && rawScale > 0 && rawScale <= 100000 ? rawScale / 100000 : null;
            for (const paragraph of children(body, 'a:p')) {
              const defaults = at(paragraph, 'a:pPr', 'a:defRPr');
              for (const run of [...children(paragraph, 'a:r'), ...children(paragraph, 'a:fld')].filter(hasText)) {
                const runProps = child(run, 'a:rPr');
                const sz = explicitRunProperty(runProps, defaults, 'sz');
                // Baseline shifts (superscript/subscript) can intentionally use
                // tiny glyphs; inherited run size/transform remains unchecked.
                const baseline = explicitRunProperty(runProps, defaults, 'baseline');
                if (sz != null && sz > 0 && scale != null && fontScaleKnown && !baseline) {
                  coverage.fontRunsChecked += 1;
                  const pt = sz / 100 * scale;
                  if (pt < MIN_FONT_PT) issue('PPTX_TEXT_TOO_SMALL', 'error', slideNumber, id, { fontSizePt: Math.round(pt * 100) / 100 });
                } else coverage.fontRunsSkipped += 1;
                const color = foreground(runProps, defaults);
                if (background && color && !effects && !hasPaintEffects(runProps) && !hasPaintEffects(defaults)) {
                  coverage.contrastRunsChecked += 1;
                  if (color === background) issue('PPTX_TEXT_INVISIBLE_CONTRAST', 'error', slideNumber, id);
                } else coverage.contrastRunsSkipped += 1;
              }
            }
          } else {
            coverage.nonTextShapes += 1;
            if (hasText(shape)) coverage.unsupportedTextContainers += 1;
          }
          // Text-only overlays also affect a later shape's background. Do not
          // pretend these can be reduced to one solid color without rendering.
          layers.push({ bounds, fill: text ? null : fill });
        }
      };
      visit(at(slide, 'p:cSld', 'p:spTree'), IDENTITY);
    }
    coverage.complete = true;
  } catch (error) {
    issue(error?.message === 'audit_limit' ? 'PPTX_DESIGN_AUDIT_LIMIT' : 'PPTX_DESIGN_AUDIT_INVALID_PACKAGE', 'error');
  }
  return result();
}

module.exports = { auditPptxDesign };
