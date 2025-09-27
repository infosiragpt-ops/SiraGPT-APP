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
async function searchPubMed(query, maxResults = 5) {
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

      return {
        title: article.title,
        url: `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${id}/`,
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
async function searchScopus(query, maxResults = 5) {
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
      const url = doi ? `https://doi.org/${doi}` : item["prism:url"];

      // Skip if no URL
      if (!url) {
        return null;
      }

      // Enhanced snippet with metadata
      const snippet = `${title}\n👤 Authors: ${authors}\n📚 Journal: ${journal || 'Scopus Journal'}\n📅 Year: ${year || 'N/A'}\n📊 Citations: ${citations}\n📄 Type: ${docType}`;

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
async function searchWebOfScience(query, maxResults = 5) {
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
      const url = doi ? `https://doi.org/${doi}` : null;
      
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
      `https://search.scielo.org/api/v1/search/?q=${encodeURIComponent(query)}&lang=en&format=json&page=1&count=10`,
      `https://articlemeta.scielo.org/api/v1/article/identifiers/?collection=scl&issn=&limit=10&offset=0&from=&until=&extra_filter=${encodeURIComponent(query)}`,
      `https://search.scielo.org/?q=${encodeURIComponent(query)}&lang=en&count=10&from=0&output=site&sort=&format=summary&fb=&page=1`
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
        if (index < 10) {
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
        if (index < 10) {
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
    
    titleMatches.slice(0, 5).forEach((titleMatch, index) => {
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
 * Web search via OpenAI Responses API with web_search tool
 * Streams markdown content back to client using SSE
 */
// router.post(
//   '/web',
//   [
//     body('query').trim().notEmpty().withMessage('Search query is required'),
//     body('chatId').optional().isString(),
//     body('model').optional().isString(),
//     body('provider').optional().isString(),
//     body('systemPrompt').optional().isString(),
//     body('maxSources').optional().isInt({ min: 3, max: 10 }),
//     body('searchMode').optional().isIn(['general', 'news', 'docs', 'academic', 'technical'])
//   ],
//   authenticateToken,
//   async (req, res) => {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({ errors: errors.array() });
//     }

//     const {
//       query,
//       chatId,
//       model: bodyModel,
//       provider: bodyProvider,
//       systemPrompt: overrideSystemPrompt,
//       maxSources: bodyMaxSources,
//       searchMode
//     } = req.body;

//     const userId = req.user.id;

//     // Check OpenAI config
//     if (!process.env.OPENAI_API_KEY) {
//       return res.status(500).json({ error: 'OpenAI API key not configured' });
//     }

//     // SSE headers
//     res.setHeader('Content-Type', 'text/event-stream');
//     res.setHeader('Cache-Control', 'no-cache');
//     res.setHeader('Connection', 'keep-alive');
//     res.setHeader('X-Accel-Buffering', 'no');
//     res.flushHeaders();

//     // Handle client disconnects
//     let aborted = false;
//     req.on('close', () => { aborted = true; });
//     const safeWrite = (obj) => {
//       if (aborted) return false;
//       try {
//         res.write(`data: ${JSON.stringify(obj)}\n\n`);
//         return true;
//       } catch (e) {
//         aborted = true;
//         return false;
//       }
//     };

//     try {
//       // Persist user query to chat if exists
//       if (chatId) {
//         const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
//         if (chat) {
//           await prisma.message.create({
//             data: {
//               chatId,
//               role: 'USER',
//               content: `🔎 Web Search (OpenAI): ${query}`,
//               timestamp: new Date(),
//             }
//           });
//         }
//       }

//       safeWrite({ type: 'start', content: '🔎 Searching the web with OpenAI...\n\n' });

//       const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
//       const provider = bodyProvider || 'OpenAI';
//       const FALLBACK_MODEL = process.env.OPENAI_SEARCH_MODEL || 'o4-mini';
//       let model = (bodyModel && typeof bodyModel === 'string' && bodyModel.trim())
//         ? bodyModel.trim()
//         : FALLBACK_MODEL;

//       // If a non-OpenAI provider/model was selected, inform and use fallback
//       const providerName = String(provider || '').toLowerCase();
//       const looksOpenAIModel = /^(gpt-|o\d|o\d-.*|gpt4|gpt-4o)/i.test(model);
//       if (providerName && providerName !== 'openai') {
//         safeWrite({ type: 'content', content: `**Note:** Selected provider “${provider}” is not supported for Web Search. Using OpenAI ${FALLBACK_MODEL}.\n\n` });
//         model = FALLBACK_MODEL;
//       } else if (!looksOpenAIModel) {
//         safeWrite({ type: 'content', content: `**Note:** Model “${model}” doesn't support OpenAI web search. Falling back to ${FALLBACK_MODEL}.\n\n` });
//         model = FALLBACK_MODEL;
//       }

//       // Tune output shape
//       const maxSources = Math.min(10, Math.max(3, Number.isInteger(bodyMaxSources) ? bodyMaxSources : (typeof bodyMaxSources === 'string' ? parseInt(bodyMaxSources, 10) : 6) || 6));
//       const mode = (searchMode || 'general');
//       const modeInstructionsMap = {
//         general: 'Mix reputable sources. Prioritize clarity and breadth.',
//         news: 'Prioritize recent, reputable news outlets. Include publication dates prominently.',
//         docs: 'Prefer official product or vendor documentation and trusted reference sites.',
//         academic: 'Prioritize peer-reviewed articles, conferences, and respected institutions.',
//         technical: 'Prefer official docs, standards, RFCs, and authoritative technical blogs.'
//       };
//       const modeInstructions = modeInstructionsMap[mode] || modeInstructionsMap.general;

//       const defaultSystemPrompt = [
//         'You are a careful web research agent. Use the web_search tool to fetch fresh, credible information.',
//         'Respond in the same language as the user\'s query (e.g., Spanish → Spanish).',
//         '',
//         `Mode focus: ${mode} — ${modeInstructions}`,
//         '',
//         'Output requirements (Markdown):',
//         '• Start with a level-3 heading: "### Web Search (OpenAI): {query}".',
//         '• Then a one-line bold purpose summary in the user\'s language.',
//         `• Follow with a numbered list of the top ${maxSources} sources (up to ${maxSources}). For each item provide:`,
//         '  - **Title** (Domain) — one concise, factual summary',
//         '  - **URL:** Direct clickable link',
//         '  - **Date:** Publication date (YYYY-MM-DD) when known',
//         '  - **Type:** article | docs | research | video',
//         '  - If an image preview is clearly available and stable, include it on a new line as Markdown: ![alt](https://...)',
//         '    Only include images you are confident will load. Do NOT fabricate image URLs.',
//         '  - If the source is a video (e.g., YouTube), clearly mark with ▶️ and provide the video URL. Do NOT embed iframes.',
//         '',
//         '• After the list, add a summary section titled in the user\'s language: use "#### Resumen" for Spanish, or "#### Summary" for other languages. Synthesize key points and caveats.',
//         '• Prefer official documentation, reputable news, academic sources, and well-known sites.',
//         '• Avoid low-quality, spammy, or irrelevant pages. Do not hallucinate links or images.',
//         '• Use clean, readable Markdown only (no HTML).',
//       ].join('\n');

//       const systemPrompt = (overrideSystemPrompt && typeof overrideSystemPrompt === 'string' && overrideSystemPrompt.trim())
//         ? overrideSystemPrompt.trim()
//         : defaultSystemPrompt;

//       // Helper to try a search and optionally fall back if the model/tool is unsupported
//       const trySearch = async (modelToUse) => {
//         return client.responses.create({
//           model: modelToUse,
//           input: [
//             { role: 'system', content: systemPrompt },
//             { role: 'user', content: `Search the web for: ${query}. Provide links and cite sources.` }
//           ],
//           tools: [{ type: 'web_search' }],
//         });
//       };

//       const isUnsupportedToolError = (err) => {
//         const msg = (err && (err.message || ''))?.toLowerCase?.() || '';
//         return (
//           msg.includes('web_search') && (
//             msg.includes('unsupported') ||
//             msg.includes('not supported') ||
//             msg.includes('does not support') ||
//             msg.includes('unknown') ||
//             msg.includes('unrecognized') ||
//             msg.includes('disabled') ||
//             msg.includes('tools are not available')
//           )
//         );
//       };

//       let response;
//       try {
//         response = await trySearch(model);
//       } catch (err) {
//         if (isUnsupportedToolError(err) || model !== FALLBACK_MODEL) {
//           // Inform user and retry with fallback model
//           safeWrite({ type: 'content', content: `**Note:** Falling back to ${FALLBACK_MODEL} because the selected model \"${model}\" cannot perform web_search.\n\n` });
//           model = FALLBACK_MODEL;
//           response = await trySearch(model);
//         } else {
//           throw err;
//         }
//       }

//       // Extract text utility compatible with different SDK structures
//       const extractText = (resp) => {
//         try {
//           if (!resp) return '';
//           if (resp.output_text) return resp.output_text; // SDK helper if available
//           const parts = [];
//           if (Array.isArray(resp.output)) {
//             for (const out of resp.output) {
//               const content = out?.content || out?.items || [];
//               const contentArr = Array.isArray(content) ? content : [];
//               for (const c of contentArr) {
//                 if (c?.type === 'output_text' && c?.text?.value) parts.push(c.text.value);
//                 if (c?.type === 'text' && typeof c?.text === 'string') parts.push(c.text);
//               }
//             }
//           }
//           if (parts.length === 0 && resp?.output?.[0]?.content?.[0]?.text?.value) {
//             return resp.output[0].content[0].text.value;
//           }
//           return parts.join('\n');
//         } catch {
//           return '';
//         }
//       };

//       let fullText = extractText(response) || '';
//       if (!fullText.trim()) {
//         fullText = `**Web Search for:** "${query}"\n\nNo detailed text was returned by the model. Please try a different query.`;
//       }

//       // Stream the content with small chunks for responsiveness
//       const today = new Date();
//       const dateStr = today.toISOString().slice(0, 10);
//       const header = `### Web Search (OpenAI): ${query}\n\n*Model: ${model} • Date: ${dateStr}*\n\n`;
//       safeWrite({ type: 'content', content: header });

//       const paragraphs = fullText.split(/\n{2,}/);
//       const chunkAndSend = async (text) => {
//         if (!text) return;
//         const lines = text.split(/\n/);
//         let buffer = '';
//         const maxLen = 800; // char-based chunk size
//         for (const line of lines) {
//           if ((buffer + line + '\n').length > maxLen) {
//             if (!safeWrite({ type: 'content', content: buffer })) return;
//             await new Promise(r => setTimeout(r, 120));
//             buffer = '';
//           }
//           buffer += line + '\n';
//         }
//         if (buffer) {
//           if (!safeWrite({ type: 'content', content: buffer + '\n' })) return;
//           await new Promise(r => setTimeout(r, 120));
//         }
//       };

//       for (const para of paragraphs) {
//         const safe = para.trim();
//         if (safe) {
//           await chunkAndSend(safe);
//         }
//       }

//       const footer = `\n---\n*Search powered by OpenAI ${model} web_search*`;
//       safeWrite({ type: 'content', content: footer });

//       // Persist assistant message
//       if (chatId) {
//         const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
//         if (chat) {
//           const contentToSave = header + fullText + footer;
//           await prisma.message.create({
//             data: {
//               chatId,
//               role: 'ASSISTANT',
//               content: contentToSave,
//               tokens: Math.min(contentToSave.length, 2000),
//               timestamp: new Date(),
//             }
//           });
//         }
//       }

//       safeWrite({ type: 'done', results: [] });
//       res.end();
//     } catch (error) {
//       console.error('OpenAI web search error:', error);
//       safeWrite({ type: 'error', error: error?.message || 'Web search failed' });
//       res.end();
//     }
//   }
// );



// open ai based webs earch make it a route
router.post(
  '/web',
  [
    body('query').trim().notEmpty().withMessage('Search query is required'),
    body('chatId').optional().isString(),
    body('model').optional().isString(),
    body('provider').optional().isString(),
  ],
  authenticateToken,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // If JSON was expected, still send JSON error (before switching to SSE)
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      query,
      chatId,
      model: bodyModel,
      provider: bodyProvider,
    } = req.body;

    // Check OpenAI config
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let aborted = false;
    req.on('close', () => { aborted = true; });

    const safeWrite = (obj) => {
      if (aborted) return false;
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
        return true;
      } catch {
        aborted = true;
        return false;
      }
    };

    const note = (content) => safeWrite({ type: 'note', content });
    const sendContent = (content) => safeWrite({ type: 'content', content });
    const sendError = (message) => safeWrite({ type: 'error', error: message });

    try {
      // Persist user query to chat if exists
      if (chatId) {
        const chat = await prisma.chat.findFirst({ where: { id: chatId, userId: req.user.id } });
        if (chat) {
          await prisma.message.create({
            data: {
              chatId,
              role: 'USER',
              content: `🔎 Web Search: ${query}`,
              timestamp: new Date(),
            }
          });
        }
      }

      // Validate provider: only OpenAI is supported for web_search
      const provider = (bodyProvider || 'OpenAI').toString().trim();
      if (provider.toLowerCase() !== 'openai') {
        sendError('Only the OpenAI provider is supported for web search.');
        safeWrite({ type: 'done', results: [] });
        return res.end();
      }

      // Start message
      safeWrite({ type: 'start', content: '🔎 Searching the web with OpenAI...\n\n' });

      // Model handling
      const FALLBACK_MODEL = process.env.OPENAI_SEARCH_MODEL || 'o4-mini';
      let model = (bodyModel && typeof bodyModel === 'string' && bodyModel.trim())
        ? bodyModel.trim()
        : FALLBACK_MODEL;

      // Simple check for "OpenAI-looking" models
      const looksOpenAIModel = /^(gpt-|o\d|o\d-.*|gpt4|gpt-4o)/i.test(model);
      if (!looksOpenAIModel) {
        note(`Selected model "${model}" doesn’t look like an OpenAI model. Falling back to ${FALLBACK_MODEL}.`);
        model = FALLBACK_MODEL;
      }

      const defaultSystemPrompt = [
        'You are a careful web research agent. Use the web_search tool to fetch fresh, credible information.',
        'Respond in the same language as the user’s query.',
        '',
        'Output requirements (Markdown):',
        '• Start with a level-3 heading: "### Web Search (OpenAI): {query}".',
        '• Then a one-line bold purpose summary.',
        '• Follow with a numbered list of 5–8 sources. For each:',
        '  - Title (Domain) — one concise, factual summary',
        '  - URL: Direct clickable link',
        '  - Date: Publication date (YYYY-MM-DD) if known',
        '  - Type: article | docs | research | video',
        '  - If a reliable image preview is available, include it as Markdown image on the next line. Do NOT fabricate.',
        '  - If the source is a video, mark with ▶️ and provide the video URL.',
        '',
        '• After the list, add a short "#### Summary" synthesizing key points and caveats.',
        '• Prefer official docs, reputable news, academic sources, and well-known sites.',
        '• Avoid low-quality/spammy content and hallucinated links/images.',
        '• Use clean, readable Markdown only (no HTML).',
      ].join('\n');

      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      // Helper to try a search
      const trySearch = async (modelToUse) => {
        return client.responses.create({
          model: modelToUse,
          input: [
            { role: 'system', content: defaultSystemPrompt },
            { role: 'user', content: `Search the web for: ${query}. Provide links and cite sources.` },
          ],
          tools: [{ type: 'web_search' }],
        });
      };

      // Detect unsupported tool errors
      const isUnsupportedToolError = (err) => {
        const msg = (err && (err.message || ''))?.toLowerCase?.() || '';
        return (
          msg.includes('web_search') && (
            msg.includes('unsupported') ||
            msg.includes('not supported') ||
            msg.includes('does not support') ||
            msg.includes('unknown') ||
            msg.includes('unrecognized') ||
            msg.includes('disabled') ||
            msg.includes('tools are not available')
          )
        );
      };

      let response;
      try {
        response = await trySearch(model);
      } catch (err) {
        if (isUnsupportedToolError(err)) {
          sendError(`The selected model "${model}" cannot perform web_search. Please choose a supported OpenAI model (e.g., ${FALLBACK_MODEL}).`);
          safeWrite({ type: 'done', results: [] });
          return res.end();
        }
        throw err;
      }

      // Extract text from various SDK shapes
      const extractText = (resp) => {
        try {
          if (!resp) return '';
          if (resp.output_text) return resp.output_text;
          const parts = [];
          if (Array.isArray(resp.output)) {
            for (const out of resp.output) {
              const content = out?.content || out?.items || [];
              const contentArr = Array.isArray(content) ? content : [];
              for (const c of contentArr) {
                if (c?.type === 'output_text' && c?.text?.value) parts.push(c.text.value);
                if (c?.type === 'text' && typeof c?.text === 'string') parts.push(c.text);
              }
            }
          }
          if (parts.length === 0 && resp?.output?.[0]?.content?.[0]?.text?.value) {
            return resp.output[0].content[0].text.value;
          }
          return parts.join('\n');
        } catch {
          return '';
        }
      };

      let fullText = extractText(response) || '';
      if (!fullText.trim()) {
        fullText = `**Web Search for:** "${query}"\n\nNo detailed text was returned by the model. Please try a different query.`;
      }

      // Stream header + content in chunks
      const today = new Date();
      const dateStr = today.toISOString().slice(0, 10);
      const header = `### Web Search (OpenAI): ${query}\n\n*Model: ${model} • Date: ${dateStr}*\n\n`;
      sendContent(header);

      const paragraphs = fullText.split(/\n{2,}/);
      for (const para of paragraphs) {
        const safe = para.trim();
        if (!safe) continue;
        if (!sendContent(safe + '\n\n')) break;
        await new Promise(r => setTimeout(r, 120));
      }

      const footer = `\n---\n*Search powered by OpenAI ${model} web_search*`;
      sendContent(footer);

      // Persist assistant message
      if (chatId) {
        const chat = await prisma.chat.findFirst({ where: { id: chatId, userId: req.user.id } });
        if (chat) {
          const contentToSave = header + fullText + footer;
          await prisma.message.create({
            data: {
              chatId,
              role: 'ASSISTANT',
              content: contentToSave,
              tokens: Math.min(contentToSave.length, 2000),
              timestamp: new Date(),
            }
          });
        }
      }

      safeWrite({ type: 'done', results: [] });
      res.end();
    } catch (error) {
      console.error('OpenAI web search error:', error);
      sendError(error?.message || 'Web search failed');
      res.end();
    }
  }
);

module.exports = router;