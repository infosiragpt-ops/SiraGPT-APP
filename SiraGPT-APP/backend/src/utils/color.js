'use strict';

/**
 * color — minimal RGB/HSL/hex codec + WCAG 2.x contrast math. Pairs
 * with the visual-media tooling already in the repo: when the agent
 * generates an SVG / dashboard / infographic, it should validate
 * that text + background colors meet contrast thresholds before
 * shipping the artifact.
 *
 * Public API:
 *   parseHex(s)                          → { r, g, b, a } | null
 *   parseRgb(s)                          — 'rgb(r,g,b)' / 'rgba(...)'
 *   parseHsl(s)                          — 'hsl(h,s%,l%)'
 *   parseColor(s)                        — auto-detect any of the above
 *   toHex({ r, g, b, a? })               → '#RRGGBB' or '#RRGGBBAA'
 *   rgbToHsl({r,g,b}) / hslToRgb({h,s,l})
 *   relativeLuminance({r,g,b})           → 0..1
 *   contrastRatio(a, b)                  → 1..21
 *   passes(ratio, level='AA', size='normal')
 *     level: 'AA' | 'AAA' ; size: 'normal' | 'large'
 */

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

function parseHex(s) {
  if (typeof s !== 'string') return null;
  let t = s.trim();
  if (t.startsWith('#')) t = t.slice(1);
  if (!/^[0-9a-fA-F]+$/.test(t)) return null;
  let r, g, b, a = 1;
  if (t.length === 3) {
    [r, g, b] = [parseInt(t[0] + t[0], 16), parseInt(t[1] + t[1], 16), parseInt(t[2] + t[2], 16)];
  } else if (t.length === 4) {
    [r, g, b] = [parseInt(t[0] + t[0], 16), parseInt(t[1] + t[1], 16), parseInt(t[2] + t[2], 16)];
    a = parseInt(t[3] + t[3], 16) / 255;
  } else if (t.length === 6) {
    [r, g, b] = [parseInt(t.slice(0, 2), 16), parseInt(t.slice(2, 4), 16), parseInt(t.slice(4, 6), 16)];
  } else if (t.length === 8) {
    [r, g, b] = [parseInt(t.slice(0, 2), 16), parseInt(t.slice(2, 4), 16), parseInt(t.slice(4, 6), 16)];
    a = parseInt(t.slice(6, 8), 16) / 255;
  } else return null;
  return { r, g, b, a };
}

function parseRgb(s) {
  if (typeof s !== 'string') return null;
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s.trim());
  if (!m) return null;
  return {
    r: clamp(Math.round(Number(m[1])), 0, 255),
    g: clamp(Math.round(Number(m[2])), 0, 255),
    b: clamp(Math.round(Number(m[3])), 0, 255),
    a: m[4] != null ? clamp(Number(m[4]), 0, 1) : 1,
  };
}

function parseHsl(s) {
  if (typeof s !== 'string') return null;
  const m = /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s.trim());
  if (!m) return null;
  const hsl = {
    h: ((Number(m[1]) % 360) + 360) % 360,
    s: clamp(Number(m[2]) / 100, 0, 1),
    l: clamp(Number(m[3]) / 100, 0, 1),
    a: m[4] != null ? clamp(Number(m[4]), 0, 1) : 1,
  };
  const rgb = hslToRgb(hsl);
  return { ...rgb, a: hsl.a };
}

function parseColor(s) {
  return parseHex(s) || parseRgb(s) || parseHsl(s);
}

function toHex({ r, g, b, a = 1 } = {}) {
  if (![r, g, b].every(Number.isFinite)) throw new TypeError('toHex: r/g/b required');
  const h = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  if (a === 1) return `#${h(r)}${h(g)}${h(b)}`;
  return `#${h(r)}${h(g)}${h(b)}${h(a * 255)}`;
}

function rgbToHsl({ r, g, b }) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
      case gn: h = (bn - rn) / d + 2; break;
      case bn: h = (rn - gn) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s, l };
}

function hslToRgb({ h, s, l }) {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const hk = h / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const t = (k) => {
    if (k < 0) k += 1;
    if (k > 1) k -= 1;
    if (k < 1 / 6) return p + (q - p) * 6 * k;
    if (k < 1 / 2) return q;
    if (k < 2 / 3) return p + (q - p) * (2 / 3 - k) * 6;
    return p;
  };
  return {
    r: Math.round(t(hk + 1 / 3) * 255),
    g: Math.round(t(hk) * 255),
    b: Math.round(t(hk - 1 / 3) * 255),
  };
}

function relativeLuminance({ r, g, b }) {
  const conv = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const R = conv(r), G = conv(g), B = conv(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrastRatio(a, b) {
  const ca = typeof a === 'string' ? parseColor(a) : a;
  const cb = typeof b === 'string' ? parseColor(b) : b;
  if (!ca || !cb) throw new TypeError('contrastRatio: parseable colors required');
  const la = relativeLuminance(ca);
  const lb = relativeLuminance(cb);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function passes(ratio, level = 'AA', size = 'normal') {
  if (level === 'AAA') return ratio >= (size === 'large' ? 4.5 : 7.0);
  return ratio >= (size === 'large' ? 3.0 : 4.5);
}

module.exports = {
  parseHex,
  parseRgb,
  parseHsl,
  parseColor,
  toHex,
  rgbToHsl,
  hslToRgb,
  relativeLuminance,
  contrastRatio,
  passes,
};
