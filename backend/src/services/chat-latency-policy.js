'use strict';

const DEFAULT_ENRICHMENT_BUDGET_MS = 900;
const MIN_ENRICHMENT_BUDGET_MS = 100;
const MAX_ENRICHMENT_BUDGET_MS = 5_000;
const SHORT_TURN_MAX_CHARS = 96;

const PERSONAL_CONTEXT_HINT = /\b(?:recuerda|recordar|recordaste|memoria|mi|mis|m[ií]o|m[ií]a|yo|soy|me\s+llamo|nombre|preferencia|prefiero|empresa|proyecto|cuenta|remember|memory|my|mine|i\s+am|i'm|name|preference|company|project|account)\b/i;

function enrichmentBudgetMs(env = process.env) {
  const configured = Number(env.SIRAGPT_CHAT_ENRICHMENT_BUDGET_MS);
  if (!Number.isFinite(configured)) return DEFAULT_ENRICHMENT_BUDGET_MS;
  return Math.min(MAX_ENRICHMENT_BUDGET_MS, Math.max(MIN_ENRICHMENT_BUDGET_MS, Math.floor(configured)));
}

function shouldUseSemanticEnrichment({ prompt, files = [], project = null, customGpt = null } = {}) {
  const text = String(prompt || '').trim();
  if (!text) return false;
  if (Array.isArray(files) && files.length > 0) return true;
  if (project || customGpt) return true;
  if (text.length > SHORT_TURN_MAX_CHARS) return true;
  return PERSONAL_CONTEXT_HINT.test(text);
}

async function resolveWithinBudget(promise, {
  fallback = [],
  budgetMs = enrichmentBudgetMs(),
  label = 'semantic-enrichment',
  logger = console,
} = {}) {
  let timer = null;
  let timedOut = false;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(fallback);
    }, budgetMs);
  });

  try {
    const value = await Promise.race([Promise.resolve(promise), deadline]);
    if (timedOut) logger.warn?.(`[chat-latency] ${label} exceeded ${budgetMs}ms; continuing without it`);
    return value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_ENRICHMENT_BUDGET_MS,
  MIN_ENRICHMENT_BUDGET_MS,
  MAX_ENRICHMENT_BUDGET_MS,
  SHORT_TURN_MAX_CHARS,
  enrichmentBudgetMs,
  shouldUseSemanticEnrichment,
  resolveWithinBudget,
};
