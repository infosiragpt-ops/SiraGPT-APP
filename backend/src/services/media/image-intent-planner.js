'use strict';

/**
 * image-intent-planner — deterministic (<2ms, zero LLM) intent classification
 * and strict prompt-obedience planner for SiraGPT image generation & surgical
 * millimeter editing.
 *
 * Guarantees:
 *   1. Compound multi-clause edit prompts ("cambia el cielo a naranja y agrega
 *      un pájaro a la derecha sin quitar el gato") preserve EVERY requested
 *      change instead of locking onto only the first verb.
 *   2. Spatial anchors ("esquina superior derecha", "ojos", "fondo", "en la
 *      mano izquierda") and explicit exclusions ("sin texto", "no cambies el
 *      rostro", "mantén el fondo intacto") become positive preservation
 *      invariants rather than contradictory or ignored clauses.
 *   3. Masked edits (freehand precision brush or rectangular box) compile a
 *      millimetric pixel-lock contract with normalized bounds so EVERY editor
 *      provider (OpenAI, Gemini, OpenRouter) respects the exact target area.
 */

function normalizePlain(text) {
  return String(text == null ? '' : text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const QUOTED_TEXT_RE = /(?:"([^"]{1,160})"|«([^»]{1,160})»|“([^”]{1,160})”|'([^']{2,120})')/g;

function extractQuotedTexts(prompt) {
  const raw = String(prompt == null ? '' : prompt);
  const found = [];
  const seen = new Set();
  for (const match of raw.matchAll(QUOTED_TEXT_RE)) {
    const text = String(match[1] || match[2] || match[3] || match[4] || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(text);
  }
  return found.slice(0, 6);
}

const SPATIAL_ANCHOR_PATTERNS = [
  { id: 'top-left', label: 'top-left corner', re: /\b(?:esquina\s+superior\s+izquierda|arriba\s+a\s+la\s+izquierda|top[\s-]left|upper[\s-]left)\b/i },
  { id: 'top-right', label: 'top-right corner', re: /\b(?:esquina\s+superior\s+derecha|arriba\s+a\s+la\s+derecha|top[\s-]right|upper[\s-]right)\b/i },
  { id: 'bottom-left', label: 'bottom-left corner', re: /\b(?:esquina\s+inferior\s+izquierda|abajo\s+a\s+la\s+izquierda|bottom[\s-]left|lower[\s-]left)\b/i },
  { id: 'bottom-right', label: 'bottom-right corner', re: /\b(?:esquina\s+inferior\s+derecha|abajo\s+a\s+la\s+derecha|bottom[\s-]right|lower[\s-]right)\b/i },
  { id: 'top', label: 'upper area', re: /\b(?:parte\s+superior|en\s+la\s+parte\s+de\s+arriba|arriba\s+del\s+todo|at\s+the\s+top|upper\s+half)\b/i },
  { id: 'bottom', label: 'lower area', re: /\b(?:parte\s+inferior|en\s+la\s+parte\s+de\s+abajo|abajo\s+del\s+todo|at\s+the\s+bottom|lower\s+half)\b/i },
  { id: 'left', label: 'left side', re: /\b(?:a\s+la\s+izquierda|lado\s+izquierdo|on\s+the\s+left|left\s+side)\b/i },
  { id: 'right', label: 'right side', re: /\b(?:a\s+la\s+derecha|lado\s+derecho|on\s+the\s+right|right\s+side)\b/i },
  { id: 'center', label: 'center frame', re: /\b(?:en\s+el\s+centro|al\s+centro|centrad[oa]|in\s+the\s+center|centered)\b/i },
  { id: 'background', label: 'background', re: /\b(?:en\s+el\s+fondo|el\s+fondo|al\s+fondo|detras|behind|in\s+the\s+background|background)\b/i },
  { id: 'foreground', label: 'foreground', re: /\b(?:primer\s+plano|al\s+frente|delante|in\s+the\s+foreground|foreground)\b/i },
  { id: 'eyes', label: 'eyes', re: /\b(?:los\s+ojos|sus\s+ojos|ojos|iris|pupilas|eyes)\b/i },
  { id: 'face', label: 'face', re: /\b(?:el\s+rostro|la\s+cara|rostro|cara|expresion\s+facial|face)\b/i },
  { id: 'hair', label: 'hair/fur', re: /\b(?:el\s+cabello|el\s+pelo|pelaje|cabello|hair|fur)\b/i },
  { id: 'hands', label: 'hands', re: /\b(?:las\s+manos|la\s+mano|mano\s+izquierda|mano\s+derecha|hands?)\b/i },
  { id: 'clothing', label: 'clothing/attire', re: /\b(?:la\s+ropa|camisa|camiseta|vestido|chaqueta|abrigo|traje|pantalon|zapatos|clothing|outfit|shirt|dress|jacket|suit)\b/i },
  { id: 'sky', label: 'sky', re: /\b(?:el\s+cielo|cielo|nubes|sky|clouds)\b/i },
  { id: 'text', label: 'text/typography', re: /\b(?:el\s+texto|las\s+letras|titulo|letrero|tipografia|rotulo|text|typography|headline|signage)\b/i },
];

function extractSpatialAnchors(prompt) {
  const norm = normalizePlain(prompt);
  if (!norm) return [];
  const anchors = [];
  const seen = new Set();
  for (const entry of SPATIAL_ANCHOR_PATTERNS) {
    if (entry.re.test(norm) && !seen.has(entry.id)) {
      seen.add(entry.id);
      anchors.push({ id: entry.id, label: entry.label });
    }
  }
  return anchors.slice(0, 6);
}

const KEEP_INVARIANT_RE = /\b(?:sin\s+(?:cambiar|modificar|tocar|alterar|perder|mover|quitar)\s+|no\s+(?:cambies|modifiques|toques|alteres|quites|borres)\s+|manten(?:iendo|er)?\s+|conserva(?:ndo)?\s+|deja(?:ndo)?\s+igual\s+|without\s+(?:changing|altering|modifying|touching|losing|removing)\s+|do\s+not\s+(?:change|alter|modify|touch|remove)\s+|keep(?:ing)?\s+)([^,.;!?]{2,80})/gi;
const EXCLUDE_ELEMENT_RE = /\b(?:sin|without|no\s+agregues|no\s+pongas|evita(?:ndo)?|avoid)\s+(?!cambiar|modificar|tocar|alterar|perder|mover|quitar|changing|altering|modifying|touching|losing|removing)([a-z0-9\s-]{2,48})(?=$|[,.;!?]|\s+(?:y|e|pero|con|en|and|but|with)\b)/gi;

function extractPreservationExclusions(prompt) {
  const norm = normalizePlain(prompt);
  if (!norm) return { keepInvariants: [], omitElements: [] };
  const keepInvariants = [];
  const omitElements = [];
  const seenKeep = new Set();
  const seenOmit = new Set();

  for (const match of norm.matchAll(KEEP_INVARIANT_RE)) {
    const target = String(match[1] || '')
      .replace(/\b(?:intact[oa]s?|igual(?:es)?|tal\s+cual|como\s+esta|unchanged|identical|as\s+is)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (target.length >= 2 && !seenKeep.has(target)) {
      seenKeep.add(target);
      keepInvariants.push(target);
    }
  }

  for (const match of norm.matchAll(EXCLUDE_ELEMENT_RE)) {
    const item = String(match[1] || '').replace(/\s+/g, ' ').trim();
    if (item.length >= 2 && !/^(?:duda|embargo|problema|problemas|falta|mas|nada)$/i.test(item) && !seenOmit.has(item)) {
      seenOmit.add(item);
      omitElements.push(item);
    }
  }

  return {
    keepInvariants: keepInvariants.slice(0, 6),
    omitElements: omitElements.slice(0, 6),
  };
}

const EDIT_ACTION_START_RE = /^(?:tambien\s+|ademas\s+|luego\s+|despues\s+|y\s+|e\s+|and\s+|also\s+)?(?:cambi|modific|quit|elimin|borr|agreg|anad|pon|coloc|insert|reemplaz|sustituy|pint|color|convirt|transform|haz|vuelv|ajust|mejor|retoc|aclar|oscurec|corr|suaviz|enfoq|desenfoq|manten|conserv|escrib|rot|gir|volt|recort|encuadr|chang|modif|remov|delet|eras|add|put|plac|insert|replac|recolor|paint|turn|make|adjust|enhanc|retouch|brighten|darken|fix|blur|sharpen|write|rotate|flip|crop)[a-z]*/i;

/**
 * Split compound multi-edit instructions into individual concrete deltas while
 * preserving quoted text verbatim.
 * Example:
 *   "cambia el cielo a naranja y agrega un pájaro a la derecha"
 *   -> ["cambia el cielo a naranja", "agrega un pájaro a la derecha"]
 */
function parseCompoundEditDeltas(prompt) {
  const raw = String(prompt == null ? '' : prompt).trim();
  if (!raw) return [];

  const quotes = [];
  const shielded = raw.replace(QUOTED_TEXT_RE, (full) => {
    const token = `__QUOTE_${quotes.length}__`;
    quotes.push(full);
    return token;
  });

  const restore = (segment) => segment
    .replace(/__QUOTE_(\d+)__/g, (_, idx) => quotes[Number(idx)] || '')
    .trim();

  // Split on sentence boundaries, semicolons, or coordinating conjunctions
  // followed by another explicit edit verb.
  const roughClauses = shielded
    .split(/(?:\s*[;.]+\s*|\s*,\s*(?=(?:y\s+|e\s+|pero\s+|tambien\s+|ademas\s+|and\s+|but\s+|also\s+)?[a-záéíóúñ])|\s+\b(?:y|e|ademas|tambien|luego|and|also)\b\s+)/i)
    .map((part) => part.trim())
    .filter(Boolean);

  if (roughClauses.length <= 1) {
    return [raw];
  }

  const deltas = [];
  for (const clause of roughClauses) {
    const normClause = normalizePlain(clause);
    // Skip pure preservation-only tail clauses ("sin cambiar el fondo", "mantén el resto igual")
    if (/^(?:sin\s+(?:cambiar|modificar|tocar|alterar)|no\s+(?:cambies|modifiques|toques|alteres)|manten|conserva|deja\s+igual|without\s+changing|keep\s+the\s+rest|do\s+not\s+change)/i.test(normClause)) {
      continue;
    }
    if (deltas.length === 0 || EDIT_ACTION_START_RE.test(normClause)) {
      deltas.push(restore(clause));
    } else {
      // Continuation of the previous delta (e.g. "rojo y dorado")
      deltas[deltas.length - 1] = `${deltas[deltas.length - 1]} ${restore(clause)}`.replace(/\s+/g, ' ').trim();
    }
  }

  return deltas.filter(Boolean).slice(0, 6);
}

const ONLY_LOCALIZED_RE = /\b(?:solo|solamente|unicamente|exclusivamente|exactamente|milimetric\w*|puntual\w*|en\s+concreto|especificamente|only|just|specifically|precisely)\b/i;
const OBJECT_ADD_REMOVE_RE = /\b(?:quita|quitale|elimina|borra|remueve|saca|agrega|agregale|anade|anadele|pon|ponle|coloca|inserta|reemplaza|sustituye|remove|delete|erase|add|insert|place|put|replace)\b/i;
const COLOR_MATERIAL_RE = /\b(?:color|colorea|pinta|tint|tono|tonalidad|matiz|saturacion|brillo|contraste|textura|material|dorad[oa]|platead[oa]|mate|metalic[oa]|madera|vidrio|cuero|recolor|hue|tint|material|texture)\b/i;
const LIGHTING_ATMOSPHERE_RE = /\b(?:iluminacion|luz|luces|sombras|atardecer|amanecer|noche|dia|lluvia|nieve|niebla|calid[oa]|fri[oa]|cinematic|lighting|shadows|sunset|sunrise|night|daytime|rain|snow|fog|warm|cool|atmosphere)\b/i;
const TYPOGRAPHY_EDIT_RE = /\b(?:texto|titulo|letrero|tipografia|fuente|letras|escribe|rotulo|watermark|marca\s+de\s+agua|text|title|headline|sign|font|lettering|write)\b/i;
const CAMERA_REFRAME_RE = /\b(?:vertical|horizontal|cuadrad[oa]|panoramic[oa]|zoom|acerca|aleja|recorta|encuadra|plano\s+medio|primer\s+plano|angulo|perspectiva|reframe|crop|aspect\s+ratio|close[\s-]up|wide\s+shot|camera\s+angle)\b/i;
const UPSCALE_VARIATION_RE = /\b(?:mejora\s+la\s+calidad|mas\s+nitid[oa]|alta\s+definicion|upscale|re[es]*cala|restaura|desenfoca\s+el\s+fondo|variacion|version\s+mejorada|enhance|sharpen|restore|variation|hd|4k)\b/i;
const DELIVERABLE_RE = /\b(?:banner|portada|cover|miniatura|thumbnail|poster|cartel|flyer|afiche|folleto|portada\s+de|para\s+instagram|para\s+facebook|para\s+youtube|para\s+linkedin)\b/i;

/**
 * Classify user intent and extract all prompt-obedience constraints.
 */
function classifyImageIntent(prompt, ctx = {}) {
  const raw = String(prompt == null ? '' : prompt).trim();
  const norm = normalizePlain(raw);
  const hasSourceImage = Boolean(ctx.hasSourceImage);
  const hasMask = Boolean(ctx.hasMask);
  const hasSelection = Boolean(ctx.hasSelection);
  const isReplyToImage = Boolean(ctx.isReplyToImage);
  const hasReferenceImages = Boolean(ctx.hasReferenceImages);

  const deltas = parseCompoundEditDeltas(raw);
  const spatialAnchors = extractSpatialAnchors(raw);
  const { keepInvariants, omitElements } = extractPreservationExclusions(raw);
  const quotedTexts = extractQuotedTexts(raw);
  const isLocalizedCue = ONLY_LOCALIZED_RE.test(norm);
  const isCompoundEdit = deltas.length > 1;

  let intent = 'generate_fresh';
  if (hasSourceImage || isReplyToImage) {
    if (hasMask || hasSelection) {
      intent = 'surgical_masked_edit';
    } else if (DELIVERABLE_RE.test(norm) && hasReferenceImages) {
      intent = 'reference_deliverable';
    } else if (TYPOGRAPHY_EDIT_RE.test(norm) && quotedTexts.length > 0) {
      intent = 'typography_text_edit';
    } else if (CAMERA_REFRAME_RE.test(norm) && !OBJECT_ADD_REMOVE_RE.test(norm) && !COLOR_MATERIAL_RE.test(norm)) {
      intent = 'camera_reframe_composition';
    } else if (isLocalizedCue || keepInvariants.length > 0 || isCompoundEdit) {
      intent = 'surgical_text_edit';
    } else if (OBJECT_ADD_REMOVE_RE.test(norm)) {
      intent = 'object_add_remove';
    } else if (COLOR_MATERIAL_RE.test(norm)) {
      intent = 'color_material_change';
    } else if (LIGHTING_ATMOSPHERE_RE.test(norm)) {
      intent = 'lighting_atmosphere_edit';
    } else if (UPSCALE_VARIATION_RE.test(norm)) {
      intent = 'variation_upscale';
    } else {
      intent = 'surgical_text_edit';
    }
  } else if (DELIVERABLE_RE.test(norm) && hasReferenceImages) {
    intent = 'reference_deliverable';
  }

  const strictness = (hasMask || hasSelection || isLocalizedCue || keepInvariants.length > 0 || quotedTexts.length > 0)
    ? 'millimetric'
    : ((hasSourceImage || isReplyToImage || omitElements.length > 0 || spatialAnchors.length > 0) ? 'strict' : 'balanced');

  return {
    intent,
    strictness,
    deltas,
    isCompoundEdit,
    spatialAnchors,
    keepInvariants,
    omitElements,
    quotedTexts,
    replyLocked: isReplyToImage,
    preserveInvariants: Boolean(hasSourceImage || isReplyToImage),
  };
}

/**
 * Build a concise, contradiction-free precision contract appended to edited
 * image prompts so models execute EVERY requested delta and lock all other
 * pixels/attributes strictly.
 */
function buildStrictEditContract(plan, { language = 'es', hasMask = false, maskBounds = null } = {}) {
  if (!plan) return '';
  const en = language === 'en';
  const lines = [];

  if (hasMask && maskBounds && Number.isFinite(maskBounds.x) && Number.isFinite(maskBounds.width)) {
    const loc = `x=${maskBounds.x}%, y=${maskBounds.y}%, width=${maskBounds.width}%, height=${maskBounds.height}%`;
    lines.push(en
      ? `Millimetric mask boundary (${loc}): modify ONLY inside the masked editable area; keep every single pixel outside the mask 100% identical in geometry, color, texture, and lighting.`
      : `Límite milimétrico de máscara (${loc}): modifica ÚNICAMENTE dentro de la zona enmascarada; conserva cada píxel fuera de la máscara 100% idéntico en geometría, color, textura e iluminación.`);
  }

  if (plan.isCompoundEdit && plan.deltas.length > 1) {
    const numbered = plan.deltas.map((delta, i) => `(${i + 1}) ${delta}`).join('; ');
    lines.push(en
      ? `Apply ALL ${plan.deltas.length} requested edits faithfully without dropping any: ${numbered}.`
      : `Aplica TODOS los ${plan.deltas.length} cambios pedidos sin omitir ninguno: ${numbered}.`);
  }

  if (plan.keepInvariants.length > 0) {
    lines.push(en
      ? `Locked invariants (must remain untouched): ${plan.keepInvariants.join(', ')}.`
      : `Elementos bloqueados (no modificar): ${plan.keepInvariants.join(', ')}.`);
  }

  if (plan.omitElements.length > 0) {
    lines.push(en
      ? `Strictly exclude from the result: ${plan.omitElements.join(', ')}.`
      : `Excluir estrictamente del resultado: ${plan.omitElements.join(', ')}.`);
  }

  if (plan.quotedTexts.length > 0) {
    lines.push(en
      ? `Render exact verbatim typography with zero misspellings: ${plan.quotedTexts.map((t) => `"${t}"`).join(', ')}.`
      : `Renderiza la tipografía literal exacta sin errores ortográficos: ${plan.quotedTexts.map((t) => `"${t}"`).join(', ')}.`);
  }

  if (plan.strictness === 'millimetric' && !hasMask) {
    lines.push(en
      ? 'Surgical precision lock: preserve subject identity, facial features, pose, camera framing, perspective, and unmentioned background details exactly as in the source image.'
      : 'Bloqueo de precisión milimétrica: conserva exactamente igual la identidad del sujeto, rasgos, pose, encuadre, perspectiva y detalles del fondo no mencionados.');
  }

  return lines.join(' ').trim();
}

/**
 * Build a concise prompt-obedience clause for fresh generations when explicit
 * spatial anchors, exclusions, or verbatim text are requested.
 */
function buildStrictGenerationContract(plan) {
  if (!plan) return '';
  const parts = [];
  if (plan.spatialAnchors.length > 0) {
    parts.push(`Follow exact spatial placement requested (${plan.spatialAnchors.map((a) => a.label).join(', ')})`);
  }
  if (plan.omitElements.length > 0) {
    parts.push(`Keep the scene completely free of: ${plan.omitElements.join(', ')}`);
  }
  if (plan.keepInvariants.length > 0) {
    parts.push(`Preserve strictly: ${plan.keepInvariants.join(', ')}`);
  }
  if (parts.length === 0) return '';
  return `Strict prompt obedience: ${parts.join('. ')}.`;
}

module.exports = {
  classifyImageIntent,
  parseCompoundEditDeltas,
  extractSpatialAnchors,
  extractPreservationExclusions,
  extractQuotedTexts,
  buildStrictEditContract,
  buildStrictGenerationContract,
};
