/**
 * design-tokens — deterministic generator that compiles a brand
 * spec (palette + typography + spacing + radii) into:
 *   1. A JSON token tree (:namespaced keys)
 *   2. A CSS :root block with custom properties
 *   3. A Tailwind-compatible extension object
 *
 * This is the Design System Generator's first concrete slice. It
 * stays free of network / LLM calls so unit tests run offline and
 * the output is byte-stable.
 *
 * Input spec:
 *   {
 *     palette: {
 *       brand:    "#2563eb",
 *       accent:   "#10b981",
 *       surface:  "#ffffff",
 *       text:     "#0f172a",
 *       muted:    "#64748b",
 *     },
 *     typography: {
 *       family_sans:  "Inter, ui-sans-serif, system-ui",
 *       family_mono:  "JetBrains Mono, ui-monospace",
 *       scale_base_px: 16,            // used for clamp() fluid sizes
 *       ratio:         1.25,          // major third by default
 *     },
 *     spacing: { base_px: 4, steps: 12 },  // 4 → 48 px
 *     radii:   { base_px: 8, steps: 5 },
 *   }
 *
 * Output:
 *   { tokens, css, tailwind, checks }
 */

const DEFAULT_SPEC = Object.freeze({
  palette: {
    brand:   "#2563eb",
    accent:  "#10b981",
    surface: "#ffffff",
    text:    "#0f172a",
    muted:   "#64748b",
  },
  typography: {
    family_sans:  "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    family_mono:  "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
    scale_base_px: 16,
    ratio: 1.25,
  },
  spacing: { base_px: 4, steps: 12 },
  radii:   { base_px: 8, steps: 5 },
});

function mergeSpec(partial) {
  const a = DEFAULT_SPEC;
  const b = partial && typeof partial === "object" ? partial : {};
  return {
    palette: { ...a.palette, ...(b.palette || {}) },
    typography: { ...a.typography, ...(b.typography || {}) },
    spacing: { ...a.spacing, ...(b.spacing || {}) },
    radii: { ...a.radii, ...(b.radii || {}) },
  };
}

function isHex(color) {
  return typeof color === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color);
}

function hexToRgb(hex) {
  let h = String(hex || "").replace("#", "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function relLuminance({ r, g, b }) {
  const c = v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

function contrastRatio(fg, bg) {
  const L1 = relLuminance(hexToRgb(fg));
  const L2 = relLuminance(hexToRgb(bg));
  const hi = Math.max(L1, L2);
  const lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

function fluidSize({ base_px, ratio, step }) {
  // Modular scale: base * ratio^step, rounded to nearest 0.25 px.
  const px = Math.round((base_px * Math.pow(ratio, step)) * 4) / 4;
  return px;
}

function mkSpacingScale({ base_px, steps }) {
  const out = {};
  for (let i = 0; i <= steps; i++) out[`s-${i}`] = `${i * base_px}px`;
  return out;
}

function mkRadiusScale({ base_px, steps }) {
  const out = { "r-0": "0px" };
  for (let i = 1; i <= steps; i++) out[`r-${i}`] = `${Math.round(base_px * (i * 0.5 + 0.5))}px`;
  return out;
}

function mkTypeScale({ scale_base_px, ratio }) {
  const steps = [-2, -1, 0, 1, 2, 3, 4, 5, 6];
  const out = {};
  for (const s of steps) {
    out[`t-${s >= 0 ? "p" : "n"}${Math.abs(s)}`] = `${fluidSize({ base_px: scale_base_px, ratio, step: s })}px`;
  }
  return out;
}

function runContrastChecks(palette) {
  // WCAG AA: 4.5 for body text, 3.0 for large text.
  const checks = [];
  const pairs = [
    ["text", "surface", 4.5, "body text on surface"],
    ["muted", "surface", 3.0, "muted text on surface"],
    ["surface", "brand", 3.0, "surface on brand (button)"],
    ["surface", "accent", 3.0, "surface on accent"],
  ];
  for (const [fgKey, bgKey, threshold, label] of pairs) {
    const fg = palette[fgKey], bg = palette[bgKey];
    if (!isHex(fg) || !isHex(bg)) {
      checks.push({ pair: label, ok: false, detail: `non-hex color (fg=${fg}, bg=${bg})` });
      continue;
    }
    const ratio = contrastRatio(fg, bg);
    checks.push({
      pair: label,
      fg, bg,
      ratio: Math.round(ratio * 100) / 100,
      threshold,
      ok: ratio >= threshold,
      detail: ratio >= threshold ? `${ratio.toFixed(2)}:1 ≥ ${threshold}:1 ✓` : `${ratio.toFixed(2)}:1 < ${threshold}:1 fails WCAG AA`,
    });
  }
  return checks;
}

function buildTokens(rawSpec) {
  const spec = mergeSpec(rawSpec);

  // Validate palette colours.
  for (const [k, v] of Object.entries(spec.palette)) {
    if (!isHex(v)) throw new Error(`design-tokens: palette.${k} must be a hex color, got ${JSON.stringify(v)}`);
  }

  const colorTokens = Object.fromEntries(Object.entries(spec.palette).map(([k, v]) => [`color-${k}`, v]));
  const typeTokens = mkTypeScale(spec.typography);
  const spaceTokens = mkSpacingScale(spec.spacing);
  const radiiTokens = mkRadiusScale(spec.radii);
  const familyTokens = {
    "font-sans": spec.typography.family_sans,
    "font-mono": spec.typography.family_mono,
  };

  const tokens = { ...colorTokens, ...typeTokens, ...spaceTokens, ...radiiTokens, ...familyTokens };

  const cssVars = Object.entries(tokens)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join("\n");
  const css = `:root {\n${cssVars}\n}`;

  const tailwind = {
    theme: {
      extend: {
        colors: Object.fromEntries(Object.entries(spec.palette).map(([k, v]) => [k, v])),
        fontFamily: {
          sans: spec.typography.family_sans.split(",").map(s => s.trim()),
          mono: spec.typography.family_mono.split(",").map(s => s.trim()),
        },
        spacing: Object.fromEntries(Object.entries(spaceTokens).map(([k, v]) => [k.replace(/^s-/, ""), v])),
        borderRadius: Object.fromEntries(Object.entries(radiiTokens).map(([k, v]) => [k.replace(/^r-/, ""), v])),
      },
    },
  };

  const checks = {
    contrast: runContrastChecks(spec.palette),
    palette_entries: Object.keys(spec.palette).length,
    type_scale_entries: Object.keys(typeTokens).length,
    spacing_entries: Object.keys(spaceTokens).length,
  };

  const passed = checks.contrast.every(c => c.ok);

  return {
    spec,
    tokens,
    css,
    tailwind,
    checks,
    passed,
  };
}

module.exports = {
  buildTokens,
  DEFAULT_SPEC,
  INTERNAL: { isHex, hexToRgb, contrastRatio, fluidSize, mkSpacingScale, mkRadiusScale, mkTypeScale, runContrastChecks, mergeSpec },
};
