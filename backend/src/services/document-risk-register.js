'use strict';

/**
 * document-risk-register.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Risk-classified register for attached documents. Different from the
 * deep-analyzer's bucket of "risk sentences": this module classifies
 * each risk into a CATEGORY, scores SEVERITY, and detects whether the
 * source itself proposes a MITIGATION nearby. The chat reads the
 * resulting block to answer "what are the risks?", "which risks are
 * highest severity?", "are mitigations proposed?".
 *
 * Categories (5):
 *   - operational    (people, process, capacity, supply chain, vendor)
 *   - legal          (regulatory, compliance, contractual, IP, sanctions)
 *   - financial      (currency, liquidity, budget, fraud, market)
 *   - technical      (security, outage, data loss, performance, scaling)
 *   - reputational   (brand, customer trust, social, press)
 *
 * Severity is heuristic (none / low / medium / high / critical):
 *   - "critical" / "catastrophic" / "irrecoverable" → critical
 *   - "high" / "significant" / "severe"            → high
 *   - "moderate" / "medium"                        → medium
 *   - "low" / "minor"                              → low
 *   - otherwise inferred from amplifiers (asap, all customers, total)
 *
 * Bilingual. Deterministic. < 20 ms on 1 MB.
 *
 * Public API:
 *   extractRiskRegister(text, opts)           → RegisterReport
 *   buildRegisterForFiles(files)              → { perFile, aggregate }
 *   renderRegisterBlock(batchReport)          → markdown string
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_RISKS_PER_FILE = 10;
const MAX_AGGREGATE_RISKS = 20;
const MAX_BLOCK_CHARS = 4200;
const MIN_SENTENCE_LEN = 12;
const MAX_SENTENCE_LEN = 280;

const CATEGORY_SIGNALS = [
  {
    label: 'operational',
    patterns: [
      /\b(supply\s+chain|vendor|outage|capacity|staffing|attrition|workflow|bottleneck|inventory|logistics|backlog)\b/i,
      /\b(cadena\s+de\s+suministro|proveedor|capacidad|personal|rotaci[oó]n|cuello\s+de\s+botella|inventario|log[ií]stica|atraso|incumplimiento\s+operativo)\b/i,
    ],
  },
  {
    label: 'legal',
    patterns: [
      /\b(regulator(?:y|s)|compliance|breach|indemnif|liability|gdpr|hipaa|sanctions?|antitrust|copyright|patent|litigation|lawsuit|fine|jurisdiction)\b/i,
      /\b(regulator(?:io|a)|cumplimiento|incumplimiento|indemnizaci[oó]n|responsabilidad|gdpr|sanci[oó]n|antimonopolio|derechos\s+de\s+autor|patente|litigio|demanda|multa|jurisdicci[oó]n)\b/i,
    ],
  },
  {
    label: 'financial',
    patterns: [
      /\b(liquidity|cash\s+flow|fx|currency|hedge|fraud|default|covenant|budget\s+(?:over|shortfall)|cost\s+overrun|tariff|inflation)\b/i,
      /\b(liquidez|flujo\s+de\s+caja|tipo\s+de\s+cambio|moneda|fraude|impago|incumplimiento\s+financiero|sobrecosto|tarifa|inflaci[oó]n)\b/i,
    ],
  },
  {
    label: 'technical',
    patterns: [
      /\b(security|vulnerability|breach|outage|downtime|data\s+loss|backup|scaling|latency|performance|incident|cve|patch|sla|sev[- ]?1)\b/i,
      /\b(seguridad|vulnerabilidad|brecha|caida|p[eé]rdida\s+de\s+datos|respaldo|escalado|rendimiento|incidente|parche|sla|criticidad\s+alta)\b/i,
    ],
  },
  {
    label: 'reputational',
    patterns: [
      /\b(brand|reputation|press|public\s+(?:opinion|relations)|backlash|social\s+media|customer\s+trust|customer\s+confidence|PR\s+crisis)\b/i,
      /\b(marca|reputaci[oó]n|prensa|opini[oó]n\s+p[uú]blica|relaciones\s+p[uú]blicas|reacci[oó]n\s+social|confianza\s+del\s+cliente|crisis\s+de\s+pr)\b/i,
    ],
  },
];

const SEVERITY_KEYWORDS = [
  { score: 'critical', re: /\b(critical|catastrophic|catastrophe|irrecoverable|cr[ií]tico|catastr[oó]fico|irrecuperable|p0|sev[-\s]?1)\b/i },
  { score: 'high',     re: /\b(high|significant|severe|major|elevated|alto|elevad[oa]|considerable|severo|grav(?:e|ísim[oa]))\b/i },
  { score: 'medium',   re: /\b(moderate|medium|m[oó]derado|medio|notable)\b/i },
  { score: 'low',      re: /\b(low|minor|negligible|bajo|menor|despreciable)\b/i },
];

const RISK_TRIGGERS = [
  /\b(risk|threat|hazard|exposure|vulnerab(?:le|ility|ilities)|concern|liab(?:le|ility|ilities)|fail(?:ure)?|may\s+(?:fail|crash|leak)|outage|breach|loss)\b/i,
  /\b(riesgo|amenaza|peligro|exposici[oó]n|vulnerab(?:le|ilidad|ilidades)|preocupaci[oó]n|responsabilidad|fall[aoí]|c[ae]ida|brecha|p[eé]rdida)\b/i,
];

const MITIGATION_TRIGGERS = [
  /\b(mitigat(?:e|ion)|plan|contingen(?:cy|t)|safeguard|control(?:s)?|monitor(?:ing)?|backup|insurance|hedge|playbook|runbook|escalation)\b/i,
  /\b(mitigar|mitigaci[oó]n|plan|contingencia|salvaguarda|control(?:es)?|monitoreo|respaldo|seguro|cobertura|playbook|runbook|escalamiento|escalamiento|plan\s+de\s+continuidad)\b/i,
];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function clip(text, max = MAX_SENTENCE_LEN) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?。！？])\s+(?=[A-ZÁÉÍÓÚÑ\d"'¿¡(])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SENTENCE_LEN);
}

function classifyCategory(sentence) {
  let best = null;
  let bestHits = 0;
  for (const sig of CATEGORY_SIGNALS) {
    let hits = 0;
    for (const re of sig.patterns) {
      // Count every keyword match — categories often share a token
      // (e.g. "outage" is both operational and technical), so we need
      // per-match counting to let the richer category win.
      const gFlag = re.flags.includes('g') ? re.flags : `${re.flags}g`;
      const global = new RegExp(re.source, gFlag);
      hits += Array.from(sentence.matchAll(global)).length;
    }
    if (hits > bestHits) {
      bestHits = hits;
      best = sig.label;
    }
  }
  return best || 'operational';
}

function classifySeverity(sentence) {
  for (const sev of SEVERITY_KEYWORDS) {
    if (sev.re.test(sentence)) return sev.score;
  }
  // Light amplifier inference
  if (/\b(all\s+customers?|every\s+user|totalmente|todos?\s+(?:los\s+)?(?:clientes?|usuarios?)|toda\s+la\s+(?:plataforma|infraestructura)|sin\s+excepci[oó]n)\b/i.test(sentence)) {
    return 'high';
  }
  return 'medium';
}

function hasMitigation(sentence, neighbour) {
  for (const re of MITIGATION_TRIGGERS) {
    if (re.test(sentence) || (neighbour && re.test(neighbour))) return true;
  }
  return false;
}

function isRiskSentence(sentence) {
  return RISK_TRIGGERS.some((re) => re.test(sentence));
}

function extractRiskRegister(input) {
  const text = safeText(input);
  if (!text) return { risks: [], totals: { critical: 0, high: 0, medium: 0, low: 0 }, total: 0 };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const risks = [];
  const seen = new Set();
  for (let i = 0; i < sentences.length; i++) {
    if (risks.length >= MAX_RISKS_PER_FILE) break;
    const s = sentences[i];
    if (!isRiskSentence(s)) continue;
    const sentence = clip(s);
    const key = sentence.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    const category = classifyCategory(s);
    const severity = classifySeverity(s);
    const mitigation = hasMitigation(s, sentences[i + 1] || sentences[i - 1] || '');
    risks.push({ sentence, category, severity, mitigation });
  }
  const totals = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const r of risks) totals[r.severity] = (totals[r.severity] || 0) + 1;
  return { risks, totals, total: risks.length };
}

function severityRank(severity) {
  switch (severity) {
    case 'critical': return 0;
    case 'high':     return 1;
    case 'medium':   return 2;
    case 'low':      return 3;
    default:         return 4;
  }
}

function buildRegisterForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractRiskRegister(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate = aggregate.concat(r.risks.map((risk) => ({ ...risk, file: name })));
  }
  aggregate.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  aggregate = aggregate.slice(0, MAX_AGGREGATE_RISKS);
  return { perFile, aggregate };
}

function renderRiskLine(risk, opts = {}) {
  const tag = `${risk.severity.toUpperCase()} · ${risk.category}`;
  const mit = risk.mitigation ? ' _(mitigation referenced nearby)_' : '';
  const file = opts.includeFile && risk.file ? ` _(${risk.file})_` : '';
  return `- [**${tag}**]${file} ${risk.sentence}${mit}`;
}

function renderRegisterBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## RISK REGISTER
Risks surfaced across the attached document(s), classified by category (operational / legal / financial / technical / reputational) and severity (critical → low), with a flag when the source itself proposes a mitigation. Use this block to answer "what are the risks?" / "which are highest severity?" without re-scanning the raw text — and quote the source sentence before claiming severity.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    const sorted = [...only.report.risks].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    sections.push(`### File: ${only.file}`);
    for (const r of sorted) sections.push(renderRiskLine(r));
  } else {
    sections.push('### Aggregate risk register (sorted by severity)');
    for (const r of batchReport.aggregate) sections.push(renderRiskLine(r, { includeFile: true }));
    for (const p of batchReport.perFile) {
      const sorted = [...p.report.risks].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
      sections.push(`\n### File: ${p.file}`);
      for (const r of sorted) sections.push(renderRiskLine(r));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...risk register truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractRiskRegister,
  buildRegisterForFiles,
  renderRegisterBlock,
  _internal: {
    splitSentences,
    isRiskSentence,
    classifyCategory,
    classifySeverity,
    hasMitigation,
    severityRank,
    CATEGORY_SIGNALS,
    SEVERITY_KEYWORDS,
    MAX_RISKS_PER_FILE,
  },
};
