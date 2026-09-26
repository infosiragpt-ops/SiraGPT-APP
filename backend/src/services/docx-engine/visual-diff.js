'use strict';

/**
 * Pixel comparison of rendered pages (before → after an edit).
 *
 * The page is split into a grid of BLOCK×BLOCK cells; a cell counts as
 * changed when enough of its pixels differ in luminance. Adjacent changed
 * cells merge into regions (bounding boxes in pixels) — those are what the
 * agent and the UI get to see: «Página 1: 2 zonas cambiadas; resto idéntico»
 * plus the after-page annotated with red boxes around each region.
 *
 * sharp is loaded lazily: the engine still works without a renderer, and the
 * unit tests run on generated PNGs.
 */

const BLOCK = 12;
const PIXEL_THRESHOLD = 48;   // 0..255 luminance delta that counts as a changed pixel
const BLOCK_RATIO = 0.02;     // share of changed pixels for a block to count as changed
const MAX_REGIONS = 12;
const THUMB_WIDTH = 720;

function loadSharp() {
  // eslint-disable-next-line global-require
  return require('sharp');
}

async function toGray(png) {
  const sharp = loadSharp();
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function resizeTo(png, width, height) {
  const sharp = loadSharp();
  return sharp(png).resize(width, height, { fit: 'fill' }).png().toBuffer();
}

/** Connected components (4-neighbour) over a boolean grid → bounding boxes in block units. */
function componentsOf(grid, cols, rows) {
  const seen = new Uint8Array(cols * rows);
  const boxes = [];
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const idx = y * cols + x;
      if (!grid[idx] || seen[idx]) continue;
      let minX = x; let maxX = x; let minY = y; let maxY = y; let count = 0;
      const stack = [idx];
      seen[idx] = 1;
      while (stack.length) {
        const cur = stack.pop();
        const cx = cur % cols;
        const cy = (cur - cx) / cols;
        count += 1;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        const neighbours = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]];
        for (const [nx, ny] of neighbours) {
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const n = ny * cols + nx;
          if (grid[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
      boxes.push({ minX, maxX, minY, maxY, count });
    }
  }
  return boxes;
}

function overlapsOrTouches(a, b, gap) {
  return !(a.maxX + gap < b.minX || b.maxX + gap < a.minX || a.maxY + gap < b.minY || b.maxY + gap < a.minY);
}

function mergeBoxes(boxes, gap = 1) {
  let merged = boxes.map((b) => ({ ...b }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < merged.length && !changed; i += 1) {
      for (let j = i + 1; j < merged.length; j += 1) {
        if (overlapsOrTouches(merged[i], merged[j], gap)) {
          merged[i] = {
            minX: Math.min(merged[i].minX, merged[j].minX), maxX: Math.max(merged[i].maxX, merged[j].maxX),
            minY: Math.min(merged[i].minY, merged[j].minY), maxY: Math.max(merged[i].maxY, merged[j].maxY),
            count: merged[i].count + merged[j].count,
          };
          merged.splice(j, 1);
          changed = true;
          break;
        }
      }
    }
  }
  return merged;
}

/** Where on the page a region sits, for the Spanish summary. */
function zoneLabel(region, width, height) {
  const cx = region.x + region.w / 2;
  const cy = region.y + region.h / 2;
  const vertical = cy < height / 3 ? 'parte superior' : cy < (2 * height) / 3 ? 'parte media' : 'parte inferior';
  const horizontal = cx < width / 3 ? 'izquierda' : cx < (2 * width) / 3 ? 'centro' : 'derecha';
  return `${vertical}, ${horizontal}`;
}

/**
 * Compare two page bitmaps.
 * @returns {Promise<{ identical: boolean, changedRatio: number, regions: Array<{x,y,w,h,zone}>, width, height, resized: boolean }>}
 */
async function diffPagePngs(beforePng, afterPng, { block = BLOCK, pixelThreshold = PIXEL_THRESHOLD, blockRatio = BLOCK_RATIO, maxRegions = MAX_REGIONS } = {}) {
  const a = await toGray(beforePng);
  let b = await toGray(afterPng);
  let resized = false;
  if (a.width !== b.width || a.height !== b.height) {
    b = await toGray(await resizeTo(afterPng, a.width, a.height));
    resized = true;
  }
  const { width, height } = a;
  const cols = Math.ceil(width / block);
  const rows = Math.ceil(height / block);
  const grid = new Uint8Array(cols * rows);
  let changedBlocks = 0;
  for (let by = 0; by < rows; by += 1) {
    for (let bx = 0; bx < cols; bx += 1) {
      const x0 = bx * block; const y0 = by * block;
      const x1 = Math.min(width, x0 + block); const y1 = Math.min(height, y0 + block);
      let differing = 0;
      for (let y = y0; y < y1; y += 1) {
        const rowOffset = y * width;
        for (let x = x0; x < x1; x += 1) {
          const i = rowOffset + x;
          if (Math.abs(a.data[i] - b.data[i]) > pixelThreshold) differing += 1;
        }
      }
      const total = (x1 - x0) * (y1 - y0);
      if (total > 0 && differing / total >= blockRatio) {
        grid[by * cols + bx] = 1;
        changedBlocks += 1;
      }
    }
  }
  const boxes = mergeBoxes(componentsOf(grid, cols, rows));
  boxes.sort((p, q) => q.count - p.count);
  const regions = boxes.slice(0, maxRegions).map((box) => {
    const x = box.minX * block; const y = box.minY * block;
    const w = Math.min(width, (box.maxX + 1) * block) - x;
    const h = Math.min(height, (box.maxY + 1) * block) - y;
    const region = { x, y, w, h };
    return { ...region, zone: zoneLabel(region, width, height) };
  });
  return {
    identical: changedBlocks === 0,
    changedRatio: cols * rows ? changedBlocks / (cols * rows) : 0,
    regions,
    regionsTotal: boxes.length,
    width,
    height,
    resized,
  };
}

function svgOverlay(regions, width, height, color) {
  const rects = regions.map((r) => `<rect x="${Math.max(0, r.x - 4)}" y="${Math.max(0, r.y - 4)}" width="${Math.min(width, r.w + 8)}" height="${Math.min(height, r.h + 8)}" rx="4" fill="none" stroke="${color}" stroke-width="3"/>`).join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects}</svg>`);
}

/** After-page with a red box around each changed region. */
async function annotatePng(png, regions, { color = '#E0483E' } = {}) {
  if (!Array.isArray(regions) || !regions.length) return png;
  const sharp = loadSharp();
  const meta = await sharp(png).metadata();
  const overlay = svgOverlay(regions, meta.width, meta.height, color);
  return sharp(png).composite([{ input: overlay, top: 0, left: 0 }]).png().toBuffer();
}

/** Compact JPEG data URI for the chat timeline / model context. */
async function thumbnailDataUri(png, { width = THUMB_WIDTH, quality = 74 } = {}) {
  const sharp = loadSharp();
  const jpeg = await sharp(png).resize({ width, withoutEnlargement: true }).jpeg({ quality }).toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

function pngDataUri(png) {
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}

function rangeText(pages) {
  if (!pages.length) return '';
  if (pages.length === 1) return `Página ${pages[0]}`;
  const sorted = [...pages].sort((a, b) => a - b);
  const contiguous = sorted.every((p, i) => i === 0 || p === sorted[i - 1] + 1);
  return contiguous ? `Páginas ${sorted[0]}–${sorted[sorted.length - 1]}` : `Páginas ${sorted.join(', ')}`;
}

/**
 * Spanish summary of a per-page comparison.
 * @param {Array<{ page: number, diff?: object, missing?: 'before'|'after' }>} pages
 */
function summarizeVisualDiff(pages, { pagesBefore = null, pagesAfter = null } = {}) {
  const lines = [];
  if (Number.isInteger(pagesBefore) && Number.isInteger(pagesAfter) && pagesBefore !== pagesAfter) {
    lines.push(`El número de páginas cambió: ${pagesBefore} → ${pagesAfter}.`);
  }
  const identical = [];
  for (const entry of pages) {
    if (entry.missing === 'before') { lines.push(`Página ${entry.page}: nueva (no existía en el original).`); continue; }
    if (entry.missing === 'after') { lines.push(`Página ${entry.page}: ya no existe en el documento editado.`); continue; }
    const diff = entry.diff;
    if (!diff) continue;
    if (diff.identical) { identical.push(entry.page); continue; }
    const zones = diff.regions.map((r) => r.zone);
    const count = diff.regionsTotal ?? diff.regions.length;
    lines.push(`Página ${entry.page}: ${count} zona${count === 1 ? '' : 's'} cambiada${count === 1 ? '' : 's'} (${[...new Set(zones)].join('; ')}); el resto de la página es idéntico.`);
  }
  if (identical.length) lines.push(`${rangeText(identical)}: idéntica${identical.length === 1 ? '' : 's'} al original.`);
  if (!lines.length) lines.push('No hay páginas que comparar.');
  return lines.join('\n');
}

/**
 * Full before/after comparison of two page sets.
 * @returns {Promise<{ pages: Array<{page, diff|missing}>, summary: string, anyChange: boolean, annotated: Array<{page, png}> }>}
 */
async function comparePageSets(beforePages, afterPages, { annotate = true, pagesBefore = null, pagesAfter = null } = {}) {
  const before = new Map((beforePages || []).map((p) => [p.page, p.png]));
  const after = new Map((afterPages || []).map((p) => [p.page, p.png]));
  const numbers = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b);
  const pages = [];
  const annotated = [];
  let anyChange = false;
  for (const page of numbers) {
    if (!before.has(page)) { pages.push({ page, missing: 'before' }); anyChange = true; if (annotate) annotated.push({ page, png: after.get(page) }); continue; }
    if (!after.has(page)) { pages.push({ page, missing: 'after' }); anyChange = true; continue; }
    const diff = await diffPagePngs(before.get(page), after.get(page));
    pages.push({ page, diff });
    if (!diff.identical) {
      anyChange = true;
      if (annotate) annotated.push({ page, png: await annotatePng(after.get(page), diff.regions) });
    }
  }
  return { pages, summary: summarizeVisualDiff(pages, { pagesBefore, pagesAfter }), anyChange, annotated };
}

module.exports = {
  BLOCK,
  diffPagePngs,
  annotatePng,
  thumbnailDataUri,
  pngDataUri,
  summarizeVisualDiff,
  comparePageSets,
  zoneLabel,
  mergeBoxes,
};
