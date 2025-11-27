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
 * Get max_tokens limit for a model
 * Different models have different token limits
 */
function getMaxTokensForModel(model) {
  const modelLimits = {
    'gpt-3.5-turbo': 4096,
    'gpt-3.5-turbo-16k': 16384,
    'gpt-4': 8192,
    'gpt-4-turbo': 128000,
    'gpt-4-turbo-preview': 128000,
    'gpt-4-1106-preview': 128000,
    'gpt-4o': 128000,
    'gpt-4o-mini': 16384,
    'gpt-4o-mini-search-preview-2025-03-11': 16384,
  };

  // Find matching model (handles partial matches)
  for (const [key, limit] of Object.entries(modelLimits)) {
    if (model.includes(key) || model === key) {
      return Math.min(limit - 1000, 4000); // Reserve 1000 tokens for safety, max 4000 for completion
    }
  }

  // Default safe limit
  return 4000;
}

/**
 * Chunk large text content into manageable pieces
 * Similar to how Cursor handles large files
 */
function chunkContent(content, maxChunkSize = 50000) {
  if (content.length <= maxChunkSize) {
    return [content];
  }

  const chunks = [];
  let currentChunk = '';
  const lines = content.split('\n');

  for (const line of lines) {
    if ((currentChunk + line + '\n').length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = line + '\n';
    } else {
      currentChunk += line + '\n';
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Chunk research results intelligently
 * Groups by topic and source to maintain context
 */
function chunkResearchResults(allSearchResults, topics, maxResultsPerChunk = 10) {
  const chunks = [];
  
  for (const topic of topics) {
    const topicResults = allSearchResults.filter(r => r.topic === topic);
    
    // Split topic results into chunks
    for (let i = 0; i < topicResults.length; i += maxResultsPerChunk) {
      const chunk = topicResults.slice(i, i + maxResultsPerChunk);
      chunks.push({
        topic: topic,
        results: chunk,
        chunkIndex: Math.floor(i / maxResultsPerChunk) + 1,
        totalChunks: Math.ceil(topicResults.length / maxResultsPerChunk)
      });
    }
  }
  
  return chunks;
}

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
 * Generate thesis from collected research using chunking approach
 * Similar to how Cursor handles large files - divides content into manageable chunks
 */
async function generateThesis(topics, allSearchResults, userId, sessionId) {
  try {
    // Update progress
    const existingSession = thesisSessions.get(sessionId);
    if (existingSession) {
      existingSession.status = 'generating_thesis';
      existingSession.progress = 70;
      existingSession.message = 'Preparing research materials and generating thesis...';
    }

    // Use a model with large context window - prefer newer models
    const availableModels = [
      'gpt-4-turbo-preview',
      'gpt-4-1106-preview',
      'gpt-4-turbo',
      'gpt-4o',
      'gpt-4'
    ];
    
    // Try to use the best available model
    let model = availableModels[0];
    let maxTokens = getMaxTokensForModel(model);
    
    // Test model availability and adjust if needed
    try {
      // Test with a small request to verify model
      await openai.chat.completions.create({
        model: model,
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 10
      });
    } catch (error) {
      console.error('Error with primary model, trying fallback:', error);
      model = availableModels[1] || 'gpt-4';
      maxTokens = getMaxTokensForModel(model);
    }

    // System prompt for thesis generation
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

    // Chunk research results intelligently
    const researchChunks = chunkResearchResults(allSearchResults, topics, 8);
    
    // Build thesis iteratively using chunks
    let thesisContent = '';
    const sections = [
      { name: 'Title Page and Abstract', prompt: 'Generate the title page and abstract (250-300 words) for the thesis.' },
      { name: 'Introduction', prompt: 'Write Chapter 1: Introduction (5-8 pages). Include background, problem statement, objectives, and significance.' },
      { name: 'Literature Review', prompt: 'Write Chapter 2: Literature Review (10-15 pages). Synthesize the research materials provided, cite sources properly, and organize by themes.' },
      { name: 'Methodology', prompt: 'Write Chapter 3: Methodology (5-8 pages). Describe the research approach, data collection methods, and analysis techniques.' },
      { name: 'Findings', prompt: 'Write Chapter 4: Findings/Results (10-15 pages). Present the key findings from the research materials with proper analysis.' },
      { name: 'Discussion', prompt: 'Write Chapter 5: Discussion (8-10 pages). Interpret the findings, discuss implications, and relate to existing literature.' },
      { name: 'Conclusion', prompt: 'Write Chapter 6: Conclusion (3-5 pages). Summarize key points, limitations, and future research directions.' },
      { name: 'References', prompt: 'Generate a comprehensive References/Bibliography section with all cited sources in proper APA or MLA format.' }
    ];

    // Generate each section using relevant research chunks
    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
      const section = sections[sectionIndex];
      
      // Update progress
      const session = thesisSessions.get(sessionId);
      if (session) {
        session.progress = 70 + (sectionIndex / sections.length) * 25;
        session.message = `Generating ${section.name}... (${sectionIndex + 1}/${sections.length})`;
      }

      // Select relevant research chunks for this section
      let relevantChunks = researchChunks;
      if (section.name === 'Literature Review' || section.name === 'Findings') {
        // Use all chunks for these sections
        relevantChunks = researchChunks;
      } else {
        // Use fewer chunks for other sections
        relevantChunks = researchChunks.slice(0, Math.min(3, researchChunks.length));
      }

      // Build research content for this section
      let sectionResearchContent = `# Research Materials for ${section.name}\n\n`;
      sectionResearchContent += `## Topics to Cover:\n${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n`;
      
      // Add relevant research chunks (limit content size)
      for (const chunk of relevantChunks) {
        sectionResearchContent += `### Topic: ${chunk.topic} (Chunk ${chunk.chunkIndex}/${chunk.totalChunks})\n\n`;
        chunk.results.forEach((result, idx) => {
          sectionResearchContent += `#### Source ${idx + 1}: ${result.source}\n`;
          sectionResearchContent += `**URL:** ${result.url}\n\n`;
          // Limit content per source to avoid token overflow
          const contentLimit = section.name === 'Literature Review' ? 2000 : 1500;
          sectionResearchContent += `**Content:**\n${result.content.substring(0, contentLimit)}\n\n`;
          sectionResearchContent += `---\n\n`;
        });
      }

      // If research content is too large, chunk it further
      const researchChunksForSection = chunkContent(sectionResearchContent, 40000);
      
      let sectionContent = '';
      
      // Process each research chunk
      for (let chunkIdx = 0; chunkIdx < researchChunksForSection.length; chunkIdx++) {
        const researchChunk = researchChunksForSection[chunkIdx];
        
        const userPrompt = chunkIdx === 0
          ? `${researchChunk}\n\n${section.prompt}\n\nBased on the above research materials, ${section.prompt.toLowerCase()}`
          : `${researchChunk}\n\nContinue and expand the ${section.name} section using this additional research material.`;

        try {
          const response = await openai.chat.completions.create({
            model: model,
            messages: [
              { role: 'system', content: systemPrompt },
              ...(thesisContent ? [{ role: 'assistant', content: `Previous thesis content:\n${thesisContent.substring(0, 5000)}...` }] : []),
              { role: 'user', content: userPrompt }
            ],
            temperature: 0.7,
            max_tokens: maxTokens
          });

          const chunkContent = response.choices[0].message.content;
          
          if (chunkIdx === 0) {
            sectionContent = chunkContent;
          } else {
            // Merge chunk content intelligently
            sectionContent += '\n\n' + chunkContent;
          }

        } catch (error) {
          console.error(`Error generating ${section.name} chunk ${chunkIdx + 1}:`, error);
          
          // If token limit error, reduce max_tokens and retry
          if (error.message && error.message.includes('max_tokens')) {
            maxTokens = Math.max(2000, maxTokens - 1000);
            console.log(`Reducing max_tokens to ${maxTokens} and retrying...`);
            
            try {
              const retryResponse = await openai.chat.completions.create({
                model: model,
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: userPrompt }
                ],
                temperature: 0.7,
                max_tokens: maxTokens
              });
              
              if (chunkIdx === 0) {
                sectionContent = retryResponse.choices[0].message.content;
              } else {
                sectionContent += '\n\n' + retryResponse.choices[0].message.content;
              }
            } catch (retryError) {
              console.error(`Retry failed for ${section.name}:`, retryError);
              // Continue with next section
              break;
            }
          } else {
            // For other errors, continue with next chunk
            break;
          }
        }
      }

      // Add section to thesis
      if (sectionContent) {
        thesisContent += (thesisContent ? '\n\n' : '') + `# ${section.name}\n\n${sectionContent}`;
      }
    }

    // Final expansion pass if thesis is still too short
    if (thesisContent.length < 50000) {
      const session = thesisSessions.get(sessionId);
      if (session) {
        session.progress = 95;
        session.message = 'Expanding thesis to meet length requirements...';
      }

      try {
        const expansionPrompt = `The thesis currently has ${(thesisContent.length / 1000).toFixed(1)}K characters. Expand it to at least 80K characters (approximately 50 pages) by:
1. Adding more detailed analysis in each section
2. Including more examples and case studies
3. Expanding the literature review with additional synthesis
4. Adding more depth to findings and discussion
5. Including more citations and references

Continue from the current thesis and maintain academic quality.`;

        const expansionResponse = await openai.chat.completions.create({
          model: model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Current thesis:\n\n${thesisContent.substring(0, 10000)}...\n\n${expansionPrompt}` }
          ],
          temperature: 0.7,
          max_tokens: maxTokens
        });

        thesisContent += '\n\n' + expansionResponse.choices[0].message.content;
      } catch (error) {
        console.error('Error in final expansion:', error);
        // Continue with existing content
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

