'use strict';

/**
 * answer-engine — the professional "answer like Perplexity/ChatGPT-search"
 * orchestrator:
 *
 *   plan → search (many providers × sub-queries → hundreds of candidates)
 *        → rank/dedupe → [deep: read top-K pages] → synthesize cited answer
 *
 * Fast mode answers from snippets (sub-second / cache-instant); deep mode
 * additionally reads the top sources for richer, better-grounded passages.
 *
 * All side-effecting collaborators are injectable (searchFn / readFn / llmFn)
 * so the whole pipeline is unit-testable with no network or model.
 */

const queryPlanner = require('./query-planner');
const synthesizer = require('./answer-synthesizer');
const relevance = require('../agents/web-search/relevance');

function now() { return Date.now(); }

function defaultSearchFn(q, o) {
  // eslint-disable-next-line global-require
  return require('../agents/web-search').searchMany(q, o);
}

function defaultReadFn(url, o) {
  // eslint-disable-next-line global-require
  const { execute } = require('../../skills/read_url/handler');
  return execute({ url, ...o });
}

/** Run page reads in parallel with a bounded fan-out + per-read timeout. */
async function readTopSources(sources, readFn, { topK, timeoutMs, maxChars, signal }) {
  const targets = sources.slice(0, topK);
  await Promise.all(targets.map(async (s) => {
    try {
      const out = await readFn(s.url, { timeoutMs, maxChars, signal });
      if (out && !out.error && out.content_markdown) {
        s.content = out.content_markdown;
        if (out.title && (!s.title || s.title.length < 8)) s.title = out.title;
        s._read = true;
      } else {
        s._readError = (out && out.error) || 'no_content';
      }
    } catch (err) {
      s._readError = String((err && err.message) || err).slice(0, 120);
    }
  }));
  return sources;
}

function buildLlmPrompt(query, citations, lang) {
  const refs = citations.map((c) => `[${c.n}] ${c.title} — ${c.url}`).join('\n');
  const langName = lang === 'en' ? 'English' : 'Spanish';
  return [
    `You are a professional research assistant. Answer the user's question in ${langName}, concisely and accurately, synthesizing ONLY the information supported by the numbered sources.`,
    'Rules: keep the inline [n] citation markers next to the claims they support; never invent facts or citation numbers; do not add sources; if the evidence is thin, say so.',
    '',
    `Question: ${query}`,
    '',
    'Sources:',
    refs,
  ].join('\n');
}

/** Reject an LLM rewrite that invents citation numbers not in the set. */
function llmRewriteIsValid(text, maxN) {
  if (typeof text !== 'string' || text.trim().length < 10) return false;
  const nums = (text.match(/\[(\d+)\]/g) || []).map((m) => Number(m.slice(1, -1)));
  return nums.every((n) => n >= 1 && n <= maxN);
}

/**
 * Produce a cited answer for a query.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {'fast'|'deep'} [opts.mode='fast']
 * @param {number} [opts.maxSources=8]            citations surfaced.
 * @param {number} [opts.candidatesPerQuery=40]   searchMany cap per sub-query.
 * @param {number} [opts.readTopK=5]              deep mode: pages to read.
 * @param {function} [opts.searchFn] [opts.readFn] [opts.llmFn]   injectable.
 */
async function answer(query, opts = {}) {
  const q = String(query || '').trim();
  const startedAt = now();
  const timings = {};
  if (!q) {
    return { query: q, answer: '', citations: [], sources: [], relatedQuestions: [], plan: null,
      stats: { candidates: 0, used: 0, providers: [], timings: {} }, mode: opts.mode || 'fast', generatedAt: new Date().toISOString() };
  }

  const mode = opts.mode === 'deep' ? 'deep' : 'fast';
  const maxSources = Math.max(1, Math.min(Number(opts.maxSources) || 8, 50));
  const candidatesPerQuery = Math.max(5, Math.min(Number(opts.candidatesPerQuery) || 40, 200));
  const readTopK = Math.max(1, Math.min(Number(opts.readTopK) || 5, 12));
  const searchFn = typeof opts.searchFn === 'function' ? opts.searchFn : defaultSearchFn;
  const readFn = typeof opts.readFn === 'function' ? opts.readFn : defaultReadFn;
  const llmFn = typeof opts.llmFn === 'function' ? opts.llmFn : null;
  // Progress hook for SSE streaming (Perplexity-style phases). Best-effort.
  const emit = typeof opts.onPhase === 'function'
    ? (phase, data) => { try { opts.onPhase({ phase, ...data }); } catch { /* ignore */ } }
    : () => {};

  // 1) Plan.
  let t = now();
  const plan = queryPlanner.plan(q, { maxSubQueries: opts.maxSubQueries });
  timings.plan = now() - t;
  emit('plan', { subQueries: plan.subQueries, isComparison: plan.isComparison });

  // 2) Search every sub-query in parallel; merge.
  t = now();
  const searchResults = await Promise.all(plan.subQueries.map((sq) =>
    Promise.resolve()
      .then(() => searchFn(sq, {
        maxResults: candidatesPerQuery,
        locale: opts.locale,
        includeScientific: opts.includeScientific,
        signal: opts.signal,
      }))
      .catch(() => ({ results: [], providers: [] })),
  ));
  const merged = [];
  const providers = new Set();
  for (const r of searchResults) {
    if (Array.isArray(r?.results)) merged.push(...r.results);
    for (const p of (r?.providers || [])) providers.add(p);
  }
  timings.search = now() - t;
  emit('search', { candidates: merged.length, providers: Array.from(providers) });

  // 3) Rank + dedupe the merged candidate pool against the ORIGINAL question.
  const ranked = relevance.rankAndFilter(q, merged, {
    limit: Math.max(maxSources * 3, 30),
    perDomain: plan.isComparison ? undefined : 6,
  }).map(({ _score, _rank, ...rest }) => rest);
  const sources = ranked.slice(0, maxSources);
  emit('sources', { sources: sources.map((s) => ({ title: s.title, url: s.url, domain: s.domain, source: s.source })) });

  // 4) Deep mode: read the top sources for richer passages.
  timings.read = 0;
  if (mode === 'deep' && sources.length) {
    emit('reading', { count: Math.min(readTopK, sources.length) });
    t = now();
    await readTopSources(sources, readFn, {
      topK: readTopK,
      timeoutMs: opts.readTimeoutMs || 6000,
      maxChars: opts.readMaxChars || 8000,
      signal: opts.signal,
    });
    timings.read = now() - t;
  }

  // 5) Synthesize the cited answer.
  emit('synthesizing', {});
  t = now();
  const synth = synthesizer.synthesize(q, sources, {
    maxSources,
    lang: plan.lang === 'und' ? undefined : plan.lang,
    aspects: plan.aspects,
  });
  timings.synthesize = now() - t;

  // 6) Optional LLM rewrite (kept faithful: same citation set, fallback safe).
  let finalAnswer = synth.answer;
  let llmUsed = false;
  if (llmFn && synth.citations.length) {
    try {
      const prompt = buildLlmPrompt(q, synth.citations, plan.lang);
      const draft = `${prompt}\n\nDraft (extractive, keep its citations):\n${synth.answer}`;
      const rewritten = await llmFn(draft, { signal: opts.signal });
      if (llmRewriteIsValid(rewritten, synth.citations.length)) {
        finalAnswer = String(rewritten).trim();
        llmUsed = true;
      }
    } catch { /* keep extractive answer */ }
  }

  timings.total = now() - startedAt;
  emit('answer', { answer: finalAnswer, citations: synth.citations, relatedQuestions: synth.relatedQuestions });

  return {
    query: q,
    mode,
    plan,
    answer: finalAnswer,
    citations: synth.citations,
    sources: sources.map((s) => ({
      title: s.title, url: s.url, domain: s.domain, snippet: s.snippet,
      read: Boolean(s._read), source: s.source,
    })),
    relatedQuestions: synth.relatedQuestions,
    coverage: synth.coverage,
    stats: {
      candidates: merged.length,
      ranked: ranked.length,
      used: synth.usedSources,
      providers: Array.from(providers),
      llmUsed,
      timings,
    },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { answer, readTopSources, buildLlmPrompt, llmRewriteIsValid };
