'use strict';

/**
 * document-tailwind.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Tailwind CSS utility class usage in HTML / JSX / Vue / Astro:
 *
 *   - spacing:     p-X / m-X / px-X / py-X / mt-X / mb-X / gap-X / space-x-X
 *   - color:       bg-{color}-{shade} / text-{color}-{shade} / border-{color}
 *   - layout:      flex / grid / block / hidden / absolute / relative / sticky
 *   - sizing:      w-X / h-X / max-w-X / min-h-X
 *   - typography:  font-{weight} / text-{size} / leading-X / tracking-X
 *   - responsive:  sm: / md: / lg: / xl: / 2xl:
 *   - variants:    hover: / focus: / active: / dark: / disabled: / first: / last:
 *   - arbitrary:   [123px] / [#fff] / [@media...]
 *
 * Public API:
 *   extractTailwind(text)             → { entries, totals, total }
 *   buildTailwindForFiles(files)      → { perFile, aggregate, totals }
 *   renderTailwindBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;

const CLASS_ATTR_RE = /\bclass(?:Name)?\s*=\s*["']([^"'\n]{1,400})["']/g;
const CLSX_RE = /\b(?:clsx|cn|cx|classnames|tw|twMerge)\s*\(\s*([^)]{1,400})\)/g;

const RESPONSIVE_PREFIXES = ['sm', 'md', 'lg', 'xl', '2xl', 'max-sm', 'max-md', 'max-lg', 'max-xl'];
const VARIANT_PREFIXES = [
  'hover', 'focus', 'focus-visible', 'focus-within', 'active', 'visited',
  'disabled', 'checked', 'enabled', 'first', 'last', 'odd', 'even',
  'dark', 'light', 'print', 'before', 'after', 'placeholder',
  'group-hover', 'group-focus', 'peer-hover', 'aria-checked', 'data-active',
  'rtl', 'ltr', 'motion-reduce', 'motion-safe', 'contrast-more', 'contrast-less',
];

const UTILITY_PATTERNS = {
  spacing: /^-?(?:p|m)[trblxy]?-/,
  layout: /^(?:flex|grid|inline|block|hidden|table|contents|absolute|relative|fixed|sticky|static|invisible|visible)/,
  sizing: /^(?:w-|h-|min-w-|min-h-|max-w-|max-h-|size-)/,
  typography: /^(?:font-|text-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl|left|center|right|justify)|leading-|tracking-|whitespace-|break-|truncate|underline|italic|capitalize|uppercase|lowercase|line-through|antialiased|subpixel-antialiased)/,
  border: /^(?:rounded|border-?[trblxy]?-|ring-)/,
  effect: /^(?:opacity-|shadow-(?:sm|md|lg|xl|2xl|inner|none)|blur-|brightness-|contrast-|grayscale|invert|saturate-|sepia|backdrop-|filter|mix-blend-)/,
  transition: /^(?:transition|duration-|delay-|ease-|animate-|will-change-)/,
  transform: /^(?:transform|translate-|scale-|rotate-|skew-|origin-)/,
  interaction: /^(?:cursor-|select-|resize|appearance-|pointer-events|touch-)/,
  color: /^(?:bg|text|border|ring|divide|outline|fill|stroke|placeholder|caret|accent|decoration|shadow|from|via|to)-(?:[a-z]+|\[)/,
  arbitrary: /\[[^\]]+\]/,
};

function classifyUtility(cls) {
  for (const [cat, re] of Object.entries(UTILITY_PATTERNS)) {
    if (re.test(cls)) return cat;
  }
  return 'other';
}

function parseVariants(cls) {
  const parts = cls.split(':');
  if (parts.length < 2) return { variants: [], base: cls };
  const base = parts.pop();
  return { variants: parts, base };
}

function extractTailwind(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;

  // Quick reject if no obvious Tailwind signals
  if (!/\bclass(?:Name)?\s*=\s*["']/.test(body) && !/\b(?:clsx|cn|twMerge|tw)\s*\(/.test(body)) {
    return { entries: [], totals: {}, total: 0 };
  }

  const seen = new Set();
  const entries = [];
  const totals = {
    spacing: 0, color: 0, layout: 0, sizing: 0, typography: 0,
    effect: 0, border: 0, transition: 0, transform: 0, interaction: 0,
    arbitrary: 0, other: 0,
    responsive: 0, variant: 0, classGroup: 0,
  };

  const classBuckets = [];
  CLASS_ATTR_RE.lastIndex = 0;
  let m;
  while ((m = CLASS_ATTR_RE.exec(body))) {
    classBuckets.push(m[1]);
  }
  CLSX_RE.lastIndex = 0;
  while ((m = CLSX_RE.exec(body))) {
    classBuckets.push(m[1]);
  }

  totals.classGroup = classBuckets.length;

  let tailwindLike = 0;
  for (const bucket of classBuckets) {
    const tokens = bucket.split(/[\s,'"`]+/).filter(Boolean);
    for (const tok of tokens) {
      if (entries.length >= MAX_PER_FILE) break;
      const { variants, base } = parseVariants(tok);
      const cat = classifyUtility(base);
      if (cat === 'other' && !variants.length && !/\[/.test(tok)) continue;
      tailwindLike += 1;
      if (variants.length) {
        for (const v of variants) {
          if (RESPONSIVE_PREFIXES.includes(v)) totals.responsive += 1;
          else if (VARIANT_PREFIXES.some((vp) => v === vp || v.startsWith(`${vp}/`))) totals.variant += 1;
        }
      }
      const key = `${cat}:${tok}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: cat, name: tok.slice(0, 50), variants: variants.slice(0, 4) });
      totals[cat] += 1;
    }
    if (entries.length >= MAX_PER_FILE) break;
  }

  if (tailwindLike === 0) {
    return { entries: [], totals: {}, total: 0 };
  }

  return { entries, totals, total: entries.length };
}

function buildTailwindForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    spacing: 0, color: 0, layout: 0, sizing: 0, typography: 0,
    effect: 0, border: 0, transition: 0, transform: 0, interaction: 0,
    arbitrary: 0, other: 0,
    responsive: 0, variant: 0, classGroup: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractTailwind(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderTailwindBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## TAILWIND CSS CLASSES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const vars = e.variants && e.variants.length ? ` (variants: ${e.variants.join('+')})` : '';
      lines.push(`- [${e.kind}] \`${e.name}\`${vars}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractTailwind,
  buildTailwindForFiles,
  renderTailwindBlock,
  _internal: { classifyUtility, parseVariants, RESPONSIVE_PREFIXES, VARIANT_PREFIXES },
};
