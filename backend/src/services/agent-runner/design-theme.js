'use strict';

/**
 * Design tokens for AgentRunner documents: the same professional themes the
 * advanced pipeline uses (document-pipeline/pptx-design-system.js) plus a
 * palette DERIVED from any color the user asks for («rosado», «#1E3A8A»,
 * «naranja»…): the background is exactly that color and the accents keep its
 * hue, so a light green deck never gets pink accents.
 *
 * Pure module (no I/O). Used by create_presentation (first-generation decks)
 * and by the DESIGN WORKFLOW (sira_design.py reads the tokens as JSON).
 */

const designSystem = require('../document-pipeline/pptx-design-system');

// Aptos only ships with recent Office builds; the render sandbox and older
// Office fall back to a wider font and the verification image drifts.
// Calibri renders the same everywhere (LibreOffice maps it to Carlito).
const FONT_FALLBACKS = { 'aptos display': 'Calibri', aptos: 'Calibri' };

function safeFont(name, fallback = 'Calibri') {
  const n = String(name || '').trim();
  if (!n) return fallback;
  return FONT_FALLBACKS[n.toLowerCase()] || n;
}

function cleanHex(hex) {
  const m = String(hex || '').trim().match(/^#?([0-9a-fA-F]{6})$/);
  return m ? m[1].toUpperCase() : null;
}

function hexToRgb(hex) {
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]) {
  return [r, g, b]
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

// WCAG 2.x relative luminance / contrast ratio: text colors are CHOSEN by
// contrast, never by a brightness threshold (coral FF7F50 used to get
// near-white ink at 2.4:1).
function channel(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const DARK_INK = '111827';
const LIGHT_INK = 'F8FAFC';

/** A background reads better with dark ink than with light ink. */
function isLight(hex) {
  return contrastRatio(hex, DARK_INK) >= contrastRatio(hex, LIGHT_INK);
}

/** The candidate with the highest contrast against every background. */
function bestContrast(backgrounds, candidates) {
  let best = candidates[0];
  let bestScore = -1;
  for (const c of candidates) {
    const score = Math.min(...backgrounds.map((bg) => contrastRatio(c, bg)));
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

/** First candidate reaching `min` against every background, else the best one. */
function firstReaching(backgrounds, candidates, min) {
  const ok = candidates.find((c) => backgrounds.every((bg) => contrastRatio(c, bg) >= min));
  return ok || bestContrast(backgrounds, candidates);
}

/** Readable text color on a filled shape (chips, header cells, KPI tiles). */
function textOn(fill) {
  return bestContrast([fill], ['FFFFFF', DARK_INK, '000000']);
}

function rgbToHsl([r, g, b]) {
  const rn = r / 255; const gn = g / 255; const bn = b / 255;
  const max = Math.max(rn, gn, bn); const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p, q, t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

/** Same hue, new lightness (and a floor on saturation so accents read as color). */
function toneOf(hex, lightness, minSaturation = 0.5) {
  const [h, s] = rgbToHsl(hexToRgb(hex));
  if (s < 0.08) return null; // white / grey / black: no hue to keep
  return rgbToHex(hslToRgb([h, Math.max(s, minSaturation), lightness]));
}

function mix(hexA, hexB, weightB) {
  const a = hexToRgb(hexA); const b = hexToRgb(hexB);
  return rgbToHex(a.map((v, i) => v * (1 - weightB) + b[i] * weightB));
}

/**
 * An accent of the background's hue that reaches `min` contrast against
 * every surface it sits on: darker steps on light themes, lighter steps on
 * dark ones; neutral colors take the default blue family; the ink as the
 * last resort (a KPI value must be readable before it is colorful).
 */
function readableAccent(bg, surfaces, { light, start, min = 3, minSaturation = 0.5, neutral, ink }) {
  const steps = [];
  for (let i = 0; i <= 14; i += 1) {
    const l = light ? start - i * 0.03 : start + i * 0.02;
    if (l <= 0.05 || l >= 0.97) break;
    const tone = toneOf(bg, l, minSaturation);
    if (!tone) break;
    steps.push(tone);
  }
  const candidates = steps.length ? steps : neutral;
  const found = candidates.find((c) => surfaces.every((s) => contrastRatio(c, s) >= min));
  if (found) return found;
  const fallback = neutral.find((c) => surfaces.every((s) => contrastRatio(c, s) >= min));
  return fallback || ink;
}

/**
 * Full token set whose background is exactly `hex`. Accents keep the hue;
 * neutral colors (white, grey, black) take the default blue accent. Every
 * text token is chosen by WCAG contrast: ink / body / muted >= 4.5:1 on the
 * background AND the card surface, accent (KPI values, eyebrow) >= 3:1.
 */
function themeFromColor(hex) {
  const bg = cleanHex(hex);
  if (!bg) return null;
  const light = isLight(bg);
  const ink = firstReaching([bg], light ? [DARK_INK, '000000'] : [LIGHT_INK, 'FFFFFF'], 4.5);
  const bodyCandidates = light ? ['374151', '1F2937', DARK_INK, '000000'] : ['E2E8F0', 'F1F5F9', 'FFFFFF'];
  // Cards: a tint of the background; when the body text cannot reach 4.5:1
  // on it, the surface moves AWAY from the text color until it does.
  let surface = light ? mix(bg, 'FFFFFF', 0.7) : mix(bg, 'FFFFFF', 0.1);
  for (let w = 0.15; w <= 0.6 && !bodyCandidates.some((c) => contrastRatio(c, surface) >= 4.5 && contrastRatio(c, bg) >= 4.5); w += 0.15) {
    surface = light ? mix(bg, 'FFFFFF', Math.min(0.95, 0.7 + w)) : mix(bg, '000000', w);
  }
  const body = firstReaching([bg, surface], bodyCandidates, 4.5);
  const muted = firstReaching([bg], light ? ['6B7280', '4B5563', '374151', DARK_INK, '000000'] : ['CBD5E1', 'E2E8F0', 'FFFFFF'], 4.5);
  const surfaceAlt = light ? mix(bg, 'FFFFFF', 0.45) : mix(surface, 'FFFFFF', 0.06);
  const neutralAccents = light ? ['2563EB', '1D4ED8', '1E3A8A'] : ['60A5FA', '93C5FD', 'BFDBFE'];
  const accent = readableAccent(bg, [bg, surface], {
    light, start: light ? 0.36 : 0.68, neutral: neutralAccents, ink,
  });
  const accent2 = readableAccent(bg, [bg], {
    light, start: light ? 0.46 : 0.78, minSaturation: 0.35, neutral: light ? ['0891B2', '0E7490'] : ['93C5FD', 'BFDBFE'], ink,
  });
  let sectionBg = light ? (toneOf(bg, 0.22, 0.45) || '0F172A') : mix(bg, '000000', 0.35);
  if (contrastRatio('FFFFFF', sectionBg) < 4.5) sectionBg = mix(sectionBg, '000000', 0.5);
  const sectionInk = firstReaching([sectionBg], ['FFFFFF', LIGHT_INK], 4.5);
  const sectionMuted = firstReaching([sectionBg], ['E2E8F0', 'F1F5F9', 'FFFFFF'], 4.5);
  return {
    id: `user-color:${bg}`,
    label: 'Color pedido',
    // The user's color is the background of EVERY slide (restyles included).
    colorLocked: true,
    fonts: { display: 'Calibri', body: 'Calibri' },
    palette: {
      bg,
      surface,
      surfaceAlt,
      ink,
      body,
      muted,
      line: light ? mix(bg, '000000', 0.12) : mix(bg, 'FFFFFF', 0.25),
      accent,
      accent2,
      chipLine: light ? mix(accent, 'FFFFFF', 0.6) : mix(bg, 'FFFFFF', 0.35),
      coverBg: bg,
      coverInk: ink,
      coverMuted: muted,
      sectionBg,
      sectionInk,
      sectionMuted,
      inverse: light ? 'FFFFFF' : '0B1220',
    },
    chartColors: [accent, accent2, mix(accent, '000000', 0.3), mix(accent2, 'FFFFFF', 0.35), 'F59E0B'],
    coverStyle: light ? 'light' : 'dark',
  };
}

function withSafeFonts(theme) {
  if (!theme || typeof theme !== 'object') return null;
  return {
    ...theme,
    fonts: {
      display: safeFont(theme.fonts && theme.fonts.display),
      body: safeFont(theme.fonts && theme.fonts.body),
    },
    palette: { ...(theme.palette || {}) },
    chartColors: Array.isArray(theme.chartColors) ? [...theme.chartColors] : [],
  };
}

/**
 * Theme for a request: a requested color (hex from the caller's own color
 * parser) wins; otherwise the style keywords of the prompt pick one of the
 * five professional themes («oscuro/elegante» → boardroom, «minimalista» →
 * minimal…); default aurora.
 */
function resolveDesignTheme({ prompt = '', colorHex = null, themeId = null } = {}) {
  const requested = cleanHex(colorHex);
  if (requested) return themeFromColor(requested);
  try {
    const id = String(themeId || '').trim().toLowerCase();
    if (id && designSystem.THEMES[id]) return withSafeFonts(designSystem.THEMES[id]);
    const picked = designSystem.pickPptxTheme({ prompt: String(prompt || '') });
    if (picked && String(picked.id || '').startsWith('user-color:')) {
      return themeFromColor(String(picked.id).slice('user-color:'.length));
    }
    return withSafeFonts(picked);
  } catch (_) {
    return withSafeFonts(designSystem.THEMES && designSystem.THEMES.aurora);
  }
}

function listThemeIds() {
  return Object.keys(designSystem.THEMES || {});
}

// Rotation order for a repeated «más diseño»: the most different look first.
const ALTERNATE_ORDER = ['consulting', 'editorial', 'boardroom', 'aurora', 'minimal'];

/** The other professional themes (tokens), for sira_design's rotation. */
function alternateThemes(excludeId = null) {
  const ids = [...ALTERNATE_ORDER, ...listThemeIds().filter((id) => !ALTERNATE_ORDER.includes(id))];
  return ids
    .filter((id) => id !== excludeId && designSystem.THEMES && designSystem.THEMES[id])
    .map((id) => withSafeFonts(designSystem.THEMES[id]));
}

module.exports = {
  resolveDesignTheme,
  themeFromColor,
  withSafeFonts,
  safeFont,
  listThemeIds,
  alternateThemes,
  isLight,
  mix,
  contrastRatio,
  relativeLuminance,
  textOn,
};
