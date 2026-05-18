const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const fetch = require('node-fetch');
const OpenAI = require('openai');
const { serializeBigIntFields } = require('../utils/bigint-serializer');
const { runAgenticBatch } = require('../services/searchBrain/agenticBatch');

const router = express.Router();

/**
 * Intelligent Query Analyzer
 * Analyzes user query to determine search intent, complexity, and optimal result count
 */
function analyzeQuery(query) {
  const lowerQuery = query.toLowerCase();

  // Determine query intent
  let intent = 'general';
  let resultCount = 10; // default

  // Research/Academic queries - need more comprehensive results
  if (lowerQuery.match(/research|study|paper|article|scientific|academic|peer.?reviewed|journal|thesis/i)) {
    intent = 'research';
    resultCount = 15;
  }
  // News queries - need recent and diverse sources
  else if (lowerQuery.match(/news|latest|recent|current|today|happening|breaking/i)) {
    intent = 'news';
    resultCount = 12;
  }
  // How-to/Tutorial queries - need step-by-step guides
  else if (lowerQuery.match(/how to|tutorial|guide|learn|steps|instructions/i)) {
    intent = 'tutorial';
    resultCount = 8;
  }
  // Comparison queries - need multiple perspectives
  else if (lowerQuery.match(/vs|versus|compare|difference|better|best/i)) {
    intent = 'comparison';
    resultCount = 10;
  }
  // Definition/Fact queries - need concise authoritative sources
  else if (lowerQuery.match(/what is|define|meaning|who is|when did/i)) {
    intent = 'definition';
    resultCount = 6;
  }
  // List queries - user wants comprehensive lists
  else if (lowerQuery.match(/list|top \d+|best \d+|\d+ best|\d+ ways/i)) {
    intent = 'list';
    resultCount = 12;
  }

  // Extract any number in query (e.g., "find me 20 articles")
  const numberMatch = query.match(/\b(\d+)\s*(article|result|paper|source|link|item)/i);
  if (numberMatch) {
    resultCount = Math.min(parseInt(numberMatch[1]), 30); // cap at 30
  }

  return { intent, resultCount };
}

/**
 * Generate Intelligent System Prompt based on query analysis
 */
function generateSystemPrompt(query, intent, resultCount) {
  const basePrompt = `You are an expert web research assistant specialized in finding high-quality, relevant, and credible information.

**Your Mission:**
Analyze the user's query and provide the MOST relevant, accurate, and useful web results. Your search should be:
- ✅ Comprehensive: Cover different perspectives and sources
- ✅ Credible: Prioritize authoritative and reliable sources
- ✅ Recent: Prefer up-to-date information when relevant
- ✅ Diverse: Include various types of content (articles, guides, videos, official docs)

**Query Analysis:**
- Intent: ${intent}
- Requested Results: ${resultCount}
- User Query: "${query}"

`;

  // Add intent-specific instructions
  const intentInstructions = {
    research: `**Research Focus:**
- Prioritize peer-reviewed articles, academic journals, and research repositories
- Include preprints from arXiv, bioRxiv if relevant
- Look for systematic reviews and meta-analyses
- Include DOIs when available
- Provide publication dates and citation counts
- Include both seminal works and recent advances`,

    news: `**News Focus:**
- Prioritize recent articles (last 7 days preferred)
- Include multiple news sources for balanced perspective
- Look for breaking news, updates, and analysis
- Include publication date and time
- Verify from credible news organizations`,

    tutorial: `**Tutorial/Guide Focus:**
- Prioritize step-by-step guides and tutorials
- Include official documentation when available
- Look for video tutorials, interactive guides, and written instructions
- Include both beginner and advanced resources
- Verify accuracy and completeness of instructions`,

    comparison: `**Comparison Focus:**
- Include multiple perspectives and viewpoints
- Look for detailed comparison articles and reviews
- Include pros/cons lists and feature comparisons
- Prioritize unbiased, analytical sources
- Include expert opinions and user reviews`,

    definition: `**Definition/Fact Focus:**
- Prioritize authoritative sources (dictionaries, encyclopedias, official sites)
- Include academic definitions when relevant
- Look for simple explanations and detailed analyses
- Verify accuracy from multiple credible sources`,

    list: `**List/Compilation Focus:**
- Provide comprehensive lists as requested
- Include diverse options/items
- Look for expert-curated lists and rankings
- Include brief descriptions for each item
- Prioritize recent and relevant compilations`,

    general: `**General Search Focus:**
- Provide diverse and relevant results
- Balance between depth and breadth
- Include official sources, news articles, and guides
- Prioritize credibility and relevance`
  };

  const outputFormat = `
**Output Format (STRICT JSON):**
Return EXACTLY ${resultCount} results in this JSON structure:
[
  {
    "title": "Exact, descriptive title",
    "url": "Valid, accessible URL (must be real and working)",
    "snippet": "Comprehensive summary (3-5 sentences covering key points, findings, or content)",
    "source": "Source name or domain",
    "date": "Publication date if available (format: YYYY-MM-DD or 'Recent' or null)",
    "type": "Type of content (article, research, tutorial, news, video, documentation, etc.)",
    "relevance": "High/Medium/Low",
    "credibility": "High/Medium/Low"
  }
]

**Critical Requirements:**
1. ✅ ALL URLs must be real, valid, and accessible
2. ✅ Snippets should be informative and comprehensive (not just title repetition)
3. ✅ Prioritize .edu, .gov, .org, and reputable domains for credibility
4. ✅ Include publication dates when available
5. ✅ Ensure diversity in sources (don't repeat the same domain)
6. ✅ Results must be DIRECTLY relevant to the query
7. ✅ Return EXACTLY ${resultCount} results (no more, no less)
8. ✅ No placeholder URLs - only real, working links
9. ✅ Provide actual content summaries, not generic descriptions

**Quality Standards:**
- Each result should add unique value
- Snippets should give users enough information to decide if they want to click
- Prioritize depth over breadth for research queries
- Ensure all information is factual and verifiable
`;

  return basePrompt + intentInstructions[intent] + outputFormat;
}

/**
 * Clean and validate search query
 */
function cleanSearchQuery(query) {
  let cleaned = query;

  // Remove emojis and special symbols
  cleaned = cleaned.replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '');

  // Remove common search instructions
  const instructionPatterns = [
    /^(search\s+for|find\s+me|look\s+for|get\s+me|show\s+me|tell\s+me\s+about)\s+/gi,
    /\s+(please|pls|thanks)$/gi,
  ];

  instructionPatterns.forEach(pattern => {
    cleaned = cleaned.replace(pattern, '');
  });

  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}

/**
 * Validate search query
 */
function isValidSearchQuery(query) {
  const cleanQuery = query.replace(/[^a-zA-Z0-9\s]/g, '').trim();

  if (cleanQuery.length < 2 || !/[a-zA-Z]/.test(cleanQuery)) {
    return false;
  }

  // Check for excessive repeated characters
  const repeatedChars = cleanQuery.match(/(.)\1{3,}/g);
  if (repeatedChars && repeatedChars.join('').length > cleanQuery.length * 0.7) {
    return false;
  }

  return true;
}

/**
 * Enhanced OpenAI Web Search with intelligent prompting
 */
async function searchOpenAIWeb(query, intent, resultCount) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.log("❌ OpenAI API key not configured");
      return { results: [], error: "OpenAI API key not configured" };
    }

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    console.log(`🔎 Searching with gpt-4o-mini (Intent: ${intent}, Results: ${resultCount})...`);

    // Generate intelligent system prompt
    const systemPrompt = generateSystemPrompt(query, intent, resultCount);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini-search-preview-2025-03-11",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Search query: ${query}` }
      ],
      max_tokens: 4000,

    });

    const content = completion.choices[0]?.message?.content?.trim();

    if (!content) {
      console.error("⚠️ No content returned from OpenAI");
      return { results: [], error: "No results returned" };
    }

    // Parse JSON safely
    let results;
    try {
      const cleanedContent = content
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```$/g, '')
        .trim();
      results = JSON.parse(cleanedContent);
    } catch (e) {
      console.warn("⚠️ Could not parse OpenAI response as JSON. Treating as a summary.", e.message);
      results = content; // Fallback to treating the content as a string summary
    }

    // Validate that results is an array before proceeding
    if (!Array.isArray(results)) {
      console.error("⚠️ OpenAI response was not a JSON array as expected. Treating as a summary.");
      // The model generated a text summary instead of a JSON list.
      // We'll format this summary as a single, high-quality search result.
      const summaryResult = {
        title: `AI Summary for "${query}"`,
        url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
        snippet: content, // Use the original, unparsed content
        source: "AI Assistant",
        date: new Date().toISOString().split('T')[0],
        type: "Summary",
        relevance: "High",
        credibility: "N/A"
      };
      results = [summaryResult]; // Put the single summary into an array
    }

    // Validate and enrich results
    const validResults = results
      .filter(r => r.title && r.url && r.url.startsWith('http'))
      .map(r => ({
        ...r,
        database: 'Web Search',
        displayLink: new URL(r.url).hostname.replace('www.', '')
      }));

    return { results: validResults, error: null };

  } catch (err) {
    console.error("OpenAI Web Search error:", err);
    return { results: [], error: err.message };
  }
}

/**
 * Main Web Search Route with Streaming
 */
/**
 * Back-compat proxy to the agentic orchestrator.
 *
 * The legacy POST /api/search/web used to pipe an LLM "search-preview"
 * completion into the chat. That path produced raw JSON when the
 * model's response was non-parseable, and the chat surface rendered
 * the JSON verbatim into the message bubble. See commit 317a8b7 for
 * the canonical agentic implementation and for the chat-interface
 * wiring; here we only preserve the old URL + SSE event shape so
 * cached clients keep working.
 *
 * Event translation:
 *   agentic `start`            → legacy `start` + intro markdown
 *   agentic `batch`            → legacy `content` with a one-line
 *                                progress row (`🟡 [N] provider
 *                                +X/target`)
 *   agentic `batch_error`      → legacy `content` warning line
 *   agentic `provider_done`    → legacy `content` one-liner
 *   agentic `collection_done`  → legacy `content` separator + tally
 *   agentic `ranking_start`    → legacy `content` message
 *   agentic `selected`         → nothing (the final summary carries
 *                                the whole top-K already)
 *   agentic `summary`          → legacy `content` with the markdown
 *                                report (the whole polished output)
 *   agentic `done`             → legacy `done` + persisted dbMessage
 *   agentic `error`            → legacy `error`
 */
router.post(
  '/web',
  [
    body('query').trim().notEmpty().withMessage('Search query is required'),
    body('chatId').optional().isString(),
  ],
  authenticateToken,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { query, chatId } = req.body;
    const userId = req.user.id;
    const cleanedQuery = cleanSearchQuery(query);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const send = (obj) => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ }
    };

    if (!isValidSearchQuery(cleanedQuery)) {
      send({
        type: 'content',
        content: "❌ **Invalid Search Query**\n\nPlease provide a meaningful search query with proper words and terms.",
      });
      send({ type: 'done' });
      try { res.end(); } catch { /* already closed */ }
      return;
    }

    if (chatId) {
      try {
        const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
        if (chat) {
          await prisma.message.create({
            data: {
              chatId,
              role: 'USER',
              content: `🔍 Web Search: ${query}`,
              timestamp: new Date(),
            },
          });
        }
      } catch (persistErr) {
        console.warn('[search/web] failed to persist user turn:', persistErr.message);
      }
    }

    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    send({
      type: 'start',
      content: `🤖 **Búsqueda agéntica** de "${cleanedQuery}"\nObjetivo: 500 fuentes · lotes de 10 · top 25\n\n`,
    });

    let fullContent = `🤖 **Búsqueda agéntica** de "${cleanedQuery}"\nObjetivo: 500 fuentes · lotes de 10 · top 25\n\n`;
    let summaryMarkdown = '';
    let selectedSources = [];
    let finalStats = null;
    let dbMessage = null;

    const append = (piece) => {
      fullContent += piece;
      send({ type: 'content', content: piece });
    };

    try {
      for await (const evt of runAgenticBatch({
        query: cleanedQuery,
        target: 500,
        batchSize: 10,
        topK: 25,
        mailto: req.user?.email || process.env.SEARCH_BRAIN_MAILTO,
        signal: controller.signal,
      })) {
        switch (evt.type) {
          case 'batch':
            append(
              `🟡 \`[${String(evt.batchN).padStart(2, '0')}]\` **${evt.provider}** → +${evt.unique} nuevas` +
              (evt.duplicates > 0 ? ` (·${evt.duplicates} dup)` : '') +
              ` · ${evt.totalCollected}/${evt.target}\n`
            );
            break;
          case 'batch_error':
            append(`⚠️ \`[${evt.batchN}]\` ${evt.provider} falló: ${evt.error}\n`);
            break;
          case 'provider_done':
            append(`✓ **${evt.provider}** agotado (${evt.contributed} contribuidas)\n`);
            break;
          case 'collection_done':
            append(`\n✅ **Recopilación completa:** ${evt.totalCollected} fuentes (${evt.deduped} únicas) en ${(evt.elapsedMs / 1000).toFixed(1)}s\n\n`);
            break;
          case 'ranking_start':
            append(`🧠 ${evt.message}\n\n`);
            break;
          case 'rerank_error':
            append(`⚠️ Reranking parcial: ${evt.error}\n`);
            break;
          case 'selected':
            selectedSources = Array.isArray(evt.sources) ? evt.sources : [];
            append(`✨ **Top ${evt.topK} seleccionado**${evt.rerankerWasUsed ? ' con reranker LLM' : ' (heurístico)'}.\n\n---\n\n`);
            break;
          case 'summary':
            summaryMarkdown = typeof evt.markdown === 'string' ? evt.markdown : '';
            // The trace lines above already narrate the run — the
            // summary is the polished report the user actually wants
            // to keep, so it becomes the canonical dbMessage content.
            append(summaryMarkdown);
            break;
          case 'done':
            finalStats = evt.stats || null;
            break;
          case 'error':
            send({ type: 'error', error: evt.message || 'agentic search failed' });
            try { res.end(); } catch { /* already closed */ }
            return;
          default:
            // Unhandled event types (aborted, persist_error, etc.)
            // are silently dropped — they don't map to the legacy
            // wire format and the agentic endpoint handles them.
            break;
        }
      }

      // Save the final polished report as the assistant message so a
      // chat reload shows the top-K report (not the progress trace).
      if (chatId && (summaryMarkdown || fullContent)) {
        try {
          const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
          if (chat) {
            dbMessage = await prisma.message.create({
              data: {
                chatId,
                role: 'ASSISTANT',
                content: summaryMarkdown || fullContent,
                tokens: Math.ceil((summaryMarkdown || fullContent).length / 4),
                timestamp: new Date(),
                metadata: {
                  source: 'agentic-search',
                  selectedSources,
                  stats: finalStats,
                },
              },
            });
          }
        } catch (persistErr) {
          console.warn('[search/web] failed to persist assistant message:', persistErr.message);
        }
      }

      send({
        type: 'done',
        results: selectedSources,
        dbMessage: dbMessage ? serializeBigIntFields(dbMessage) : null,
        stats: finalStats,
      });
      try { res.end(); } catch { /* already closed */ }
    } catch (error) {
      console.error('[search/web] agentic pipeline error:', error);
      const msg = String(error?.message || error || 'agentic search failed');
      let friendly = 'Hubo un problema con la búsqueda. Por favor intenta de nuevo.';
      if (/429|rate.?limit|too many/i.test(msg)) friendly = 'El servidor está procesando muchas solicitudes. Intenta de nuevo en unos segundos.';
      else if (/timeout|timed.?out|ETIMEDOUT/i.test(msg)) friendly = 'La búsqueda tardó demasiado. Intenta de nuevo.';
      send({ type: 'error', error: friendly });
      try { res.end(); } catch { /* already closed */ }
    }
  }
);

module.exports = router;
