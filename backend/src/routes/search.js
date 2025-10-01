// const express = require('express');
// const { body, validationResult } = require('express-validator');
// const { authenticateToken } = require('../middleware/auth');
// const prisma = require('../config/database');

// const router = express.Router();

// // Google Custom Search API
// // Google Custom Search API
// async function performGoogleSearch(query, apiKey, searchEngineId) {
//   try {
//     const response = await fetch(
//       `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${searchEngineId}&q=${encodeURIComponent(query)}&num=10`
//     );

//     if (!response.ok) {
//       throw new Error(`Google Search: ${response.status}`);
//     }

//     const data = await response.json();

//     return data.items?.map(item => {
//       const thumbnail = item.pagemap?.cse_image?.[0]?.src || item.pagemap?.cse_thumbnail?.[0]?.src || null;
//       const meta = item.pagemap || {};

//       return {
//         title: item.title,
//         url: item.link,
//         snippet: item.snippet,
//         displayLink: item.displayLink,
//         image: thumbnail, // ✅ preview image
//         author: meta.person?.[0]?.name || null, // if schema.org person exists
//         date: meta.article?.[0]?.datepublished || meta.newsarticle?.[0]?.datepublished || null, // if available
//         rating: meta.aggregateRating?.[0]?.ratingValue || null, // e.g., reviews
//       };
//     }) || [];
//   } catch (error) {
//     console.error('Google Search API error:', error);
//     throw error;
//   }
// }

// // Web Search endpoint  without stream (Old version):
// // router.post(
// //   '/web',
// //   [
// //     body('query').trim().notEmpty().withMessage('Search query is required'),
// //     body('chatId').optional().isString(),
// //   ],
// //   authenticateToken,
// //   async (req, res) => {
// //     try {
// //       const errors = validationResult(req);
// //       if (!errors.isEmpty()) {
// //         return res.status(400).json({ errors: errors.array() });
// //       }

// //       const { query, chatId } = req.body;
// //       const userId = req.user.id;

// //       // Check if Google Search API credentials are available
// //       const googleApiKey = process.env.GOOGLE_API_KEY;
// //       const searchEngineId = process.env.GOOGLE_SEARCH_ENGINE_ID;

// //       if (!googleApiKey || !searchEngineId) {
// //         return res.status(500).json({ 
// //           error: 'Google Search API not configured. Please set GOOGLE_API_KEY and GOOGLE_SEARCH_ENGINE_ID environment variables.' 
// //         });
// //       }

// //       // Check monthly limit
// //       if (req.user.apiUsage >= req.user.monthlyLimit) {
// //         return res.status(429).json({
// //           error: 'Monthly API limit exceeded',
// //           usage: { current: req.user.apiUsage, limit: req.user.monthlyLimit },
// //         });
// //       }

// //       // Perform Google Search
// //       const searchResults = await performGoogleSearch(query, googleApiKey, searchEngineId);

// //       // Format search results for chat
// //       const searchContent = `**Web Search Results for: "${query}"**\n\n` +
// //         searchResults.map((result, index) => 
// //           `**${index + 1}. [${result.title}](${result.url})**\n` +
// //           `${result.snippet}\n` +
// //           `Source: ${result.displayLink}\n`
// //         ).join('\n') +
// //         '\n---\n*Search completed using Google Custom Search API*';

// //       // Save messages if chatId provided
// //       if (chatId) {
// //         const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
// //         if (chat) {
// //           // Save user search query
// //           await prisma.message.create({
// //             data: {
// //               chatId,
// //               role: 'USER',
// //               content: `🔍 Web Search: ${query}`,
// //               timestamp: new Date(), // Use timestamp field
// //             }
// //           });

// //           // Save search results
// //           await prisma.message.create({
// //             data: { 
// //               chatId, 
// //               role: 'ASSISTANT', 
// //               content: searchContent, 
// //               tokens: searchContent.length,
// //               timestamp: new Date(), // Use timestamp field
// //             }
// //           });

// //           // Update chat
// //           await prisma.chat.update({
// //             where: { id: chatId },
// //             data: {
// //               updatedAt: new Date(),
// //               title: chat.title === 'New Chat'
// //                 ? `Search: ${query.slice(0, 30)}${query.length > 30 ? '...' : ''}`
// //                 : chat.title
// //             }
// //           });
// //         }
// //       }

// //       // Track usage (minimal cost for search)
// //       const tokens = 50; // Fixed token cost for search
// //       await prisma.apiUsage.create({
// //         data: { userId, model: 'google-search', tokens, cost: tokens * 0.001 }
// //       });

// //       const updatedUser = await prisma.user.update({
// //         where: { id: userId },
// //         data: { apiUsage: { increment: tokens } }
// //       });

// //       res.json({
// //         results: searchResults,
// //         content: searchContent,
// //         tokens,
// //         usage: { current: updatedUser.apiUsage, limit: updatedUser.monthlyLimit }
// //       });

// //     } catch (error) {
// //       console.error('Web search error:', error);
// //       res.status(500).json({ error: error.message || 'Web search failed' });
// //     }
// //   }
// // );
// // Replace the existing route with this streaming version:

// router.post(
//   '/web',
//   [
//     body('query').trim().notEmpty().withMessage('Search query is required'),
//     body('chatId').optional().isString(),
//   ],
//   authenticateToken,
//   async (req, res) => {
//     try {
//       const errors = validationResult(req);
//       if (!errors.isEmpty()) {
//         return res.status(400).json({ errors: errors.array() });
//       }

//       const { query, chatId } = req.body;
//       const userId = req.user.id;

//       // Check API credentials
//       const googleApiKey = process.env.GOOGLE_API_KEY;
//       const searchEngineId = process.env.GOOGLE_SEARCH_ENGINE_ID;

//       if (!googleApiKey || !searchEngineId) {
//         return res.status(500).json({
//           error: 'Google Search API not configured.'
//         });
//       }

//       // Set up streaming headers
//       res.setHeader('Content-Type', 'text/event-stream');
//       res.setHeader('Cache-Control', 'no-cache');
//       res.setHeader('Connection', 'keep-alive');
//       res.setHeader('X-Accel-Buffering', 'no');
//       res.flushHeaders();

//       // Save user search query first
//       if (chatId) {
//         const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
//         if (chat) {
//           await prisma.message.create({
//             data: {
//               chatId,
//               role: 'USER',
//               content: `🔍 Web Search: ${query}`,
//               timestamp: new Date(),
//             }
//           });
//         }
//       }

//       // Stream initial message
//       res.write(`data: ${JSON.stringify({ type: 'start', content: '🔍 Searching the web...\n\n' })}\n\n`);

//       // Perform search
//       const searchResults = await performGoogleSearch(query, googleApiKey, searchEngineId);

//       // Stream title
//       const title = `**Web Search Results for: "${query}"**\n\n`;
//       res.write(`data: ${JSON.stringify({ type: 'content', content: title })}\n\n`);
//       console.log('Search Results:', searchResults);
//       // Stream each result with delay for typing effect
//       for (let i = 0; i < searchResults.length; i++) {
//         const result = searchResults[i];
//         let resultText = `**${i + 1}. [${result.title}](${result.url})**\n${result.snippet}\nSource: ${result.displayLink}`;

//         if (result.image) {
//           resultText += `\n![preview](${result.image})`; // ✅ render preview image (Markdown)
//         }
//         if (result.date) {
//           resultText += `\n🗓️ Published: ${result.date}`;
//         }
//         if (result.author) {
//           resultText += `\n✍️ Author: ${result.author}`;
//         }
//         if (result.rating) {
//           resultText += `\n⭐ Rating: ${result.rating}`;
//         }

//         resultText += '\n\n';

//         res.write(`data: ${JSON.stringify({ type: 'content', content: resultText })}\n\n`);
//         await new Promise(resolve => setTimeout(resolve, 300));
//       }


//       // Stream completion
//       const footer = '\n---\n*Search completed using Google Custom Search API*';
//       res.write(`data: ${JSON.stringify({ type: 'content', content: footer })}\n\n`);

//       // Final message
//       const fullContent = title +
//         searchResults.map((result, index) =>
//           `**${index + 1}. [${result.title}](${result.url})**\n${result.snippet}\nSource: ${result.displayLink}\n`
//         ).join('\n') + footer;

//       // Save complete response
//       if (chatId) {
//         const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
//         if (chat) {
//           await prisma.message.create({
//             data: {
//               chatId,
//               role: 'ASSISTANT',
//               content: fullContent,
//               tokens: 50,
//               timestamp: new Date(),
//             }
//           });
//         }
//       }

//       res.write(`data: ${JSON.stringify({ type: 'done', results: searchResults })}\n\n`);
//       res.end();

//     } catch (error) {
//       console.error('Web search error:', error);
//       res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
//       res.end();
//     }
//   }
// );
// module.exports = router;

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const fetch = require('node-fetch');
const xml2js = require('xml2js');
const OpenAI = require('openai');

const router = express.Router();

/**
 * Check if query is meaningful for search
 */
function isValidSearchQuery(query) {
  // Remove special characters and check length
  const cleanQuery = query.replace(/[^a-zA-Z0-9\s]/g, '').trim();

  // Must be at least 2 characters and contain letters
  if (cleanQuery.length < 2 || !/[a-zA-Z]/.test(cleanQuery)) {
    return false;
  }

  // Check if it's just random characters (more than 70% consecutive repeated chars)
  const repeatedChars = cleanQuery.match(/(.)\1{3,}/g);
  if (repeatedChars && repeatedChars.join('').length > cleanQuery.length * 0.7) {
    return false;
  }

  return true;
}

/**
 * Clean search query while preserving user intent
 * Extracts the core search topic from natural language queries
 */
function cleanSearchQuery(query) {
  let cleaned = query;

  // Remove emojis and special symbols
  cleaned = cleaned.replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '');

  // Remove common search instructions and phrases
  const instructionPatterns = [
    /^(search\s+for|find\s+me|look\s+for|get\s+me|show\s+me|tell\s+me\s+about)\s+/gi,
    /\s+(please|pls)$/gi,
    /find\s+me\s+\d+\s+(scientific\s+)?(articles?|papers?|studies?)/gi,
    /\d+\s+(scientific\s+)?(articles?|papers?|studies?)\s+on\s+/gi,
    /\s+on\s+this\s+topic$/gi,
    /just\s+like\s+that$/gi,
  ];

  instructionPatterns.forEach(pattern => {
    cleaned = cleaned.replace(pattern, '');
  });

  // Extract key terms from natural language
  // Remove question words at the beginning
  cleaned = cleaned.replace(/^(what\s+is\s+the|what\s+are\s+the|how\s+does|how\s+do|why\s+does|why\s+do|when\s+does|when\s+do|where\s+does|where\s+do)\s+/gi, '');

  // Clean up common phrases
  cleaned = cleaned.replace(/\s+(influence\s+of|effect\s+of|impact\s+of|role\s+of)\s+/gi, ' ');
  cleaned = cleaned.replace(/\s+(and\s+its|on\s+the|in\s+the|of\s+the|for\s+the)\s+/gi, ' ');

  // Remove extra whitespace and trim
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  console.log(`🧹 Query cleaned: "${query}" → "${cleaned}"`);
  return cleaned;
}

/**
 * Filter out low-quality results
 */
function filterQualityResults(results, query) {
  return results.filter(result => {
    // Ensure title is a string
    const title = typeof result.title === 'string' ? result.title : String(result.title || '');

    // Filter out results with default/placeholder values
    if (title.includes('Untitled') ||
      title === 'Article Title' ||
      title === 'Research Article' ||
      result.authors === 'Unknown authors' ||
      result.journal === 'Unknown Journal' ||
      result.journal === 'SciELO Journal' ||
      title.length < 10) {
      return false;
    }

    // Filter out results without proper URLs
    if (!result.url || result.url === '#' || result.url.includes('unknown')) {
      return false;
    }

    // Basic relevance check - title should contain at least one word from query
    const queryWords = query.toLowerCase().split(/\s+/).filter(word => word.length > 2);
    const titleWords = result.title.toLowerCase();
    const hasRelevantKeyword = queryWords.some(word => titleWords.includes(word));

    return hasRelevantKeyword || result.title.length > 20; // Allow longer titles even without keyword match
  });
}

/**
 * Enhanced arXiv Search with comprehensive metadata
 */
async function searchArXiv(query, maxResults = 30) {
  try {
    console.log(`📚 arXiv: Searching for "${query}" (max: ${maxResults})`);
    const base = 'http://export.arxiv.org/api/query';
    const params = new URLSearchParams({
      search_query: `all:${query}`,
      start: '0',
      max_results: String(maxResults),
      sortBy: 'relevance',
      sortOrder: 'descending',
    });

    const url = `${base}?${params.toString()}`;
    console.log(`📚 arXiv: Request URL: ${url}`);
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'OpenWebUI/1.0 (arXiv Search)'
      }
    });

    if (!res.ok) {
      console.error(`arXiv API error: ${res.status} ${res.statusText}`);
      return [];
    }

    const xml = await res.text();
    const parsed = await xml2js.parseStringPromise(xml, { explicitArray: true, mergeAttrs: true });
    const entries = parsed?.feed?.entry || [];
    console.log(`📚 arXiv: Found ${entries.length} raw entries`);

    const results = entries.map((e) => {
      const title = (e.title?.[0] || '').replace(/\s+/g, ' ').trim();
      const summary = (e.summary?.[0] || '').replace(/\s+/g, ' ').trim();
      const published = e.published?.[0] || null;
      const updated = e.updated?.[0] || null;
      const year = published ? new Date(published).getFullYear() : null;

      // Get all authors (not limited to 5)
      const authors = (e.author || [])
        .map((a) => a?.name?.[0])
        .filter(Boolean);
      const authorsDisplay = authors.slice(0, 5).join(', ') + (authors.length > 5 ? ` et al. (${authors.length} total)` : '');

      // Get links
      const links = (e.link || []);
      const pdfLink = links.find(l => l.rel?.[0] === 'related' && /pdf/.test(l.title?.[0] || ''))?.href?.[0]
        || links.find(l => l.type?.[0] === 'application/pdf')?.href?.[0];
      const altLink = links.find(l => l.rel?.[0] === 'alternate')?.href?.[0];
      const url = pdfLink || altLink || null;

      // Get categories
      const categories = (e.category || []).map(c => c.term?.[0]).filter(Boolean);
      const primaryCategory = e['arxiv:primary_category']?.[0]?.term?.[0] || categories[0] || '';
      const categoriesDisplay = categories.slice(0, 3).join(', ') + (categories.length > 3 ? '...' : '');

      // Get arXiv ID for citation count lookup
      const arxivId = e.id?.[0]?.split('/abs/')?.[1] || '';

      // Validate essential fields
      if (!title || title.length < 10 || !url) {
        return null;
      }

      // Create comprehensive snippet with all metadata - FULL ABSTRACT
      const snippet = `📝 **Abstract:** ${summary}\n\n` +
        `👥 **Authors:** ${authorsDisplay}\n` +
        `🏷️ **Categories:** ${categoriesDisplay}\n` +
        `📅 **Published:** ${published ? new Date(published).toLocaleDateString() : 'N/A'}\n` +
        `🔄 **Updated:** ${updated ? new Date(updated).toLocaleDateString() : 'N/A'}\n` +
        `🆔 **arXiv ID:** ${arxivId}\n` +
        `📄 **PDF:** [Download](${pdfLink || url})`;

      return {
        title,
        url,
        snippet,
        displayLink: 'arxiv.org',
        authors: authorsDisplay,
        journal: 'arXiv',
        year: year ? String(year) : 'N/A',
        doi: null,
        type: 'preprint',
        abstract: summary,
        categories: categoriesDisplay,
        primaryCategory,
        arxivId,
        pdfUrl: pdfLink,
        publishedDate: published,
        updatedDate: updated,
        database: 'arXiv'
      };
    }).filter(Boolean);

    console.log(`📚 arXiv: Mapped ${results.length} valid results (after null filter)`);
    const filtered = filterQualityResults(results, query);
    console.log(`📚 arXiv: Returning ${filtered.length} quality results`);
    return filtered;
  } catch (err) {
    console.error('arXiv error:', err);
    return [];
  }
}

/**
 * Enhanced PubMed Search with comprehensive metadata and abstracts
 */
async function searchPubMed(query, maxResults = 10) {
  try {
    // Step 1: Search for PubMed IDs
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${maxResults}&retmode=json&sort=relevance`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    if (!searchData.esearchresult?.idlist?.length) return [];

    // Step 2: Get detailed information including abstracts
    const ids = searchData.esearchresult.idlist.slice(0, maxResults);
    const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${ids.join(',')}&retmode=xml`;
    const summaryRes = await fetch(summaryUrl);
    const xmlData = await summaryRes.text();

    // Parse XML response
    const parsed = await xml2js.parseStringPromise(xmlData, { explicitArray: true, mergeAttrs: true });
    const articles = parsed?.PubmedArticleSet?.PubmedArticle || [];

    const results = articles.map(article => {
      const medlineCitation = article?.MedlineCitation?.[0];
      const pubmedData = article?.PubmedData?.[0];

      if (!medlineCitation) return null;

      const articleData = medlineCitation?.Article?.[0];
      if (!articleData) return null;

      // Extract title - ensure it's a string
      const rawTitle = articleData?.ArticleTitle?.[0];
      const title = typeof rawTitle === 'string' ? rawTitle : (rawTitle?._ || String(rawTitle || ''));
      if (!title || title.length < 10) return null;

      // Extract abstract
      const abstractObj = articleData?.Abstract?.[0];
      const abstractTexts = abstractObj?.AbstractText || [];
      const abstract = abstractTexts.map(a => {
        if (typeof a === 'string') return a;
        if (a._) return `${a.Label ? a.Label + ': ' : ''}${a._}`;
        return '';
      }).filter(Boolean).join('\n');

      // Extract authors
      const authorList = articleData?.AuthorList?.[0]?.Author || [];
      const authors = authorList
        .map(a => {
          const lastName = a?.LastName?.[0] || '';
          const foreName = a?.ForeName?.[0] || '';
          return foreName && lastName ? `${foreName} ${lastName}` : (lastName || '');
        })
        .filter(Boolean);
      const authorsDisplay = authors.slice(0, 5).join(', ') + (authors.length > 5 ? ` et al. (${authors.length} total)` : '');

      // Extract journal information
      const journal = articleData?.Journal?.[0];
      const journalTitle = journal?.Title?.[0] || journal?.ISOAbbreviation?.[0] || 'PubMed';

      // Extract publication date
      const pubDate = journal?.JournalIssue?.[0]?.PubDate?.[0];
      const year = pubDate?.Year?.[0] || null;
      const month = pubDate?.Month?.[0] || '';
      const day = pubDate?.Day?.[0] || '';

      // Extract PMID and DOI
      const pmid = medlineCitation?.PMID?.[0]?._ || medlineCitation?.PMID?.[0] || '';
      const articleIds = pubmedData?.ArticleIdList?.[0]?.ArticleId || [];
      const doi = articleIds.find(id => id.IdType === 'doi')?._ || null;

      // Extract MeSH terms
      const meshTerms = medlineCitation?.MeshHeadingList?.[0]?.MeshHeading || [];
      const keywords = meshTerms
        .map(m => m?.DescriptorName?.[0]?._ || m?.DescriptorName?.[0])
        .filter(Boolean)
        .slice(0, 5);

      // Build URL
      const url = doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;

      // Create comprehensive snippet - FULL ABSTRACT
      const snippet = `📝 **Abstract:** ${abstract || 'No abstract available'}\n\n` +
        `👥 **Authors:** ${authorsDisplay || 'Unknown authors'}\n` +
        `📚 **Journal:** ${journalTitle}\n` +
        `📅 **Published:** ${year || 'N/A'}${month ? ` ${month}` : ''}${day ? ` ${day}` : ''}\n` +
        `🆔 **PMID:** ${pmid}\n` +
        (doi ? `� **DOI:** ${doi}\n` : '') +
        (keywords.length ? `🏷️ **Keywords:** ${keywords.join(', ')}` : '');

      return {
        title,
        url,
        snippet,
        displayLink: "ncbi.nlm.nih.gov",
        authors: authorsDisplay,
        journal: journalTitle,
        year: year ? year.toString() : "N/A",
        doi,
        pmid,
        abstract,
        keywords,
        type: "research_article",
        database: "PubMed"
      };
    }).filter(Boolean);

    return filterQualityResults(results, query);
  } catch (err) {
    console.error("PubMed error:", err);
    return [];
  }
}

/**
 * Enhanced Scopus Search with quality filtering and comprehensive metadata
 */
async function searchScopus(query, maxResults = 10) {
  try {
    if (!process.env.SCOPUS_API_KEY) {
      console.log("Scopus API key not configured, skipping Scopus search");
      return [];
    }

    const searchQuery = `TITLE-ABS-KEY(${query})`;
    const url = `https://api.elsevier.com/content/search/scopus?query=${encodeURIComponent(searchQuery)}&count=${maxResults}&field=title,creator,prism:publicationName,prism:coverDate,prism:doi,dc:description,citedby-count,prism:aggregationType,affiliation,authkeywords`;

    const res = await fetch(url, {
      headers: {
        "X-ELS-APIKey": process.env.SCOPUS_API_KEY,
        "Accept": "application/json"
      }
    });

    if (!res.ok) {
      console.error(`Scopus API error: ${res.status} ${res.statusText}`);
      return [];
    }

    const data = await res.json();
    const entries = data?.["search-results"]?.entry || [];

    if (!entries.length) return [];

    const results = entries.map((item) => {
      // Handle title (can be array or string)
      const title = Array.isArray(item["dc:title"])
        ? item["dc:title"][0]
        : item["dc:title"];

      // Skip if no proper title
      if (!title || title.length < 10 || title.includes('Untitled')) {
        return null;
      }

      // Handle authors
      const authors = item["dc:creator"]
        ? (Array.isArray(item["dc:creator"])
          ? item["dc:creator"].slice(0, 3).join(", ")
          : item["dc:creator"])
        : null;

      // Skip if no authors
      if (!authors) {
        return null;
      }

      // Publication details
      const journal = item["prism:publicationName"];
      const year = item["prism:coverDate"]
        ? new Date(item["prism:coverDate"]).getFullYear()
        : null;


      const citations = item["citedby-count"] || "0";

      const docType = item["prism:aggregationType"] || "Article";

      const doi = item["prism:doi"];
      const url = doi ? `https://doi.org/${doi}` : (item["prism:url"] || `https://www.scopus.com/record/display.uri?eid=2-s2.0-${item['eid']}&origin=resultslist`);

      if (!url) {
        return null;
      }


      const description = item["dc:description"] || title;
      const authorKeywords = item["authkeywords"] || '';

      const snippet = `📝 **Abstract:** ${description || title}\n\n` +
        `� **Authors:** ${authors}\n` +
        `📚 **Journal:** ${journal || 'Scopus Journal'}\n` +
        `📅 **Year:** ${year || 'N/A'}\n` +
        `📊 **Citations:** ${citations}\n` +
        `📄 **Type:** ${docType}\n` +
        (doi ? `🔗 **DOI:** ${doi}\n` : '') +
        (authorKeywords ? `🏷️ **Keywords:** ${authorKeywords}` : '');

      return {
        title,
        url,
        snippet,
        displayLink: "scopus.com",
        authors,
        journal: journal || "Scopus Journal",
        year: year ? year.toString() : "N/A",
        citations: citations.toString(),
        doi,
        type: docType.toLowerCase(),
        database: "Scopus"
      };
    }).filter(Boolean); // Remove null entries

    return filterQualityResults(results, query);
  } catch (err) {
    console.error("Scopus error:", err);
    return [];
  }
}

/**
 * Enhanced Web of Science Search with quality filtering and comprehensive metadata
 */
async function searchWebOfScience(query, maxResults = 30) {
  try {
    if (!process.env.WOS_API_KEY) {
      console.log("Web of Science API key not configured, skipping WoS search");
      return [];
    }

    const url = `https://api.clarivate.com/api/woslite/v1/documents?q=${encodeURIComponent(query)}&count=${maxResults}&offset=0`;

    const res = await fetch(url, {
      headers: {
        "X-ApiKey": process.env.WOS_API_KEY,
        "Accept": "application/json"
      }
    });

    if (!res.ok) {
      console.error(`WoS API error: ${res.status} ${res.statusText}`);
      return [];
    }

    const data = await res.json();
    const records = data?.Data || [];

    if (!records.length) return [];

    const results = records.map(item => {
      const title = item.title?.[0];
      const authors = item.author?.slice(0, 3).join(", ");
      const journal = item.source?.[0];
      const year = item.published_year;
      const abstract = item.abstract;

      // Skip if missing essential data
      if (!title || title.length < 10 || !authors || title.includes('Untitled')) {
        return null;
      }

      const doi = item.identifier?.doi?.[0];
      const url = doi ? `https://doi.org/${doi}` : (item.url || null);

      // Skip if no URL
      if (!url) {
        return null;
      }

      const citations = item.times_cited || "0";
      const snippet = `${abstract || title}\n👤 Authors: ${authors}\n📚 Journal: ${journal || 'WoS Journal'}\n📅 Year: ${year || 'N/A'}\n📊 Citations: ${citations}`;

      return {
        title,
        url,
        snippet,
        displayLink: "webofscience.com",
        authors,
        journal: journal || "Web of Science Journal",
        year: year ? year.toString() : "N/A",
        citations: citations.toString(),
        doi,
        database: "Web of Science",
        type: "research_article"
      };
    }).filter(Boolean);

    return filterQualityResults(results, query);
  } catch (err) {
    console.error("Web of Science error:", err);
    return [];
  }
}

/**
 * Enhanced SciELO Search with quality filtering
 */
async function searchSciELO(query) {
  try {
    console.log('Searching SciELO...');

    const endpoints = [
      `https://search.scielo.org/api/v1/search/?q=${encodeURIComponent(query)}&lang=en&format=json&page=1&count=15`,
      `https://articlemeta.scielo.org/api/v1/article/identifiers/?collection=scl&issn=&limit=15&offset=0&from=&until=&extra_filter=${encodeURIComponent(query)}`,
      `https://search.scielo.org/?q=${encodeURIComponent(query)}&lang=en&count=15&from=0&output=site&sort=&format=summary&fb=&page=1`
    ];

    let results = [];

    for (let i = 0; i < endpoints.length; i++) {
      try {
        console.log(`Trying SciELO endpoint ${i + 1}...`);

        const response = await fetch(endpoints[i], {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'application/json, text/html, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache'
          },
          timeout: 10000
        });

        if (response.ok) {
          const contentType = response.headers.get('content-type');

          if (contentType && contentType.includes('application/json')) {
            const data = await response.json();
            results = await parseSciELOResponse(data, i, query);
            if (results.length > 0) {
              console.log(`SciELO endpoint ${i + 1} successful, found ${results.length} results`);
              break;
            }
          } else {
            const html = await response.text();
            results = await parseSciELOHTML(html, query);
            if (results.length > 0) {
              console.log(`SciELO HTML parsing successful, found ${results.length} results`);
              break;
            }
          }
        } else {
          console.log(`SciELO endpoint ${i + 1} failed: ${response.status} ${response.statusText}`);
        }
      } catch (endpointError) {
        console.log(`SciELO endpoint ${i + 1} error:`, endpointError.message);
        continue;
      }
    }

    return filterQualityResults(results, query);

  } catch (error) {
    console.error('SciELO search error:', error);
    return [];
  }
}

// Helper function to parse SciELO responses with quality checks
async function parseSciELOResponse(data, endpointIndex, query) {
  const results = [];

  try {
    if (endpointIndex === 0) {
      const items = data.response?.docs || data.docs || [];

      items.forEach((item, index) => {
        if (index < 15) {
          const title = item.ti_en || item.ti || item.title;
          const authors = item.au || item.authors;

          // Skip if missing essential data or poor quality
          if (!title || title.length < 10 || title === 'Article Title' || !authors) {
            return;
          }

          results.push({
            title: title,
            authors: Array.isArray(authors) ? authors : [authors],
            journal: item.ta || item.journal || 'SciELO Journal',
            year: item.da || item.year || new Date().getFullYear(),
            abstract: item.ab_en || item.ab || item.abstract || 'No abstract available',
            doi: item.doi || null,
            url: item.url || `https://www.scielo.br/article/${item.id || 'unknown'}`,
            type: item.type || 'Article',
            language: item.la || 'en'
          });
        }
      });
    } else if (endpointIndex === 1) {
      const items = data.objects || data.results || [];

      items.forEach((item, index) => {
        if (index < 15) {
          const title = item.title;
          const authors = item.authors;

          // Skip if missing essential data
          if (!title || title.length < 10 || title === 'Research Article' || !authors) {
            return;
          }

          results.push({
            title: title,
            authors: Array.isArray(authors) ? authors.map(a => a.name || a) : [authors],
            journal: item.journal || 'SciELO Collection',
            year: item.publication_year || new Date().getFullYear(),
            abstract: item.abstract || 'Abstract not available',
            doi: item.doi || null,
            url: item.html_url || item.pdf_url || 'https://www.scielo.br',
            type: 'Article',
            language: item.original_language || 'en'
          });
        }
      });
    }
  } catch (parseError) {
    console.error('Error parsing SciELO response:', parseError);
  }

  return results;
}

// Helper function to parse HTML response with quality checks
async function parseSciELOHTML(html, query) {
  const results = [];

  try {
    const titleMatches = html.match(/<h3[^>]*>(.*?)<\/h3>/gi) || [];
    const authorMatches = html.match(/authors?[^>]*>(.*?)</gi) || [];

    titleMatches.slice(0, 15).forEach((titleMatch, index) => {
      const title = titleMatch.replace(/<[^>]*>/g, '').trim();
      const author = authorMatches[index] ? authorMatches[index].replace(/<[^>]*>/g, '').trim() : null;

      // Only include if we have meaningful data
      if (title && title.length > 10 && author && !title.includes('SciELO Article')) {
        results.push({
          title: title,
          authors: [author],
          journal: 'SciELO Database',
          year: new Date().getFullYear(),
          abstract: 'Abstract available on SciELO platform',
          doi: null,
          url: 'https://www.scielo.br',
          type: 'Article',
          language: 'en'
        });
      }
    });
  } catch (parseError) {
    console.error('Error parsing SciELO HTML:', parseError);
  }

  return results;
}

/**
 * Enhanced Crossref Search with comprehensive metadata
 */
async function searchCrossref(query, maxResults = 10) {
  try {
    console.log(`🔗 Crossref: Searching for "${query}" (max: ${maxResults})`);

    // Crossref API endpoint
    const baseUrl = 'https://api.crossref.org/works';
    const params = new URLSearchParams({
      query: query,
      rows: String(maxResults),
      sort: 'relevance',
      order: 'desc'
    });

    const url = `${baseUrl}?${params.toString()}`;
    console.log(`🔗 Crossref: Request URL: ${url}`);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'OpenWebUI/1.0 (mailto:contact@example.com)', // Crossref requires a User-Agent
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.error(`Crossref API error: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = await response.json();
    const items = data?.message?.items || [];
    console.log(`🔗 Crossref: Found ${items.length} raw entries`);

    const results = items.map((item) => {
      // Extract title
      const title = Array.isArray(item.title) ? item.title[0] : item.title;
      if (!title || title.length < 10) return null;

      // Extract authors
      const authors = item.author ?
        item.author.slice(0, 5).map(a => `${a.given || ''} ${a.family || ''}`.trim()).filter(Boolean).join(', ') +
        (item.author.length > 5 ? ` et al. (${item.author.length} total)` : '')
        : 'Unknown authors';

      // Extract journal/container
      const journal = Array.isArray(item['container-title']) ?
        item['container-title'][0] :
        (item['container-title'] || 'Crossref Journal');

      // Extract publication date
      const publishedDate = item.published || item['published-print'] || item['published-online'];
      const year = publishedDate ? publishedDate['date-parts']?.[0]?.[0] : null;

      // Extract DOI and create URL
      const doi = item.DOI;
      const url = doi ? `https://doi.org/${doi}` : null;
      if (!url) return null;

      // Extract abstract or use title
      const abstract = item.abstract || `Research article published in ${journal}`;

      // Extract additional metadata
      const type = item.type || 'journal-article';
      const publisher = item.publisher || 'Unknown Publisher';
      const citationCount = item['is-referenced-by-count'] || 0;

      // Create comprehensive snippet
      const snippet = `📝 **Abstract:** ${abstract}\n\n` +
        `👥 **Authors:** ${authors}\n` +
        `📚 **Journal:** ${journal}\n` +
        `🏢 **Publisher:** ${publisher}\n` +
        `📅 **Published:** ${year || 'N/A'}\n` +
        `📊 **Citations:** ${citationCount}\n` +
        `🔗 **DOI:** ${doi}\n` +
        `📄 **Type:** ${type.replace('-', ' ')}`;

      return {
        title,
        url,
        snippet,
        displayLink: 'doi.org',
        authors,
        journal,
        year: year ? String(year) : 'N/A',
        doi,
        type,
        abstract,
        publisher,
        citations: String(citationCount),
        database: 'Crossref'
      };
    }).filter(Boolean);

    console.log(`🔗 Crossref: Mapped ${results.length} valid results`);
    const filtered = filterQualityResults(results, query);
    console.log(`🔗 Crossref: Returning ${filtered.length} quality results`);
    return filtered;
  } catch (err) {
    console.error('Crossref error:', err);
    return [];
  }
}

async function searchOpenAIWeb(query) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.log("OpenAI API key not configured, skipping OpenAI Web Search");
      return [];
    }

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    console.log('🤖 OpenAI: Searching for comprehensive information...');

    // Enhanced prompt for better topic coverage
    const prompt = `You are a research assistant providing comprehensive information about: "${query}"

Please provide a detailed, well-structured response covering:
1. Definition and overview of the topic
2. Current state of research and knowledge
3. Key findings, facts, and important points
4. Recent developments or trends
5. Practical applications or implications
6. Notable researchers, institutions, or sources if applicable

Make your response informative, accurate, and comprehensive. Focus on providing valuable insights about this specific topic.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are an expert research assistant providing comprehensive, accurate information on any topic. Provide detailed, well-structured responses with factual information." },
        { role: "user", content: prompt },
      ],
      max_tokens: 2000,
      temperature: 0.3,
    });

    const content = completion.choices[0]?.message?.content;

    if (content) {
      // Format with rich metadata like other sources
      const currentDate = new Date();
      const snippet = `🤖 **AI-Generated Research Summary:**\n\n${content}\n\n` +
        `📊 **Source:** OpenAI GPT-4o-mini Knowledge Base\n` +
        `📅 **Generated:** ${currentDate.toLocaleDateString()} at ${currentDate.toLocaleTimeString()}\n` +
        `🔍 **Query:** ${query}\n` +
        `⚡ **Model:** GPT-4o-mini (OpenAI)\n` +
        `📚 **Type:** Comprehensive AI Research Summary`;

      console.log(`🤖 OpenAI: Generated comprehensive summary (${content.length} characters)`);

      return [{
        title: `Comprehensive Summary: ${query}`,
        url: `#ai-summary-${Date.now()}`, // Use a hash link instead of external URL
        snippet: snippet,
        displayLink: "AI Generated Summary",
        authors: "OpenAI GPT-4o-mini",
        journal: "AI Knowledge Base",
        year: currentDate.getFullYear().toString(),
        type: "ai_research_summary",
        database: "GPT-4o-mini-search"
      }];
    }
    return [];
  } catch (err) {
    console.error("OpenAI Web Search error:", err);
    return [];
  }
}

/* ORIGINAL CODE - DISABLED UNTIL API SUPPORTS web_search_preview
async function searchOpenAIWebOriginal(query) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.log("OpenAI API key not configured, skipping OpenAI Web Search");
      return [];
    }

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    console.log('Searching OpenAI for web results...');

    // Prompt the GPT-4o model to act as a web search engine and summarize
    const prompt = `Please act as a comprehensive web search engine. For the query "${query}", provide a concise summary of the most relevant information found online, citing any specific sources or domains if possible. Structure the answer as if it's a top web search result snippet. Focus on factual and highly relevant information.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a helpful assistant that provides web search results." },
        { role: "user", content: prompt },
      ],
      tools: [{ type: "web_search_preview" }],
    });

    const content = completion.choices[0]?.message?.content;
    console.log(completion.choices[0]?.message);

    if (content) {
      return [{
        title: `OpenAI Summary for "${query}"`,
        url: `https://openai.com/chat-gpt`,
        snippet: content,
        displayLink: "openai.com",
        authors: "OpenAI",
        journal: "AI Web Search",
        year: new Date().getFullYear().toString(),
        type: "ai_summary",
        database: "OpenAI Web Search"
      }];
    }
    return [];
  } catch (err) {
    console.error("OpenAI Web Search error:", err);
    return [];
  }
}
*/

/**
 * Enhanced academic search route with query validation and quality filtering
 */
// router.post(
//   '/web',
//   [
//     body('query').trim().notEmpty().withMessage('Search query is required'),
//     body('chatId').optional().isString(),
//   ],
//   authenticateToken,
//   async (req, res) => {
//     try {
//       const errors = validationResult(req);
//       if (!errors.isEmpty()) {
//         return res.status(400).json({ errors: errors.array() });
//       }

//       const { query, chatId } = req.body;
//       const userId = req.user.id;

//       // Validate query quality
//       if (!isValidAcademicQuery(query)) {
//         res.setHeader('Content-Type', 'text/event-stream');
//         res.setHeader('Cache-Control', 'no-cache');
//         res.setHeader('Connection', 'keep-alive');
//         res.setHeader('X-Accel-Buffering', 'no');
//         res.flushHeaders();

//         res.write(`data: ${JSON.stringify({
//           type: 'content',
//           content: "❌ **Invalid Search Query**\n\nYour search query doesn't appear to be suitable for academic search. Please try:\n\n• Using meaningful scientific or research terms\n• Spelling out complete words\n• Using proper terminology\n\n**Good examples:**\n• 'machine learning cancer diagnosis'\n• 'COVID-19 treatment efficacy'\n• 'artificial intelligence medical imaging'\n• 'gene therapy clinical trials'\n\nPlease enter a valid academic search query."
//         })}\n\n`);

//         res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
//         res.end();
//         return;
//       }

//       // Set up streaming
//       res.setHeader('Content-Type', 'text/event-stream');
//       res.setHeader('Cache-Control', 'no-cache');
//       res.setHeader('Connection', 'keep-alive');
//       res.setHeader('X-Accel-Buffering', 'no');
//       res.flushHeaders();

//       // Save user query
//       if (chatId) {
//         const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
//         if (chat) {
//           await prisma.message.create({
//             data: {
//               chatId,
//               role: 'USER',
//               content: `🔍 Academic Search: ${query}`,
//               timestamp: new Date(),
//             }
//           });
//         }
//       }

//       res.write(`data: ${JSON.stringify({ type: 'start', content: '🔍 Searching academic databases...\n\n' })}\n\n`);

//       const searchPromises = [
//         searchPubMed(query).catch(err => {
//           console.error('PubMed search failed:', err);
//           return [];
//         }),
//         searchScopus(query).catch(err => {
//           console.error('Scopus search failed:', err);
//           return [];
//         }),
//         searchSciELO(query).catch(err => {
//           console.error('SciELO search failed:', err);
//           return [];
//         })
//       ];

//       // Add Web of Science if API key available
//       if (process.env.WOS_API_KEY) {
//         searchPromises.push(
//           searchWebOfScience(query).catch(err => {
//             console.error('Web of Science search failed:', err);
//             return [];
//           })
//         );
//       }
//       if (process.env.OPENAI_API_KEY) {
//         res.write(`data: ${JSON.stringify({ type: 'content', content: '✨ Searching OpenAI Web...\n\n' })}\n\n`);
//         await new Promise(resolve => setTimeout(resolve, 100));
//       }


//       // Stream progress updates
//       res.write(`data: ${JSON.stringify({ type: 'content', content: '📚 Searching PubMed Central...\n' })}\n\n`);
//       await new Promise(resolve => setTimeout(resolve, 500));

//       res.write(`data: ${JSON.stringify({ type: 'content', content: '🔬 Searching Scopus...\n' })}\n\n`);
//       await new Promise(resolve => setTimeout(resolve, 500));

//       // res.write(`data: ${JSON.stringify({ type: 'content', content: '🌎 Searching SciELO...\n' })}\n\n`);
//       // await new Promise(resolve => setTimeout(resolve, 500));

//       // if (process.env.WOS_API_KEY) {
//       //   res.write(`data: ${JSON.stringify({ type: 'content', content: '📊 Searching Web of Science...\n\n' })}\n\n`);
//       // }

//       // Execute all searches
//       const [pubmedResults, scopusResults, scieloResults, wosResults = []] = await Promise.all(searchPromises);

//       // Combine and organize results by database
//       const allResults = [
//         ...pubmedResults.map(r => ({ ...r, database: 'PubMed Central' })),
//         ...scopusResults.map(r => ({ ...r, database: 'Scopus' })),
//         ...scieloResults.map(r => ({ ...r, database: 'SciELO' })),
//         ...wosResults.map(r => ({ ...r, database: 'Web of Science' }))
//       ];

//       console.log(`Found ${allResults.length} quality results:`, {
//         pubmed: pubmedResults.length,
//         scopus: scopusResults.length,
//         scielo: scieloResults.length,
//         wos: wosResults.length
//       });

//       if (allResults.length === 0) {
//         res.write(`data: ${JSON.stringify({
//           type: 'content',
//           content: "⚠️ **No Relevant Academic Results Found**\n\nWe searched across academic databases but couldn't find articles matching your query. This could happen because:\n\n• **Query too specific**: Try broader terms\n• **Spelling issues**: Check scientific terminology\n• **New research area**: Topic might be too recent\n• **Database coverage**: Some fields may not be well-represented\n\n**Suggestions:**\n• Try different keywords or synonyms\n• Use broader scientific terms\n• Check spelling of technical terms\n• Try related research topics\n\n**Good academic search examples:**\n• 'machine learning healthcare'\n• 'cancer immunotherapy'\n• 'renewable energy efficiency'\n• 'neural networks applications'\n\n"
//         })}\n\n`);
//       } else {
//         const title = `**🎓 Academic Search Results for: "${query}"**\n\n📊 Found ${allResults.length} high-quality articles across ${new Set(allResults.map(r => r.database)).size} databases\n\n`;
//         res.write(`data: ${JSON.stringify({ type: 'content', content: title })}\n\n`);

//         // Group results by database for better organization
//         const databases = ['PubMed Central', 'Scopus', 'SciELO', 'Web of Science'];

//         for (const db of databases) {
//           const dbResults = allResults.filter(r => r.database === db);
//           if (dbResults.length > 0) {
//             const dbHeader = `### ${db} (${dbResults.length} results)\n\n`;
//             res.write(`data: ${JSON.stringify({ type: 'content', content: dbHeader })}\n\n`);

//             for (let i = 0; i < dbResults.length; i++) {
//               const result = dbResults[i];
//               let resultText = `**${i + 1}. [${result.title}](${result.url})**\n`;
//               resultText += `${result.snippet}\n\n`;

//               res.write(`data: ${JSON.stringify({ type: 'content', content: resultText })}\n\n`);
//               await new Promise(resolve => setTimeout(resolve, 300));
//             }
//           }
//         }
//       }

//       const footer = `\n---\n*🔍 Search completed across academic databases*\n*📚 Databases: PubMed Central, Scopus,*\n*⏱️ Search time: ${new Date().toLocaleTimeString()}*`;
//       res.write(`data: ${JSON.stringify({ type: 'content', content: footer })}\n\n`);

//       // Save complete response
//       if (chatId) {
//         const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
//         if (chat) {
//           const fullContent = allResults.length > 0
//             ? `**🎓 Academic Search Results for: "${query}"**\n\n` +
//             allResults.map((r, i) => `**${i + 1}. [${r.title}](${r.url})**\n${r.snippet}\nDatabase: ${r.database}\n`).join('\n') +
//             footer
//             : `**🎓 Academic Search Results for: "${query}"**\n\nNo relevant academic results found. Please try different keywords or broader terms.${footer}`;

//           await prisma.message.create({
//             data: {
//               chatId,
//               role: 'ASSISTANT',
//               content: fullContent,
//               tokens: 50,
//               timestamp: new Date(),
//             }
//           });
//         }
//       }

//       res.write(`data: ${JSON.stringify({ type: 'done', results: allResults })}\n\n`);
//       res.end();

//     } catch (error) {
//       console.error('Academic search error:', error);
//       res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
//       res.end();
//     }
//   }
// );
router.post(
  '/web',
  [
    body('query').trim().notEmpty().withMessage('Search query is required'),
    body('chatId').optional().isString(),
    body('sources').optional().isObject(),
  ],
  authenticateToken,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { query, chatId, sources } = req.body;
      const userId = req.user.id;

      // Default sources if not provided (all enabled)
      const searchSources = sources || {
        scopus: true,
        pubmed: true,
        gpt4oMini: true
      };

      console.log('🔍 Search sources selected:', searchSources);

      // Clean the query to extract core search topic
      const cleanedQuery = cleanSearchQuery(query);
      console.log(`🔍 Original query: "${query}"`);
      console.log(`🔍 Cleaned query: "${cleanedQuery}"`);

      // Validate cleaned query quality
      if (!isValidSearchQuery(cleanedQuery)) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        res.write(`data: ${JSON.stringify({
          type: 'content',
          content: "❌ **Invalid Search Query**\n\nYour search query doesn't appear to be suitable for academic search. Please try:\n\n• Using meaningful scientific or research terms\n• Spelling out complete words\n• Using proper terminology\n\n**Good examples:**\n• 'machine learning cancer diagnosis'\n• 'COVID-19 treatment efficacy'\n• 'artificial intelligence medical imaging'\n• 'gene therapy clinical trials'\n\nPlease enter a valid academic search query."
        })}\n\n`);

        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
        return;
      }

      // Set up streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // Save user query
      if (chatId) {
        const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
        if (chat) {
          await prisma.message.create({
            data: {
              chatId,
              role: 'USER',
              content: `🔍 Academic Search: ${query}`,
              timestamp: new Date(),
            }
          });
        }
      }

      res.write(`data: ${JSON.stringify({ type: 'start', content: '🔍 Searching academic databases...\n\n' })}\n\n`);

      // Debug: Log the query being searched
      console.log(`🔍 Starting search for query: "${cleanedQuery}"`);

      // MODIFIED: Use a dynamic task list based on selected sources
      const searchTasks = [];

      // Always include arXiv for academic searches (it's free and comprehensive)
      //searchTasks.push({ name: 'arXiv', promise: searchArXiv(cleanedQuery) });

      // Add PubMed if selected
      if (searchSources.pubmed) {
        searchTasks.push({ name: 'PubMed', promise: searchPubMed(cleanedQuery) });
      }

      // Add Scopus if selected
      if (searchSources.scopus) {
        searchTasks.push({ name: 'Scopus', promise: searchScopus(cleanedQuery) });
      }

      // Add GPT-4o-mini search if selected
      if (searchSources.gpt4oMini && process.env.OPENAI_API_KEY) {
        searchTasks.push({ name: 'GPT-4o-mini-search', promise: searchOpenAIWeb(cleanedQuery) });
      }

      // Add Crossref search (always enabled - it's free and comprehensive)
      searchTasks.push({ name: 'Crossref', promise: searchCrossref(cleanedQuery) });

      // Optional: Add Web of Science if API key available (not in UI but can be enabled)
      if (process.env.WOS_API_KEY) {
        searchTasks.push({ name: 'Web of Science', promise: searchWebOfScience(cleanedQuery) });
      }

      console.log(`🔍 Enabled search tasks: ${searchTasks.map(t => t.name).join(', ')}`);


      // Stream progress updates for each search source
      res.write(`data: ${JSON.stringify({ type: 'content', content: '� Searching arXiv preprints...\n' })}\n\n`);
      await new Promise(resolve => setTimeout(resolve, 100)); // Shorter delay for smoother streaming

      res.write(`data: ${JSON.stringify({ type: 'content', content: '📚 Searching PubMed...\n' })}\n\n`);
      await new Promise(resolve => setTimeout(resolve, 100));

      res.write(`data: ${JSON.stringify({ type: 'content', content: '🔬 Searching Scopus...\n' })}\n\n`);
      await new Promise(resolve => setTimeout(resolve, 100));

      // res.write(`data: ${JSON.stringify({ type: 'content', content: '🌎 Searching SciELO...\n' })}\n\n`);
      // await new Promise(resolve => setTimeout(resolve, 100));

      if (process.env.WOS_API_KEY) {
        res.write(`data: ${JSON.stringify({ type: 'content', content: '📊 Searching Web of Science...\n' })}\n\n`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      // NEW: Stream update for OpenAI search
      if (process.env.OPENAI_API_KEY) {
        res.write(`data: ${JSON.stringify({ type: 'content', content: '✨ Searching OpenAI Web...\n\n' })}\n\n`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Execute all searches concurrently
      // MODIFIED: Process results dynamically
      const resultsByDatabase = await Promise.all(
        searchTasks.map(async (task) => {
          try {
            const results = await task.promise;
            return { database: task.name, results: results };
          } catch (err) {
            console.error(`${task.name} search failed:`, err);
            return { database: task.name, results: [] };
          }
        })
      );

      let allResults = [];
      const foundDatabases = new Set();
      resultsByDatabase.forEach(({ database, results }) => {
        if (results && results.length > 0) {
          foundDatabases.add(database);
          allResults = allResults.concat(results);
        }
      });

      console.log(`Found ${allResults.length} quality results:`,
        resultsByDatabase.reduce((acc, { database, results }) => {
          acc[database] = results.length;
          return acc;
        }, {})
      );

      if (allResults.length === 0) {
        res.write(`data: ${JSON.stringify({
          type: 'content',
          content: "⚠️ **No Relevant Academic Results Found**\n\nWe searched across academic databases but couldn't find articles matching your query. This could happen because:\n\n• **Query too specific**: Try broader terms\n• **Spelling issues**: Check scientific terminology\n• **New research area**: Topic might be too recent\n• **Database coverage**: Some fields may not be well-represented\n\n**Suggestions:**\n• Try different keywords or synonyms\n• Use broader scientific terms\n• Check spelling of technical terms\n• Try related research topics\n\n**Good academic search examples:**\n• 'machine learning healthcare'\n• 'cancer immunotherapy'\n• 'renewable energy efficiency'\n• 'neural networks applications'\n\n"
        })}\n\n`);
      } else {
        const title = `**🎓 Academic & Web Search Results for: "${query}"**\n\n📊 Found ${allResults.length} high-quality articles/summaries across ${foundDatabases.size} source(s)\n\n`;
        res.write(`data: ${JSON.stringify({ type: 'content', content: title })}\n\n`);

        // Group results by database for better organization
        // MODIFIED: Added arXiv to the ordered list at the beginning for preprints
        const databasesOrdered = ['arXiv', 'PubMed', 'Scopus', 'Web of Science', 'SciELO', 'OpenAI Web Search'];

        for (const db of databasesOrdered) {
          const dbResults = allResults.filter(r => r.database === db);
          if (dbResults.length > 0) {
            const dbHeader = `### ${db} (${dbResults.length} results)\n\n`;
            res.write(`data: ${JSON.stringify({ type: 'content', content: dbHeader })}\n\n`);

            for (let i = 0; i < dbResults.length; i++) {
              const result = dbResults[i];
              let resultText = `**${i + 1}. [${result.title}](${result.url})**\n`;
              resultText += `${result.snippet}\n\n`;

              res.write(`data: ${JSON.stringify({ type: 'content', content: resultText })}\n\n`);
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          }
        }
      }

      // MODIFIED: Updated footer to include all found databases
      const footerDatabases = Array.from(foundDatabases).join(', ');
      const footer = `\n---\n*🔍 Search completed across databases*\n*📚 Databases: ${footerDatabases || 'N/A'}*\n*⏱️ Search time: ${new Date().toLocaleTimeString()}*`;
      res.write(`data: ${JSON.stringify({ type: 'content', content: footer })}\n\n`);

      // Save complete response
      if (chatId) {
        const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
        if (chat) {
          const fullContent = allResults.length > 0
            ? `**🎓 Academic & Web Search Results for: "${cleanedQuery}"**\n\n` +
            allResults.map((r, i) => `**${i + 1}. [${r.title}](${r.url})**\n${r.snippet}\nDatabase: ${r.database}\n`).join('\n') +
            footer
            : `**🎓 Academic & Web Search Results for: "${cleanedQuery}"**\n\nNo relevant academic or web results found. Please try different keywords or broader terms.${footer}`;

          await prisma.message.create({
            data: {
              chatId,
              role: 'ASSISTANT',
              content: fullContent,
              tokens: 50, // Adjust token count based on actual response length if needed
              timestamp: new Date(),
            }
          });
        }
      }

      res.write(`data: ${JSON.stringify({ type: 'done', results: allResults })}\n\n`);
      res.end();

    } catch (error) {
      console.error('Academic search error:', error);
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    }
  }
);

module.exports = router;
