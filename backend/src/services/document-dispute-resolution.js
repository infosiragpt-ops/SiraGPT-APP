'use strict';

/**
 * document-dispute-resolution.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects DISPUTE RESOLUTION mechanisms in attached documents —
 * mediation, arbitration, court forum, ADR escalation ladders, and
 * the seat / venue named for any arbitration. Lets the chat answer
 * "how are disputes handled?" / "where would litigation happen?"
 * with citeable clauses instead of guesses.
 *
 * Detected mechanisms (deterministic, bilingual, < 12 ms on 1 MB):
 *
 *   - arbitration       binding / non-binding / ICC / AAA / JAMS /
 *                       LCIA / SIAC / ICDR references
 *   - mediation         "subject to mediation", "mediación previa"
 *   - litigation        "exclusive jurisdiction of the courts of"
 *   - escalation        good-faith / escalation steps
 *   - waivers           "waive jury trial", "waive class action"
 *
 * Each finding carries its mechanism tag + (when present) the seat
 * (city / forum) + the source sentence.
 *
 * Public API:
 *   extractDisputeResolution(text)        → DisputeReport
 *   buildDisputesForFiles(files)          → { perFile, aggregate }
 *   renderDisputesBlock(report)           → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 12;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4200;
const MIN_SENTENCE_LEN = 14;
const MAX_SENTENCE_LEN = 320;

const MECHANISM_PATTERNS = [
  // Order matters — when a sentence describes an escalation ladder
  // (e.g. "mediation before arbitration"), the FIRST listed mechanism
  // wins. Mediation precedes arbitration to capture pre-arbitration
  // mediation language; litigation precedes both because litigation
  // forums almost never coexist with mediation/arbitration in the
  // same sentence (and when they do, the forum is more diagnostic).
  {
    mechanism: 'waiver',
    patterns: [
      /\b(waive\s+(?:any\s+right\s+to\s+)?(?:jury\s+trial|class[\s-]?action|trial\s+by\s+jury)|jury\s+trial\s+waiver|class[\s-]?action\s+waiver)\b/i,
      /(?:^|[^\p{L}])(renuncia\s+(?:al?\s+)?(?:juicio\s+por\s+jurado|acci[oó]n\s+colectiva))(?=[^\p{L}]|$)/iu,
    ],
  },
  {
    mechanism: 'litigation',
    patterns: [
      /\b(exclusive\s+jurisdiction|subject\s+to\s+the\s+jurisdiction|federal\s+courts?\s+of|state\s+courts?\s+of)\b/i,
      /\bjurisdiction\s+of\s+(?:the\s+|[A-Z])[^.]{0,50}?\bcourts?\b/i,
      /\bcourts?\s+of\s+[A-Z][A-Za-z\s]{2,40}/,
      /(?:^|[^\p{L}])(jurisdicci[oó]n\s+(?:exclusiva\s+)?de\s+los\s+tribunales|sometido\s+a\s+los\s+tribunales|tribunales\s+(?:federales|estatales)\s+de)(?=[^\p{L}]|$)/iu,
    ],
  },
  {
    mechanism: 'escalation',
    patterns: [
      /\b(good[-\s]?faith\s+(?:negotiation|effort|discussion)|escalation\s+(?:process|procedure|ladder)|first\s+(?:attempt|seek)\s+to\s+resolve)\b/i,
      /(?:^|[^\p{L}])(negociaci[oó]n\s+de\s+buena\s+fe|proceso\s+de\s+escalamiento|primer(?:o)?\s+intent(?:o|ar)\s+resolver)(?=[^\p{L}]|$)/iu,
    ],
  },
  {
    mechanism: 'mediation',
    patterns: [
      /\b(mediation|mediator|subject\s+to\s+mediation)\b/i,
      /(?:^|[^\p{L}])(mediaci[oó]n|mediador|sujeto\s+a\s+mediaci[oó]n|mediaci[oó]n\s+previa)(?=[^\p{L}]|$)/iu,
    ],
  },
  {
    mechanism: 'arbitration',
    patterns: [
      /\b(arbitration|arbitrated|arbitrator|arbitrators|binding\s+arbitration|non[-\s]?binding\s+arbitration|arbitral\s+(?:tribunal|panel)|ICC\s+(?:Rules|arbitration)|AAA\s+arbitration|JAMS\s+arbitration|LCIA|SIAC|ICDR)\b/i,
      /(?:^|[^\p{L}])(arbitraje|arbitrado|árbitro|árbitros|tribunal\s+arbitral|sede\s+arbitral|reglamento\s+(?:CCI|ICC))(?=[^\p{L}]|$)/iu,
    ],
  },
  {
    mechanism: 'escalation',
    patterns: [
      /\b(good[-\s]?faith\s+(?:negotiation|effort|discussion)|escalation\s+(?:process|procedure|ladder)|first\s+(?:attempt|seek)\s+to\s+resolve)\b/i,
      /(?:^|[^\p{L}])(negociaci[oó]n\s+de\s+buena\s+fe|proceso\s+de\s+escalamiento|primer(?:o)?\s+intent(?:o|ar)\s+resolver)(?=[^\p{L}]|$)/iu,
    ],
  },
  {
    mechanism: 'waiver',
    patterns: [
      /\b(waive\s+(?:any\s+right\s+to\s+)?(?:jury\s+trial|class[\s-]?action|trial\s+by\s+jury)|jury\s+trial\s+waiver|class[\s-]?action\s+waiver)\b/i,
      /(?:^|[^\p{L}])(renuncia\s+(?:al?\s+)?(?:juicio\s+por\s+jurado|acci[oó]n\s+colectiva))(?=[^\p{L}]|$)/iu,
    ],
  },
];

const SEAT_PATTERNS = [
  /\b(?:in|at|seat(?:ed)?\s+(?:in|at))\s+(?:the\s+(?:city\s+of\s+)?)?([A-Z][A-Za-zÁÉÍÓÚÑáéíóúñ.\s,-]{2,60}?)(?=[.,;]|\s+(?:before|under|administered|conducted))/i,
  /(?:^|[^\p{L}])(?:en|sede\s+(?:en|de))\s+(?:la\s+(?:ciudad\s+de\s+)?)?([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.\s,-]{2,60}?)(?=[.,;]|\s+(?:ante|conforme|administrad[oa]))/iu,
];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clip(text, max = MAX_SENTENCE_LEN) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?。！？])\s+(?=[A-ZÁÉÍÓÚÑ\d"'¿¡(])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SENTENCE_LEN);
}

function matchesAny(sentence, patterns) {
  for (const re of patterns) if (re.test(sentence)) return true;
  return false;
}

function pickSeat(sentence) {
  for (const re of SEAT_PATTERNS) {
    const m = sentence.match(re);
    if (m && m[1]) {
      const seat = m[1].trim().replace(/[.,;]+$/, '');
      if (seat.length >= 2 && seat.length <= 80) return seat;
    }
  }
  return null;
}

function extractDisputeResolution(input) {
  const text = safeText(input);
  if (!text) return { findings: [], totals: {}, total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const findings = [];
  const totals = {};
  const seen = new Set();
  for (const s of sentences) {
    if (findings.length >= MAX_PER_FILE) break;
    for (const m of MECHANISM_PATTERNS) {
      if (!matchesAny(s, m.patterns)) continue;
      const clipped = clip(s);
      const key = `${m.mechanism}|${clipped.toLowerCase().slice(0, 80)}`;
      if (seen.has(key)) break;
      seen.add(key);
      const seat = m.mechanism === 'arbitration' ? pickSeat(s) : null;
      findings.push({ mechanism: m.mechanism, sentence: clipped, seat });
      totals[m.mechanism] = (totals[m.mechanism] || 0) + 1;
      break; // each sentence tagged with the first mechanism that matches
    }
  }
  return {
    findings,
    totals,
    total: findings.length,
    truncated: text.length > SCAN_HEAD_BYTES,
  };
}

function buildDisputesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractDisputeResolution(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate = aggregate.concat(r.findings.map((x) => ({ ...x, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderFindingLine(f, opts = {}) {
  const tag = f.mechanism.toUpperCase();
  const seat = f.seat ? ` _(seat: ${f.seat})_` : '';
  const file = opts.includeFile && f.file ? ` _(${f.file})_` : '';
  return `- [**${tag}**]${file} ${f.sentence}${seat}`;
}

function renderDisputesBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## DISPUTE RESOLUTION
Dispute-resolution clauses surfaced from the attached document(s), tagged by mechanism (arbitration / mediation / litigation / escalation / waiver) and any named seat / forum. Use this block to answer "how are disputes handled?" / "where would litigation happen?" — quote the source sentence before claiming a forum is firm.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const f of only.report.findings) sections.push(renderFindingLine(f));
  } else {
    sections.push('### Aggregate dispute-resolution clauses');
    for (const f of batchReport.aggregate) sections.push(renderFindingLine(f, { includeFile: true }));
    for (const p of batchReport.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const f of p.report.findings) sections.push(renderFindingLine(f));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...dispute resolution block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractDisputeResolution,
  buildDisputesForFiles,
  renderDisputesBlock,
  _internal: {
    splitSentences,
    matchesAny,
    pickSeat,
    MECHANISM_PATTERNS,
    SEAT_PATTERNS,
  },
};
