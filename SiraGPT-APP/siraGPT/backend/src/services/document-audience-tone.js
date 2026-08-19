'use strict';

/**
 * document-audience-tone.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Two-axis classifier for the rhetorical posture of an attached document:
 *
 *   audience  — who the writer is writing TO
 *               (executive | legal | technical | academic | marketing |
 *                customer-support | clinical | general)
 *
 *   tone      — HOW the writer is writing
 *               (formal | persuasive | instructional | analytical |
 *                conversational | urgent | neutral)
 *
 * The chat layer reads the resulting block so the model mirrors the
 * source's register instead of defaulting to its own house style. The
 * block also flags mismatches across multi-file uploads ("the contract
 * is formal-legal, the email is conversational-customer-support — keep
 * them separate in your answer").
 *
 * Detection coverage (deterministic, no LLM, < 15 ms on a 1 MB doc):
 *
 *   - Lexical anchors per audience  (technical keywords, legalese,
 *     academic citation styles, marketing CTAs, support ticket cues).
 *   - Sentence-level features for tone (modal verbs for persuasive /
 *     instructional, hedging for analytical, exclamation density and
 *     deadline triggers for urgent, contraction ratio for
 *     conversational).
 *   - Bilingual (Spanish / English) keyword sets.
 *
 * Confidence is the share of total weight captured by the winning
 * label (0..1). Falls back to "general" / "neutral" when no axis
 * accumulates enough signal.
 *
 * Public API:
 *   classifyDocument(text, opts)            → { audience, tone, …}
 *   buildAudienceToneForFiles(files, opts)  → { perFile, aggregate }
 *   renderAudienceToneBlock(batchReport)    → markdown string ('' when empty)
 */

const SCAN_HEAD_BYTES = 60_000;
const MIN_CONFIDENCE = 0.18;
const MAX_BLOCK_CHARS = 3200;

const AUDIENCE_SIGNALS = [
  {
    label: 'executive',
    weight: 1.0,
    patterns: [
      /\b(KPI|OKR|ROI|stakeholder|shareholder|board|fiscal|EBITDA|gross\s+margin|q[1-4]\s+202\d|forecast|runway|burn rate|north star)\b/i,
      /\b(directorio|consejo|stakeholders?|m[aá]rgenes?|ingresos|presupuesto|proyecci[oó]n|hoja\s+de\s+ruta|cuota\s+de\s+mercado)\b/i,
      /\bexecutive\s+summary\b/i,
      /\bresumen\s+ejecutivo\b/i,
    ],
  },
  {
    label: 'legal',
    weight: 1.1,
    patterns: [
      /\b(hereby|herein|hereinafter|whereas|notwithstanding|jurisdiction|indemnif(?:y|ies|ied|ication)|liability|liabilit(?:y|ies)|breach|covenants?|warrant(?:y|ies)|representation\s+and\s+warranty|force\s+majeure)\b/i,
      /\b(estipulado|conforme|en\s+lo\s+sucesivo|por\s+cuanto|no\s+obstante|jurisdicci[oó]n|indemnizaci[oó]n|responsabilidad\s+solidaria|fuerza\s+mayor)\b/i,
      /\bsection\s+\d+(\.\d+)?\b/i,
      /\bcl[áa]usula\s+(?:\w+\s+){0,3}\d+/i,
    ],
  },
  {
    label: 'technical',
    weight: 1.0,
    patterns: [
      /\b(API|SDK|HTTP|JSON|YAML|gRPC|Kubernetes|Docker|stack\s+trace|exception|null\s+pointer|race\s+condition|backpressure|throughput|latency|p99|tcp|tls|oauth|jwt)\b/i,
      /\b(despliegue|infraestructura|microservicio|contenedor|escalado|servidor|endpoint|consulta\s+sql|excepci[oó]n)\b/i,
      /```[\s\S]+?```/,
      /\b(?:[a-z][a-zA-Z0-9_]*\(\)|function\s+\w+\(|class\s+\w+|def\s+\w+\(|import\s+\w+|require\(['"])/,
    ],
  },
  {
    label: 'academic',
    weight: 1.0,
    patterns: [
      /\b(hypothesis|methodology|literature\s+review|et\s+al\.|p\s?<\s?0\.0?5|confidence\s+interval|systematic\s+review|meta[- ]analysis|peer[- ]review|abstract\s*:|references)\b/i,
      /\b(hip[oó]tesis|metodolog[ií]a|revisi[oó]n\s+de\s+literatura|et\s+al\.|intervalo\s+de\s+confianza|revisi[oó]n\s+sistem[áa]tica|meta\s+an[áa]lisis|revisi[oó]n\s+por\s+pares|resumen\s*:|referencias?)\b/i,
      /\(\s*[A-Z][A-Za-z]+(?:\s+(?:y|and|&)\s+[A-Z][A-Za-z]+)?\s*,?\s*(?:19|20)\d{2}[a-z]?\s*\)/,
      /\[\d{1,3}\](?:\s|,|\.|$)/,
    ],
  },
  {
    label: 'marketing',
    weight: 0.95,
    patterns: [
      /\b(unlock|empower|elevate|transform\s+your|join\s+(?:us|now|today)|limited[- ]time|sign\s+up|click\s+(?:here|now)|game[- ]changer|breakthrough|world[- ]class)\b/i,
      /\b(descubre|aprovecha|empieza\s+ya|reg[ií]strate|s[úu]mate|aprovecha\s+ahora|imperdible|incre[ií]ble|el\s+(?:mejor|m[áa]s\s+innovador))\b/i,
      /\b(?:CTA|llamada\s+a\s+la\s+acci[oó]n)\b/i,
      /[!¡]{1,3}\s/,
    ],
  },
  {
    label: 'customer-support',
    weight: 0.9,
    patterns: [
      /\b(ticket\s+(?:#|number)|case\s+id|reproduce|workaround|escalate|please\s+(?:try|check|confirm)|customer\s+reported|sla|response\s+time)\b/i,
      /\b(ticket\s+#|caso\s+(?:n[uú]mero|id)|reproducir|paliativo|soluci[oó]n\s+temporal|escalar|por\s+favor\s+(?:intenta|verifica|confirma)|reportad[oa]\s+por\s+el\s+cliente|tiempo\s+de\s+respuesta)\b/i,
    ],
  },
  {
    label: 'clinical',
    weight: 1.05,
    patterns: [
      /\b(diagnos(?:is|tic)|prognosis|patient|symptom|dosage|mg|mL|treatment\s+plan|adverse\s+event|contraindication|posology|pediatric|geriatric)\b/i,
      /\b(diagn[oó]stico|pron[oó]stico|paciente|s[ií]ntoma|dosis|tratamiento|evento\s+adverso|contraindicaci[oó]n|posolog[ií]a|pedi[áa]trico|geri[áa]trico)\b/i,
    ],
  },
];

const TONE_SIGNALS = [
  {
    label: 'formal',
    weight: 1.0,
    patterns: [
      /\b(hereby|herein|notwithstanding|pursuant\s+to|in\s+accordance\s+with|whereas|aforementioned)\b/i,
      /\b(estipulado|conforme\s+a|no\s+obstante|de\s+acuerdo\s+(?:con|a)|por\s+cuanto|antes\s+mencionado)\b/i,
      /\b(sirva\s+la\s+presente|tengo\s+el\s+honor|por\s+medio\s+de\s+la\s+presente)\b/i,
    ],
  },
  {
    label: 'persuasive',
    weight: 0.95,
    patterns: [
      /\b(must|should|imperative|crucial|critical(?:ly)?|essential|undoubtedly|clearly|without\s+a\s+doubt|game[- ]changer)\b/i,
      /\b(debe(?:mos)?|hay\s+que|imperativo|crucial|cr[íi]tico|esencial|sin\s+duda|claramente|sin\s+lugar\s+a\s+dudas)\b/i,
      /[!¡]{1,3}/,
    ],
  },
  {
    label: 'instructional',
    weight: 0.95,
    patterns: [
      /\b(step\s+\d|first[,\s]+next[,\s]+|then[,\s]+finally|follow\s+(?:the|these)\s+(?:steps|instructions)|click|select|tap|press|run\s+the\s+(?:command|script))\b/i,
      /\b(paso\s+\d|primero[,\s]+luego[,\s]+|finalmente|sigue\s+(?:los|estos)\s+pasos|haz\s+clic|selecciona|pulsa|presiona|ejecuta\s+el\s+(?:comando|script))\b/i,
      /^(\s*\d+\.\s+|\s*\*\s+|\s*-\s+)/m,
    ],
  },
  {
    label: 'analytical',
    weight: 1.0,
    patterns: [
      /\b(however|moreover|nevertheless|furthermore|in\s+contrast|on\s+the\s+other\s+hand|consequently|therefore|thus|as\s+a\s+result|in\s+light\s+of|based\s+on\s+(?:the\s+)?(?:data|evidence|results))\b/i,
      /\b(sin\s+embargo|adem[áa]s|no\s+obstante|por\s+otro\s+lado|en\s+contraste|por\s+lo\s+tanto|en\s+consecuencia|por\s+ello|seg[úu]n\s+(?:los\s+)?(?:datos|resultados|evidencia))\b/i,
      /\b(suggest|indicate|imply|may|might|could|appear\s+to)\b/i,
    ],
  },
  {
    label: 'conversational',
    weight: 0.9,
    patterns: [
      /\b(I'm|you're|we're|it's|don't|can't|won't|let's|gonna|wanna)\b/i,
      /\b(¿|qu[ée]\s+tal|c[oó]mo\s+(?:est[áa]s|van)|oye|mira|sabes\s+qu[ée]|pues|bueno|venga)\b/i,
      /\b(hi|hello|hey|hola|saludos|qu[ée]\s+pasa)\b/i,
    ],
  },
  {
    label: 'urgent',
    weight: 1.0,
    patterns: [
      /\b(urgent|asap|immediately|right\s+away|deadline|due\s+by|by\s+end\s+of|critical|p0|sev[- ]?1|emergency)\b/i,
      /\b(urgente|cuanto\s+antes|de\s+inmediato|fecha\s+l[ií]mite|vence|cr[ií]tico|emergencia|prioridad\s+m[áa]xima)\b/i,
      /[!¡]{2,}/,
    ],
  },
];

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

function countMatches(text, patterns) {
  let total = 0;
  for (const re of patterns) {
    for (const _m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
      total++;
      if (total >= 20) return total; // cap per pattern set
    }
  }
  return total;
}

function scoreAxis(text, signals) {
  const tally = signals.map((s) => {
    const hits = countMatches(text, s.patterns);
    return { label: s.label, score: hits * s.weight, hits };
  });
  tally.sort((a, b) => b.score - a.score);
  const totalScore = tally.reduce((acc, t) => acc + t.score, 0);
  if (tally.length === 0 || tally[0].score === 0) {
    return { winner: null, confidence: 0, runnerUp: null, totals: tally };
  }
  const confidence = totalScore > 0 ? tally[0].score / totalScore : 0;
  return {
    winner: tally[0].label,
    winnerScore: tally[0].score,
    runnerUp: tally[1]?.score > 0 ? tally[1].label : null,
    runnerUpScore: tally[1]?.score || 0,
    confidence,
    totals: tally,
  };
}

function classifyDocument(input, opts = {}) {
  const text = safeText(input);
  if (!text) {
    return {
      audience: 'general',
      audienceConfidence: 0,
      audienceRunnerUp: null,
      tone: 'neutral',
      toneConfidence: 0,
      toneRunnerUp: null,
      truncated: false,
    };
  }
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const audience = scoreAxis(head, AUDIENCE_SIGNALS);
  const tone = scoreAxis(head, TONE_SIGNALS);
  return {
    audience: audience.confidence >= MIN_CONFIDENCE && audience.winner ? audience.winner : 'general',
    audienceConfidence: Number(audience.confidence.toFixed(3)),
    audienceRunnerUp: audience.runnerUp || null,
    tone: tone.confidence >= MIN_CONFIDENCE && tone.winner ? tone.winner : 'neutral',
    toneConfidence: Number(tone.confidence.toFixed(3)),
    toneRunnerUp: tone.runnerUp || null,
    truncated: text.length > SCAN_HEAD_BYTES,
    opts,
  };
}

function buildAudienceToneForFiles(files, opts = {}) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  for (const f of list) {
    const text = safeText(f.extractedText);
    if (!text) continue;
    const report = classifyDocument(text, opts);
    perFile.push({
      file: f.name || f.originalName || f.id || 'attachment',
      report,
    });
  }
  // Aggregate: detect mismatches across files.
  const audiences = new Set(perFile.map((p) => p.report.audience));
  const tones = new Set(perFile.map((p) => p.report.tone));
  return {
    perFile,
    aggregate: {
      audiences: Array.from(audiences),
      tones: Array.from(tones),
      mixed: audiences.size > 1 || tones.size > 1,
    },
  };
}

function describeAudience(label) {
  switch (label) {
    case 'executive':         return 'C-suite / board / leadership readers — KPI / financial framing, terse, decision-oriented';
    case 'legal':             return 'Counsel / legal team — formal definitional language, clause references, enforceability framing';
    case 'technical':         return 'Engineers / SREs / developers — API / code / infra vocabulary, error semantics, reproducibility';
    case 'academic':          return 'Researchers / faculty / reviewers — citation conventions, hypothesis / methodology / results structure';
    case 'marketing':         return 'Prospective customers / growth audience — benefit-led, CTA-rich, emotionally charged claims';
    case 'customer-support':  return 'Help-desk / customer success staff — ticket / case framing, troubleshooting language, SLA references';
    case 'clinical':          return 'Healthcare professionals — diagnostic / pharmacological vocabulary, dosage references, contraindications';
    default:                  return 'General / mixed audience — no dominant register detected';
  }
}

function describeTone(label) {
  switch (label) {
    case 'formal':            return 'Formal / declarative — full sentences, no contractions, regulatory phrasing';
    case 'persuasive':        return 'Persuasive — modal verbs, strong claims, calls for action';
    case 'instructional':     return 'Instructional — step-by-step structure, imperatives, procedural verbs';
    case 'analytical':        return 'Analytical — hedged claims, contrast/causation connectors, evidence anchoring';
    case 'conversational':    return 'Conversational — contractions, first-person, casual greetings';
    case 'urgent':            return 'Urgent — deadlines, escalation language, dense punctuation';
    default:                  return 'Neutral — no strong tonal signal detected';
  }
}

function renderPerFile(perFile) {
  const lines = [];
  for (const entry of perFile) {
    const r = entry.report;
    const audPart = `audience=${r.audience} (${(r.audienceConfidence * 100).toFixed(0)}%${r.audienceRunnerUp ? `, runner-up: ${r.audienceRunnerUp}` : ''})`;
    const tonePart = `tone=${r.tone} (${(r.toneConfidence * 100).toFixed(0)}%${r.toneRunnerUp ? `, runner-up: ${r.toneRunnerUp}` : ''})`;
    lines.push(`- **${entry.file}** — ${audPart}; ${tonePart}`);
    lines.push(`  - Audience cue: ${describeAudience(r.audience)}`);
    lines.push(`  - Tone cue: ${describeTone(r.tone)}`);
  }
  return lines.join('\n');
}

function renderAudienceToneBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## DOCUMENT AUDIENCE & TONE
Two-axis classification of each attached document. Use the AUDIENCE label to mirror the register the reader expects (executive ≠ academic ≠ support) and the TONE label to mirror HOW the source writes. When multiple documents disagree on these axes, keep their analyses in separate paragraphs so registers don't bleed across files.`;
  const body = renderPerFile(batchReport.perFile);
  const aggregate = batchReport.aggregate;
  let mismatch = '';
  if (aggregate && aggregate.mixed) {
    const audPart = aggregate.audiences.length > 1
      ? `audience mix: ${aggregate.audiences.join(', ')}`
      : '';
    const tonePart = aggregate.tones.length > 1
      ? `tone mix: ${aggregate.tones.join(', ')}`
      : '';
    mismatch = `\n\n_Mixed-register batch detected — ${[audPart, tonePart].filter(Boolean).join('; ')}. Answer each document in its own register; do not assume a single house style._`;
  }
  let combined = `${heading}\n\n${body}${mismatch}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...audience/tone block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  classifyDocument,
  buildAudienceToneForFiles,
  renderAudienceToneBlock,
  _internal: {
    AUDIENCE_SIGNALS,
    TONE_SIGNALS,
    countMatches,
    scoreAxis,
    describeAudience,
    describeTone,
    MIN_CONFIDENCE,
    SCAN_HEAD_BYTES,
  },
};
