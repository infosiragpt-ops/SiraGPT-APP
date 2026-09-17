'use strict';

/**
 * Export durable preferences as SFT / DPO / RM JSONL.
 *
 * Reads the preference store (hydrated from Postgres when attached).
 * Falls back to the in-memory feedback-ledger so existing callers keep
 * working before the first durable write.
 *
 * RLAIF rows are omitted from DPO/SFT unless includeRlaif=true — mixing
 * AI labels into a human-preference fine-tune is a documented source of
 * reward-model overoptimization.
 */

const store = require('./preference-store');
const piiScrubber = require('../agents/pii-scrubber');
const { cosine } = require('./vectors');

const MIN_PAIR_SIMILARITY = 0.6;

const AGENT_PERSONAS = {
  code_review: 'You are a senior software engineer performing a rigorous code review.',
  test_gen: 'You are a senior software engineer writing rigorous unit tests.',
  debug: 'You are an expert debugger localising the root cause of a failure.',
  code_gen: 'You are a senior software engineer generating production-quality code.',
  requirements: 'You are a tech lead turning vague feature requests into structured specs.',
  maintenance: 'You are a senior engineer triaging a maintenance ticket.',
  static_check: 'You are a static analysis expert auditing code for real issues.',
  log_analysis: 'You are an SRE debugging a production log burst.',
  chat: 'You are SiraGPT, a helpful assistant.',
};

function systemPromptFor(agent) {
  return AGENT_PERSONAS[agent] || 'You are a helpful software engineering assistant.';
}

function responseAsString(response) {
  if (typeof response === 'string') return response;
  try { return JSON.stringify(response, null, 0); } catch { return String(response); }
}

function maybeScrub(text, { scrubPii, aggressive, piiHits }) {
  if (!scrubPii) return text;
  const r = piiScrubber.scrub(String(text || ''), { aggressive });
  piiHits.push(...r.hits);
  return r.scrubbed;
}

async function allEvents(userId) {
  if (userId) await store.hydrateUser(userId).catch(() => []);
  let events = store.dump(userId);
  if (events.length === 0) {
    try {
      const ledger = require('../agents/feedback-ledger');
      events = (ledger._dump(userId) || []).map((e) => ({
        ...e,
        label: e.helpful ? 'chosen' : 'rejected',
        source: 'explicit',
        promptText: e.request,
        responseText: responseAsString(e.response),
        promptEmbedding: e.embedding,
        agent: e.agent,
      }));
    } catch {
      /* ledger optional */
    }
  }
  return events;
}

function exportSFT({ events, agent, scrubPii, aggressive, includeRlaif }) {
  const piiHits = [];
  const eligible = events
    .filter((e) => e.label === 'chosen' || e.helpful === true)
    .filter((e) => includeRlaif || e.source !== 'rlaif')
    .filter((e) => !agent || e.agent === agent);
  const lines = eligible.map((e) => JSON.stringify({
    messages: [
      { role: 'system', content: systemPromptFor(e.agent) },
      { role: 'user', content: maybeScrub(e.promptText || e.request, { scrubPii, aggressive, piiHits }) },
      { role: 'assistant', content: maybeScrub(responseAsString(e.responseText || e.response), { scrubPii, aggressive, piiHits }) },
    ],
  }));
  return { lines, count: lines.length, piiHits };
}

function exportDPO({ events, agent, scrubPii, aggressive, includeRlaif }) {
  const piiHits = [];
  const pool = events
    .filter((e) => includeRlaif || e.source !== 'rlaif')
    .filter((e) => !agent || e.agent === agent);

  const lines = [];
  const used = new Set();

  const byPair = new Map();
  for (const e of pool) {
    if (!e.pairId) continue;
    let g = byPair.get(e.pairId);
    if (!g) { g = {}; byPair.set(e.pairId, g); }
    if (e.label === 'chosen') g.chosen = e;
    if (e.label === 'rejected') g.rejected = e;
  }
  for (const g of byPair.values()) {
    if (!g.chosen || !g.rejected) continue;
    used.add(g.chosen.id || g.chosen.runId);
    used.add(g.rejected.id || g.rejected.runId);
    lines.push(JSON.stringify({
      input: {
        messages: [
          { role: 'system', content: systemPromptFor(g.chosen.agent || g.rejected.agent) },
          { role: 'user', content: maybeScrub(g.chosen.promptText || g.chosen.request, { scrubPii, aggressive, piiHits }) },
        ],
      },
      preferred_output: [{ role: 'assistant', content: maybeScrub(responseAsString(g.chosen.responseText || g.chosen.response), { scrubPii, aggressive, piiHits }) }],
      non_preferred_output: [{ role: 'assistant', content: maybeScrub(responseAsString(g.rejected.responseText || g.rejected.response), { scrubPii, aggressive, piiHits }) }],
    }));
  }

  // Similarity-paired leftovers (legacy path from feedback-ledger).
  const helpful = pool.filter((e) => (e.label === 'chosen' || e.helpful) && e.promptEmbedding && !used.has(e.id || e.runId));
  const unhelpful = pool.filter((e) => (e.label === 'rejected' || e.helpful === false) && e.promptEmbedding && !used.has(e.id || e.runId));
  const usedHelpful = new Set();
  for (const reject of unhelpful) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < helpful.length; i++) {
      if (usedHelpful.has(i)) continue;
      const sim = cosine(reject.promptEmbedding, helpful[i].promptEmbedding);
      if (sim > bestScore) { bestScore = sim; bestIdx = i; }
    }
    if (bestIdx === -1 || bestScore < MIN_PAIR_SIMILARITY) continue;
    usedHelpful.add(bestIdx);
    const win = helpful[bestIdx];
    lines.push(JSON.stringify({
      input: {
        messages: [
          { role: 'system', content: systemPromptFor(win.agent || reject.agent) },
          { role: 'user', content: maybeScrub(win.promptText || win.request, { scrubPii, aggressive, piiHits }) },
        ],
      },
      preferred_output: [{ role: 'assistant', content: maybeScrub(responseAsString(win.responseText || win.response), { scrubPii, aggressive, piiHits }) }],
      non_preferred_output: [{ role: 'assistant', content: maybeScrub(responseAsString(reject.responseText || reject.response), { scrubPii, aggressive, piiHits }) }],
    }));
  }

  return { lines, count: lines.length, piiHits };
}

function exportRlcd({ events, agent, scrubPii, aggressive, includeRlaif }) {
  const piiHits = [];
  const pool = events
    .filter((e) => includeRlaif || e.source !== 'rlaif')
    .filter((e) => !agent || e.agent === agent);
  let pairs = [];
  try {
    const contrastive = require('../rlcd/contrastive');
    pairs = contrastive.buildDocumentPairs(pool, { limit: 80 });
  } catch {
    pairs = [];
  }
  const lines = pairs.map((p) => JSON.stringify({
    prompt: maybeScrub(p.prompt, { scrubPii, aggressive, piiHits }),
    chosen: maybeScrub(p.chosen, { scrubPii, aggressive, piiHits }),
    rejected: maybeScrub(p.rejected, { scrubPii, aggressive, piiHits }),
    chosen_confidence: p.chosenConfidence,
    rejected_confidence: p.rejectedConfidence,
    delta: p.delta,
    overconfident_reject: p.overconfidentReject === true,
    agent: 'document',
  }));
  return { lines, count: lines.length, piiHits };
}

function exportRM({ events, agent, scrubPii, aggressive, includeRlaif }) {
  const piiHits = [];
  const eligible = events
    .filter((e) => e.label === 'chosen' || e.label === 'rejected')
    .filter((e) => includeRlaif || e.source !== 'rlaif')
    .filter((e) => !agent || e.agent === agent);
  const lines = eligible.map((e) => JSON.stringify({
    prompt: maybeScrub(e.promptText || e.request, { scrubPii, aggressive, piiHits }),
    response: maybeScrub(responseAsString(e.responseText || e.response), { scrubPii, aggressive, piiHits }),
    label: e.label === 'chosen' ? 1 : 0,
    source: e.source,
    agent: e.agent || null,
  }));
  return { lines, count: lines.length, piiHits };
}

async function exportData({
  userId,
  format = 'sft',
  agent = null,
  scrubPii = true,
  aggressive = false,
  includeRlaif = false,
} = {}) {
  const events = await allEvents(userId);
  const args = { events, agent, scrubPii, aggressive, includeRlaif };
  let out;
  if (format === 'sft') out = exportSFT(args);
  else if (format === 'dpo' || format === 'pairs') out = exportDPO(args);
  else if (format === 'rm') out = exportRM(args);
  else if (format === 'rlcd') out = exportRlcd(args);
  else throw new Error(`rlhf.export: unknown format "${format}" (use 'sft', 'dpo', 'rm', or 'rlcd')`);
  const ndjson = out.lines.join('\n') + (out.lines.length > 0 ? '\n' : '');
  try {
    require('./metrics').recordExport({
      format,
      count: out.count,
      bytes: Buffer.byteLength(ndjson, 'utf8'),
    });
  } catch {
    /* telemetry is optional */
  }
  return {
    format,
    count: out.count,
    scrubbed: scrubPii,
    piiHits: out.piiHits,
    ndjson,
  };
}

module.exports = {
  exportData,
  exportSFT,
  exportDPO,
  exportRM,
  exportRlcd,
  systemPromptFor,
  AGENT_PERSONAS,
  MIN_PAIR_SIMILARITY,
};
