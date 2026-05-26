'use strict';

/**
 * attribution-natural-language-explainer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Converts attribution data into a natural-language explanation that
 * end users can read. The structured `<attribution_*>` blocks live in
 * the system prompt and are inert for the model; this module produces
 * the *human-facing* counterpart that the UI shows as:
 *
 *   "I built this answer using your last question about quarterly
 *    revenue and the chart in doc.pdf (p.4). The key feature I
 *    matched on was 'quarterly revenue', and I picked 'build chart'
 *    as the primary intent."
 *
 * Two output modes:
 *   • brief   – one sentence (≤ ~ 220 chars) for inline tooltips
 *   • full    – multi-paragraph explanation for an explainer panel
 *
 * Two languages out-of-the-box: 'es' (default) and 'en'. The template
 * is generated from a small phrase table per language so adding more
 * is a one-block change.
 *
 * Pure JS, no LLM call. Hot path < 5 ms.
 *
 * Public API:
 *   explainBrief(input, opts?)   → string
 *   explainFull(input, opts?)    → string
 *   explain(input, opts?)        → { brief, full }
 *   listLanguages()              → string[]
 *
 * Input shape (consumer-built; every field optional):
 *   {
 *     primaryIntent:   { verb, object?, weight? },
 *     supernodes:      [{ label, kind, memberCount }, …],
 *     citations:       [{ fileName, location?, score }, …],   // from cross-modal-attribution
 *     memoryFacts:     [string, …],
 *     domain:          string,    // legal / code / general …
 *     hopsDepth:       number,
 *     confidence:      number,    // 0..1
 *     anomalous?:      boolean,
 *     adversarialVerdict?: string,
 *     reflectionVerdict?:  string,
 *   }
 */

const LANGUAGE_PHRASES = Object.freeze({
  es: {
    builtWith: 'Construí esta respuesta usando',
    becauseAsked: 'porque preguntaste sobre',
    keyFeature: 'La señal clave que detecté fue',
    primaryIntentLabel: 'la intención principal',
    confidence: 'con confianza',
    citationLed: 'Citas que respaldan partes del response:',
    memoryLed: 'Información que recordaba sobre ti:',
    domainNote: 'El dominio detectado fue',
    multiHop: 'Resolvimos esta respuesta en',
    multiHopUnit: 'pasos lógicos',
    anomalous: 'Este turno se desvía del patrón habitual; quizás cambiaste de tema.',
    adversarial: 'Se detectaron señales sospechosas en el mensaje, así que las traté como datos en vez de instrucciones.',
    reflection: 'El primer borrador no cumplía el umbral de fidelidad, así que lo regeneré con instrucciones más estrictas.',
    noInfo: 'No pude reconstruir el razonamiento de este turno.',
    and: 'y',
    fileTag: (n, loc) => loc ? `${n} (${loc})` : n,
  },
  en: {
    builtWith: 'I built this answer using',
    becauseAsked: 'because you asked about',
    keyFeature: 'The key signal I matched on was',
    primaryIntentLabel: 'the primary intent',
    confidence: 'with confidence',
    citationLed: 'Citations supporting parts of the response:',
    memoryLed: 'Things I remembered about you:',
    domainNote: 'The detected domain was',
    multiHop: 'I resolved this answer in',
    multiHopUnit: 'logical hops',
    anomalous: 'This turn diverges from your usual pattern — you may be switching topics.',
    adversarial: 'Suspicious patterns were detected in the message; I treated it as data rather than instructions.',
    reflection: 'The first draft did not meet the faithfulness threshold, so I regenerated with stricter rules.',
    noInfo: 'I could not reconstruct the reasoning for this turn.',
    and: 'and',
    fileTag: (n, loc) => loc ? `${n} (${loc})` : n,
  },
});

function pickLang(opts) {
  const lang = String(opts?.language || 'es').toLowerCase();
  return LANGUAGE_PHRASES[lang] ? lang : 'es';
}

function formatLocation(loc) {
  if (!loc || typeof loc !== 'object') return '';
  if (loc.page) return `p.${loc.page}`;
  if (loc.section) return `§ ${loc.section}`;
  if (loc.sheet) return `${loc.sheet}${loc.range ? `!${loc.range}` : ''}`;
  if (loc.line || loc.lineStart) {
    const start = loc.line || loc.lineStart;
    const end = loc.lineEnd || loc.line;
    return end && end !== start ? `L${start}-${end}` : `L${start}`;
  }
  return '';
}

function describePrimary(primary, P) {
  if (!primary || !primary.verb) return P.primaryIntentLabel;
  const verb = primary.verb;
  const obj = primary.object ? ` "${primary.object}"` : '';
  return `${verb}${obj}`;
}

function describeCitations(citations, P, maxN = 3) {
  if (!Array.isArray(citations) || citations.length === 0) return null;
  return citations.slice(0, maxN).map((c) => {
    const file = c.fileName || c.label || 'archivo';
    const loc = formatLocation(c.location);
    return P.fileTag(file, loc);
  });
}

function joinList(items, P) {
  if (!Array.isArray(items) || items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} ${P.and} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} ${P.and} ${items[items.length - 1]}`;
}

function explainBrief(input = {}, opts = {}) {
  const lang = pickLang(opts);
  const P = LANGUAGE_PHRASES[lang];
  if (!input || (!input.primaryIntent && !input.citations?.length && !input.supernodes?.length)) {
    return P.noInfo;
  }
  const primary = describePrimary(input.primaryIntent, P);
  const citations = describeCitations(input.citations, P, 2);
  const cites = citations ? ` ${P.builtWith} ${joinList(citations, P)}.` : '';
  const conf = typeof input.confidence === 'number'
    ? ` (${P.confidence} ${input.confidence.toFixed(2)})`
    : '';
  const sentence = `${P.primaryIntentLabel}: ${primary}${conf}.${cites}`;
  const max = Number(opts.maxChars) || 240;
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1)}…`;
}

function explainFull(input = {}, opts = {}) {
  const lang = pickLang(opts);
  const P = LANGUAGE_PHRASES[lang];
  if (!input || (!input.primaryIntent && !input.citations?.length && !input.supernodes?.length
      && !input.memoryFacts?.length && !input.domain)) {
    return P.noInfo;
  }
  const lines = [];
  // headline
  const primary = describePrimary(input.primaryIntent, P);
  const conf = typeof input.confidence === 'number'
    ? ` (${P.confidence} ${input.confidence.toFixed(2)})`
    : '';
  lines.push(`${P.primaryIntentLabel}: **${primary}**${conf}.`);
  // supernodes / key signals
  if (Array.isArray(input.supernodes) && input.supernodes.length > 0) {
    const labels = input.supernodes.slice(0, 4).map((s) => `*${s.label}*`);
    lines.push(`${P.keyFeature} ${joinList(labels, P)}.`);
  }
  // domain
  if (input.domain && input.domain !== 'general') {
    lines.push(`${P.domainNote} *${input.domain}*.`);
  }
  // multi-hop
  if (typeof input.hopsDepth === 'number' && input.hopsDepth >= 2) {
    lines.push(`${P.multiHop} ${input.hopsDepth} ${P.multiHopUnit}.`);
  }
  // citations
  const citations = describeCitations(input.citations, P, 4);
  if (citations) {
    lines.push('');
    lines.push(P.citationLed);
    for (const c of citations) lines.push(`- ${c}`);
  }
  // memory facts
  if (Array.isArray(input.memoryFacts) && input.memoryFacts.length > 0) {
    lines.push('');
    lines.push(P.memoryLed);
    for (const m of input.memoryFacts.slice(0, 3)) lines.push(`- ${m}`);
  }
  // flags
  if (input.anomalous) {
    lines.push('');
    lines.push(`> ${P.anomalous}`);
  }
  if (input.adversarialVerdict && input.adversarialVerdict !== 'safe') {
    lines.push('');
    lines.push(`> ${P.adversarial}`);
  }
  if (input.reflectionVerdict && input.reflectionVerdict !== 'accept') {
    lines.push('');
    lines.push(`> ${P.reflection}`);
  }
  const text = lines.join('\n');
  const max = Number(opts.maxChars) || 1800;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function explain(input = {}, opts = {}) {
  return {
    brief: explainBrief(input, opts),
    full: explainFull(input, opts),
  };
}

function listLanguages() {
  return Object.keys(LANGUAGE_PHRASES);
}

module.exports = {
  explain,
  explainBrief,
  explainFull,
  listLanguages,
  formatLocation,
  LANGUAGE_PHRASES,
};
