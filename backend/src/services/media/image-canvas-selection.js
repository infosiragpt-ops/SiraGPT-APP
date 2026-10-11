'use strict';

/**
 * Which attached picture is the CANVAS (the image being edited) and which
 * are MATERIAL (a logo, a signature, a sticker…) when one turn carries
 * several images and nobody pinned one. Upload order used to decide («the
 * first file is the canvas»), which put the logo under the photo as often
 * as not. Pure ranking over names, pixels and the user's words; the caller
 * supplies the metrics (see `imageMetrics`).
 */

function fold(value) {
  return String(value == null ? '' : value)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

// File names that announce material to place or follow.
const MATERIAL_NAME_RE = /(?:^|[^a-z])(?:logo|logotipo|isotipo|imagotipo|marca|brand|icono?|icon|sticker|pegatina|firma|signature|watermark|marca[-_ ]?de[-_ ]?agua|sello|stamp|emblema|insignia|badge|escudo|qr|overlay)(?:[^a-z]|$)/;
// File names that announce the picture being edited.
const CANVAS_NAME_RE = /(?:^|[^a-z])(?:foto|photo|retrato|portrait|fondo|background|banner|poster|afiche|escena|scene|paisaje|landscape|producto|product|selfie|captura|screenshot|img|dsc|pxl|whatsapp image|image|imagen|camiseta|playera|remera|polera|taza|mockup)(?:[^a-z]|$)/;
// The user's words: «ponle este logo», «agrega esta firma», «con este sticker».
const MATERIAL_WORD_RE = /\b(?:logo|logotipo|isotipo|imagotipo|marca|icono|sticker|pegatina|firma|sello|emblema|insignia|escudo|marca de agua|watermark|signature|badge|stamp|icon|qr)s?\b/;
const CANVAS_WORD_RE = /\b(?:foto|fotografia|imagen|retrato|fondo|escena|paisaje|producto|selfie|captura|screenshot|camiseta|playera|remera|polera|taza|photo|picture|image|portrait|background|scene|shirt|mug)s?\b/;

/** Best-effort pixel facts of an image buffer (null fields when unreadable). */
async function imageMetrics(buffer) {
  const out = { width: null, height: null, area: null, transparent: false, bytes: Buffer.isBuffer(buffer) ? buffer.length : 0 };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return out;
  try {
    const sharp = require('sharp');
    const image = sharp(buffer, { limitInputPixels: 40 * 1024 * 1024 });
    const metadata = await image.metadata();
    const rotated = metadata.orientation && metadata.orientation >= 5;
    out.width = rotated ? metadata.height : metadata.width;
    out.height = rotated ? metadata.width : metadata.height;
    out.area = out.width && out.height ? out.width * out.height : null;
    if (metadata.hasAlpha) {
      try {
        const stats = await image.stats();
        out.transparent = stats && stats.isOpaque === false;
      } catch { out.transparent = false; }
    }
  } catch { /* not an image sharp can read: keep nulls */ }
  return out;
}

/**
 * Score how much an image looks like MATERIAL rather than the canvas.
 * Positive = material, negative = canvas, 0 = no evidence.
 */
function materialScore(image, { maxArea, instructionNamesMaterial }) {
  const name = fold(image && image.name);
  let score = 0;
  const reasons = [];
  if (name && MATERIAL_NAME_RE.test(name)) { score += 3; reasons.push('name:material'); }
  if (name && CANVAS_NAME_RE.test(name) && !MATERIAL_NAME_RE.test(name)) { score -= 3; reasons.push('name:canvas'); }
  if (image && image.transparent) { score += 2; reasons.push('alpha'); }
  const area = Number(image && image.area);
  if (Number.isFinite(area) && area > 0 && Number.isFinite(maxArea) && maxArea > 0 && area <= maxArea * 0.4) {
    score += 1; reasons.push('small');
  }
  // A material noun in the request makes the pixel evidence count double:
  // «ponle este logo» + a small transparent PNG is as clear as a file name.
  if (instructionNamesMaterial && (image?.transparent || reasons.includes('small'))) { score += 1; reasons.push('instruction:material'); }
  return { score, reasons };
}

/**
 * @param {{ instruction?: string, images: Array<{ id: string, name?: string, width?: number, height?: number, area?: number, transparent?: boolean }> }} input
 * @returns {{ canvasId: string|null, referenceIds: string[], order: string[], roles: Record<string,'canvas'|'material'>, reason: string, confidence: 'high'|'medium'|'low', changed: boolean }}
 */
function rankEditInputs({ instruction = '', images = [] } = {}) {
  const list = (Array.isArray(images) ? images : []).filter((image) => image && image.id != null).map((image) => ({ ...image, id: String(image.id) }));
  const ids = list.map((image) => image.id);
  const empty = { canvasId: ids[0] || null, referenceIds: ids.slice(1), order: ids, roles: {}, reason: 'single', confidence: 'high', changed: false };
  if (list.length <= 1) {
    if (ids[0]) empty.roles[ids[0]] = 'canvas';
    return empty;
  }
  const norm = fold(instruction);
  const instructionNamesMaterial = MATERIAL_WORD_RE.test(norm);
  const areas = list.map((image) => Number(image.area) || (Number(image.width) * Number(image.height)) || 0);
  const maxArea = Math.max(0, ...areas);
  const scored = list.map((image, index) => {
    const withArea = { ...image, area: areas[index] || null };
    const { score, reasons } = materialScore(withArea, { maxArea, instructionNamesMaterial });
    return { id: image.id, index, score, reasons };
  });
  const minScore = Math.min(...scored.map((entry) => entry.score));
  const maxScore = Math.max(...scored.map((entry) => entry.score));
  if (minScore === maxScore) {
    // No evidence tells the pictures apart: keep the user's order. When the
    // words name a canvas AND material it is still a coin toss, so say so.
    const roles = {};
    ids.forEach((id, index) => { roles[id] = index === 0 ? 'canvas' : 'material'; });
    return { canvasId: ids[0], referenceIds: ids.slice(1), order: ids, roles, reason: 'upload-order', confidence: 'low', changed: false };
  }
  // The least material-like image is the canvas; ties keep upload order.
  const canvas = scored.reduce((best, entry) => (entry.score < best.score ? entry : best), scored[0]);
  const order = [canvas.id, ...scored.filter((entry) => entry.id !== canvas.id).map((entry) => entry.id)];
  const roles = {};
  order.forEach((id, index) => { roles[id] = index === 0 ? 'canvas' : 'material'; });
  const strong = scored.some((entry) => entry.reasons.some((reason) => reason.startsWith('name:')))
    || scored.some((entry) => entry.reasons.includes('alpha') && entry.reasons.includes('small'));
  const confidence = strong ? 'high' : (maxScore - minScore >= 2 ? 'medium' : 'low');
  const reason = scored.filter((entry) => entry.id !== canvas.id).flatMap((entry) => entry.reasons).filter(Boolean).join(',') || 'score';
  return {
    canvasId: canvas.id,
    referenceIds: order.slice(1),
    order,
    roles,
    reason,
    confidence,
    changed: canvas.id !== ids[0],
  };
}

function displayNameOf(source, index) {
  const record = source && source.record;
  const name = (record && (record.originalName || record.filename)) || (source && source.source) || '';
  const clean = String(name || '').split(/[\\/]/).pop().trim();
  return clean || `imagen ${index + 1}`;
}

/**
 * One sentence for the provider prompt telling which input is the canvas
 * and which inputs are material. Empty with fewer than two sources.
 */
function describeInputRoles(sources, { language = 'es' } = {}) {
  const list = Array.isArray(sources) ? sources.filter(Boolean) : [];
  if (list.length < 2) return '';
  const names = list.map((source, index) => `«${displayNameOf(source, index)}»`);
  const materials = names.slice(1).map((name, index) => `${language === 'en' ? 'input image' : 'la imagen'} ${index + 2} (${name})`).join(language === 'en' ? ' and ' : ' y ');
  return language === 'en'
    ? ` Input image 1 (${names[0]}) is the canvas to edit; ${materials} ${list.length > 2 ? 'are' : 'is'} material to place on it or follow. Edit the canvas: keep its scene, subject and composition, and never redraw the canvas from the material.`
    : ` La imagen 1 (${names[0]}) es el lienzo que se edita; ${materials} ${list.length > 2 ? 'son' : 'es'} material para colocar sobre él o seguir. Edita el lienzo: conserva su escena, sujeto y composición, y nunca redibujes el lienzo a partir del material.`;
}

module.exports = {
  imageMetrics,
  rankEditInputs,
  describeInputRoles,
  _internal: { materialScore, fold, MATERIAL_NAME_RE, CANVAS_NAME_RE, MATERIAL_WORD_RE, CANVAS_WORD_RE, displayNameOf },
};
