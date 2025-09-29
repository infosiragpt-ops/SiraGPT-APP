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
 * Check if query is meaningful for academic search
 */
function isValidAcademicQuery(query) {
  // Remove special characters and check length
  const cleanQuery = query.replace(/[^a-zA-Z0-9\s]/g, '').trim();

  // Must be at least 3 characters and contain letters
  if (cleanQuery.length < 3 || !/[a-zA-Z]/.test(cleanQuery)) {
    return false;
  }

  // Check if it's just random characters (more than 50% consecutive repeated chars)
  const repeatedChars = cleanQuery.match(/(.)\1{2,}/g);
  if (repeatedChars && repeatedChars.join('').length > cleanQuery.length * 0.5) {
    return false;
  }

  // Check if it contains common academic terms or is a reasonable length
  const academicTerms = /\b(research|study|analysis|review|survey|method|model|data|technology|system|algorithm|treatment|diagnosis|therapy|medicine|clinical|patient|disease|health|cancer|covid|drug|vaccine|biology|protein|gene|cell|brain|heart|neuroscience|genetics|microbiology|biochemistry|physics|chemistry|materials|nanotechnology|energy|robotics|engineering|psychology|sociology|education|economics|behavior|policy|climate|environment|ecology|pollution|biodiversity|sustainability)\b/i;

  return cleanQuery.length >= 3 && (academicTerms.test(cleanQuery) || cleanQuery.split(/\s+/).length >= 2);
}

/**
 * Filter out low-quality results
 */
function filterQualityResults(results, query) {
  return results.filter(result => {
    // Filter out results with default/placeholder values
    if (result.title.includes('Untitled') ||
      result.title === 'Article Title' ||
      result.title === 'Research Article' ||
      result.authors === 'Unknown authors' ||
      result.journal === 'Unknown Journal' ||
      result.journal === 'SciELO Journal' ||
      result.title.length < 10) {
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
 * Enhanced PubMed Search with quality filtering
 */
async function searchPubMed(query, maxResults = 15) {
  try {
    // Step 1: Search for PMC IDs
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pmc&term=${encodeURIComponent(query)}&retmax=${maxResults}&retmode=json`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    if (!searchData.esearchresult?.idlist?.length) return [];

    // Step 2: Get detailed information for each article
    const ids = searchData.esearchresult.idlist.slice(0, maxResults);
    const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pmc&id=${ids.join(',')}&retmode=json`;
    const summaryRes = await fetch(summaryUrl);
    const summaryData = await summaryRes.json();

    const results = ids.map(id => {
      const article = summaryData.result?.[id];
      if (!article || !article.title) {
        return null; // Skip articles without proper data
      }

      // Extract authors
      const authors = article.authors?.map(a => a.name).join(', ') ||
        article.authorlist?.split(',').slice(0, 3).join(', ');

      // Extract publication date
      const pubDate = article.pubdate || article.epubdate || article.printpubdate || "";
      const year = pubDate ? new Date(pubDate).getFullYear() : null;

      // Only include if we have meaningful data
      if (!article.title || article.title.length < 10 || !authors) {
        return null;
      }

      const doi = article.articleids?.find(id => id.idtype === 'doi')?.value;
      const url = doi ? `https://doi.org/${doi}` : `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${id}/`;

      return {
        title: article.title,
        url: url,
        snippet: `${article.title}\n👤 ${authors}\n📚 ${article.fulljournalname || article.source || 'PubMed Central'}\n📅 ${year || 'N/A'}`,
        displayLink: "ncbi.nlm.nih.gov",
        authors: authors,
        journal: article.fulljournalname || article.source || "PubMed Central",
        year: year ? year.toString() : "N/A",
        doi: article.articleids?.find(id => id.idtype === 'doi')?.value || null,
        type: "research_article"
      };
    }).filter(Boolean); // Remove null entries

    return filterQualityResults(results, query);
  } catch (err) {
    console.error("PubMed error:", err);
    return [];
  }
}

/**
 * Enhanced Scopus Search with quality filtering
 */
async function searchScopus(query, maxResults = 15) {
  try {
    if (!process.env.SCOPUS_API_KEY) {
      console.log("Scopus API key not configured, skipping Scopus search");
      return [];
    }

    const searchQuery = `TITLE-ABS-KEY(${query})`;
    const url = `https://api.elsevier.com/content/search/scopus?query=${encodeURIComponent(searchQuery)}&count=${maxResults}&field=title,creator,prism:publicationName,prism:coverDate,prism:doi,dc:description,citedby-count,prism:aggregationType`;

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

      // Citations count
      const citations = item["citedby-count"] || "0";

      // Document type
      const docType = item["prism:aggregationType"] || "Article";

      // DOI and URL
      const doi = item["prism:doi"];
      const url = doi ? `https://doi.org/${doi}` : (item["prism:url"] || `https://www.scopus.com/record/display.uri?eid=2-s2.0-${item['eid']}&origin=resultslist`);

      // Skip if no URL
      if (!url) {
        return null;
      }

      // Enhanced snippet with metadata
      const description = item["dc:description"] || title;
      const snippet = `${description}\n👤 Authors: ${authors}\n📚 Journal: ${journal || 'Scopus Journal'}\n📅 Year: ${year || 'N/A'}\n📊 Citations: ${citations}\n📄 Type: ${docType}`;

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
 * Enhanced Web of Science Search with quality filtering
 */
async function searchWebOfScience(query, maxResults = 15) {
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

async function searchOpenAIWeb(query) {
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
      // stream: true,

      // We are relying on the model's internal capabilities, not an explicit 'web_search' tool type here.
      // If you had a custom tool, it would be defined in 'tools' and you'd handle 'tool_calls'.
    });

    const content = completion.choices[0]?.message?.content;
    console.log(completion.choices[0]?.message);

    if (content) {
      // Format the content as a single search result to match other sources
      return [{
        title: `OpenAI Summary for "${query}"`,
        url: `https://openai.com/chat-gpt`, // Placeholder URL, as OpenAI does not provide a direct source link for its internal browsing summary.
        snippet: content,
        displayLink: "openai.com",
        authors: "OpenAI", // Attributing the summary to OpenAI
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
  ],
  authenticateToken,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { query, chatId } = req.body;
      const userId = req.user.id;

      // Validate query quality
      if (!isValidAcademicQuery(query)) {
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

      // MODIFIED: Use a dynamic task list for promises
      const searchTasks = [];
      searchTasks.push({ name: 'PubMed Central', promise: searchPubMed(query) });
      searchTasks.push({ name: 'Scopus', promise: searchScopus(query) });
      // searchTasks.push({ name: 'SciELO', promise: searchSciELO(query) });
      if (process.env.WOS_API_KEY) {
        searchTasks.push({ name: 'Web of Science', promise: searchWebOfScience(query) });
      }
      // NEW: Add OpenAI Web Search to the tasks
      if (process.env.OPENAI_API_KEY) {
        searchTasks.push({ name: 'OpenAI Web Search', promise: searchOpenAIWeb(query) });
      }


      // Stream progress updates for each search source
      res.write(`data: ${JSON.stringify({ type: 'content', content: '📚 Searching PubMed Central...\n' })}\n\n`);
      await new Promise(resolve => setTimeout(resolve, 100)); // Shorter delay for smoother streaming

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
        const title = `**🎓 Academic & Web Search Results for: "${query}"**\n\n📊 Found ${allResults.length} high-quality articles/summaries across ${foundDatabases.size} databases\n\n`;
        res.write(`data: ${JSON.stringify({ type: 'content', content: title })}\n\n`);

        // Group results by database for better organization
        // MODIFIED: Added OpenAI to the ordered list
        const databasesOrdered = ['PubMed Central', 'Scopus', 'SciELO', 'Web of Science', 'OpenAI Web Search'];

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
            ? `**🎓 Academic & Web Search Results for: "${query}"**\n\n` +
            allResults.map((r, i) => `**${i + 1}. [${r.title}](${r.url})**\n${r.snippet}\nDatabase: ${r.database}\n`).join('\n') +
            footer
            : `**🎓 Academic & Web Search Results for: "${query}"**\n\nNo relevant academic or web results found. Please try different keywords or broader terms.${footer}`;

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
