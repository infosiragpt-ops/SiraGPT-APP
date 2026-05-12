'use strict';

/**
 * document-insights-engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure-function, dependency-free insights extractor that runs alongside the
 * `document-professional-analyzer` to enrich the chat context with structured
 * findings BEFORE the LLM sees the raw document text.
 *
 * The professional analyzer answers "what kind of document is this and what
 * recipe should the model follow?". This engine answers "what concrete facts
 * have we already pulled out so the model can cite them confidently?".
 *
 * Design constraints (mirrors document-professional-analyzer):
 *  - Synchronous, deterministic, no LLM call, no network. Adds <30 ms to the
 *    chat path even for 1 MB of text.
 *  - Resilient: handles empty / null / non-string inputs without throwing.
 *  - Token-budget aware: each section caps to a small number of items so the
 *    final markdown block stays under ~4 KB even for 20 attached files.
 *
 * Public API:
 *   extractDocumentInsights(text, opts) → InsightsReport
 *   renderInsightsBlock(report, opts)   → string (markdown block)
 *   buildInsightsForFiles(files, opts)  → { perFile, aggregate }
 */

const MAX_ENTITIES_PER_TYPE = 12;
const MAX_KEY_NUMBERS = 16;
const MAX_DATES = 12;
const MAX_QUOTES = 6;
const MAX_ACTION_ITEMS = 12;
const MAX_QUESTIONS = 8;
const MAX_RISKS = 10;
const MAX_LINKS = 10;
const SCAN_HEAD_BYTES = 32_000;

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function safeText(value) {
  if (typeof value !== 'string') return '';
  return value;
}

function uniquePreserveOrder(values, max = Infinity) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function clip(text, max = 240) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function countOccurrences(text, regex) {
  return (text.match(regex) || []).length;
}

// ──────────────────────────────────────────────────────────────────────────
// Entity extraction (heuristic, language-aware)
// ──────────────────────────────────────────────────────────────────────────

const PERSON_TITLE = /\b(?:Sr\.?|Sra\.?|Srta\.?|Dr\.?|Dra\.?|Lic\.?|Ing\.?|Mr\.?|Mrs\.?|Ms\.?|Mx\.?|Prof\.?|Don|Doña|Sir|Dame)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,3})/g;
const FULL_NAME = /\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+(?:de|la|del|y|von|van|der|den|le|la)\s+|\s+)[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)\b/g;
const ORG_SUFFIX = /\b([A-ZÁÉÍÓÚÑ][\w&.-]*(?:\s+[A-ZÁÉÍÓÚÑ][\w&.-]*){0,3}\s+(?:Inc\.?|Corp\.?|Corporation|LLC|Ltd\.?|Limited|GmbH|S\.A\.?|S\.L\.?|S\.A\.S\.?|SAS|SAC|SRL|S\.R\.L\.?|EIRL|PLC|AG|NV|BV|Pty|Co\.?|Group|Holdings|Foundation|Trust|Bank|University|Universidad|Hospital|Clínica|Cliínica|Asociaci[oó]n))\b/g;
const URL = /https?:\/\/[^\s<>"']+/g;
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const PHONE = /\+?\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}[\s.-]?\d{2,4}[\s.-]?\d{2,4}/g;
const ISO_DATE = /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g;
const SLASH_DATE = /\b(?:0?[1-9]|[12]\d|3[01])[\/.-](?:0?[1-9]|1[0-2])[\/.-](?:19|20)?\d{2}\b/g;
const NAMED_DATE = /\b(?:0?[1-9]|[12]\d|3[01])\s+(?:de\s+)?(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|january|february|march|april|may|june|july|august|september|october|november|december)\s+(?:de\s+)?(?:19|20)\d{2}\b/gi;
const TIME_MARKER = /\b(?:hoy|ayer|mañana|today|yesterday|tomorrow|this\s+(?:week|month|quarter|year)|next\s+(?:week|month|quarter|year)|esta\s+semana|este\s+mes|el\s+pr[oó]ximo\s+\w+)\b/gi;

const MONEY = /(?:[$€£¥]|US\$|S\/\.?|R\$|MX\$|Bs\.?|CLP|COP|PEN|MXN|EUR|USD|GBP|JPY|BRL|ARS|CAD|AUD)\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?(?:\s?(?:millones?|mil(?:l(?:ones?|ardos?))?|millions?|billions?|thousands?|m|k|bn|mm))?\b|\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?\s?(?:USD|EUR|GBP|JPY|BRL|ARS|MXN|PEN|COP|CLP|CAD|AUD|d[oó]lares?|euros?|libras?|pesos?|soles?|reales?)\b/gi;
const PERCENT = /\b\d{1,3}(?:[.,]\d+)?\s?%(?:\s?(?:YoY|MoM|QoQ|interanual|mensual|trimestral|anual))?/gi;
const LARGE_NUMBER = /\b\d{1,3}(?:[.,]\d{3}){1,}(?:[.,]\d+)?\b/g;

// ──────────────────────────────────────────────────────────────────────────
// Action items, questions, risks, claims
// ──────────────────────────────────────────────────────────────────────────

const ACTION_PATTERNS = [
  /(?:^|\n)\s*(?:[-*•]|\d+[.)])\s*(?:TODO|FIXME|XXX|ACTION|TO\s+DO|PENDIENTE|TAREA|ACCI[OÓ]N|HACER)[:\s]+(.+)/gi,
  /\b(?:we|the team|el equipo|nosotros)\s+(?:will|shall|must|need to|have to|need|debemos|tenemos que|necesitamos|vamos a)\s+(.{8,160}?)(?=\.|$|;)/gi,
  /\b(?:owner|responsable|assignee)\s*[:=]\s*([^,.\n]{2,40})\s+(?:will|shall|must|debe|tiene que)\s+(.{8,160}?)(?=\.|$|;)/gi,
  /\bfollow[- ]?up\s*[:=]\s+(.{8,160}?)(?=\.|$|;)/gi,
  /\bdue\s+(?:by|date)?[:\s]+([A-Z0-9][^.\n]{4,40})/gi,
];

// Use lookbehind/lookahead so consecutive questions on the same line are
// detected — consuming the leading/trailing whitespace would skip the next
// question's leading anchor.
const QUESTION_PATTERN = /(?<=^|[\s>—–-])([A-ZÁÉÍÓÚÑ¿][^.!?\n]{8,180}\?)(?=\s|$)/g;

const RISK_PATTERNS = [
  /\b(?:risk|riesgo|amenaza|threat|vulnerab(?:le|ility)|exposure|debilidad|peligro|hazard|fragility|fragilidad|exposici[oó]n)\b[:.\s][^.\n]{4,180}/gi,
  /\b(?:we (?:risk|may lose)|podr[ií]a perder|could fail|puede fallar|likely to|probable que|warning|atenci[oó]n)\b[:.\s][^.\n]{4,180}/gi,
  /\b(?:critical|cr[ií]tico|severe|severo|high\s+severity|alta\s+severidad|p0|p1)\b[:.\s][^.\n]{4,180}/gi,
];

const CLAIM_PATTERNS = [
  /\b(?:we (?:show|prove|demonstrate|find|conclude|argue|propose)|nuestros? (?:resultados?|hallazgos?|conclusiones?)|los (?:resultados?|datos?) (?:muestran|indican|sugieren|demuestran))\b[^.\n]{8,200}\./gi,
  /\b(?:therefore|por (?:lo )?tanto|en consecuencia|consequently|accordingly|thus|as a result|en resumen|in summary)\b[^.\n]{8,220}\./gi,
];

// ──────────────────────────────────────────────────────────────────────────
// Public extractors
// ──────────────────────────────────────────────────────────────────────────

function extractEntities(text) {
  const head = text.slice(0, SCAN_HEAD_BYTES);
  const persons = [];
  const orgs = [];
  const places = []; // populated indirectly when ORG_SUFFIX hits (e.g. "Universidad de Lima")

  let match;
  while ((match = PERSON_TITLE.exec(head)) !== null) {
    persons.push(match[1].trim());
  }
  PERSON_TITLE.lastIndex = 0;

  // Light pass for "Firstname Lastname" capitalised pairs — coarse, but
  // good enough as a backup signal when no titles are present.
  while ((match = FULL_NAME.exec(head)) !== null) {
    const candidate = match[1].trim();
    if (candidate.split(/\s+/).length <= 4 && !/^[A-ZÁÉÍÓÚÑ]+$/.test(candidate)) {
      persons.push(candidate);
    }
  }
  FULL_NAME.lastIndex = 0;

  while ((match = ORG_SUFFIX.exec(head)) !== null) {
    orgs.push(match[1].trim().replace(/\s+/g, ' '));
  }
  ORG_SUFFIX.lastIndex = 0;

  return {
    persons: uniquePreserveOrder(persons, MAX_ENTITIES_PER_TYPE),
    organizations: uniquePreserveOrder(orgs, MAX_ENTITIES_PER_TYPE),
    places: uniquePreserveOrder(places, MAX_ENTITIES_PER_TYPE),
  };
}

function extractContacts(text) {
  const head = text.slice(0, SCAN_HEAD_BYTES);
  return {
    urls: uniquePreserveOrder(head.match(URL) || [], MAX_LINKS),
    emails: uniquePreserveOrder(head.match(EMAIL) || [], MAX_LINKS),
    phones: uniquePreserveOrder(head.match(PHONE) || [], MAX_LINKS),
  };
}

function extractDates(text) {
  const head = text.slice(0, SCAN_HEAD_BYTES);
  const iso = head.match(ISO_DATE) || [];
  const slash = head.match(SLASH_DATE) || [];
  const named = head.match(NAMED_DATE) || [];
  const relative = head.match(TIME_MARKER) || [];
  return {
    absolute: uniquePreserveOrder([...iso, ...slash, ...named], MAX_DATES),
    relative: uniquePreserveOrder(relative.map(s => s.toLowerCase()), MAX_DATES),
  };
}

function extractKeyNumbers(text) {
  const head = text.slice(0, SCAN_HEAD_BYTES);
  const money = head.match(MONEY) || [];
  const percents = head.match(PERCENT) || [];
  const large = head.match(LARGE_NUMBER) || [];
  return {
    money: uniquePreserveOrder(money.map(s => s.trim()), MAX_KEY_NUMBERS),
    percentages: uniquePreserveOrder(percents.map(s => s.trim()), MAX_KEY_NUMBERS),
    largeNumbers: uniquePreserveOrder(large.map(s => s.trim()), MAX_KEY_NUMBERS),
  };
}

function extractActionItems(text) {
  const items = [];
  for (const pattern of ACTION_PATTERNS) {
    let m;
    while ((m = pattern.exec(text)) !== null) {
      // Take last capture group as the action body
      const body = (m[m.length - 1] || '').trim();
      if (body && body.length >= 6 && body.length <= 220) {
        items.push(clip(body));
      }
      if (items.length >= MAX_ACTION_ITEMS * 2) break;
    }
    pattern.lastIndex = 0;
  }
  return uniquePreserveOrder(items, MAX_ACTION_ITEMS);
}

function extractQuestions(text) {
  const head = text.slice(0, SCAN_HEAD_BYTES);
  const out = [];
  let m;
  while ((m = QUESTION_PATTERN.exec(head)) !== null) {
    const q = m[1].trim();
    if (q.length >= 10 && q.length <= 200) out.push(q);
    if (out.length >= MAX_QUESTIONS * 2) break;
  }
  QUESTION_PATTERN.lastIndex = 0;
  return uniquePreserveOrder(out, MAX_QUESTIONS);
}

function extractRisks(text) {
  const items = [];
  const head = text.slice(0, SCAN_HEAD_BYTES);
  for (const pattern of RISK_PATTERNS) {
    let m;
    while ((m = pattern.exec(head)) !== null) {
      const snippet = (m[0] || '').trim();
      if (snippet.length >= 12 && snippet.length <= 240) {
        items.push(clip(snippet, 200));
      }
      if (items.length >= MAX_RISKS * 2) break;
    }
    pattern.lastIndex = 0;
  }
  return uniquePreserveOrder(items, MAX_RISKS);
}

function extractClaims(text) {
  const items = [];
  const head = text.slice(0, SCAN_HEAD_BYTES);
  for (const pattern of CLAIM_PATTERNS) {
    let m;
    while ((m = pattern.exec(head)) !== null) {
      const snippet = (m[0] || '').trim().replace(/\s+/g, ' ');
      if (snippet.length >= 16 && snippet.length <= 260) {
        items.push(clip(snippet, 220));
      }
      if (items.length >= MAX_QUOTES * 2) break;
    }
    pattern.lastIndex = 0;
  }
  return uniquePreserveOrder(items, MAX_QUOTES);
}

// ──────────────────────────────────────────────────────────────────────────
// Content metrics
// ──────────────────────────────────────────────────────────────────────────

function computeContentMetrics(text) {
  const chars = text.length;
  const words = (text.match(/[\p{L}\p{N}]+/gu) || []).length;
  const sentences = Math.max(1, countOccurrences(text, /[.!?]+(?=\s|$)/g));
  const paragraphs = Math.max(1, text.split(/\n{2,}/).filter(p => p.trim().length > 0).length);
  const avgSentenceLen = words / sentences;
  const codeBlocks = countOccurrences(text, /```[\s\S]*?```/g);
  const inlineCode = countOccurrences(text, /(?<!`)`[^`\n]+`(?!`)/g);
  const tables = countOccurrences(text, /^\|.+\|.*\n\|[-:|\s]+\|/gm);
  const headings = countOccurrences(text, /^#{1,6}\s+\S/gm);
  const lists = countOccurrences(text, /^\s*(?:[-*+]|\d+[.)])\s+\S/gm);
  // Reading time ~220 wpm for prose, ~120 wpm for technical content
  const baseSpeed = (codeBlocks > 0 || inlineCode > 5 || tables > 0) ? 150 : 220;
  const readingMinutes = Math.max(1, Math.round(words / baseSpeed));
  // Lix-ish complexity score: longer sentences + larger words → harder
  const longWords = (text.slice(0, 16_000).match(/[\p{L}]{7,}/gu) || []).length;
  const sampleWords = Math.max(1, (text.slice(0, 16_000).match(/[\p{L}\p{N}]+/gu) || []).length);
  const complexity = Math.round(avgSentenceLen + (longWords * 100) / sampleWords);
  return {
    chars,
    words,
    sentences,
    paragraphs,
    headings,
    lists,
    tables,
    codeBlocks,
    inlineCode,
    avgSentenceLength: Number(avgSentenceLen.toFixed(1)),
    readingMinutes,
    readabilityScore: complexity, // higher = harder
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Master extractor
// ──────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} InsightsReport
 * @property {object} entities
 * @property {string[]} entities.persons
 * @property {string[]} entities.organizations
 * @property {string[]} entities.places
 * @property {object} contacts
 * @property {string[]} contacts.urls
 * @property {string[]} contacts.emails
 * @property {string[]} contacts.phones
 * @property {object} dates
 * @property {string[]} dates.absolute
 * @property {string[]} dates.relative
 * @property {object} numbers
 * @property {string[]} numbers.money
 * @property {string[]} numbers.percentages
 * @property {string[]} numbers.largeNumbers
 * @property {string[]} actionItems
 * @property {string[]} questions
 * @property {string[]} risks
 * @property {string[]} claims
 * @property {object} metrics
 */

function extractDocumentInsights(text /*: string */, opts /*: { headBytes?: number } */ = {}) {
  const safe = safeText(text);
  if (!safe.trim()) {
    return {
      entities: { persons: [], organizations: [], places: [] },
      contacts: { urls: [], emails: [], phones: [] },
      dates: { absolute: [], relative: [] },
      numbers: { money: [], percentages: [], largeNumbers: [] },
      actionItems: [],
      questions: [],
      risks: [],
      claims: [],
      metrics: { chars: 0, words: 0, sentences: 0, paragraphs: 0, headings: 0, lists: 0, tables: 0, codeBlocks: 0, inlineCode: 0, avgSentenceLength: 0, readingMinutes: 0, readabilityScore: 0 },
    };
  }
  // headBytes is ignored — kept in signature for future tuning without API churn.
  void opts;

  return {
    entities: extractEntities(safe),
    contacts: extractContacts(safe),
    dates: extractDates(safe),
    numbers: extractKeyNumbers(safe),
    actionItems: extractActionItems(safe),
    questions: extractQuestions(safe),
    risks: extractRisks(safe),
    claims: extractClaims(safe),
    metrics: computeContentMetrics(safe),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Markdown rendering
// ──────────────────────────────────────────────────────────────────────────

function bulletList(items, max = 8) {
  if (!items || items.length === 0) return '— (none detected)';
  return items.slice(0, max).map(item => `- ${item}`).join('\n');
}

function inlineList(items, max = 8) {
  if (!items || items.length === 0) return '_(none detected)_';
  return items.slice(0, max).join(' · ');
}

function renderInsightsBlock(report, opts = {}) {
  if (!report) return '';
  const title = opts.title || 'EXTRACTED INSIGHTS';
  const fileLabel = opts.fileLabel ? ` — ${opts.fileLabel}` : '';
  const { entities, contacts, dates, numbers, metrics } = report;

  const sections = [];

  // Header + metrics
  sections.push(`## ${title}${fileLabel}`);
  sections.push(
    `**Metrics** · ${metrics.words.toLocaleString()} words · ${metrics.sentences.toLocaleString()} sentences · ${metrics.paragraphs} paragraphs · ${metrics.headings} headings · ${metrics.tables} tables · ~${metrics.readingMinutes} min read · readability ${metrics.readabilityScore}`,
  );

  if (entities.persons.length || entities.organizations.length) {
    sections.push('### Named entities');
    if (entities.persons.length) sections.push(`**People:** ${inlineList(entities.persons)}`);
    if (entities.organizations.length) sections.push(`**Organizations:** ${inlineList(entities.organizations)}`);
  }

  if (numbers.money.length || numbers.percentages.length || numbers.largeNumbers.length) {
    sections.push('### Key numbers');
    if (numbers.money.length) sections.push(`**Money:** ${inlineList(numbers.money)}`);
    if (numbers.percentages.length) sections.push(`**Percentages:** ${inlineList(numbers.percentages)}`);
    if (numbers.largeNumbers.length) sections.push(`**Large numbers:** ${inlineList(numbers.largeNumbers)}`);
  }

  if (dates.absolute.length || dates.relative.length) {
    sections.push('### Dates');
    if (dates.absolute.length) sections.push(`**Absolute:** ${inlineList(dates.absolute)}`);
    if (dates.relative.length) sections.push(`**Relative:** ${inlineList(dates.relative)}`);
  }

  if (contacts.emails.length || contacts.urls.length || contacts.phones.length) {
    sections.push('### Contacts & links');
    if (contacts.emails.length) sections.push(`**Emails:** ${inlineList(contacts.emails)}`);
    if (contacts.urls.length) sections.push(`**URLs:** ${inlineList(contacts.urls, 6)}`);
    if (contacts.phones.length) sections.push(`**Phones:** ${inlineList(contacts.phones)}`);
  }

  if (report.actionItems.length) {
    sections.push('### Detected action items');
    sections.push(bulletList(report.actionItems, 8));
  }
  if (report.questions.length) {
    sections.push('### Open questions in the document');
    sections.push(bulletList(report.questions, 6));
  }
  if (report.risks.length) {
    sections.push('### Detected risk signals');
    sections.push(bulletList(report.risks, 6));
  }
  if (report.claims.length) {
    sections.push('### Headline claims & conclusions');
    sections.push(bulletList(report.claims, 6));
  }

  return sections.join('\n\n');
}

/**
 * Build per-file insights + a single aggregate report across multiple files.
 * Used by the chat enrichment pipeline so the model receives both granular
 * and cross-document context in one pass.
 *
 * @param {Array<{ filename?: string, originalName?: string, name?: string, extractedText?: string, text?: string }>} files
 * @param {object} [opts]
 * @returns {{ perFile: Array<{ file: string, report: ReturnType<typeof extractDocumentInsights> }>, aggregate: ReturnType<typeof extractDocumentInsights> }}
 */
function buildInsightsForFiles(files, opts = {}) {
  void opts;
  const list = Array.isArray(files) ? files : [];
  const perFile = [];
  let aggregateText = '';
  for (const file of list) {
    if (!file || typeof file !== 'object') continue;
    const text = safeText(file.extractedText || file.text || '');
    if (!text.trim()) continue;
    const fileLabel = file.originalName || file.filename || file.name || 'archivo';
    perFile.push({ file: fileLabel, report: extractDocumentInsights(text) });
    // Concatenate (capped) for aggregate analysis
    if (aggregateText.length < 64_000) {
      aggregateText += `\n\n=== ${fileLabel} ===\n` + text.slice(0, 8_000);
    }
  }
  return {
    perFile,
    aggregate: extractDocumentInsights(aggregateText),
  };
}

module.exports = {
  extractDocumentInsights,
  renderInsightsBlock,
  buildInsightsForFiles,
  // Internals exposed for unit tests
  _internal: {
    extractEntities,
    extractContacts,
    extractDates,
    extractKeyNumbers,
    extractActionItems,
    extractQuestions,
    extractRisks,
    extractClaims,
    computeContentMetrics,
  },
};
