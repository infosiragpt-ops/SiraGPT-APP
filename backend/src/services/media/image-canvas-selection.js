'use strict';

/**
 * Which attached picture is the CANVAS (the image being edited) and which
 * are MATERIAL (a logo, a signature, a sticker…) when one turn carries
 * several images and nobody pinned one. Upload order used to decide («the
 * first file is the canvas»), which put the logo under the photo as often
 * as not. Pure ranking over names, pixels and the user's words; the caller
 * supplies the metrics (see `imageMetrics`).
 *
 * The order only changes on STRONG material evidence (a material file name,
 * or real transparency): size alone, two ordinary photos, an explicit order
 * in the words («la primera imagen») or a composition request («combina
 * estas dos fotos») keep the user's order.
 */

function fold(value) {
  return String(value == null ? '' : value)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

// File names that announce material to place or follow.
const MATERIAL_NAME_RE = /(?:^|[^a-z])(?:logos?|logotipos?|isotipos?|imagotipos?|marcas?|brands?|iconos?|icons?|stickers?|pegatinas?|firmas?|signatures?|watermarks?|marcas?[-_ ]?de[-_ ]?agua|sellos?|stamps?|emblemas?|insignias?|badges?|escudos?|qr|overlays?)(?:[^a-z]|$)/;
// File names that announce the picture being edited.
const CANVAS_NAME_RE = /(?:^|[^a-z])(?:fotos?|photos?|retratos?|portraits?|fondos?|backgrounds?|banners?|posters?|afiches?|escenas?|scenes?|paisajes?|landscapes?|productos?|products?|selfies?|capturas?|screenshots?|img|dsc|pxl|whatsapp image|images?|imagen(?:es)?|camisetas?|playeras?|remeras?|poleras?|tazas?|mockups?)(?:[^a-z]|$)/;
// The user's words.
const MATERIAL_WORDS = 'logos?|logotipos?|isotipos?|imagotipos?|marcas?|iconos?|stickers?|pegatinas?|firmas?|sellos?|emblemas?|insignias?|escudos?|marcas? de agua|watermarks?|signatures?|badges?|stamps?|icons?|qr';
const CANVAS_WORDS = 'fotos?|fotografias?|imagen(?:es)?|retratos?|fondos?|escenas?|paisajes?|productos?|selfies?|capturas?|screenshots?|camisetas?|playeras?|remeras?|poleras?|tazas?|photos?|pictures?|images?|portraits?|backgrounds?|scenes?|shirts?|mugs?';
const MATERIAL_WORD_RE = new RegExp(`\\b(?:${MATERIAL_WORDS})\\b`);
const CANVAS_WORD_RE = new RegExp(`\\b(?:${CANVAS_WORDS})\\b`);
// «ponle este logo a la foto»: a placing verb, or a destination preposition
// before a canvas noun. Without one, a material noun is the thing being
// edited («haz que este logo tenga los colores de esta foto»).
const PLACING_RE = new RegExp(`\\b(?:pon(?:le|lo|la|los|las|me)?|coloca(?:le|lo|la|me)?|agrega(?:le|lo|la|me)?|anade(?:le|lo|la|me)?|inserta(?:le|lo|la)?|pega(?:le|lo|la)?|superpon(?:e|lo|la)?|estampa(?:lo|la)?|incrusta(?:lo|la)?|put|place|add|insert|overlay|stick|stamp|paste)\\b|\\b(?:a|en|sobre|dentro de|encima de|on|onto|into)\\s+(?:la|el|esta|este|mi|the|this|my)\\s+(?:${CANVAS_WORDS})\\b`);
// «la primera imagen», «the second photo»: the user already ordered the inputs.
const EXPLICIT_ORDER_RE = /\b(?:la |el |a la |de la |en la )?(?:primer[ao]|segund[ao]|tercer[ao]|cuart[ao]|penultim[ao]|ultim[ao])\b|\b(?:the )?(?:first|second|third|fourth|last) (?:image|photo|picture|one|file)\b|\bimagen [1-8]\b|\bimage [1-8]\b/;
// A composition: no canvas and no material, both pictures are content.
const COMPOSITION_RE = /\b(?:collage|montaje|mosaico|mosaic|montage|grid|cuadricula|combina(?:r|los|las|me)?|une(?:los|las|me)?|junta(?:los|las|me)?|mezcla(?:r|los|las)?|fusiona(?:r|los|las)?|lado a lado|una sola imagen|en una sola|side by side|merge|combine|blend|compose|stitch|face ?swap|intercambia(?:r)? (?:las )?caras|cambia la cara)\b/;

/** «combina estas dos fotos», «haz un collage»: both pictures are content. */
function isCompositionRequest(instruction) {
  return COMPOSITION_RE.test(fold(instruction));
}

/** «la primera imagen», «the second photo»: the words already order the inputs. */
function hasExplicitOrder(instruction) {
  return EXPLICIT_ORDER_RE.test(fold(instruction));
}

/**
 * Best-effort pixel facts of an image buffer (null fields when unreadable).
 * Transparency is measured on a 64 px thumbnail, never on the full image.
 */
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
        const stats = await image.clone().resize(64, 64, { fit: 'inside', withoutEnlargement: true }).stats();
        out.transparent = stats && stats.isOpaque === false;
      } catch { out.transparent = false; }
    }
  } catch { /* not an image sharp can read: keep nulls */ }
  return out;
}

/**
 * How much an image looks like MATERIAL rather than the canvas. Positive =
 * material, negative = canvas. `evidence` is true only for STRONG material
 * signals (a material name, real transparency); size alone is weak.
 */
function materialScore(image, { maxArea }) {
  const name = fold(image && image.name);
  let score = 0;
  const reasons = [];
  const materialName = Boolean(name) && MATERIAL_NAME_RE.test(name);
  const canvasName = Boolean(name) && !materialName && CANVAS_NAME_RE.test(name);
  if (materialName) { score += 3; reasons.push('name:material'); }
  if (canvasName) { score -= 3; reasons.push('name:canvas'); }
  if (image && image.transparent) { score += 2; reasons.push('alpha'); }
  const area = Number(image && image.area);
  const small = Number.isFinite(area) && area > 0 && Number.isFinite(maxArea) && maxArea > 0 && area <= maxArea * 0.4;
  if (small) { score += 1; reasons.push('small'); }
  return { score, reasons, evidence: materialName || Boolean(image && image.transparent) };
}

function keepOrder(ids, reason, confidence = 'low') {
  const roles = {};
  ids.forEach((id, index) => { roles[id] = index === 0 ? 'canvas' : 'material'; });
  return { canvasId: ids[0] || null, referenceIds: ids.slice(1), order: ids, roles, reason, confidence, changed: false };
}

/**
 * @param {{ instruction?: string, images: Array<{ id: string, name?: string, width?: number, height?: number, area?: number, transparent?: boolean }> }} input
 * @returns {{ canvasId: string|null, referenceIds: string[], order: string[], roles: Record<string,'canvas'|'material'>, reason: string, confidence: 'high'|'medium'|'low', changed: boolean }}
 */
function rankEditInputs({ instruction = '', images = [] } = {}) {
  const list = (Array.isArray(images) ? images : []).filter((image) => image && image.id != null).map((image) => ({ ...image, id: String(image.id) }));
  const ids = list.map((image) => image.id);
  if (list.length <= 1) return keepOrder(ids, 'single', 'high');
  const norm = fold(instruction);
  // The words already settled the roles, or there are none to settle.
  if (EXPLICIT_ORDER_RE.test(norm)) return keepOrder(ids, 'explicit-order', 'high');
  if (COMPOSITION_RE.test(norm)) return keepOrder(ids, 'composition', 'high');

  const areas = list.map((image) => Number(image.area) || (Number(image.width) * Number(image.height)) || 0);
  const maxArea = Math.max(0, ...areas);
  const scored = list.map((image, index) => {
    const { score, reasons, evidence } = materialScore({ ...image, area: areas[index] || null }, { maxArea });
    return { id: image.id, index, score, reasons, evidence };
  });
  const withEvidence = scored.filter((entry) => entry.evidence);
  // No strong material signal (two photos, two neutral names, size only):
  // the user's order stands.
  if (!withEvidence.length) return keepOrder(ids, 'upload-order', 'low');
  if (withEvidence.length === scored.length) return keepOrder(ids, 'all-material', 'low');

  // «haz que este logo tenga los colores de esta foto», «cambia el color del
  // logo»: the material noun is the OBJECT being edited, so the material-like
  // picture is the canvas and the others are references.
  const editsMaterial = MATERIAL_WORD_RE.test(norm) && !PLACING_RE.test(norm);
  const pick = editsMaterial
    ? scored.reduce((best, entry) => (entry.score > best.score ? entry : best), scored[0])
    : scored.reduce((best, entry) => (entry.score < best.score ? entry : best), scored[0]);
  const order = [pick.id, ...scored.filter((entry) => entry.id !== pick.id).map((entry) => entry.id)];
  const roles = {};
  order.forEach((id, index) => { roles[id] = index === 0 ? 'canvas' : 'material'; });
  const materialSide = scored.filter((entry) => entry.id !== pick.id);
  const strongEvidence = (entry) => entry.reasons.includes('name:material') || (entry.reasons.includes('alpha') && entry.reasons.includes('small'));
  // Confidence follows the evidence on the picture that drove the decision:
  // the material when placing, the material-looking canvas when editing it.
  const confidence = (editsMaterial ? strongEvidence(pick) : materialSide.some(strongEvidence)) ? 'high' : 'medium';
  const reason = editsMaterial
    ? ['instruction:edits-material', ...pick.reasons].join(',')
    : (materialSide.flatMap((entry) => entry.reasons).join(',') || 'score');
  return { canvasId: pick.id, referenceIds: order.slice(1), order, roles, reason, confidence, changed: pick.id !== ids[0] };
}

const FILE_NAME_RE = /^[\p{L}\p{N} _().,\-\[\]]{1,80}\.[a-z0-9]{2,5}$/iu;

/** The user's own file name, or a neutral label: never an internal id or a URL. */
function displayNameOf(source, index, language = 'es') {
  const record = source && source.record;
  const raw = record ? String(record.originalName || record.filename || '') : '';
  const clean = raw.split(/[\\/]/).pop().split(/[?#]/)[0].trim();
  if (clean && FILE_NAME_RE.test(clean)) return clean;
  return language === 'en' ? `image ${index + 1}` : `imagen ${index + 1}`;
}

/**
 * One sentence for the provider prompt telling which input is the canvas
 * and which inputs are material. Empty with fewer than two sources.
 */
function describeInputRoles(sources, { language = 'es' } = {}) {
  const list = Array.isArray(sources) ? sources.filter(Boolean) : [];
  if (list.length < 2) return '';
  const names = list.map((source, index) => `«${displayNameOf(source, index, language)}»`);
  const materials = names.slice(1).map((name, index) => `${language === 'en' ? 'input image' : 'la imagen'} ${index + 2} (${name})`).join(language === 'en' ? ' and ' : ' y ');
  return language === 'en'
    ? ` Input image 1 (${names[0]}) is the canvas to edit; ${materials} ${list.length > 2 ? 'are' : 'is'} material to place on it or follow. Edit the canvas: keep its scene, subject and composition, and never redraw the canvas from the material.`
    : ` La imagen 1 (${names[0]}) es el lienzo que se edita; ${materials} ${list.length > 2 ? 'son' : 'es'} material para colocar sobre él o seguir. Edita el lienzo: conserva su escena, sujeto y composición, y nunca redibujes el lienzo a partir del material.`;
}

module.exports = {
  imageMetrics,
  rankEditInputs,
  describeInputRoles,
  isCompositionRequest,
  hasExplicitOrder,
  _internal: { materialScore, fold, MATERIAL_NAME_RE, CANVAS_NAME_RE, MATERIAL_WORD_RE, CANVAS_WORD_RE, PLACING_RE, EXPLICIT_ORDER_RE, COMPOSITION_RE, displayNameOf },
};
