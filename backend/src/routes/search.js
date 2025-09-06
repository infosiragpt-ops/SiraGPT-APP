const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');

const router = express.Router();

// Google Custom Search API
// Google Custom Search API
async function performGoogleSearch(query, apiKey, searchEngineId) {
  try {
    const response = await fetch(
      `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${searchEngineId}&q=${encodeURIComponent(query)}&num=10`
    );

    if (!response.ok) {
      throw new Error(`Google Search API error: ${response.status}`);
    }

    const data = await response.json();

    return data.items?.map(item => {
      const thumbnail = item.pagemap?.cse_image?.[0]?.src || item.pagemap?.cse_thumbnail?.[0]?.src || null;
      const meta = item.pagemap || {};

      return {
        title: item.title,
        url: item.link,
        snippet: item.snippet,
        displayLink: item.displayLink,
        image: thumbnail, // ✅ preview image
        author: meta.person?.[0]?.name || null, // if schema.org person exists
        date: meta.article?.[0]?.datepublished || meta.newsarticle?.[0]?.datepublished || null, // if available
        rating: meta.aggregateRating?.[0]?.ratingValue || null, // e.g., reviews
      };
    }) || [];
  } catch (error) {
    console.error('Google Search API error:', error);
    throw error;
  }
}

// Web Search endpoint  without stream (Old version):
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

//       // Check if Google Search API credentials are available
//       const googleApiKey = process.env.GOOGLE_API_KEY;
//       const searchEngineId = process.env.GOOGLE_SEARCH_ENGINE_ID;

//       if (!googleApiKey || !searchEngineId) {
//         return res.status(500).json({ 
//           error: 'Google Search API not configured. Please set GOOGLE_API_KEY and GOOGLE_SEARCH_ENGINE_ID environment variables.' 
//         });
//       }

//       // Check monthly limit
//       if (req.user.apiUsage >= req.user.monthlyLimit) {
//         return res.status(429).json({
//           error: 'Monthly API limit exceeded',
//           usage: { current: req.user.apiUsage, limit: req.user.monthlyLimit },
//         });
//       }

//       // Perform Google Search
//       const searchResults = await performGoogleSearch(query, googleApiKey, searchEngineId);

//       // Format search results for chat
//       const searchContent = `**Web Search Results for: "${query}"**\n\n` +
//         searchResults.map((result, index) => 
//           `**${index + 1}. [${result.title}](${result.url})**\n` +
//           `${result.snippet}\n` +
//           `Source: ${result.displayLink}\n`
//         ).join('\n') +
//         '\n---\n*Search completed using Google Custom Search API*';

//       // Save messages if chatId provided
//       if (chatId) {
//         const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
//         if (chat) {
//           // Save user search query
//           await prisma.message.create({
//             data: {
//               chatId,
//               role: 'USER',
//               content: `🔍 Web Search: ${query}`,
//               timestamp: new Date(), // Use timestamp field
//             }
//           });

//           // Save search results
//           await prisma.message.create({
//             data: { 
//               chatId, 
//               role: 'ASSISTANT', 
//               content: searchContent, 
//               tokens: searchContent.length,
//               timestamp: new Date(), // Use timestamp field
//             }
//           });

//           // Update chat
//           await prisma.chat.update({
//             where: { id: chatId },
//             data: {
//               updatedAt: new Date(),
//               title: chat.title === 'New Chat'
//                 ? `Search: ${query.slice(0, 30)}${query.length > 30 ? '...' : ''}`
//                 : chat.title
//             }
//           });
//         }
//       }

//       // Track usage (minimal cost for search)
//       const tokens = 50; // Fixed token cost for search
//       await prisma.apiUsage.create({
//         data: { userId, model: 'google-search', tokens, cost: tokens * 0.001 }
//       });

//       const updatedUser = await prisma.user.update({
//         where: { id: userId },
//         data: { apiUsage: { increment: tokens } }
//       });

//       res.json({
//         results: searchResults,
//         content: searchContent,
//         tokens,
//         usage: { current: updatedUser.apiUsage, limit: updatedUser.monthlyLimit }
//       });

//     } catch (error) {
//       console.error('Web search error:', error);
//       res.status(500).json({ error: error.message || 'Web search failed' });
//     }
//   }
// );
// Replace the existing route with this streaming version:

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

      // Check API credentials
      const googleApiKey = process.env.GOOGLE_API_KEY;
      const searchEngineId = process.env.GOOGLE_SEARCH_ENGINE_ID;

      if (!googleApiKey || !searchEngineId) {
        return res.status(500).json({ 
          error: 'Google Search API not configured.' 
        });
      }

      // Set up streaming headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // Save user search query first
      if (chatId) {
        const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
        if (chat) {
          await prisma.message.create({
            data: {
              chatId,
              role: 'USER',
              content: `🔍 Web Search: ${query}`,
              timestamp: new Date(),
            }
          });
        }
      }

      // Stream initial message
      res.write(`data: ${JSON.stringify({ type: 'start', content: '🔍 Searching the web...\n\n' })}\n\n`);

      // Perform search
      const searchResults = await performGoogleSearch(query, googleApiKey, searchEngineId);

      // Stream title
      const title = `**Web Search Results for: "${query}"**\n\n`;
      res.write(`data: ${JSON.stringify({ type: 'content', content: title })}\n\n`);
console.log('Search Results:', searchResults);
      // Stream each result with delay for typing effect
     for (let i = 0; i < searchResults.length; i++) {
  const result = searchResults[i];
  let resultText = `**${i + 1}. [${result.title}](${result.url})**\n${result.snippet}\nSource: ${result.displayLink}`;
  
  if (result.image) {
    resultText += `\n![preview](${result.image})`; // ✅ render preview image (Markdown)
  }
  if (result.date) {
    resultText += `\n🗓️ Published: ${result.date}`;
  }
  if (result.author) {
    resultText += `\n✍️ Author: ${result.author}`;
  }
  if (result.rating) {
    resultText += `\n⭐ Rating: ${result.rating}`;
  }

  resultText += '\n\n';

  res.write(`data: ${JSON.stringify({ type: 'content', content: resultText })}\n\n`);
  await new Promise(resolve => setTimeout(resolve, 300));
}


      // Stream completion
      const footer = '\n---\n*Search completed using Google Custom Search API*';
      res.write(`data: ${JSON.stringify({ type: 'content', content: footer })}\n\n`);

      // Final message
      const fullContent = title + 
        searchResults.map((result, index) => 
          `**${index + 1}. [${result.title}](${result.url})**\n${result.snippet}\nSource: ${result.displayLink}\n`
        ).join('\n') + footer;

      // Save complete response
      if (chatId) {
        const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
        if (chat) {
          await prisma.message.create({
            data: { 
              chatId, 
              role: 'ASSISTANT', 
              content: fullContent, 
              tokens: 50,
              timestamp: new Date(),
            }
          });
        }
      }

      res.write(`data: ${JSON.stringify({ type: 'done', results: searchResults })}\n\n`);
      res.end();

    } catch (error) {
      console.error('Web search error:', error);
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    }
  }
);
module.exports = router;