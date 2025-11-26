const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const OpenAI = require('openai');
const { createDocument } = require('../services/document-service');
const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Thesis Generation System
 * 
 * Steps:
 * 1. User provides topics
 * 2. Search multiple websites for each topic
 * 3. Extract and save all search results
 * 4. Generate comprehensive thesis using large context model
 * 5. Save thesis as document
 */

// Store for thesis generation sessions
const thesisSessions = new Map();

/**
 * Search multiple websites for a topic
 */
async function searchMultipleSources(topic) {
  const searchResults = [];
  const sources = [
    { name: 'Google Scholar', url: `https://scholar.google.com/scholar?q=${encodeURIComponent(topic)}` },
    { name: 'ResearchGate', url: `https://www.researchgate.net/search?q=${encodeURIComponent(topic)}` },
    { name: 'PubMed', url: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(topic)}` },
    { name: 'ArXiv', url: `https://arxiv.org/search/?query=${encodeURIComponent(topic)}&searchtype=all` },
    { name: 'IEEE Xplore', url: `https://ieeexplore.ieee.org/search/searchresult.jsp?queryText=${encodeURIComponent(topic)}` },
    { name: 'Wikipedia', url: `https://en.wikipedia.org/wiki/Special:Search/${encodeURIComponent(topic)}` },
    { name: 'Google Search', url: `https://www.google.com/search?q=${encodeURIComponent(topic)}` }
  ];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });
  const page = await context.newPage();

  for (const source of sources) {
    try {
      console.log(`🔍 Searching ${source.name} for: ${topic}`);
      await page.goto(source.url, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(2000);

      // Extract content based on source type
      const content = await page.evaluate((sourceName) => {
        let extractedContent = {
          title: document.title,
          url: window.location.href,
          content: '',
          links: []
        };

        // Remove scripts and styles
        const scripts = document.querySelectorAll('script, style, noscript, nav, header, footer');
        scripts.forEach(el => el.remove());

        // Extract main content
        const mainContent = document.querySelector('main, article, .content, #content, [role="main"]') 
          || document.body;
        
        if (mainContent) {
          extractedContent.content = mainContent.innerText || mainContent.textContent || '';
          
          // Extract links
          const links = mainContent.querySelectorAll('a[href]');
          links.forEach(link => {
            const href = link.href;
            const text = link.innerText || link.textContent;
            if (href && text && href.startsWith('http') && text.trim().length > 5) {
              extractedContent.links.push({ url: href, text: text.trim() });
            }
          });
        }

        return extractedContent;
      }, source.name);

      // Limit content size
      content.content = content.content.substring(0, 10000);
      content.links = content.links.slice(0, 20);

      searchResults.push({
        source: source.name,
        topic: topic,
        url: source.url,
        title: content.title,
        content: content.content,
        links: content.links,
        timestamp: new Date().toISOString()
      });

      console.log(`✅ Found content from ${source.name}`);
      await page.waitForTimeout(1000); // Rate limiting

    } catch (error) {
      console.error(`❌ Error searching ${source.name}:`, error.message);
      // Continue with other sources even if one fails
    }
  }

  await browser.close();
  return searchResults;
}

/**
 * Extract detailed content from a URL
 */
async function extractContentFromUrl(url, topic) {
  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(2000);

    const content = await page.evaluate(() => {
      // Remove scripts and styles
      const scripts = document.querySelectorAll('script, style, noscript, nav, header, footer, aside');
      scripts.forEach(el => el.remove());

      const mainContent = document.querySelector('main, article, .content, #content, [role="main"]') 
        || document.body;
      
      return {
        title: document.title,
        content: mainContent ? (mainContent.innerText || mainContent.textContent || '') : '',
        headings: Array.from(mainContent.querySelectorAll('h1, h2, h3')).map(h => h.innerText || h.textContent)
      };
    });

    await browser.close();

    return {
      url: url,
      topic: topic,
      title: content.title,
      content: content.content.substring(0, 15000),
      headings: content.headings,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error(`Error extracting content from ${url}:`, error.message);
    return null;
  }
}

/**
 * Generate thesis from collected research
 */
async function generateThesis(topics, allSearchResults, userId, sessionId) {
  try {
    // Compile all research content
    let researchContent = `# Research Material for Thesis Generation\n\n`;
    researchContent += `## Topics to Cover:\n${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n`;
    researchContent += `## Collected Research:\n\n`;

    // Group results by topic
    topics.forEach(topic => {
      researchContent += `### Topic: ${topic}\n\n`;
      const topicResults = allSearchResults.filter(r => r.topic === topic);
      
      topicResults.forEach((result, idx) => {
        researchContent += `#### Source ${idx + 1}: ${result.source}\n`;
        researchContent += `**URL:** ${result.url}\n\n`;
        researchContent += `**Content:**\n${result.content.substring(0, 3000)}\n\n`;
        researchContent += `---\n\n`;
      });
    });

    // Generate comprehensive thesis using large context model
    const systemPrompt = `You are an expert academic writer and researcher. Your task is to create a comprehensive, well-structured thesis document based on the provided research materials.

**Requirements:**
1. Create a professional thesis document with a minimum of 50 pages (when converted to Word/PDF)
2. Include proper academic structure: Abstract, Introduction, Literature Review, Methodology, Findings, Discussion, Conclusion, References
3. Use all the provided research materials and cite sources appropriately
4. Write in a formal, academic tone
5. Include detailed analysis, examples, and evidence from the research
6. Ensure the thesis is comprehensive, well-argued, and academically sound
7. Include proper citations in APA or MLA format
8. Add section numbers, headings, and subheadings
9. Include tables, figures, and examples where appropriate
10. Make sure each section is substantial and detailed

**Structure:**
- Title Page
- Abstract (250-300 words)
- Table of Contents
- List of Figures/Tables (if applicable)
- Chapter 1: Introduction (5-8 pages)
- Chapter 2: Literature Review (10-15 pages)
- Chapter 3: Methodology (5-8 pages)
- Chapter 4: Findings/Results (10-15 pages)
- Chapter 5: Discussion (8-10 pages)
- Chapter 6: Conclusion (3-5 pages)
- References/Bibliography
- Appendices (if needed)

Write the complete thesis in Markdown format with proper formatting.`;

    const userPrompt = `${researchContent}\n\nBased on the above research materials and topics, generate a comprehensive thesis document that is at least 50 pages long when formatted. Ensure all content is derived from the provided research materials.`;

    // Update progress - get existing session and update it
    const existingSession = thesisSessions.get(sessionId);
    if (existingSession) {
      existingSession.status = 'generating_thesis';
      existingSession.progress = 70;
      existingSession.message = 'Generating comprehensive thesis using AI...';
    }

    // Use a model with large context window - prefer newer models
    const availableModels = [
      'gpt-4-turbo-preview',
      'gpt-4-1106-preview',
      'gpt-4-turbo',
      'gpt-4'
    ];
    
    // Try to use the best available model
    let model = availableModels[0];
    let thesisContent = '';
    
    // First generation - generate comprehensive thesis
    try {
      const response = await openai.chat.completions.create({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 16000
      });

      thesisContent = response.choices[0].message.content;
    } catch (error) {
      console.error('Error with primary model, trying fallback:', error);
      // Try fallback model
      model = availableModels[1] || 'gpt-4';
      const response = await openai.chat.completions.create({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 16000
      });
      thesisContent = response.choices[0].message.content;
    }

    // Update session progress
    const session = thesisSessions.get(sessionId);
    if (session) {
      session.progress = 75;
      session.message = 'Expanding thesis content...';
    }

    // Continue generation to ensure 50+ pages
    let continuationCount = 0;
    const maxContinuations = 3;
    
    while (thesisContent.length < 80000 && continuationCount < maxContinuations) {
      continuationCount++;
      const continuationPrompt = `Continue writing the thesis. Add more detailed content, expand sections, add more examples, data, analysis, case studies, and ensure it reaches at least 50 pages. Continue from where you left off and maintain academic quality.`;

      try {
        const continuationResponse = await openai.chat.completions.create({
          model: model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: thesisContent },
            { role: 'user', content: continuationPrompt }
          ],
          temperature: 0.7,
          max_tokens: 16000
        });

        thesisContent += '\n\n' + continuationResponse.choices[0].message.content;
        
        // Update session progress
        if (session) {
          session.progress = 75 + (continuationCount / maxContinuations) * 15;
          session.message = `Expanding thesis... (${continuationCount}/${maxContinuations})`;
        }
      } catch (error) {
        console.error(`Error in continuation ${continuationCount}:`, error);
        break; // Stop if continuation fails
      }
    }

    return thesisContent;

  } catch (error) {
    console.error('Error generating thesis:', error);
    throw error;
  }
}

/**
 * Start Thesis Generation
 */
router.post(
  '/generate',
  [
    body('topics').isArray().withMessage('Topics must be an array'),
    body('topics.*').isString().trim().notEmpty().withMessage('Each topic must be a non-empty string'),
    body('chatId').optional().isString(),
  ],
  authenticateToken,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { topics, chatId } = req.body;
      const userId = req.user.id;

      if (!topics || topics.length === 0) {
        return res.status(400).json({ error: 'At least one topic is required' });
      }

      // Generate session ID
      const sessionId = `thesis-${userId}-${Date.now()}`;

      // Initialize session
      thesisSessions.set(sessionId, {
        status: 'initializing',
        progress: 0,
        message: 'Starting thesis generation process...',
        userId: userId,
        topics: topics,
        searchResults: [],
        thesisContent: null
      });

      // Return immediately and process in background
      res.json({
        success: true,
        sessionId: sessionId,
        message: 'Thesis generation started. Use /api/thesis/status/:sessionId to check progress.'
      });

      // Process in background
      processThesisGeneration(sessionId, topics, userId, chatId).catch(error => {
        console.error('Background thesis generation error:', error);
        thesisSessions.set(sessionId, {
          ...thesisSessions.get(sessionId),
          status: 'error',
          error: error.message
        });
      });

    } catch (error) {
      console.error('Thesis generation error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * Background thesis generation process
 */
async function processThesisGeneration(sessionId, topics, userId, chatId) {
  try {
    const session = thesisSessions.get(sessionId);
    let allSearchResults = [];

    // Step 1: Search all topics
    const currentSession = thesisSessions.get(sessionId);
    if (currentSession) {
      currentSession.status = 'searching';
      currentSession.progress = 10;
      currentSession.message = 'Searching multiple sources for research materials...';
    }

    for (let i = 0; i < topics.length; i++) {
      const topic = topics[i];
      const sessionUpdate = thesisSessions.get(sessionId);
      if (sessionUpdate) {
        sessionUpdate.message = `Searching sources for topic ${i + 1}/${topics.length}: ${topic}`;
        sessionUpdate.progress = 10 + (i / topics.length) * 30;
      }

      const searchResults = await searchMultipleSources(topic);
      allSearchResults = allSearchResults.concat(searchResults);

      // Save search results to database
      if (chatId) {
        await prisma.message.create({
          data: {
            chatId: chatId,
            role: 'ASSISTANT',
            content: `✅ Found ${searchResults.length} sources for topic: "${topic}"\n\n${searchResults.map(r => `- ${r.source}: ${r.url}`).join('\n')}`
          }
        });
      }
    }

    const sessionUpdate1 = thesisSessions.get(sessionId);
    if (sessionUpdate1) {
      sessionUpdate1.searchResults = allSearchResults;
      sessionUpdate1.status = 'extracting';
      sessionUpdate1.progress = 40;
      sessionUpdate1.message = `Extracted ${allSearchResults.length} research sources. Processing detailed content...`;
    }

    // Step 2: Extract detailed content from top results
    const topResults = allSearchResults.slice(0, 30); // Limit to prevent timeout
    const detailedResults = [];

    for (let i = 0; i < topResults.length; i++) {
      const result = topResults[i];
      const sessionUpdate2 = thesisSessions.get(sessionId);
      if (sessionUpdate2) {
        sessionUpdate2.message = `Extracting detailed content from source ${i + 1}/${topResults.length}...`;
        sessionUpdate2.progress = 40 + (i / topResults.length) * 20;
      }

      const detailedContent = await extractContentFromUrl(result.url, result.topic);
      if (detailedContent) {
        detailedResults.push(detailedContent);
      }
    }

    // Combine search results with detailed content
    allSearchResults = allSearchResults.map(result => {
      const detailed = detailedResults.find(d => d.url === result.url);
      if (detailed) {
        return { ...result, detailedContent: detailed.content, headings: detailed.headings };
      }
      return result;
    });

    // Step 3: Save all research materials
    const sessionUpdate3 = thesisSessions.get(sessionId);
    if (sessionUpdate3) {
      sessionUpdate3.status = 'saving';
      sessionUpdate3.progress = 60;
      sessionUpdate3.message = 'Saving research materials...';
    }

    // Save to database
    const researchData = {
      topics: topics,
      sources: allSearchResults.map(r => ({
        source: r.source,
        url: r.url,
        title: r.title,
        topic: r.topic
      })),
      totalSources: allSearchResults.length,
      timestamp: new Date().toISOString()
    };

    if (chatId) {
      await prisma.message.create({
        data: {
          chatId: chatId,
          role: 'ASSISTANT',
          content: `📚 Research Materials Saved\n\n**Total Sources Found:** ${allSearchResults.length}\n**Topics Covered:** ${topics.length}\n\n**Sources by Topic:**\n${topics.map(topic => {
            const count = allSearchResults.filter(r => r.topic === topic).length;
            return `- ${topic}: ${count} sources`;
          }).join('\n')}`
        }
      });
    }

    // Step 4: Generate thesis
    const sessionUpdate4 = thesisSessions.get(sessionId);
    if (sessionUpdate4) {
      sessionUpdate4.status = 'generating';
      sessionUpdate4.progress = 70;
      sessionUpdate4.message = 'Generating comprehensive thesis using AI...';
    }

    const thesisContent = await generateThesis(topics, allSearchResults, userId, sessionId);

    const sessionUpdate5 = thesisSessions.get(sessionId);
    if (sessionUpdate5) {
      sessionUpdate5.thesisContent = thesisContent;
      sessionUpdate5.status = 'saving_document';
      sessionUpdate5.progress = 90;
      sessionUpdate5.message = 'Saving thesis as document...';
    }

    // Step 5: Save thesis as document
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `Thesis_${timestamp}.docx`;
    const { filePath, safeFilename } = await createDocument(userId, filename, thesisContent);

    const finalSession = thesisSessions.get(sessionId);
    if (finalSession) {
      finalSession.status = 'completed';
      finalSession.progress = 100;
      finalSession.message = 'Thesis generation completed successfully!';
      finalSession.documentPath = filePath;
      finalSession.documentFilename = safeFilename;
    }

    // Save thesis message to chat
    if (chatId) {
      await prisma.message.create({
        data: {
          chatId: chatId,
          role: 'ASSISTANT',
          content: `# ✅ Thesis Generation Completed!\n\n**Topics Covered:** ${topics.length}\n**Research Sources:** ${allSearchResults.length}\n**Thesis Length:** ${(thesisContent.length / 1000).toFixed(1)}K characters\n\n**Document:** ${safeFilename}\n\nYour comprehensive thesis has been generated and saved. You can download it from the files section.`,
          files: JSON.stringify([{
            type: 'document',
            name: safeFilename,
            url: `/api/thesis/download/${sessionId}`,
            path: filePath
          }])
        }
      });
    }

    console.log(`✅ Thesis generation completed for session ${sessionId}`);

  } catch (error) {
    console.error('Thesis generation process error:', error);
    const session = thesisSessions.get(sessionId);
    if (session) {
      session.status = 'error';
      session.error = error.message;
      session.message = `Error: ${error.message}`;
    }
  }
}

/**
 * Get Thesis Generation Status
 */
router.get('/status/:sessionId', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.id;

    const session = thesisSessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.userId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({
      status: session.status,
      progress: session.progress,
      message: session.message,
      error: session.error,
      documentPath: session.documentPath,
      documentFilename: session.documentFilename,
      topics: session.topics,
      sourcesCount: session.searchResults?.length || 0
    });

  } catch (error) {
    console.error('Get status error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Download Thesis Document
 */
router.get('/download/:sessionId', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.id;

    const session = thesisSessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.userId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!session.documentPath) {
      return res.status(404).json({ error: 'Document not ready yet' });
    }

    res.download(session.documentPath, session.documentFilename);

  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

