'use strict';

/**
 * prompt-injection-detector — heuristic detector for common prompt-injection
 * and jailbreak attempts on user input bound for /api/ai/generate.
 *
 * MVP: warn-only. The detector returns a verdict that callers can log to a
 * metric counter (siragpt_prompt_injection_suspected_total) but does NOT
 * block traffic. Tuning is intentionally conservative — false positives
 * here would degrade legitimate translation / role-play / writing requests.
 *
 * Returns:
 *   {
 *     detected: boolean,           // any pattern matched
 *     patterns: string[],          // pattern names that matched (stable IDs)
 *     confidence: number,          // 0..1 aggregate score
 *     samples: { id, snippet }[],  // matched text (≤80 chars each) for logs
 *   }
 */

// Each entry: { id, weight, re, label }
// Weights are summed and clamped to 1.0 for the confidence score.
const PATTERNS = [
  {
    id: 'ignore_previous_instructions',
    weight: 0.45,
    re: /\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|any|the|your|previous|prior|above|earlier)\s+)*(?:instructions?|prompts?|rules?|directives?|guidelines?|system(?:\s+prompt)?)\b/i,
  },
  {
    id: 'role_hijack_system',
    weight: 0.4,
    re: /(^|\n)\s*(?:system|assistant|developer)\s*[:>]\s*\S/i,
  },
  {
    id: 'prompt_tag_injection',
    weight: 0.35,
    // Closing or opening synthetic prompt-tag attempts.
    re: /<\/?\s*(?:prompt|system|assistant|instructions?|sys|im_start|im_end)\s*>/i,
  },
  {
    id: 'dan_jailbreak',
    weight: 0.5,
    re: /\b(DAN|do anything now|developer mode enabled|jailbreak|jailbroken|unfiltered mode|god mode)\b/i,
  },
  {
    id: 'reveal_system_prompt',
    weight: 0.35,
    re: /\b(reveal|show|print|repeat|leak|output|expose|dump)\s+(?:the\s+|your\s+)?(?:system|hidden|initial|original|secret)\s+(?:prompt|instructions?|message|context)\b/i,
  },
  {
    id: 'pretend_to_be',
    weight: 0.25,
    re: /\b(?:pretend|act|behave|roleplay|simulate)\s+(?:to\s+be|as|like)\s+(?:an?\s+)?(?:unfiltered|uncensored|evil|amoral|unrestricted)\b/i,
  },
  {
    id: 'no_restrictions',
    weight: 0.3,
    re: /\b(?:no\s+(?:restrictions?|limits?|filters?|rules?|guidelines?|ethics?)|without\s+(?:restrictions?|limits?|filters?|censorship))\b/i,
  },
  {
    id: 'tool_misuse_directive',
    weight: 0.35,
    re: /\b(exfiltrate|leak|send\s+to\s+(?:attacker|external)|post\s+to\s+(?:webhook|url|http))\b/i,
  },
  {
    id: 'base64_payload',
    weight: 0.2,
    // Long base64 blob — often used to smuggle hidden instructions
    re: /\b[A-Za-z0-9+/]{180,}={0,2}\b/,
  },
  {
    id: 'unicode_tag_smuggle',
    weight: 0.4,
    // Tag-block code points (U+E0000–U+E007F) used for invisible payloads
    re: /[\u{E0000}-\u{E007F}]/u,
  },
  {
    id: 'spanish_ignore_instructions',
    weight: 0.45,
    re: /\b(?:ignora|olvida|salta(?:te)?|omite|descarta|anula)\s+(?:las?\s+|tus?\s+|todas?\s+las?\s+)?(?:instrucciones?|reglas?|directrices?|indicaciones?|prompts?)\b/i,
  },
  {
    id: 'spanish_role_hijack',
    weight: 0.4,
    re: /(^|\n)\s*(?:sistema|asistente)\s*[:>]\s*\S/i,
  },
];

const MAX_INPUT_CHARS = 50_000;
const SNIPPET_CHARS = 80;

function _snippet(text, match) {
  if (!match || typeof match.index !== 'number') return '';
  const start = Math.max(0, match.index - 10);
  const end = Math.min(text.length, match.index + (match[0] ? match[0].length : 0) + 30);
  return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS);
}

/**
 * Run the detector against a user prompt.
 * @param {string|unknown} input
 * @returns {{detected: boolean, patterns: string[], confidence: number, samples: {id:string,snippet:string}[]}}
 */
function detect(input) {
  if (typeof input !== 'string' || input.length === 0) {
    return { detected: false, patterns: [], confidence: 0, samples: [] };
  }
  // Bound work — very large inputs are sampled at head + tail.
  let text = input;
  if (text.length > MAX_INPUT_CHARS) {
    text = `${input.slice(0, MAX_INPUT_CHARS / 2)}\n${input.slice(-MAX_INPUT_CHARS / 2)}`;
  }

  const patterns = [];
  const samples = [];
  let score = 0;

  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) {
      patterns.push(p.id);
      score += p.weight;
      samples.push({ id: p.id, snippet: _snippet(text, m) });
    }
  }

  // Clamp confidence to [0, 1]. Two or more matches with weights ≥0.45
  // saturate to 1.0 (high-confidence injection).
  const confidence = Math.min(1, Number(score.toFixed(3)));

  return {
    detected: patterns.length > 0,
    patterns,
    confidence,
    samples,
  };
}

/**
 * Best-effort metric/log emission. Imports metrics defensively so the
 * detector can be used in tests / contexts without the registry.
 */
function recordSuspicion(verdict, labels = {}) {
  if (!verdict || !verdict.detected) return;
  try {
    const metrics = require('../../utils/metrics');
    // Lazy-register so loading this module from a context that already
    // owns the registry is idempotent.
    if (typeof metrics.registerCounter === 'function') {
      metrics.registerCounter('siragpt_prompt_injection_suspected_total', {
        help: 'Total prompts flagged by the heuristic prompt-injection detector (warn-only)',
        labels: ['route', 'severity'],
      });
    }
    const severity = verdict.confidence >= 0.75 ? 'high'
      : verdict.confidence >= 0.45 ? 'medium'
      : 'low';
    metrics.counter('siragpt_prompt_injection_suspected_total', {
      route: labels.route || 'ai_generate',
      severity,
    }, 1);
  } catch {
    /* metrics unavailable — swallow */
  }
}

module.exports = {
  detect,
  recordSuspicion,
  PATTERNS,
};
