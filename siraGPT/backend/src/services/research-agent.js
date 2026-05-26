'use strict';

/**
 * research-agent.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "Manus-like" autonomous research agent: given a topic, runs a planner →
 * searcher → browser → vision → synthesiser loop that crawls real scientific
 * sources, visits open-access landing pages with a headless browser, captures
 * screenshots, and asks a vision LLM to extract structured findings before
 * deciding whether to keep digging or compose the final answer.
 *
 * Public API:
 *   run({ query, depth, maxSteps, providers, onEvent }) → ResearchReport
 *
 * Event stream (each fired via opts.onEvent, mirror of agent SSE protocol):
 *   { type: 'phase',      phase: 'plan' | 'search' | 'browse' | 'analyse' | 'decide' | 'synthesise', label }
 *   { type: 'paper',      paper: Paper }
 *   { type: 'page',       url, screenshot?: base64, statusCode, title }
 *   { type: 'finding',    finding: { text, source, confidence } }
 *   { type: 'decision',   action: 'continue' | 'refine' | 'finalise', reasoning, nextQuery? }
 *   { type: 'report',     report: ResearchReport }
 *
 * Design constraints (mirror of sister modules — research.js, agent-core.js):
 *   - Stateless: each invocation builds an in-memory context. No DB writes
 *     beyond the eventual chat-message persistence handled by the caller.
 *   - All upstream calls are timeout-bounded. The headless browser session
 *     is bounded by `maxBrowserMs` (default 60s total budget).
 *   - Pure-JS + Playwright (already a dep). No Python sidecar.
 *   - Browser sessions auto-close on every code path (try/finally + abort).
 *   - When Playwright is unavailable (CI sandbox, missing chromium), the
 *     agent degrades to "text-only" mode and skips screenshots without
 *     crashing — finding-extraction falls back to the paper abstract.
 */

const scientificSearch = require('./scientific-search');
const researchRunStore = require('./research-run-store');

const DEFAULTS = {
  maxSteps: 6,
  maxPapersPerSearch: 10,
  maxPagesToVisit: 4,
  maxBrowserMs: 60_000,
  perPageNavMs: 15_000,
  perPageRenderMs: 4_000,
  screenshotMaxBytes: 250_000, // ~250KB after PNG compression
};

const DEPTH_CONFIG = {
  quick:    { maxSteps: 3, maxPagesToVisit: 2, maxPapersPerSearch: 6 },
  standard: { maxSteps: 6, maxPagesToVisit: 4, maxPapersPerSearch: 10 },
  deep:     { maxSteps: 9, maxPagesToVisit: 6, maxPapersPerSearch: 15 },
};

function emit(onEvent, event) {
  if (typeof onEvent !== 'function') return;
  try { onEvent(event); } catch { /* best effort */ }
}

let playwrightModule = null;
function getPlaywright() {
  if (playwrightModule !== null) return playwrightModule;
  try {
    playwrightModule = require('playwright');
  } catch {
    playwrightModule = false; // marker: tried, not available
  }
  return playwrightModule;
}

let aiServiceModule = null;
function getAiService() {
  if (aiServiceModule !== null) return aiServiceModule;
  try { aiServiceModule = require('./ai-service'); }
  catch { aiServiceModule = false; }
  return aiServiceModule;
}

/**
 * Browser session wrapper — opens a single Chromium instance for the lifetime
 * of one research run. Each visit() reuses a fresh context (clean cookies,
 * fresh viewport) so cross-page state doesn't leak between sources.
 *
 * Degrades gracefully when Playwright isn't installed or chromium isn't
 * present — visit() then returns a stub with no screenshot.
 */
function createBrowserSession({ totalBudgetMs }) {
  const pw = getPlaywright();
  let browser = null;
  let elapsedSinceStart = 0;
  const startedAt = Date.now();

  async function lazyInit() {
    if (browser || !pw) return;
    try {
      browser = await pw.chromium.launch({ headless: true });
    } catch (err) {
      // Browser exec missing or launch failed — degrade to text-only.
      browser = false;
      return { error: err.message };
    }
  }

  async function visit(url, { perPageNavMs, perPageRenderMs, screenshotMaxBytes }) {
    const stub = { url, statusCode: null, title: null, text: null, screenshotBase64: null, error: null };
    if (!pw) {
      stub.error = 'playwright_not_installed';
      return stub;
    }
    elapsedSinceStart = Date.now() - startedAt;
    if (elapsedSinceStart > totalBudgetMs) {
      stub.error = 'browser_budget_exhausted';
      return stub;
    }
    await lazyInit();
    if (!browser) {
      stub.error = 'browser_launch_failed';
      return stub;
    }
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 SiraGPT-Research/1.0',
      javaScriptEnabled: true,
    });
    const page = await context.newPage();
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: perPageNavMs });
      stub.statusCode = response?.status() || null;
      // Give SPAs a moment to settle (but cap so a heavy page doesn't burn budget)
      try { await page.waitForLoadState('networkidle', { timeout: perPageRenderMs }); } catch { /* ignore timeout */ }
      stub.title = await page.title();
      stub.text = (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).slice(0, 8000);
      const png = await page.screenshot({ fullPage: false, type: 'png' });
      // Cap screenshot size so the prompt + result payload stays sane.
      if (png && png.length <= screenshotMaxBytes) {
        stub.screenshotBase64 = png.toString('base64');
      } else if (png) {
        stub.screenshotBase64 = png.slice(0, screenshotMaxBytes).toString('base64');
        stub.error = 'screenshot_truncated';
      }
    } catch (err) {
      stub.error = err.message || String(err);
    } finally {
      try { await context.close(); } catch { /* */ }
    }
    return stub;
  }

  async function close() {
    if (browser && browser !== false) {
      try { await browser.close(); } catch { /* */ }
    }
    browser = null;
  }

  return { visit, close };
}

/**
 * Vision analyser. Given a screenshot + page text, asks the OpenAI vision
 * model to extract findings as a structured list. Falls back to text-only
 * extraction when vision isn't configured or the screenshot was skipped.
 */
async function analysePage({ pageData, paper, query, aiClient }) {
  const findings = [];
  // Always extract at least the textual abstract if no model is wired
  if (!aiClient) {
    if (paper.abstract) {
      findings.push({
        text: paper.abstract.slice(0, 400),
        source: paper.htmlUrl || paper.doi || paper.title,
        confidence: 0.4,
      });
    }
    return findings;
  }

  const blocks = [];
  blocks.push({
    type: 'text',
    text:
`You are reading a scientific source to answer:
  USER QUERY: ${query}

Source title: ${paper.title}
URL: ${pageData.url}

Page text (first 8000 chars):
"""
${pageData.text || paper.abstract || '(no text extracted)'}
"""

Extract 2-5 concrete findings that DIRECTLY help answer the user query.
For each finding, return a JSON object with:
  - text:       one sentence, factual, no hedging
  - source:     the URL or DOI of this page
  - confidence: 0.0-1.0 based on how clearly the page supports the finding

Reply with a JSON array only, no prose. If the page has nothing relevant,
return [].`,
  });
  if (pageData.screenshotBase64) {
    blocks.push({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${pageData.screenshotBase64}`, detail: 'low' },
    });
  }

  try {
    const resp = await aiClient.chat.completions.create({
      model: process.env.RESEARCH_VISION_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: blocks }],
      temperature: 0.2,
      max_tokens: 600,
    });
    const txt = resp.choices?.[0]?.message?.content || '[]';
    const jsonStart = txt.indexOf('[');
    const jsonEnd = txt.lastIndexOf(']');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const parsed = JSON.parse(txt.slice(jsonStart, jsonEnd + 1));
      if (Array.isArray(parsed)) {
        for (const f of parsed) {
          if (!f || typeof f !== 'object') continue;
          findings.push({
            text: String(f.text || '').slice(0, 600),
            source: String(f.source || pageData.url || paper.htmlUrl || ''),
            confidence: Number.isFinite(Number(f.confidence)) ? Math.max(0, Math.min(1, Number(f.confidence))) : 0.5,
          });
        }
      }
    }
  } catch (err) {
    // Vision failure → fall back to abstract
    if (paper.abstract) {
      findings.push({
        text: paper.abstract.slice(0, 400),
        source: paper.htmlUrl || paper.doi || paper.title,
        confidence: 0.3,
      });
    }
  }
  return findings;
}

/**
 * Decision step — the agent inspects the findings collected so far and
 * decides whether to refine the query, search a different provider mix,
 * or wrap up. Deterministic heuristic that doesn't require an LLM call.
 */
function decideNextAction({ findings, step, maxSteps, queriesTried }) {
  if (step >= maxSteps - 1) {
    return { action: 'finalise', reasoning: 'reached step budget' };
  }
  if (findings.length === 0) {
    return {
      action: 'refine',
      reasoning: 'no findings collected so far — broaden the query',
      nextQuery: queriesTried[queriesTried.length - 1] + ' OR review OR survey',
    };
  }
  if (findings.length < 3) {
    return {
      action: 'continue',
      reasoning: `only ${findings.length} findings — keep searching with the same query`,
    };
  }
  const highConf = findings.filter((f) => f.confidence >= 0.6).length;
  if (highConf >= 3) {
    return { action: 'finalise', reasoning: `${highConf} high-confidence findings — synthesise the answer` };
  }
  return { action: 'continue', reasoning: 'iterate one more cycle to confirm findings' };
}

/**
 * Synthesise the final markdown report.
 */
function synthesise({ query, findings, papers, queriesTried }) {
  const seen = new Set();
  const dedupedFindings = findings.filter((f) => {
    const key = f.text.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  dedupedFindings.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  const lines = [];
  lines.push(`# Research synthesis: ${query}\n`);
  lines.push(`*${dedupedFindings.length} findings across ${papers.length} unique papers · ${queriesTried.length} query variants*\n`);

  if (dedupedFindings.length === 0) {
    lines.push('## Findings\n');
    lines.push('_No high-quality findings extracted. Try a more specific query or a different provider mix._\n');
  } else {
    lines.push('## Key findings\n');
    dedupedFindings.slice(0, 12).forEach((f, idx) => {
      const conf = Math.round((f.confidence || 0) * 100);
      lines.push(`${idx + 1}. ${f.text}  \n   _Source · confidence ${conf}%:_ ${f.source}`);
    });
  }

  if (papers.length > 0) {
    lines.push('\n## Sources consulted\n');
    papers.slice(0, 20).forEach((p, idx) => {
      const authors = (p.authors || []).slice(0, 3).map((a) => a.name).filter(Boolean).join(', ');
      const tail = p.year ? ` (${p.year})` : '';
      const venue = p.venue ? ` · *${p.venue}*` : '';
      const link = p.htmlUrl || (p.doi ? `https://doi.org/${p.doi}` : null);
      const linkText = link ? ` — [link](${link})` : '';
      lines.push(`${idx + 1}. **${p.title}**${tail}${venue}${linkText}` + (authors ? `  \n   ${authors}` : ''));
    });
  }

  if (queriesTried.length > 1) {
    lines.push('\n## Query variants tried\n');
    queriesTried.forEach((q, idx) => lines.push(`${idx + 1}. \`${q}\``));
  }

  return lines.join('\n');
}

/**
 * Main entry point.
 *
 * @param {object} opts
 * @param {string} opts.query
 * @param {string} [opts.depth]      — quick | standard | deep
 * @param {number} [opts.maxSteps]
 * @param {string[]} [opts.providers]
 * @param {function} [opts.onEvent]  — SSE-style listener
 * @param {object}   [opts.aiClient] — OpenAI-compatible client for vision step
 * @returns {Promise<ResearchReport>}
 */
async function run(opts = {}) {
  const query = String(opts.query || '').trim();
  if (!query) throw new Error('query is required');

  const depthCfg = DEPTH_CONFIG[opts.depth] || DEPTH_CONFIG.standard;
  const cfg = {
    ...DEFAULTS,
    ...depthCfg,
    ...opts,
  };
  const runId = researchRunStore.createRunId(query);
  researchRunStore.saveRun({
    id: runId,
    query,
    depth: opts.depth || 'standard',
    status: 'running',
    createdAt: Date.now(),
    events: [],
  });
  const onEvent = (event) => {
    researchRunStore.appendEvent(runId, event);
    if (typeof opts.onEvent === 'function') {
      try { opts.onEvent(event); } catch { /* best effort */ }
    }
  };

  const queriesTried = [query];
  const allPapers = [];
  const allFindings = [];
  let aiClient = opts.aiClient;
  if (!aiClient) {
    const ai = getAiService();
    if (ai && typeof ai.getOpenAIClient === 'function') {
      try { aiClient = ai.getOpenAIClient(); } catch { /* */ }
    }
  }

  const browserSession = createBrowserSession({ totalBudgetMs: cfg.maxBrowserMs });

  try {
    let currentQuery = query;
    for (let step = 0; step < cfg.maxSteps; step++) {
      emit(onEvent, { type: 'phase', phase: 'search', label: `step ${step + 1}/${cfg.maxSteps}: ${currentQuery}` });

      // ── Search across providers ──
      const searchResult = await scientificSearch.search(currentQuery, {
        providers: cfg.providers,
        limit: cfg.maxPapersPerSearch,
        timeoutMs: 8000,
      });
      const newPapers = searchResult.papers.filter((p) =>
        !allPapers.some((existing) => normaliseTitleKey(existing.title) === normaliseTitleKey(p.title))
      );
      for (const p of newPapers) allPapers.push(p);
      newPapers.forEach((p) => emit(onEvent, { type: 'paper', paper: p }));

      // ── Browse top-N pages ──
      emit(onEvent, { type: 'phase', phase: 'browse', label: `visiting up to ${cfg.maxPagesToVisit} pages` });
      const topToVisit = newPapers.slice(0, cfg.maxPagesToVisit);
      for (const paper of topToVisit) {
        const url = paper.htmlUrl || (paper.doi ? `https://doi.org/${paper.doi}` : null);
        if (!url) continue;
        const pageData = await browserSession.visit(url, {
          perPageNavMs: cfg.perPageNavMs,
          perPageRenderMs: cfg.perPageRenderMs,
          screenshotMaxBytes: cfg.screenshotMaxBytes,
        });
        emit(onEvent, {
          type: 'page',
          url: pageData.url,
          screenshot: pageData.screenshotBase64 ? `data:image/png;base64,${pageData.screenshotBase64.slice(0, 100)}…` : null,
          statusCode: pageData.statusCode,
          title: pageData.title,
          error: pageData.error,
        });

        // ── Vision/text analysis ──
        emit(onEvent, { type: 'phase', phase: 'analyse', label: `extracting findings from ${paper.title.slice(0, 60)}…` });
        const findings = await analysePage({ pageData, paper, query, aiClient });
        for (const f of findings) {
          allFindings.push(f);
          emit(onEvent, { type: 'finding', finding: f });
        }
      }

      // ── Decide ──
      const decision = decideNextAction({
        findings: allFindings,
        step,
        maxSteps: cfg.maxSteps,
        queriesTried,
      });
      emit(onEvent, { type: 'decision', ...decision });
      if (decision.action === 'finalise') break;
      if (decision.action === 'refine' && decision.nextQuery) {
        currentQuery = decision.nextQuery;
        queriesTried.push(currentQuery);
      }
    }

    emit(onEvent, { type: 'phase', phase: 'synthesise', label: 'composing report' });
    const report = synthesise({ query, findings: allFindings, papers: allPapers, queriesTried });
    const result = {
      query,
      report,
      findings: allFindings,
      papers: allPapers,
      queriesTried,
      stats: {
        papersFound: allPapers.length,
        findingsExtracted: allFindings.length,
        queryVariants: queriesTried.length,
      },
    };
    emit(onEvent, { type: 'report', report: result });
    return result;
  } finally {
    await browserSession.close();
  }
}

function normaliseTitleKey(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

module.exports = {
  run,
  _internal: {
    createBrowserSession,
    analysePage,
    decideNextAction,
    synthesise,
    normaliseTitleKey,
  },
};
