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
const MAX_IDENTIFIERS_PER_TYPE = 10;
const MAX_BIBLIOGRAPHIC_PER_TYPE = 8;
const MAX_STATISTICAL = 12;
const MAX_ACRONYMS = 14;
const MAX_TRENDS = 10;
const MAX_CROSS_REFS = 10;
const MAX_GEO = 10;
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
// Technical identifiers (IPs, UUIDs, hashes, JWTs, IBAN, SWIFT, MAC)
// ──────────────────────────────────────────────────────────────────────────

// Strict IPv4: each octet 0-255. Negative lookbehind prevents matching the
// suffix of a longer version string ("1.10.0.0.42" should not yield "10.0.0.42"),
// and the lookahead rejects only a continuing `.NN` pattern — a trailing
// period from a sentence (e.g. "ping 8.8.8.8.") must still produce a match.
const IPV4 = /(?<![\d.])((?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3})(?!\d)(?!\.\d)/g;
// IPv6 — compressed or full, with optional zone id.  Loose by design.
const IPV6 = /(?<![:.\w])((?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}|::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:)(?![\w:])/g;
const MAC_ADDRESS = /\b([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}|[0-9A-Fa-f]{2}(?:-[0-9A-Fa-f]{2}){5})\b/g;
const UUID = /\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89ABab][0-9a-fA-F]{3}-[0-9a-fA-F]{12})\b/g;
// Hash digests anchored by length so they don't catch random long hex blobs.
// We require the value to be on a word boundary and the next/prev char to NOT
// be hex — that's enough to skip extracts inside longer strings.
const MD5_HASH = /(?<![0-9a-fA-F])([0-9a-fA-F]{32})(?![0-9a-fA-F])/g;
const SHA1_HASH = /(?<![0-9a-fA-F])([0-9a-fA-F]{40})(?![0-9a-fA-F])/g;
const SHA256_HASH = /(?<![0-9a-fA-F])([0-9a-fA-F]{64})(?![0-9a-fA-F])/g;
const JWT_TOKEN = /\b(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;
// IBAN — country code + 2 check digits + 11-30 alphanumeric BBAN chars.
// Accepts both unformatted ("GB82WEST12345698765432") and 4-char-grouped
// ("DE89 3704 0044 0532 0130 00") variants. We strip whitespace post-match
// before deduping.
const IBAN = /\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]){11,30})\b/g;
// SWIFT/BIC: 8 or 11 alphanumerics (letters for first 4 — institution code).
const SWIFT_BIC = /\b([A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b/g;
// AWS ARN — arn:partition:service:region:account-id:resource
const AWS_ARN = /\b(arn:(?:aws|aws-cn|aws-us-gov):[\w-]+:[\w-]*:\d*:[\w-/:.*]+)\b/g;

// ──────────────────────────────────────────────────────────────────────────
// Bibliographic references (DOI, ISBN, arXiv, RFC, PubMed)
// ──────────────────────────────────────────────────────────────────────────

const DOI = /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+[A-Za-z0-9])/g;
// ISBN-13 and ISBN-10; both with optional "ISBN" prefix and hyphens/spaces.
const ISBN = /\bISBN(?:-1[03])?[:\s]*((?:97[89][- ]?)?(?:\d[- ]?){9}[\dXx])\b/gi;
// arXiv: new format YYMM.NNNNN(vN), old format archive/YYMMNNN
const ARXIV = /\barXiv:\s*((?:\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?))/gi;
const RFC_REF = /\bRFC[\s-]?(\d{1,5})\b/g;
const PUBMED = /\bPMID:?\s*(\d{4,9})\b/gi;
const PMC_ID = /\bPMC\s?(\d{4,9})\b/g;

// ──────────────────────────────────────────────────────────────────────────
// Geographic references (GPS coordinates, postal codes, country mentions)
// ──────────────────────────────────────────────────────────────────────────

// Decimal-degree coordinates: "12.345, -67.890" with reasonable bounds.
const GPS_DECIMAL = /(?<![\w.])(-?(?:[0-8]?\d(?:\.\d{2,8})?|90(?:\.0+)?)\s*[,;]\s*-?(?:1[0-7]\d(?:\.\d{2,8})?|180(?:\.0+)?|\d{1,2}(?:\.\d{2,8})?))(?![\w.])/g;
// DMS coordinates: 12°34'56.78"N 67°89'01.23"W
const GPS_DMS = /(\d{1,3}°\s?\d{1,2}'(?:\s?\d{1,2}(?:\.\d+)?")?\s?[NSEW](?:\s+\d{1,3}°\s?\d{1,2}'(?:\s?\d{1,2}(?:\.\d+)?")?\s?[NSEW])?)/g;
// US/CA/UK postal codes (loose; international postal codes are too varied).
const POSTAL_CODE = /\b(?:[A-Z]\d[A-Z]\s?\d[A-Z]\d|\d{5}(?:-\d{4})?|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/g;

// ──────────────────────────────────────────────────────────────────────────
// Statistical claims (sample size, p-values, correlation, mean ± SD, CI)
// ──────────────────────────────────────────────────────────────────────────

const SAMPLE_SIZE = /\b[Nn]\s*=\s*(\d{1,7}(?:[,.]\d{3})*)/g;
// p-value: "p = 0.05", "p < 0.001", "p > 0.1", "p-value of 0.03"
const P_VALUE = /\bp\s*(?:[-]?value\s*(?:of|=|:)?\s*|[=<>≤≥])\s*(0?\.\d{1,6}|\d\.\d{1,6}e?-?\d{0,3})/gi;
// Correlations: r = 0.78, ρ = 0.42, R² = 0.65
const CORRELATION = /\b(?:r|ρ|R(?:\^?2|²))\s*=\s*(-?0?\.\d{1,4}|-?1\.0+|-?\d\.\d{1,4})/g;
// Confidence intervals: "95% CI [1.2, 3.4]" or "CI: 1.2-3.4"
const CONFIDENCE_INTERVAL = /\b(\d{1,3}\s*%?\s*CI[:\s]*[\[(]?\s*-?\d+(?:\.\d+)?\s*[-,]\s*-?\d+(?:\.\d+)?\s*[\])]?)/gi;
// Effect sizes: Cohen's d, odds ratio (OR), hazard ratio (HR), risk ratio (RR)
const EFFECT_SIZE = /\b(?:Cohen's\s*d|OR|HR|RR)\s*=\s*(-?\d+(?:\.\d+)?)/gi;
// Mean ± SD pattern: "12.5 ± 3.2"
const MEAN_SD = /\b(\d+(?:\.\d+)?\s*[±+\/\-]\s*\d+(?:\.\d+)?)\b/g;

// ──────────────────────────────────────────────────────────────────────────
// Acronyms with definitions
// ──────────────────────────────────────────────────────────────────────────

// "Health Insurance Portability and Accountability Act (HIPAA)"
// Acronym must be 2-8 uppercase letters; up to 7 preceding words are checked
// for matching initials (case-insensitive, allows skipping function words).
const ACRONYM_TRAILING = /(?:^|[\s.,;:(])((?:[A-Z][A-Za-zÁÉÍÓÚÑ-]+\s+(?:[a-zñáéíóú]+\s+){0,3}){1,6}[A-Z][A-Za-zÁÉÍÓÚÑ-]+)\s+\(([A-Z][A-Z0-9]{1,7})\)/g;
// "HIPAA (Health Insurance Portability and Accountability Act)"
const ACRONYM_LEADING = /\b([A-Z][A-Z0-9]{1,7})\s+\(([A-Z][\w\s,&-]{6,80}?)\)/g;

// ──────────────────────────────────────────────────────────────────────────
// Trend signals (growth/decline + magnitude)
// ──────────────────────────────────────────────────────────────────────────

const TREND_PATTERNS = [
  // "increased 12.5%", "grew by 8%", "rose 3 percentage points"
  /\b(?:increased?|grew|rose|jumped|climb(?:ed)?|surged|spiked|aument[oóò]|creci[oó]|subi[oó]|escal[oó])(?:\s+by)?\s+(?:[a-z]{1,8}\s+)?((?:\$|€|£|US\$|S\/|R\$)?\d+(?:[.,]\d+)?\s*(?:%|percentage\s+points?|pts?|p\.p\.|millones?|millions?|billions?|thousands?|miles))/gi,
  // "decreased 12.5%", "dropped 8%", "fell to X"
  /\b(?:decreased?|dropped|fell|declined?|plunged|tumbled|disminuy[oó]|baj[oó]|cay[oó]|descend[oó])(?:\s+by)?\s+(?:[a-z]{1,8}\s+)?((?:\$|€|£|US\$|S\/|R\$)?\d+(?:[.,]\d+)?\s*(?:%|percentage\s+points?|pts?|p\.p\.|millones?|millions?|billions?|thousands?|miles))/gi,
  // "grew from X to Y", "rose from 12% to 18%", "pasó de X a Y"
  /\b(?:from|de|desde)\s+((?:\$|€|£|US\$|S\/|R\$)?\d+(?:[.,]\d+)?\s*(?:%|millones?|millions?|billions?|thousands?|miles)?)\s+(?:to|a|hasta)\s+((?:\$|€|£|US\$|S\/|R\$)?\d+(?:[.,]\d+)?\s*(?:%|millones?|millions?|billions?|thousands?|miles)?)/gi,
  // "+12% YoY", "-3.5% MoM"
  /(?:^|\s)([+-]\d+(?:[.,]\d+)?%\s*(?:YoY|MoM|QoQ|YTD|interanual|mensual|trimestral|anual)?)/gi,
];

// ──────────────────────────────────────────────────────────────────────────
// Cross-references inside the document
// ──────────────────────────────────────────────────────────────────────────

const CROSS_REFERENCE_PATTERNS = [
  /\b(?:see|véase|consulta(?:r)?|ver|cf\.?|refer\s+to|refi[eé]rase)\s+(?:also\s+|tambi[eé]n\s+)?((?:section|secci[oó]n|chapter|cap[ií]tulo|figure|figura|table|tabla|appendix|ap[eé]ndice|equation|ecuaci[oó]n|annex|anexo|page|p[aá]gina)\s+[A-Z0-9]+(?:\.[0-9A-Z]+)*)/gi,
  /\b(?:as\s+(?:shown|defined|discussed|described|outlined)\s+in|como\s+(?:se\s+(?:muestra|define|discute|describe)|se\s+observa)\s+en)\s+((?:section|secci[oó]n|chapter|cap[ií]tulo|figure|figura|table|tabla|appendix|ap[eé]ndice|annex|anexo)\s+[A-Z0-9]+(?:\.[0-9A-Z]+)*)/gi,
  /\b((?:section|secci[oó]n|chapter|cap[ií]tulo|figure|figura|table|tabla|appendix|ap[eé]ndice|equation|ecuaci[oó]n)\s+\d+(?:\.\d+){1,3})/gi,
];

// ──────────────────────────────────────────────────────────────────────────
// Sentiment signals (strong positive/negative phrasing)
// ──────────────────────────────────────────────────────────────────────────

const POSITIVE_SIGNALS = /\b(?:excellent|outstanding|exceptional|remarkable|impressive|breakthrough|exitoso|sobresaliente|excelente|excepcional|notable|impresionante|hito|logro\s+importante|success\s+story|caso\s+de\s+éxito)\b[^.\n]{0,140}/gi;
const NEGATIVE_SIGNALS = /\b(?:critical|severe|serious|catastrophic|disastrous|failure|cr[ií]tico|severo|grave|catastr[oó]fico|desastr[oó]so|fracaso|fall[oa]|p[eé]rdida|debacle|colapso)\b[^.\n]{0,140}/gi;

// ──────────────────────────────────────────────────────────────────────────
// Identifier / bibliographic / geographic / statistical / acronym / trend
// / cross-reference / sentiment extractors
// ──────────────────────────────────────────────────────────────────────────

function extractIdentifiers(text) {
  const head = text.slice(0, SCAN_HEAD_BYTES);
  const collect = (re) => {
    const out = [];
    let m;
    while ((m = re.exec(head)) !== null) {
      out.push((m[1] || m[0]).trim());
    }
    re.lastIndex = 0;
    return out;
  };
  return {
    ipv4: uniquePreserveOrder(collect(IPV4), MAX_IDENTIFIERS_PER_TYPE),
    ipv6: uniquePreserveOrder(collect(IPV6), MAX_IDENTIFIERS_PER_TYPE),
    macAddresses: uniquePreserveOrder(collect(MAC_ADDRESS), MAX_IDENTIFIERS_PER_TYPE),
    uuids: uniquePreserveOrder(collect(UUID), MAX_IDENTIFIERS_PER_TYPE),
    hashes: {
      md5: uniquePreserveOrder(collect(MD5_HASH), MAX_IDENTIFIERS_PER_TYPE),
      sha1: uniquePreserveOrder(collect(SHA1_HASH), MAX_IDENTIFIERS_PER_TYPE),
      sha256: uniquePreserveOrder(collect(SHA256_HASH), MAX_IDENTIFIERS_PER_TYPE),
    },
    jwts: uniquePreserveOrder(collect(JWT_TOKEN), MAX_IDENTIFIERS_PER_TYPE),
    ibans: uniquePreserveOrder(collect(IBAN).map(s => s.replace(/\s+/g, '')), MAX_IDENTIFIERS_PER_TYPE),
    swiftCodes: uniquePreserveOrder(collect(SWIFT_BIC), MAX_IDENTIFIERS_PER_TYPE),
    awsArns: uniquePreserveOrder(collect(AWS_ARN), MAX_IDENTIFIERS_PER_TYPE),
  };
}

function extractBibliographic(text) {
  const head = text.slice(0, SCAN_HEAD_BYTES);
  const collect = (re) => {
    const out = [];
    let m;
    while ((m = re.exec(head)) !== null) {
      out.push((m[1] || m[0]).trim());
    }
    re.lastIndex = 0;
    return out;
  };
  return {
    dois: uniquePreserveOrder(collect(DOI), MAX_BIBLIOGRAPHIC_PER_TYPE),
    isbns: uniquePreserveOrder(collect(ISBN).map(s => s.replace(/[-\s]/g, '')), MAX_BIBLIOGRAPHIC_PER_TYPE),
    arxivIds: uniquePreserveOrder(collect(ARXIV), MAX_BIBLIOGRAPHIC_PER_TYPE),
    rfcs: uniquePreserveOrder(collect(RFC_REF).map(n => `RFC ${n}`), MAX_BIBLIOGRAPHIC_PER_TYPE),
    pubmedIds: uniquePreserveOrder(collect(PUBMED).map(n => `PMID ${n}`), MAX_BIBLIOGRAPHIC_PER_TYPE),
    pmcIds: uniquePreserveOrder(collect(PMC_ID).map(n => `PMC${n}`), MAX_BIBLIOGRAPHIC_PER_TYPE),
  };
}

function extractGeographic(text) {
  const head = text.slice(0, SCAN_HEAD_BYTES);
  const decimal = [];
  let m;
  while ((m = GPS_DECIMAL.exec(head)) !== null) decimal.push(m[1].trim());
  GPS_DECIMAL.lastIndex = 0;
  const dms = [];
  while ((m = GPS_DMS.exec(head)) !== null) dms.push(m[1].trim());
  GPS_DMS.lastIndex = 0;
  const postal = [];
  while ((m = POSTAL_CODE.exec(head)) !== null) postal.push(m[0].trim());
  POSTAL_CODE.lastIndex = 0;
  return {
    coordinatesDecimal: uniquePreserveOrder(decimal, MAX_GEO),
    coordinatesDms: uniquePreserveOrder(dms, MAX_GEO),
    postalCodes: uniquePreserveOrder(postal, MAX_GEO),
  };
}

function extractStatisticalClaims(text) {
  const head = text.slice(0, SCAN_HEAD_BYTES);
  const collect = (re, format) => {
    const out = [];
    let m;
    while ((m = re.exec(head)) !== null) {
      out.push(format ? format(m) : (m[1] || m[0]).trim());
    }
    re.lastIndex = 0;
    return out;
  };
  return {
    sampleSizes: uniquePreserveOrder(collect(SAMPLE_SIZE, m => `n=${m[1]}`), MAX_STATISTICAL),
    pValues: uniquePreserveOrder(collect(P_VALUE, m => m[0].trim()), MAX_STATISTICAL),
    correlations: uniquePreserveOrder(collect(CORRELATION, m => m[0].trim()), MAX_STATISTICAL),
    confidenceIntervals: uniquePreserveOrder(collect(CONFIDENCE_INTERVAL), MAX_STATISTICAL),
    effectSizes: uniquePreserveOrder(collect(EFFECT_SIZE, m => m[0].trim()), MAX_STATISTICAL),
    meansAndSd: uniquePreserveOrder(collect(MEAN_SD), MAX_STATISTICAL),
  };
}

function extractAcronyms(text) {
  const head = text.slice(0, SCAN_HEAD_BYTES);
  const acronyms = [];
  let m;
  while ((m = ACRONYM_TRAILING.exec(head)) !== null) {
    const definition = m[1].trim().replace(/\s+/g, ' ');
    const acr = m[2];
    if (acronymMatchesDefinition(acr, definition)) {
      acronyms.push({ acronym: acr, definition });
    }
    if (acronyms.length >= MAX_ACRONYMS * 2) break;
  }
  ACRONYM_TRAILING.lastIndex = 0;
  while ((m = ACRONYM_LEADING.exec(head)) !== null) {
    const acr = m[1];
    const definition = m[2].trim().replace(/\s+/g, ' ');
    if (acronymMatchesDefinition(acr, definition)) {
      acronyms.push({ acronym: acr, definition });
    }
    if (acronyms.length >= MAX_ACRONYMS * 2) break;
  }
  ACRONYM_LEADING.lastIndex = 0;
  const seen = new Set();
  const out = [];
  for (const item of acronyms) {
    const key = item.acronym.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= MAX_ACRONYMS) break;
  }
  return out;
}

function acronymMatchesDefinition(acronym, definition) {
  // Word-anchored fuzzy match. The acronym's FIRST letter must land at the
  // start of some meaningful word — that prevents random subsequence hits
  // like "TAD" matching "The cat sat on the mat". Subsequent letters can
  // either start a later word OR appear inside the current word (handles
  // compound forms like "Hypertext" supplying both H and T to HTTP).
  const STOPWORDS = new Set(['and', 'of', 'the', 'a', 'an', 'for', 'to', 'in', 'on', 'with', 'or',
    'para', 'por', 'de', 'la', 'el', 'los', 'las', 'y', 'o', 'en', 'con', 'al', 'del']);
  const acrLetters = acronym.replace(/[^A-Z]/g, '').split('');
  if (acrLetters.length < 2) return false;
  const words = definition.split(/[\s,]+/)
    .map(w => w.replace(/[^\wÁÉÍÓÚÑáéíóúñ-]/g, ''))
    .filter(w => w.length > 0);
  const meaningful = words.filter(w => !STOPWORDS.has(w.toLowerCase()));
  if (meaningful.length < 2) return false;
  const upperWords = meaningful.map(w => w.toUpperCase());
  // Try every word that starts with the acronym's first letter as a seed
  for (let seedIdx = 0; seedIdx < upperWords.length; seedIdx++) {
    if (upperWords[seedIdx][0] !== acrLetters[0]) continue;
    if (tryAcronymMatchFromSeed(acrLetters, upperWords, seedIdx)) return true;
  }
  return false;
}

function tryAcronymMatchFromSeed(acrLetters, upperWords, seedIdx) {
  let wordIdx = seedIdx;
  let charIdx = 1; // Next position to look within the current word
  for (let i = 1; i < acrLetters.length; i++) {
    const letter = acrLetters[i];
    // Prefer staying in the current word (handles compounds like Hypertext
    // contributing both H and T to HTTP), then fall back to a later word
    // that starts with the letter.
    let advancedInWord = false;
    if (wordIdx < upperWords.length && charIdx <= upperWords[wordIdx].length) {
      const localIdx = upperWords[wordIdx].indexOf(letter, charIdx);
      if (localIdx !== -1) {
        charIdx = localIdx + 1;
        advancedInWord = true;
      }
    }
    if (advancedInWord) continue;
    let foundWord = -1;
    for (let j = wordIdx + 1; j < upperWords.length; j++) {
      if (upperWords[j][0] === letter) { foundWord = j; break; }
    }
    if (foundWord === -1) return false;
    wordIdx = foundWord;
    charIdx = 1;
  }
  return true;
}

function extractTrends(text) {
  const head = text.slice(0, SCAN_HEAD_BYTES);
  const trends = [];
  for (const pattern of TREND_PATTERNS) {
    let m;
    while ((m = pattern.exec(head)) !== null) {
      const snippet = m[0].trim().replace(/\s+/g, ' ');
      if (snippet.length >= 4 && snippet.length <= 160) {
        trends.push(snippet);
      }
      if (trends.length >= MAX_TRENDS * 2) break;
    }
    pattern.lastIndex = 0;
  }
  return uniquePreserveOrder(trends, MAX_TRENDS);
}

function extractCrossReferences(text) {
  const head = text.slice(0, SCAN_HEAD_BYTES);
  const refs = [];
  for (const pattern of CROSS_REFERENCE_PATTERNS) {
    let m;
    while ((m = pattern.exec(head)) !== null) {
      const ref = (m[1] || m[0]).trim().replace(/\s+/g, ' ');
      if (ref.length >= 4 && ref.length <= 80) {
        refs.push(ref);
      }
      if (refs.length >= MAX_CROSS_REFS * 2) break;
    }
    pattern.lastIndex = 0;
  }
  return uniquePreserveOrder(refs, MAX_CROSS_REFS);
}

function extractSentimentSignals(text) {
  const head = text.slice(0, SCAN_HEAD_BYTES);
  const positive = [];
  const negative = [];
  let m;
  while ((m = POSITIVE_SIGNALS.exec(head)) !== null) {
    positive.push(clip(m[0].trim().replace(/\s+/g, ' '), 180));
    if (positive.length >= MAX_QUOTES * 2) break;
  }
  POSITIVE_SIGNALS.lastIndex = 0;
  while ((m = NEGATIVE_SIGNALS.exec(head)) !== null) {
    negative.push(clip(m[0].trim().replace(/\s+/g, ' '), 180));
    if (negative.length >= MAX_QUOTES * 2) break;
  }
  NEGATIVE_SIGNALS.lastIndex = 0;
  return {
    positive: uniquePreserveOrder(positive, MAX_QUOTES),
    negative: uniquePreserveOrder(negative, MAX_QUOTES),
  };
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
      identifiers: {
        ipv4: [], ipv6: [], macAddresses: [], uuids: [],
        hashes: { md5: [], sha1: [], sha256: [] },
        jwts: [], ibans: [], swiftCodes: [], awsArns: [],
      },
      bibliographic: { dois: [], isbns: [], arxivIds: [], rfcs: [], pubmedIds: [], pmcIds: [] },
      geographic: { coordinatesDecimal: [], coordinatesDms: [], postalCodes: [] },
      statistical: {
        sampleSizes: [], pValues: [], correlations: [],
        confidenceIntervals: [], effectSizes: [], meansAndSd: [],
      },
      acronyms: [],
      trends: [],
      crossReferences: [],
      sentiment: { positive: [], negative: [] },
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
    identifiers: extractIdentifiers(safe),
    bibliographic: extractBibliographic(safe),
    geographic: extractGeographic(safe),
    statistical: extractStatisticalClaims(safe),
    acronyms: extractAcronyms(safe),
    trends: extractTrends(safe),
    crossReferences: extractCrossReferences(safe),
    sentiment: extractSentimentSignals(safe),
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

  // Technical identifiers — surfaced when present so the model can cite them
  // verbatim instead of paraphrasing IPs/UUIDs/hashes.
  const ids = report.identifiers;
  if (
    ids && (
      ids.ipv4?.length || ids.ipv6?.length || ids.macAddresses?.length || ids.uuids?.length
      || ids.hashes?.md5?.length || ids.hashes?.sha1?.length || ids.hashes?.sha256?.length
      || ids.jwts?.length || ids.ibans?.length || ids.swiftCodes?.length || ids.awsArns?.length
    )
  ) {
    sections.push('### Technical identifiers');
    if (ids.ipv4?.length) sections.push(`**IPv4:** ${inlineList(ids.ipv4)}`);
    if (ids.ipv6?.length) sections.push(`**IPv6:** ${inlineList(ids.ipv6, 6)}`);
    if (ids.macAddresses?.length) sections.push(`**MAC addresses:** ${inlineList(ids.macAddresses, 6)}`);
    if (ids.uuids?.length) sections.push(`**UUIDs:** ${inlineList(ids.uuids, 6)}`);
    if (ids.hashes?.md5?.length) sections.push(`**MD5 hashes:** ${inlineList(ids.hashes.md5, 5)}`);
    if (ids.hashes?.sha1?.length) sections.push(`**SHA-1 hashes:** ${inlineList(ids.hashes.sha1, 5)}`);
    if (ids.hashes?.sha256?.length) sections.push(`**SHA-256 hashes:** ${inlineList(ids.hashes.sha256, 5)}`);
    if (ids.jwts?.length) sections.push(`**JWT tokens (truncated):** ${inlineList(ids.jwts.map(j => `${j.slice(0, 30)}…`), 4)}`);
    if (ids.ibans?.length) sections.push(`**IBANs:** ${inlineList(ids.ibans, 5)}`);
    if (ids.swiftCodes?.length) sections.push(`**SWIFT/BIC codes:** ${inlineList(ids.swiftCodes, 6)}`);
    if (ids.awsArns?.length) sections.push(`**AWS ARNs:** ${inlineList(ids.awsArns, 5)}`);
  }

  // Bibliographic references — anchor citations the model can verify.
  const bib = report.bibliographic;
  if (
    bib && (
      bib.dois?.length || bib.isbns?.length || bib.arxivIds?.length
      || bib.rfcs?.length || bib.pubmedIds?.length || bib.pmcIds?.length
    )
  ) {
    sections.push('### Bibliographic references');
    if (bib.dois?.length) sections.push(`**DOIs:** ${inlineList(bib.dois, 6)}`);
    if (bib.isbns?.length) sections.push(`**ISBNs:** ${inlineList(bib.isbns, 6)}`);
    if (bib.arxivIds?.length) sections.push(`**arXiv IDs:** ${inlineList(bib.arxivIds, 6)}`);
    if (bib.rfcs?.length) sections.push(`**RFCs:** ${inlineList(bib.rfcs, 6)}`);
    if (bib.pubmedIds?.length) sections.push(`**PubMed IDs:** ${inlineList(bib.pubmedIds, 6)}`);
    if (bib.pmcIds?.length) sections.push(`**PMC IDs:** ${inlineList(bib.pmcIds, 6)}`);
  }

  // Geographic references — help with location-bound analysis.
  const geo = report.geographic;
  if (geo && (geo.coordinatesDecimal?.length || geo.coordinatesDms?.length || geo.postalCodes?.length)) {
    sections.push('### Geographic references');
    if (geo.coordinatesDecimal?.length) sections.push(`**Coordinates (decimal):** ${inlineList(geo.coordinatesDecimal, 5)}`);
    if (geo.coordinatesDms?.length) sections.push(`**Coordinates (DMS):** ${inlineList(geo.coordinatesDms, 5)}`);
    if (geo.postalCodes?.length) sections.push(`**Postal codes:** ${inlineList(geo.postalCodes, 8)}`);
  }

  // Statistical claims — critical for research/scientific documents.
  const stats = report.statistical;
  if (
    stats && (
      stats.sampleSizes?.length || stats.pValues?.length || stats.correlations?.length
      || stats.confidenceIntervals?.length || stats.effectSizes?.length || stats.meansAndSd?.length
    )
  ) {
    sections.push('### Statistical claims');
    if (stats.sampleSizes?.length) sections.push(`**Sample sizes:** ${inlineList(stats.sampleSizes)}`);
    if (stats.pValues?.length) sections.push(`**p-values:** ${inlineList(stats.pValues)}`);
    if (stats.correlations?.length) sections.push(`**Correlations:** ${inlineList(stats.correlations)}`);
    if (stats.confidenceIntervals?.length) sections.push(`**Confidence intervals:** ${inlineList(stats.confidenceIntervals, 5)}`);
    if (stats.effectSizes?.length) sections.push(`**Effect sizes:** ${inlineList(stats.effectSizes)}`);
    if (stats.meansAndSd?.length) sections.push(`**Mean ± SD pairs:** ${inlineList(stats.meansAndSd, 6)}`);
  }

  // Acronyms with their first-mention definitions — keeps the model from
  // hallucinating expansions.
  if (report.acronyms?.length) {
    sections.push('### Acronyms & definitions');
    const lines = report.acronyms.slice(0, 10).map(({ acronym, definition }) => `- **${acronym}** — ${definition}`);
    sections.push(lines.join('\n'));
  }

  if (report.trends?.length) {
    sections.push('### Quantified trends');
    sections.push(bulletList(report.trends, 8));
  }

  if (report.crossReferences?.length) {
    sections.push('### Internal cross-references');
    sections.push(`_(navigation hints inside the document)_\n${bulletList(report.crossReferences, 8)}`);
  }

  if (report.sentiment && (report.sentiment.positive?.length || report.sentiment.negative?.length)) {
    sections.push('### Sentiment signals');
    if (report.sentiment.positive?.length) sections.push(`**Strong positive:**\n${bulletList(report.sentiment.positive, 4)}`);
    if (report.sentiment.negative?.length) sections.push(`**Strong negative:**\n${bulletList(report.sentiment.negative, 4)}`);
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
    extractIdentifiers,
    extractBibliographic,
    extractGeographic,
    extractStatisticalClaims,
    extractAcronyms,
    extractTrends,
    extractCrossReferences,
    extractSentimentSignals,
    acronymMatchesDefinition,
    tryAcronymMatchFromSeed,
    computeContentMetrics,
  },
};
