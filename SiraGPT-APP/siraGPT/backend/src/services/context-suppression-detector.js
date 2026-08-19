'use strict';

/**
 * context-suppression-detector.js
 *
 * Detects when the current user request *contradicts* a constraint or
 * preference the same user expressed earlier in the thread, in stored
 * memory, or in their profile.
 *
 * Inspired by the "suppression / refusal circuit" analyses in Anthropic's
 * Biology-of-LLM paper: refusals exist because a competing circuit
 * suppresses the default helpful response. At the context layer we mirror
 * that idea — if the current request would override an earlier "do not /
 * never / siempre / nunca" rule, we flag it so the assistant either
 * (a) confirms with the user before overriding, or (b) keeps respecting
 * the earlier rule.
 *
 * No LLM call. Heuristic detection only.
 */

const conceptExtractor = require('./concept-extractor');

const MAX_RULES = 40;
const MAX_CONFLICTS = 20;

// Sentence-level rule extractors.
const RULE_PATTERNS = [
  {
    kind: 'preserve',
    test: /\b(?:no\s+(?:modifiques|toques|cambies)\s+(?:la\s+)?(?:ui|interfaz|frontend|estilos?|css|html|design))\b/i,
    polarity: 'forbid',
    target: 'ui_change',
  },
  {
    kind: 'preserve',
    test: /\b(?:don'?t\s+(?:change|touch|modify|break)\s+(?:the\s+)?(?:ui|frontend|styles?|css|design))\b/i,
    polarity: 'forbid',
    target: 'ui_change',
  },
  {
    kind: 'language',
    test: /\b(?:siempre|always)\s+(?:responde|respond|contesta|reply)\s+(?:en|in)\s+(espa[ñn]ol|spanish|ingl[eé]s|english|portugu[eé]s|portuguese|franc[eé]s|french|alem[aá]n|german)\b/i,
    polarity: 'require',
    target: 'language',
  },
  {
    kind: 'language',
    test: /\b(?:no\s+respondas\s+en|do\s+not\s+(?:reply|respond)\s+in)\s+(espa[ñn]ol|spanish|ingl[eé]s|english|portugu[eé]s|portuguese|franc[eé]s|french|alem[aá]n|german)\b/i,
    polarity: 'forbid',
    target: 'language',
  },
  {
    kind: 'format',
    test: /\b(?:no\s+(?:uses|use)\s+(?:emojis?|bullets?|listas?|tablas?|tables?))\b/i,
    polarity: 'forbid',
    target: 'format',
  },
  {
    kind: 'format',
    test: /\b(?:siempre|always)\s+(?:incluye|include)\s+(?:c[oó]digo|code|ejemplos?|examples?|citas?|citations?)\b/i,
    polarity: 'require',
    target: 'format',
  },
  {
    kind: 'tool',
    test: /\b(?:no\s+(?:uses|llames|invoques)\s+(?:la\s+)?(?:b[uú]squeda\s+web|web\s+search|herramientas?|tools?|apis?|mcps?))\b/i,
    polarity: 'forbid',
    target: 'tool_use',
  },
  {
    kind: 'tool',
    test: /\b(?:do\s+not\s+(?:use|call|invoke)\s+(?:web\s+search|tools?|apis?|mcps?))\b/i,
    polarity: 'forbid',
    target: 'tool_use',
  },
  {
    kind: 'data',
    test: /\b(?:no\s+(?:inventes|fabriques|alucines|hagas\s+up)|don'?t\s+(?:make\s+up|fabricate|hallucinate|invent)|stick\s+to\s+(?:the|provided)\s+(?:data|context|file))\b/i,
    polarity: 'forbid',
    target: 'fabrication',
  },
  {
    kind: 'scope',
    test: /\b(?:trabaja\s+(?:solo|sólo|únicamente)\s+(?:en|sobre)|only\s+work\s+on|stay\s+within\s+the\s+scope\s+of)\s+([^.,;\n]{4,60})/i,
    polarity: 'require',
    target: 'scope',
  },
  {
    kind: 'tone',
    test: /\b(?:tono|tone)\s+(?:profesional|formal|casual|amigable|professional|formal|casual|friendly)\b/i,
    polarity: 'require',
    target: 'tone',
  },
];

// Catalog of "current-request would override rule X" detectors.
const VIOLATION_TESTS = {
  ui_change: /\b(?:modifica|edita|cambia|reescribe|rewrite|edit|modify|update|tweak)\s+(?:la\s+)?(?:ui|interfaz|frontend|estilos?|css|html|design)\b/i,
  fabrication: /\b(?:invent[aá]|fabric[aá]|haz\s+up|just\s+(?:guess|make\s+up)|placeholder|dummy\s+data)\b/i,
  tool_use: /\b(?:busca\s+en\s+(?:la\s+)?web|web\s+search|llama\s+(?:la|al)\s+api|invoca\s+(?:el|la)\s+tool|use\s+the\s+web)\b/i,
};

// ── Helpers ────────────────────────────────────────────────────────────────

function safeText(s) { return String(s == null ? '' : s).slice(0, 4000); }

function extractRules(sources = []) {
  const rules = [];
  for (const src of sources) {
    if (!src) continue;
    const text = safeText(typeof src === 'string' ? src : src.text || src.content || src.fact || '');
    if (!text.trim()) continue;
    for (const pat of RULE_PATTERNS) {
      const m = text.match(pat.test);
      if (!m) continue;
      const captured = m[1] || '';
      rules.push({
        id: `rule_${rules.length + 1}`,
        kind: pat.kind,
        target: pat.target,
        polarity: pat.polarity,
        sourceKind: typeof src === 'string' ? 'inline' : (src.kind || src.source || 'unknown'),
        surface: m[0].slice(0, 160),
        captured: captured ? captured.trim().slice(0, 80) : null,
      });
      if (rules.length >= MAX_RULES) return rules;
    }
  }
  return rules;
}

function detectViolations(prompt, rules) {
  const safe = safeText(prompt);
  const conflicts = [];
  for (const rule of rules) {
    if (rule.polarity === 'forbid' && VIOLATION_TESTS[rule.target]) {
      const m = safe.match(VIOLATION_TESTS[rule.target]);
      if (m) {
        conflicts.push({
          ruleId: rule.id,
          ruleSurface: rule.surface,
          currentSurface: m[0],
          severity: 'high',
          recommendation: `Ask the user whether they want to override the prior rule ("${rule.surface}") before proceeding.`,
        });
      }
    }
    if (rule.polarity === 'require' && rule.target === 'language' && rule.captured) {
      const declaredLang = rule.captured.toLowerCase();
      const promptLang = conceptExtractor.detectLanguage(safe);
      const wantsSpanish = /espa|spanish/.test(declaredLang);
      const wantsEnglish = /ingl|english/.test(declaredLang);
      if (wantsSpanish && promptLang === 'en') {
        conflicts.push({
          ruleId: rule.id,
          ruleSurface: rule.surface,
          currentSurface: '(message is in English)',
          severity: 'medium',
          recommendation: 'User asked you to always reply in Spanish; respond in Spanish even though the latest message is in English.',
        });
      }
      if (wantsEnglish && promptLang === 'es') {
        conflicts.push({
          ruleId: rule.id,
          ruleSurface: rule.surface,
          currentSurface: '(message is in Spanish)',
          severity: 'medium',
          recommendation: 'User asked you to always reply in English; respond in English even though the latest message is in Spanish.',
        });
      }
    }
    if (conflicts.length >= MAX_CONFLICTS) break;
  }
  return conflicts;
}

function analyze({ prompt = '', history = [], memories = [], userProfile = null } = {}) {
  const sources = [];
  if (Array.isArray(history)) sources.push(...history);
  if (Array.isArray(memories)) sources.push(...memories);
  if (userProfile?.customInstructions) sources.push({ kind: 'profile', text: String(userProfile.customInstructions) });
  if (userProfile?.preferredTone) sources.push({ kind: 'profile', text: `tono ${userProfile.preferredTone}` });

  const rules = extractRules(sources);
  const conflicts = detectViolations(prompt, rules);

  return {
    rules,
    conflicts,
    hasConflicts: conflicts.length > 0,
  };
}

function renderSuppressionBlock(result, opts = {}) {
  if (!result || !result.hasConflicts) return '';
  const lines = [];
  lines.push('## CONTEXT-SUPPRESSION ALERT');
  lines.push(`The current request appears to override ${result.conflicts.length} earlier user-defined rule(s). Resolve before answering:`);
  for (const c of result.conflicts) {
    lines.push(`- [${c.severity}] ${c.ruleSurface}`);
    lines.push(`  • New request says: "${c.currentSurface}"`);
    lines.push(`  • Recommendation: ${c.recommendation}`);
  }
  const cap = Math.max(500, Number(opts.maxChars) || 1400);
  const out = lines.join('\n');
  if (out.length > cap) return `${out.slice(0, cap - 80).trimEnd()}\n… [suppression truncated]`;
  return out;
}

module.exports = {
  analyze,
  extractRules,
  detectViolations,
  renderSuppressionBlock,
  RULE_PATTERNS,
};
