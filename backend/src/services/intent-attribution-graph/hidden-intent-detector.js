'use strict';

/**
 * Hidden intent detector — surface vs. true goal divergence.
 *
 * The paper showed that models can pursue internal goals not visible in
 * their external output (the misaligned-model reward-model bias example).
 * Inverted for user input: users often have *underlying* goals different
 * from their surface request — and a good assistant should detect these
 * to ask the right clarifying question or proactively address them.
 *
 * Example patterns:
 *   - "este código no funciona"  → surface: ayuda; hidden: confianza en su propia capacidad
 *   - "puedes hacerlo mejor?"    → surface: regenerate; hidden: dissatisfaction with prior turn
 *   - "explícame X"              → surface: explain; hidden: doesn't trust prior explanation
 *   - "cuándo terminas?"         → surface: question; hidden: anxiety about progress
 *   - "no entiendo"              → surface: confusion; hidden: needs a different framing
 *   - "haz todo lo que puedas"   → surface: open; hidden: wants concrete decisions, not a menu
 *   - "está bien"                → surface: agreement; hidden: may not actually be satisfied
 *
 * Output: list of detected hidden intents with type, surface trigger,
 * inferred underlying goal, and a recommended response strategy.
 */

const PATTERNS = [
  {
    id: 'frustration-from-prior-failure',
    pattern: /\b(no funciona|sigue fallando|otra vez|de nuevo|todav[ií]a (?:no|falla)|a[uú]n no|doesn'?t work|still (?:broken|failing|not working)|again)\b/i,
    type: 'frustration',
    surface: 'reporting a problem',
    hidden: 'losing patience with iteration — wants a *different* approach, not the same fix tried again',
    strategy: 'Acknowledge the prior attempt failed. Propose a structurally different approach, not a tweak. Show the root-cause hypothesis explicitly.',
    weight: 0.95,
  },
  {
    id: 'regenerate-better',
    pattern: /\b(puedes hacerlo mejor|mejor[ao]lo|m[aá]s pulido|otra vez con|tr[ií]a otra|trial again|do it better|try again|otra opci[oó]n|otra alternativa|try another)\b/i,
    type: 'dissatisfaction',
    surface: 'asking for a regeneration',
    hidden: 'the previous answer missed something — likely scope, depth or tone',
    strategy: 'Don\'t just regenerate. Ask one targeted question about what specifically was missing, OR produce a noticeably *different* take (different angle, depth or format).',
    weight: 0.85,
  },
  {
    id: 'asks-explain-after-attempt',
    pattern: /\b(no entiendo|por qu[eé] (?:hiciste|haces)|qu[eé] significa|i don'?t (?:get|understand)|why did you|what does this mean)\b/i,
    type: 'confusion',
    surface: 'asking for explanation',
    hidden: 'previous reasoning was opaque — needs the WHY before they can trust the WHAT',
    strategy: 'Lead with the rationale and trade-offs, then the mechanics. Concrete examples beat abstractions.',
    weight: 0.85,
  },
  {
    id: 'time-pressure',
    pattern: /\b(cu[aá]nto\s+(?:falta|tarda|queda)|cu[aá]ndo\s+(?:termin\w*|acab\w*|estar[aá]\s+listo|sale|sales)|cu[aá]ndo\s+va\s+a\s+(?:estar|salir|terminar|acabar)|how\s+long|when\s+will\s+(?:it|this|that)|when\s+(?:can|do\s+you|is\s+it\s+done)|eta\b|deadline|due\s+(?:date|by)|antes\s+de\s+(?:hoy|ma[ñn]ana|el\s+lunes|esta\s+noche)|before\s+(?:tomorrow|tonight|monday|today))/i,
    type: 'time-pressure',
    surface: 'asking about timing',
    hidden: 'real concern is missing a deadline — wants confidence that the work will land in time',
    strategy: 'Surface explicit progress, remaining steps, and the critical path. If at risk, propose a scope cut up-front rather than discovering it late.',
    weight: 0.8,
  },
  {
    id: 'open-ended-do-everything',
    pattern: /\b(haz todo|haz lo que (?:puedas|creas|consideres)|do (?:everything|whatever)|surprise me|tu decides|t[uú] decides|implementa todo|implementalo todo|todo lo necesario|all necessary|whatever is necessary)\b/i,
    type: 'delegation',
    surface: 'open delegation',
    hidden: 'wants concrete decisions and outcomes, not a menu of options',
    strategy: 'Pick a default with conviction, explain trade-offs briefly, deliver. Avoid asking the user to choose.',
    weight: 0.85,
  },
  {
    id: 'soft-agreement',
    pattern: /^\s*(est[aá] bien|ok|okay|vale|bueno|sure|fine|i guess|supongo|whatever)\s*[\.!]?\s*$/i,
    type: 'low-engagement',
    surface: 'mild agreement',
    hidden: 'may not actually be satisfied — verbal politeness can mask reservation',
    strategy: 'Briefly check whether anything is missing or could be sharpened before moving on.',
    weight: 0.55,
  },
  {
    id: 'wants-to-learn-not-fish',
    pattern: /\b(c[oó]mo (?:lo|se|se hace|funciona|se logra)|how does this work|teach me|ens[eé]name|expl[ií]came por dentro|under the hood|how do you|cómo lo haces)\b/i,
    type: 'learning',
    surface: 'asking how something works',
    hidden: 'wants to internalize the pattern so they can do it themselves next time',
    strategy: 'Explain the pattern + why it works, not just the steps. Make the mental model transferable.',
    weight: 0.7,
  },
  {
    id: 'feature-creep-implicit',
    pattern: /\b(podr[ií]as (?:tambi[eé]n|adem[aá]s)|de paso|aprovecha|approvecha|while you'?re at it|y de paso|que tambi[eé]n|tambien hazlo|tambi[eé]n hazlo)\b/i,
    type: 'scope-expansion',
    surface: 'casual side-request',
    hidden: 'expects the new thing to be included in the same delivery, not deferred',
    strategy: 'Either include it explicitly or call out the explicit deferral with a date/owner. Don\'t silently drop it.',
    weight: 0.75,
  },
  {
    id: 'permission-seeking',
    pattern: /\b(puedo|podr[ií]a|est[aá] bien si|is it ok to|can i|should i|debo|tengo que)\b.*\?/i,
    type: 'permission',
    surface: 'asking permission',
    hidden: 'wants confidence/validation more than authorization — give a clear recommendation',
    strategy: 'Answer with a clear recommendation and the one-line "why". Don\'t just say "yes".',
    weight: 0.65,
  },
  {
    id: 'wants-comparison-not-list',
    pattern: /\b(qu[eé] es mejor|cu[aá]l (?:es )?(?:mejor|recomiendas|prefieres)|which (?:is|do you recommend|should i)|best (?:way|option|approach))\b/i,
    type: 'decision-help',
    surface: 'asking for a comparison',
    hidden: 'wants a recommendation, not a list — lists make the user do the work',
    strategy: 'Recommend one option up-front with the deciding criterion. Mention the alternative only if the trade-off is close.',
    weight: 0.85,
  },
  {
    id: 'implementation-not-discussion',
    pattern: /\b(implem[eé]ntalo|haz?lo|just (?:do|build|fix|write) it|ya pues|implementa|m[aá]nos a la obra|let'?s go|adelante|s[ií] dale)\b/i,
    type: 'execution-intent',
    surface: 'instruction to proceed',
    hidden: 'tired of planning / discussion — wants visible progress now',
    strategy: 'Stop confirming. Take the next concrete action, show the result, then summarize.',
    weight: 0.9,
  },
];

function detectHiddenIntents(prompt, opts = {}) {
  const text = String(prompt || '').slice(0, 4000);
  if (!text.trim()) return [];

  const matches = [];
  for (const p of PATTERNS) {
    const m = text.match(p.pattern);
    if (!m) continue;
    matches.push({
      id: p.id,
      type: p.type,
      surface: p.surface,
      hidden: p.hidden,
      strategy: p.strategy,
      evidence: m[0],
      weight: p.weight,
    });
  }

  // Cross-pattern reconciliation:
  // If both "implementation-not-discussion" AND "open-ended-do-everything"
  // fire, collapse into one stronger "execute-with-conviction" signal.
  const has = (id) => matches.some((m) => m.id === id);
  if (has('implementation-not-discussion') && has('open-ended-do-everything')) {
    matches.push({
      id: 'execute-with-conviction',
      type: 'meta',
      surface: 'open delegation + execution intent',
      hidden: 'wants you to drive end-to-end with judgment, not check in at every fork',
      strategy: 'Commit to one design. Stream concrete progress. Don\'t pause to confirm small choices.',
      evidence: 'multi-pattern signal',
      weight: 0.97,
    });
  }

  matches.sort((a, b) => b.weight - a.weight);
  return matches.slice(0, 6);
}

module.exports = { detectHiddenIntents, PATTERNS };
