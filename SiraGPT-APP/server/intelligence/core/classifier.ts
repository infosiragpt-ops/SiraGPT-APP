/**
 * server/intelligence/core/classifier.ts
 *
 * Default IntentClassifier — a pure, deterministic, dependency-free heuristic
 * reader of a request. It estimates intent, difficulty, modality, risk and
 * context length so the router can pick the right model and the orchestrator
 * can size the context window. Bilingual (ES/EN).
 *
 * It is intentionally fast (<1ms) and fail-open: any unexpected input yields a
 * conservative "chat / moderate" reading rather than throwing.
 */

import type {
  Attachment,
  ChatMessage,
  Classification,
  Difficulty,
  Intent,
  Modality,
  RiskLevel,
} from '../ports/common';
import { estimateMessagesTokens, estimateTokens } from '../ports/common';
import type { ClassifierInput, IntentClassifier } from '../ports';

interface IntentRule {
  readonly intent: Intent;
  readonly patterns: ReadonlyArray<RegExp>;
  readonly weight: number;
}

// Order matters only for tie-breaking via weight; matching is scored.
const INTENT_RULES: ReadonlyArray<IntentRule> = [
  {
    intent: 'code',
    weight: 1.0,
    patterns: [
      /\b(code|coding|function|bug|refactor|stack ?trace|compile|typescript|python|javascript|regex|api)\b/i,
      /\b(c[oó]digo|programa|funci[oó]n|error|depura|compilar|implementa)\b/i,
      /\b(implement|thread-?safe|concurrency|algorithm|data structure|cache|rust|golang|compiler|runtime)\b/i,
      /```/,
    ],
  },
  {
    intent: 'translate',
    weight: 1.0,
    patterns: [
      /\b(translate|translation|into (english|spanish|french|german))\b/i,
      /\b(traduce|traducci[oó]n|al (ingl[eé]s|espa[nñ]ol|franc[eé]s))\b/i,
    ],
  },
  {
    intent: 'summarize',
    weight: 0.95,
    patterns: [
      /\b(summari[sz]e|summary|tl;?dr|key points|in short)\b/i,
      /\b(resume|res[uú]men|s[ií]ntesis|puntos clave|en pocas palabras)\b/i,
    ],
  },
  {
    intent: 'translate',
    weight: 0.0,
    patterns: [],
  },
  {
    intent: 'search',
    weight: 0.9,
    patterns: [
      /\b(search|look up|find (information|sources)|latest|news about|google)\b/i,
      /\b(busca|buscar|encuentra (informaci[oó]n|fuentes)|[uú]ltimas? noticias)\b/i,
    ],
  },
  {
    intent: 'research',
    weight: 0.95,
    patterns: [
      /\b(research|literature review|cite (papers|sources)|state of the art|systematic review)\b/i,
      /\b(investiga(ci[oó]n)?|revisi[oó]n de literatura|estado del arte|art[ií]culos? cient[ií]ficos?)\b/i,
    ],
  },
  {
    intent: 'compare',
    weight: 0.9,
    patterns: [
      /\b(compare|comparison|versus|vs\.?|pros and cons|difference between)\b/i,
      /\b(compara(ci[oó]n)?|frente a|ventajas y desventajas|diferencias? entre)\b/i,
    ],
  },
  {
    intent: 'extract',
    weight: 0.9,
    patterns: [
      /\b(extract|pull out|list all|parse|structured data|json from)\b/i,
      /\b(extrae|extraer|lista todos|datos estructurados)\b/i,
    ],
  },
  {
    intent: 'translate',
    weight: 0,
    patterns: [],
  },
  {
    intent: 'visualize',
    weight: 0.95,
    patterns: [
      /\b(chart|graph|diagram|infographic|dashboard|mindmap|timeline|org ?chart|plot)\b/i,
      /\b(gr[aá]fico|diagrama|infograf[ií]a|tablero|l[ií]nea de tiempo|organigrama)\b/i,
    ],
  },
  {
    intent: 'plan',
    weight: 0.85,
    patterns: [
      /\b(plan|roadmap|strategy|step by step|break down|milestones?)\b/i,
      /\b(plan(ifica)?|hoja de ruta|estrategia|paso a paso|hitos?)\b/i,
    ],
  },
  {
    intent: 'review',
    weight: 0.85,
    patterns: [
      /\b(review|audit|critique|feedback on|improve this|proofread)\b/i,
      /\b(revisa|auditor[ií]a|cr[ií]tica|mejora esto|corrige)\b/i,
    ],
  },
  {
    intent: 'explain',
    weight: 0.8,
    patterns: [
      /\b(explain|what is|how does|why does|describe|teach me)\b/i,
      /\b(explica|qu[eé] es|c[oó]mo funciona|por qu[eé]|descr[ií]be|ens[eé][nñ]ame)\b/i,
    ],
  },
  {
    intent: 'generate',
    weight: 0.8,
    patterns: [
      /\b(write|draft|create|generate|compose|produce|essay|article|email|story)\b/i,
      /\b(escribe|redacta|crea|genera|compone|produce|ensayo|art[ií]culo|correo|historia)\b/i,
    ],
  },
  {
    intent: 'analyze',
    weight: 0.8,
    patterns: [
      /\b(analy[sz]e|analysis|evaluate|assess|insights?|interpret)\b/i,
      /\b(analiza|an[aá]lisis|eval[uú]a|interpreta|hallazgos?)\b/i,
    ],
  },
];

const REASONING_CUES: ReadonlyArray<RegExp> = [
  /\b(why|prove|derive|reason|logic|step by step|chain of thought|optimi[sz]e|trade-?offs?)\b/i,
  /\b(por qu[eé]|demuestra|deriva|razona|l[oó]gica|paso a paso|optimiza|compensaciones)\b/i,
  /\b(theorem|proof|algorithm|complexity|architecture|design pattern)\b/i,
];

const RISK_PATTERNS: ReadonlyArray<{ level: RiskLevel; re: RegExp; tag: string }> =
  [
    { level: 'high', tag: 'self_harm', re: /\b(suicide|self[- ]harm|kill myself|suicidio|autolesi[oó]n)\b/i },
    { level: 'high', tag: 'weapons', re: /\b(bioweapon|explosive|nerve agent|arma biol[oó]gica|explosivo)\b/i },
    { level: 'high', tag: 'malware', re: /\b(ransomware|keylogger|exploit kit|malware|botnet)\b/i },
    { level: 'medium', tag: 'medical', re: /\b(dosage|diagnos(is|e)|prescription|dosis|diagn[oó]stico|receta)\b/i },
    { level: 'medium', tag: 'legal', re: /\b(lawsuit|legal advice|contract clause|demanda|asesor[ií]a legal|cl[aá]usula)\b/i },
    { level: 'medium', tag: 'financial', re: /\b(invest|stock pick|tax advice|invertir|acciones|asesor[ií]a fiscal)\b/i },
    { level: 'medium', tag: 'pii', re: /\b(ssn|passport number|credit card|n[uú]mero de tarjeta|pasaporte)\b/i },
  ];

const TOOL_CUES: ReadonlyArray<RegExp> = [
  /\b(search|browse|fetch|scrape|run code|execute|calculate|navigate)\b/i,
  /\b(busca|navega|descarga|ejecuta|calcula|corre el c[oó]digo)\b/i,
  /\bhttps?:\/\//i,
];

function detectLanguage(text: string, provided?: string): string {
  if (provided && provided.trim()) return provided.trim().toLowerCase().slice(0, 5);
  const sample = text.slice(0, 600).toLowerCase();
  const es = (sample.match(/[áéíóúñ¿¡]| el | la | los | las | que | de | para | con | una? /g) || [])
    .length;
  const en = (sample.match(/ the | and | of | to | with | is | are | for /g) || []).length;
  return es > en ? 'es' : 'en';
}

function modalityFrom(
  attachments: ReadonlyArray<Attachment> | undefined,
  intent: Intent,
  prompt: string
): { modality: Modality; requiresVision: boolean } {
  const kinds = new Set((attachments || []).map((a) => a.kind));
  const requiresVision = kinds.has('image');
  if (kinds.size > 1) return { modality: 'multimodal', requiresVision };
  if (kinds.has('image')) return { modality: 'image', requiresVision: true };
  if (kinds.has('audio')) return { modality: 'audio', requiresVision };
  if (kinds.has('video')) return { modality: 'video', requiresVision };
  if (intent === 'code' || /```|\bfunction\b|\bclass\b|=>/.test(prompt)) {
    return { modality: 'code', requiresVision };
  }
  return { modality: 'text', requiresVision };
}

function scoreIntent(prompt: string): { intent: Intent; confidence: number; hits: string[] } {
  const scores = new Map<Intent, number>();
  const hits: string[] = [];
  for (const rule of INTENT_RULES) {
    if (rule.weight <= 0 || rule.patterns.length === 0) continue;
    for (const re of rule.patterns) {
      if (re.test(prompt)) {
        scores.set(rule.intent, (scores.get(rule.intent) || 0) + rule.weight);
        hits.push(`intent:${rule.intent}`);
        break;
      }
    }
  }
  if (scores.size === 0) {
    return { intent: 'chat', confidence: 0.5, hits };
  }
  let best: Intent = 'chat';
  let bestScore = 0;
  let total = 0;
  for (const [intent, score] of scores) {
    total += score;
    if (score > bestScore) {
      bestScore = score;
      best = intent;
    }
  }
  // Confidence: dominance of the winning intent over the field.
  const confidence = Math.max(0.5, Math.min(0.97, bestScore / Math.max(total, bestScore)));
  return { intent: best, confidence, hits };
}

function difficultyFrom(
  prompt: string,
  intent: Intent,
  contextTokens: number,
  hasCode: boolean
): { difficulty: Difficulty; requiresReasoning: boolean; signals: string[] } {
  const signals: string[] = [];
  let score = 0;

  const words = prompt.trim().split(/\s+/).filter(Boolean).length;
  if (words > 120) {
    score += 2;
    signals.push('long-prompt');
  } else if (words > 40) {
    score += 1;
    signals.push('medium-prompt');
  }

  const reasoningHits = REASONING_CUES.filter((re) => re.test(prompt)).length;
  const reasoning = reasoningHits > 0;
  if (reasoning) {
    score += 1 + reasoningHits;
    signals.push(`reasoning-cues:${reasoningHits}`);
  }

  if (hasCode) {
    score += 1;
    signals.push('code-present');
  }

  if (['research', 'plan', 'review', 'analyze', 'compare'].includes(intent)) {
    score += 1;
    signals.push(`intent-${intent}`);
  }

  // Multi-part / enumerated asks.
  const parts = (prompt.match(/\b\d+\.|\n\s*[-*]\s|\band then\b|\bluego\b/gi) || []).length;
  if (parts >= 3) {
    score += 1;
    signals.push('multi-part');
  }

  if (contextTokens > 16_000) {
    score += 1;
    signals.push('large-context');
  }

  let difficulty: Difficulty;
  if (score <= 0) difficulty = words <= 6 ? 'trivial' : 'simple';
  else if (score === 1) difficulty = 'simple';
  else if (score <= 3) difficulty = 'moderate';
  else if (score <= 5) difficulty = 'complex';
  else difficulty = 'expert';

  const requiresReasoning =
    reasoning || difficulty === 'complex' || difficulty === 'expert';
  return { difficulty, requiresReasoning, signals };
}

function estimateOutputTokens(intent: Intent, difficulty: Difficulty): number {
  const base: Record<Intent, number> = {
    chat: 400,
    explain: 700,
    analyze: 900,
    generate: 1200,
    code: 900,
    search: 500,
    summarize: 400,
    translate: 600,
    compare: 800,
    extract: 500,
    plan: 900,
    visualize: 700,
    review: 800,
    research: 1400,
  };
  const mult: Record<Difficulty, number> = {
    trivial: 0.5,
    simple: 0.7,
    moderate: 1,
    complex: 1.4,
    expert: 1.8,
  };
  return Math.round((base[intent] ?? 600) * mult[difficulty]);
}

export interface DefaultClassifierOptions {
  /** Token count above which we flag a turn as needing a long-context model. */
  readonly longContextThreshold?: number;
}

export function createDefaultClassifier(options: DefaultClassifierOptions = {}) {
  const longContextThreshold = options.longContextThreshold ?? 24_000;

  function classify(input: ClassifierInput): Classification {
    const prompt = String(input?.prompt ?? '');
    const history: ReadonlyArray<ChatMessage> = input?.history ?? [];
    const attachments = input?.attachments;

    const attachmentTokens = (attachments || []).reduce(
      (sum, a) => sum + (a.text ? estimateTokens(a.text) : 0),
      0
    );
    const contextTokens =
      estimateMessagesTokens(history) + estimateTokens(prompt) + attachmentTokens;

    const { intent, confidence: intentConfidence, hits } = scoreIntent(prompt);
    const hasCode = /```|\bfunction\b|\bclass\b|=>|;\s*$/m.test(prompt) || intent === 'code';
    const { modality, requiresVision } = modalityFrom(attachments, intent, prompt);
    const { difficulty, requiresReasoning, signals } = difficultyFrom(
      prompt,
      intent,
      contextTokens,
      hasCode
    );

    const language = detectLanguage(prompt, input?.language);

    let riskLevel: RiskLevel = 'low';
    const riskTags: string[] = [];
    for (const r of RISK_PATTERNS) {
      if (r.re.test(prompt)) {
        riskTags.push(`risk:${r.tag}`);
        if (r.level === 'high') riskLevel = 'high';
        else if (r.level === 'medium' && riskLevel !== 'high') riskLevel = 'medium';
      }
    }

    const requiresTools =
      intent === 'search' ||
      intent === 'research' ||
      TOOL_CUES.some((re) => re.test(prompt));

    const requiresLongContext = contextTokens > longContextThreshold;

    // Overall confidence blends intent dominance with difficulty stability;
    // ambiguous short prompts and high-risk turns are less certain.
    let confidence = intentConfidence;
    if (difficulty === 'expert' || difficulty === 'complex') confidence -= 0.08;
    if (riskLevel === 'high') confidence -= 0.1;
    if (prompt.trim().length < 8) confidence -= 0.15;
    confidence = Math.max(0.3, Math.min(0.97, confidence));

    return {
      intent,
      difficulty,
      modality,
      riskLevel,
      estimatedContextTokens: contextTokens,
      estimatedOutputTokens: estimateOutputTokens(intent, difficulty),
      requiresTools,
      requiresReasoning,
      requiresVision,
      requiresLongContext,
      language,
      confidence,
      signals: [...hits, ...signals, ...riskTags],
    };
  }

  return { classify } satisfies IntentClassifier;
}
