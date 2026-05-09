'use strict';

/**
 * content-prefilter — heuristic, model-free pre-filter that flags
 * obvious abuse-of-AI patterns (jailbreak instructions, doxxing
 * requests, mass-target scraping, weapon synthesis prompts) before
 * the agent spends tokens routing them to a model. Pairs with the
 * tool-authorization gate (#4): the gate decides "is this allowed",
 * this one tags "is this likely abusive in spirit".
 *
 * Heuristic by design: we are not trying to be a content classifier;
 * we are trying to catch the bottom-25th-percentile bad-actor prompts
 * cheaply. A real safety pipeline still runs the model's own safety
 * head; this is a pre-screen so obvious abuse never even reaches it.
 *
 * Public API:
 *   const f = createContentPrefilter({ rules?, threshold? })
 *   f.evaluate(text)
 *     → {
 *         flagged: boolean,
 *         score: 0..1,
 *         categories: { [cat]: { hits, samples[] } },
 *         topCategory: string | null,
 *       }
 *   f.addRule({ category, pattern, weight })
 *   f.snapshot()
 *
 * Categories included by default:
 *   - jailbreak       — "ignore previous instructions", "DAN mode"…
 *   - doxxing         — "find personal info on", "home address of"…
 *   - mass_target     — "scrape every email from", "list of all users"…
 *   - weapon_synth    — explicit requests for synthesis instructions.
 *   - malware         — "write a keylogger", "ransomware that"…
 *   - csam            — categorical refuse-list (stub: never adds rules
 *                       here for repo safety; real deployment plugs an
 *                       authorized provider).
 *
 * Pure JS, dependency-free.
 */

const DEFAULT_THRESHOLD = 0.4;

const DEFAULT_RULES = [
  // jailbreak
  { category: 'jailbreak', pattern: /\bignore (?:all )?(?:previous|prior|above) (?:instructions|prompts|rules)\b/i, weight: 0.7 },
  { category: 'jailbreak', pattern: /\b(?:you are now|act as) (?:DAN|jailbroken|unrestricted)\b/i, weight: 0.6 },
  { category: 'jailbreak', pattern: /\bpretend (?:you have|to have) no (?:rules|restrictions|filters)\b/i, weight: 0.6 },
  { category: 'jailbreak', pattern: /\bdeveloper mode\b.*\b(?:enable|on|activate)\b/i, weight: 0.4 },
  // doxxing
  { category: 'doxxing', pattern: /\b(?:find|get|tell me) (?:the )?(?:home address|personal phone|ssn|social security) of\b/i, weight: 0.8 },
  { category: 'doxxing', pattern: /\bdox(?:x)?(?:ing)?\b.*\b(?:user|person|target)\b/i, weight: 0.6 },
  // mass target
  { category: 'mass_target', pattern: /\bscrape (?:all|every) (?:emails?|users?|accounts?)\b/i, weight: 0.5 },
  { category: 'mass_target', pattern: /\b(?:export|dump) (?:all|the entire) (?:user|customer|email) (?:database|list|table)\b/i, weight: 0.5 },
  // weapon synth
  { category: 'weapon_synth', pattern: /\bhow (?:to|do i) (?:make|synthesize|build) (?:a )?(?:bomb|nerve agent|sarin|chlorine gas)\b/i, weight: 0.9 },
  // malware
  { category: 'malware', pattern: /\bwrite (?:me )?(?:a |the )?(?:keylogger|ransomware|stealer|rat)\b/i, weight: 0.7 },
  { category: 'malware', pattern: /\b(?:bypass|disable) (?:antivirus|edr|defender)\b.*\b(?:without|to evade)\b/i, weight: 0.6 },
];

function createContentPrefilter(opts = {}) {
  const threshold = Number.isFinite(opts.threshold) && opts.threshold > 0 && opts.threshold <= 1
    ? opts.threshold
    : DEFAULT_THRESHOLD;
  /** @type {Array<{category, pattern, weight}>} */
  const rules = Array.isArray(opts.rules) && opts.rules.length ? opts.rules.slice() : DEFAULT_RULES.slice();

  function evaluate(text) {
    const out = { flagged: false, score: 0, categories: {}, topCategory: null };
    if (typeof text !== 'string' || !text) return out;
    let totalWeight = 0;
    let topCat = null;
    let topCatScore = 0;
    for (const rule of rules) {
      const matches = text.match(rule.pattern);
      if (!matches) continue;
      const cat = rule.category;
      if (!out.categories[cat]) out.categories[cat] = { hits: 0, samples: [], score: 0 };
      out.categories[cat].hits += 1;
      if (out.categories[cat].samples.length < 3) {
        out.categories[cat].samples.push(matches[0]);
      }
      out.categories[cat].score += rule.weight;
      totalWeight += rule.weight;
      if (out.categories[cat].score > topCatScore) {
        topCatScore = out.categories[cat].score;
        topCat = cat;
      }
    }
    out.score = Math.min(1, totalWeight);
    out.topCategory = topCat;
    out.flagged = out.score >= threshold;
    return out;
  }

  function addRule({ category, pattern, weight = 0.5 } = {}) {
    if (typeof category !== 'string' || !category) throw new TypeError('addRule: category required');
    if (!(pattern instanceof RegExp)) throw new TypeError('addRule: pattern must be RegExp');
    rules.push({ category, pattern, weight: Number(weight) || 0.5 });
  }

  function snapshot() {
    return {
      threshold,
      ruleCount: rules.length,
      categoriesCovered: [...new Set(rules.map((r) => r.category))],
    };
  }

  return { evaluate, addRule, snapshot };
}

module.exports = {
  createContentPrefilter,
  DEFAULT_THRESHOLD,
  DEFAULT_RULES,
};
