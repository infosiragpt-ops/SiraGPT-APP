'use strict';

/**
 * pptx-design-system — professional theme gallery + design tokens for the
 * PPTX builder (advanced-document-pipeline buildPptx).
 *
 * Inspired by how Claude's Agent Skills approach presentation design: a
 * small set of opinionated, professionally-tuned themes (palette +
 * typography + chart colors) selected from the user's intent, instead of
 * one hardcoded look. Every token is used by buildPptx so a theme swap
 * changes the whole deck coherently (cover, agenda, section dividers,
 * bullets, stats, quotes, charts, footer).
 *
 * Pure module: no I/O, no LLM. Fully unit-testable.
 *
 * Themes:
 *   aurora     — modern slate/blue (default; evolución del look original)
 *   boardroom  — executive dark navy + amber (juntas directivas, legal, premium)
 *   minimal    — white, near-black ink, single vivid accent (keynote/clean)
 *   editorial  — warm cream + deep green/terracotta (educación, cultura)
 *   consulting — white, deep navy structured (estrategia/negocios)
 */

const THEMES = {
  aurora: {
    id: 'aurora',
    label: 'Aurora',
    description: 'Moderno y luminoso: slate + azul eléctrico con acentos cian.',
    fonts: { display: 'Aptos Display', body: 'Aptos' },
    palette: {
      bg: 'F8FAFC',          // slide background
      surface: 'FFFFFF',     // cards
      surfaceAlt: 'EFF6FF',  // tinted cards / chips
      ink: '0F172A',         // primary text
      body: '334155',        // body text
      muted: '64748B',       // captions / footer
      line: 'E2E8F0',        // hairlines / borders
      accent: '2563EB',      // primary accent
      accent2: '06B6D4',     // secondary accent
      chipLine: 'BFDBFE',    // chip borders
      coverBg: 'EEF6FF',
      coverInk: '0F172A',
      coverMuted: '334155',
      sectionBg: '0F172A',   // section divider background
      sectionInk: 'FFFFFF',
      sectionMuted: 'CBD5E1',
      inverse: 'FFFFFF',
    },
    chartColors: ['2563EB', '06B6D4', '8B5CF6', '10B981', 'F59E0B'],
    coverStyle: 'light',
    eyebrow: 'PRESENTACIÓN PROFESIONAL',
  },
  boardroom: {
    id: 'boardroom',
    label: 'Boardroom',
    description: 'Ejecutivo oscuro: azul noche con acentos ámbar/dorado.',
    fonts: { display: 'Aptos Display', body: 'Aptos' },
    palette: {
      bg: '0B1220',
      surface: '111B2E',
      surfaceAlt: '16233B',
      ink: 'F8FAFC',
      body: 'CBD5E1',
      muted: '7C8BA1',
      line: '1F2E48',
      accent: 'D9A441',
      accent2: '5EA0EF',
      chipLine: '2C3E5D',
      coverBg: '0B1220',
      coverInk: 'F8FAFC',
      coverMuted: '9FB0C8',
      sectionBg: '060B14',
      sectionInk: 'F8FAFC',
      sectionMuted: '8FA1B8',
      inverse: '0B1220',
    },
    chartColors: ['D9A441', '5EA0EF', '34D399', 'F472B6', '94A3B8'],
    coverStyle: 'dark',
    eyebrow: 'BRIEFING EJECUTIVO',
  },
  minimal: {
    id: 'minimal',
    label: 'Minimal',
    description: 'Blanco, tinta casi negra y un solo acento vivo. Aire y foco.',
    fonts: { display: 'Aptos Display', body: 'Aptos' },
    palette: {
      bg: 'FFFFFF',
      surface: 'FFFFFF',
      surfaceAlt: 'F5F5F4',
      ink: '111827',
      body: '374151',
      muted: '9CA3AF',
      line: 'E5E7EB',
      accent: 'E11D48',
      accent2: '111827',
      chipLine: 'E5E7EB',
      coverBg: 'FFFFFF',
      coverInk: '111827',
      coverMuted: '4B5563',
      sectionBg: '111827',
      sectionInk: 'FFFFFF',
      sectionMuted: 'D1D5DB',
      inverse: 'FFFFFF',
    },
    chartColors: ['E11D48', '111827', '6B7280', 'F59E0B', '0EA5E9'],
    coverStyle: 'light',
    eyebrow: 'PRESENTACIÓN',
  },
  editorial: {
    id: 'editorial',
    label: 'Editorial',
    description: 'Cálido y humano: crema, verde profundo y terracota.',
    fonts: { display: 'Georgia', body: 'Aptos' },
    palette: {
      bg: 'FAF7F2',
      surface: 'FFFFFF',
      surfaceAlt: 'F2EBE0',
      ink: '1C1917',
      body: '44403C',
      muted: '78716C',
      line: 'E7DFD2',
      accent: '15803D',
      accent2: 'C2571B',
      chipLine: 'D6CCBB',
      coverBg: 'F2EBE0',
      coverInk: '1C1917',
      coverMuted: '57534E',
      sectionBg: '14532D',
      sectionInk: 'FDFCF9',
      sectionMuted: 'BBF7D0',
      inverse: 'FFFFFF',
    },
    chartColors: ['15803D', 'C2571B', '0F766E', 'A16207', '57534E'],
    coverStyle: 'light',
    eyebrow: 'DOSSIER',
  },
  consulting: {
    id: 'consulting',
    label: 'Consulting',
    description: 'Estructurado y sobrio: blanco, azul marino profundo y gris.',
    fonts: { display: 'Aptos Display', body: 'Aptos' },
    palette: {
      bg: 'FFFFFF',
      surface: 'FFFFFF',
      surfaceAlt: 'F1F5F9',
      ink: '0C2340',
      body: '334155',
      muted: '6B7280',
      line: 'D8DEE9',
      accent: '1E3A5F',
      accent2: '2E75B6',
      chipLine: 'C7D2E0',
      coverBg: 'FFFFFF',
      coverInk: '0C2340',
      coverMuted: '46596E',
      sectionBg: '0C2340',
      sectionInk: 'FFFFFF',
      sectionMuted: 'B7C4D6',
      inverse: 'FFFFFF',
    },
    chartColors: ['1E3A5F', '2E75B6', '6B93B8', '94A9C0', 'C4CFDC'],
    coverStyle: 'light',
    eyebrow: 'DOCUMENTO DE TRABAJO',
  },
};

const DEFAULT_THEME_ID = 'aurora';

// Prompt keyword → theme. First match wins; checked before template mapping so
// the user's explicit styling words override the template default.
const PROMPT_THEME_RULES = [
  { re: /\b(oscur\w*|dark|nocturn\w*|ejecutiv\w*|executive|elegant\w*|lujo|luxury|premium|dorad\w*|gold)\b/i, theme: 'boardroom' },
  { re: /\b(minimalis\w*|minimal|limpi\w*|clean|simple|sobri\w*|blanc\w*)\b/i, theme: 'minimal' },
  { re: /\b(c[aá]lid\w*|warm|editorial|educaci[oó]n|educativ\w*|cultural?|humanis\w*|creativ\w*|natur\w*)\b/i, theme: 'editorial' },
  { re: /\b(consultor\w*|consulting|estrateg\w*|strategy|corporativ\w*|corporate|negocio\w*|business|financier\w*|finanz\w*|banca)\b/i, theme: 'consulting' },
  { re: /\b(modern\w*|tecnol[oó]g\w*|tech|startup|innovaci[oó]n|digital)\b/i, theme: 'aurora' },
];

// Template → theme fallback when the prompt doesn't say anything about style.
const TEMPLATE_THEME_MAP = {
  business: 'consulting',
  legal: 'boardroom',
  premium: 'boardroom',
  education: 'editorial',
  academic: 'minimal',
};

/**
 * Pick the theme for a deck from the user's prompt + detected template.
 * Explicit prompt styling keywords win over the template default.
 */
function pickPptxTheme({ template = '', prompt = '', themeId = null } = {}) {
  if (themeId && THEMES[themeId]) return THEMES[themeId];
  const text = String(prompt || '');
  for (const rule of PROMPT_THEME_RULES) {
    if (rule.re.test(text)) return THEMES[rule.theme];
  }
  const mapped = TEMPLATE_THEME_MAP[String(template || '').toLowerCase()];
  return THEMES[mapped] || THEMES[DEFAULT_THEME_ID];
}

function listPptxThemes() {
  return Object.values(THEMES).map(({ id, label, description }) => ({ id, label, description }));
}

// ── Chart type selection ────────────────────────────────────────────────
// Time-looking labels → line; ≤6 categories whose values sum ≈100 → doughnut
// (parts of a whole); everything else → bar. Conservative: bar is the safe
// default because it reads well for any data shape.

const TEMPORAL_LABEL_RE = /^(?:ene(?:ro)?|feb(?:rero)?|mar(?:zo)?|abr(?:il)?|may(?:o)?|jun(?:io)?|jul(?:io)?|ago(?:sto)?|sep(?:tiembre)?|oct(?:ubre)?|nov(?:iembre)?|dic(?:iembre)?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|q[1-4]|[12]\d{3}|(?:19|20)\d{2}[-/ ]?(?:0?[1-9]|1[0-2])?|d[ií]a\s*\d+|semana\s*\d+|week\s*\d+|t[1-4])$/i;

function looksTemporal(labels = []) {
  if (!Array.isArray(labels) || labels.length < 3) return false;
  const matches = labels.filter((label) => TEMPORAL_LABEL_RE.test(String(label || '').trim()));
  return matches.length >= Math.ceil(labels.length * 0.7);
}

function sumsToHundred(values = []) {
  if (!Array.isArray(values) || values.length < 2 || values.length > 6) return false;
  const numbers = values.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0);
  if (numbers.length !== values.length) return false;
  const total = numbers.reduce((sum, value) => sum + value, 0);
  return total >= 90 && total <= 110;
}

/**
 * Choose the chart type for a data series.
 * @returns {'bar'|'line'|'doughnut'}
 */
function pickChartType({ labels = [], values = [] } = {}) {
  if (looksTemporal(labels)) return 'line';
  if (sumsToHundred(values)) return 'doughnut';
  return 'bar';
}

module.exports = {
  THEMES,
  DEFAULT_THEME_ID,
  pickPptxTheme,
  listPptxThemes,
  pickChartType,
  // exported for tests
  looksTemporal,
  sumsToHundred,
};
