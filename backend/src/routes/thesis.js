const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const OpenAI = require('openai');
const { createDocument } = require('../services/document-service');
const { chromium } = require('playwright');
const fs = require('fs').promises;
const fsSync = require('fs');
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
 * Calculate similarity between two text strings (simple word overlap)
 */
function calculateSimilarity(text1, text2) {
  if (!text1 || !text2 || text1.length === 0 || text2.length === 0) {
    return 0;
  }

  const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 3));

  if (words1.size === 0 || words2.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const word of words1) {
    if (words2.has(word)) {
      intersection++;
    }
  }

  const union = words1.size + words2.size - intersection;
  return intersection / union; // Jaccard similarity
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

// Endpoint to serve screenshots
router.get('/screenshots/:sessionId/:filename', (req, res) => {
  const { sessionId, filename } = req.params;

  // Use absolute path resolution
  const screenshotPath = path.resolve(__dirname, '../../uploads/screenshots', sessionId, filename);

  console.log(`📷 Screenshot requested: ${screenshotPath}`);
  console.log(`📷 __dirname: ${__dirname}`);
  console.log(`📷 Resolved path: ${screenshotPath}`);

  // Check if file exists before sending
  fs.access(screenshotPath)
    .then(() => {
      console.log(`✅ Screenshot file found, serving: ${filename}`);
      // Set proper content type
      res.setHeader('Content-Type', 'image/png');
      res.sendFile(screenshotPath, (err) => {
        if (err) {
          console.error(`❌ Error sending screenshot file: ${err.message}`);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Error serving screenshot', message: err.message });
          }
        }
      });
    })
    .catch((err) => {
      console.error(`❌ Screenshot not found: ${screenshotPath}`, err.message);

      // Try to list directory contents for debugging
      const dirPath = path.resolve(__dirname, '../../uploads/screenshots', sessionId);
      fs.readdir(dirPath)
        .then(files => {
          console.log(`📁 Files in directory ${dirPath}:`, files);
        })
        .catch(dirErr => {
          console.error(`❌ Cannot read directory: ${dirPath}`, dirErr.message);
        });

      res.status(404).json({
        error: 'Screenshot not found',
        path: screenshotPath,
        sessionId: sessionId,
        filename: filename
      });
    });
});

/**
 * Intelligent Topic Analysis - Analyzes topic and generates ONE optimized search query
 * Returns only ONE query to prevent duplicate searches
 */
async function analyzeTopicAndGenerateQuery(topic) {
  try {
    // Use AI to analyze the topic and generate ONE optimized search query
    const analysisPrompt = `Analyze this research topic and generate ONE optimized search query for academic databases. 

Topic: "${topic}"

Instructions:
1. If the topic is a complete thesis title or research question, keep it as ONE unified query - DO NOT SPLIT IT
2. Do NOT split the topic by commas, dashes, or location names (like "Pisco - 2025")
3. Extract key academic concepts and create ONE comprehensive search query
4. Focus on academic keywords that will find relevant scientific articles
5. Return ONLY ONE optimized query string, not multiple queries

Return ONLY the optimized query string (not an array). Example:
"production management system optimize unproductive times agricultural agro-industrial"

CRITICAL: Return ONLY ONE query string. Do NOT return multiple queries or an array.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are an expert research librarian. Generate ONE optimized academic search query. Return only the query string, not an array.' },
        { role: 'user', content: analysisPrompt }
      ],
      temperature: 0.3,
      max_tokens: 200
    });

    let optimizedQuery = response.choices[0].message.content.trim();

    // Clean up the response - remove JSON formatting if present
    optimizedQuery = optimizedQuery.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/g, '').trim();
    optimizedQuery = optimizedQuery.replace(/^["']|["']$/g, ''); // Remove quotes

    // If it looks like JSON array, extract first element
    if (optimizedQuery.startsWith('[')) {
      try {
        const parsed = JSON.parse(optimizedQuery);
        optimizedQuery = Array.isArray(parsed) ? parsed[0] : optimizedQuery;
      } catch (e) {
        // Keep original if parsing fails
      }
    }

    // If query is too short or invalid, use original topic
    if (!optimizedQuery || optimizedQuery.length < 5) {
      optimizedQuery = topic;
    }

    console.log(`🧠 Generated optimized query: "${optimizedQuery}" from topic: "${topic}"`);
    return optimizedQuery;
  } catch (error) {
    console.error('Error analyzing topic:', error.message);
    // Fallback to original topic
    return topic;
  }
}

/**
 * Helper function to capture screenshot on every URL navigation
 * This ensures real-time screenshots for every page visit
 */
async function captureScreenshotOnNavigation(page, sessionId, screenshotsDir, sourceName, url) {
  try {
    // Wait a bit for page to fully load
    await page.waitForTimeout(2000);

    const session = thesisSessions.get(sessionId);
    if (!session) return;

    // Generate unique screenshot filename
    const timestamp = Date.now();
    const screenshotFilename = `${sourceName.replace(/\s+/g, '_').toLowerCase()}_${timestamp}.png`;
    const screenshotPath = path.resolve(screenshotsDir, screenshotFilename);

    // Capture screenshot
    await page.screenshot({
      path: screenshotPath,
      fullPage: false, // Faster capture
      type: 'png'
    });

    console.log(`📸 Real-time screenshot captured: ${screenshotFilename} for ${url}`);

    // Update session immediately for real-time display
    session.currentSource = sourceName;
    session.currentUrl = url;
    session.currentScreenshot = screenshotFilename;
    session.screenshots = session.screenshots || [];
    session.screenshots.push({
      source: sourceName,
      filename: screenshotFilename,
      url: url,
      timestamp: new Date().toISOString()
    });
    session.lastUpdated = new Date().toISOString();

    // Verify file was created
    try {
      const stats = await fs.stat(screenshotPath);
      console.log(`📊 Screenshot verified: ${stats.size} bytes`);
    } catch (statError) {
      console.error(`❌ Screenshot verification failed: ${statError.message}`);
    }
  } catch (error) {
    console.error(`❌ Error capturing screenshot: ${error.message}`);
    // Don't throw - continue even if screenshot fails
  }
}

/**
 * Enhanced ResearchGate search - clicks through multiple results and extracts PDFs/content
 */
async function searchResearchGate(topic, sessionId, page, screenshotsDir) {
  const results = [];
  try {
    console.log(`🔬 Searching ResearchGate for: ${topic}`);
    const searchUrl = `https://www.researchgate.net/search?q=${encodeURIComponent(topic)}`;

    // Navigate to search page with proper wait
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Capture screenshot immediately after navigation (real-time)
    await captureScreenshotOnNavigation(page, sessionId, screenshotsDir, 'ResearchGate', searchUrl);

    // Wait for search results to load
    try {
      await page.waitForSelector('a[href*="/publication/"], .nova-legacy-c-card__title a, .research-detail-header-section__title a', { timeout: 10000 });
    } catch (waitError) {
      console.log(`⚠️ Search results may not have loaded, continuing anyway...`);
    }

    // Scroll down to load more results
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight / 2);
    });
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(2000);

    // Find all search result links with improved selectors
    const resultLinks = await page.evaluate(() => {
      const links = [];
      const seenUrls = new Set();

      // ResearchGate search result selectors - more comprehensive
      const selectors = [
        'a[href*="/publication/"]',
        '.nova-legacy-c-card__title a',
        '.research-detail-header-section__title a',
        'a[data-test="publication-title"]',
        '.nova-legacy-v-publication-item__title a',
        '.nova-legacy-c-card__body a[href*="/publication/"]',
        'div[class*="publication"] a[href*="/publication/"]',
        'article a[href*="/publication/"]'
      ];

      for (const selector of selectors) {
        try {
          const elements = document.querySelectorAll(selector);
          elements.forEach(el => {
            const href = el.href || el.getAttribute('href');
            const text = el.innerText || el.textContent || '';
            if (href && href.includes('/publication/') && text.trim().length > 10) {
              let fullUrl = href.startsWith('http') ? href : `https://www.researchgate.net${href}`;
              // Clean up URL
              fullUrl = fullUrl.split('?')[0]; // Remove query params

              if (!seenUrls.has(fullUrl)) {
                seenUrls.add(fullUrl);
                links.push({
                  url: fullUrl,
                  title: text.trim()
                });
              }
            }
          });
        } catch (e) {
          // Continue if selector fails
        }
      }

      // Also try to find links by text content
      const allLinks = document.querySelectorAll('a');
      allLinks.forEach(el => {
        const href = el.href || el.getAttribute('href');
        const text = el.innerText || el.textContent || '';
        if (href && href.includes('/publication/') && text.trim().length > 15 && !seenUrls.has(href)) {
          let fullUrl = href.startsWith('http') ? href : `https://www.researchgate.net${href}`;
          fullUrl = fullUrl.split('?')[0];
          seenUrls.add(fullUrl);
          links.push({
            url: fullUrl,
            title: text.trim()
          });
        }
      });

      return links.slice(0, 15); // Get up to 15 results, will process only 10
    });

    console.log(`📄 Found ${resultLinks.length} ResearchGate results, clicking through each article...`);

    // Click through each result and extract content (limit to 10 articles as requested)
    const resultsToProcess = resultLinks.slice(0, 10);
    for (let i = 0; i < resultsToProcess.length; i++) {
      const resultLink = resultsToProcess[i];
      try {
        console.log(`  📖 [${i + 1}/${resultsToProcess.length}] Clicking on article: ${resultLink.title.substring(0, 60)}...`);


        // Navigate to the article page with proper wait
        try {
          await page.goto(resultLink.url, { waitUntil: 'networkidle', timeout: 20000 });

          // Capture screenshot immediately after navigation (real-time)
          await captureScreenshotOnNavigation(page, sessionId, screenshotsDir, 'ResearchGate', resultLink.url);

          // Update session message
          if (session) {
            session.message = `ResearchGate: Extracting content from article ${i + 1}/${resultsToProcess.length} - ${resultLink.title.substring(0, 40)}...`;
            session.lastUpdated = new Date().toISOString();
          }

          // Check if article requires permission/login - skip if it does
          const requiresPermission = await page.evaluate(() => {
            // Look for common permission/login indicators
            const permissionIndicators = [
              'Sign up to continue',
              'Request full-text',
              'Request PDF',
              'Join ResearchGate',
              'Log in to continue',
              'This publication is not available',
              'Request access',
              'Full-text available',
              'Full-text not available'
            ];

            const bodyText = document.body.innerText || document.body.textContent || '';
            const hasPermissionRequest = permissionIndicators.some(indicator =>
              bodyText.toLowerCase().includes(indicator.toLowerCase())
            );

            // Check for specific ResearchGate permission elements
            const permissionElements = document.querySelectorAll(
              '[data-test="request-full-text"], ' +
              '.request-full-text, ' +
              '.nova-legacy-c-button--primary:has-text("Request"), ' +
              'button:has-text("Request full-text"), ' +
              'button:has-text("Request PDF")'
            );

            return hasPermissionRequest || permissionElements.length > 0;
          });

          if (requiresPermission) {
            console.log(`    ⚠️ Article requires permission/login, skipping: ${resultLink.title.substring(0, 50)}...`);
            continue; // Skip this article
          }

          // Wait for main content to appear
          try {
            await page.waitForSelector('main, article, h1, .publication-title', { timeout: 5000 });
          } catch (e) {
            console.log(`    ⚠️ Main content selector not found, continuing...`);
          }
        } catch (navError) {
          console.log(`    ⚠️ Navigation error: ${navError.message}, trying to continue...`);
          // Try to continue even if navigation fails
        }

        // Extract content and check for PDF with improved extraction
        const pageContent = await page.evaluate(() => {
          // Remove scripts and styles
          const scripts = document.querySelectorAll('script, style, noscript, nav, header, footer, .ads, .advertisement');
          scripts.forEach(el => el.remove());

          // Find PDF download link - specifically look for "Read full text" and "Download PDF" buttons
          let pdfUrl = null;
          let fullTextUrl = null;

          // First, look for "Read full text" or "Download PDF" buttons/links
          const fullTextSelectors = [
            'a:has-text("Read full-text")',
            'a:has-text("Read full text")',
            'a:has-text("Download full-text")',
            'a:has-text("Download PDF")',
            'button:has-text("Read full-text")',
            'button:has-text("Read full text")',
            'button:has-text("Download PDF")',
            'a[data-test="read-full-text"]',
            'a[data-test="download-pdf"]',
            '.nova-legacy-c-button:has-text("Read full")',
            '.nova-legacy-c-button:has-text("Download")'
          ];

          // Try to find full text or PDF download buttons
          for (const selector of fullTextSelectors) {
            try {
              const elements = document.querySelectorAll('a, button');
              for (const el of elements) {
                const text = (el.innerText || el.textContent || '').toLowerCase();
                if (text.includes('read full') || text.includes('download pdf') || text.includes('download full')) {
                  const href = el.href || el.getAttribute('href') || el.getAttribute('data-href') || el.getAttribute('data-url');
                  if (href) {
                    fullTextUrl = href.startsWith('http') ? href : `https://www.researchgate.net${href}`;
                    break;
                  }
                }
              }
              if (fullTextUrl) break;
            } catch (e) {
              // Continue to next selector
            }
          }

          // Also check standard PDF selectors
          const pdfSelectors = [
            'a[href*=".pdf"]',
            'a[data-test="download-pdf"]',
            'a[title*="PDF"]',
            'a[title*="Download"]',
            'a[href*="/download/"]',
            'button[data-test="download-pdf"]',
            '.download-pdf',
            'a[aria-label*="PDF"]',
            'a[aria-label*="Download"]',
            'a[href*="/publication/"] a[href*=".pdf"]'
          ];

          for (const selector of pdfSelectors) {
            const pdfLinks = document.querySelectorAll(selector);
            for (const pdfLink of pdfLinks) {
              const href = pdfLink.href || pdfLink.getAttribute('href') || pdfLink.getAttribute('data-href');
              if (href && (href.includes('.pdf') || href.includes('/download/'))) {
                pdfUrl = href.startsWith('http') ? href : `https://www.researchgate.net${href}`;
                break;
              }
            }
            if (pdfUrl) break;
          }

          // Use fullTextUrl if found, otherwise use pdfUrl
          const finalPdfUrl = fullTextUrl || pdfUrl;

          // Extract title - multiple selectors
          let title = document.title;
          const titleSelectors = [
            'h1',
            '.publication-title',
            '[data-test="publication-title"]',
            '.nova-legacy-v-publication-item__title',
            '.research-detail-header-section__title',
            'h1[class*="title"]'
          ];
          for (const selector of titleSelectors) {
            const titleEl = document.querySelector(selector);
            if (titleEl) {
              title = titleEl.innerText || titleEl.textContent || title;
              if (title.trim().length > 10) break;
            }
          }

          // Extract abstract - multiple selectors
          let abstract = '';
          const abstractSelectors = [
            '.publication-abstract',
            '.abstract',
            '[data-test="publication-abstract"]',
            '.nova-legacy-c-card__body',
            '.research-detail-header-section__description',
            '[class*="abstract"]',
            '[class*="summary"]'
          ];
          for (const selector of abstractSelectors) {
            const abstractEl = document.querySelector(selector);
            if (abstractEl) {
              abstract = abstractEl.innerText || abstractEl.textContent || '';
              if (abstract.trim().length > 50) break;
            }
          }

          // Extract authors - multiple selectors
          let authors = '';
          const authorSelectors = [
            '.publication-authors a',
            '.author-list a',
            '[data-test="publication-authors"] a',
            '.nova-legacy-v-person-inline-item',
            '[class*="author"] a',
            '.research-detail-header-section__authors a'
          ];
          const authorsList = [];
          for (const selector of authorSelectors) {
            const authorsEls = document.querySelectorAll(selector);
            if (authorsEls.length > 0) {
              authorsEls.forEach(a => {
                const authorName = a.innerText || a.textContent || '';
                if (authorName.trim().length > 2 && !authorsList.includes(authorName.trim())) {
                  authorsList.push(authorName.trim());
                }
              });
              if (authorsList.length > 0) break;
            }
          }
          authors = authorsList.join(', ');

          // Extract main content - comprehensive extraction
          let content = '';
          const contentSelectors = [
            'main',
            'article',
            '.publication-content',
            '[role="main"]',
            '.nova-legacy-c-card__body',
            '.research-detail-header-section',
            '.publication-detail'
          ];

          for (const selector of contentSelectors) {
            const mainContent = document.querySelector(selector);
            if (mainContent) {
              content = mainContent.innerText || mainContent.textContent || '';
              if (content.trim().length > 500) break;
            }
          }

          // Fallback to body if no main content found
          if (!content || content.trim().length < 500) {
            content = document.body.innerText || document.body.textContent || '';
          }

          // Extract additional sections
          const sections = {};
          const sectionSelectors = {
            methods: ['.methods', '[class*="method"]', 'section:has(h2:contains("Method"))'],
            results: ['.results', '[class*="result"]', 'section:has(h2:contains("Result"))'],
            conclusion: ['.conclusion', '[class*="conclusion"]', 'section:has(h2:contains("Conclusion"))']
          };

          return {
            title: title.trim(),
            abstract: abstract.trim(),
            authors: authors,
            content: content.substring(0, 80000), // Increased content limit
            pdfUrl: finalPdfUrl, // Use the found PDF/full text URL
            fullTextUrl: fullTextUrl, // Store full text URL separately
            url: window.location.href,
            sections: sections
          };
        });

        // Try to download and extract PDF content if available
        // Priority: Try full text URL first, then PDF URL
        let pdfContent = null;
        let pdfText = null;
        const pdfUrlToUse = pageContent.fullTextUrl || pageContent.pdfUrl;

        if (pdfUrlToUse) {
          try {
            console.log(`    📥 Attempting to access full text/PDF from: ${pdfUrlToUse}`);

            // First, try to click the "Read full text" or "Download PDF" button if it exists
            const buttonClicked = await page.evaluate(() => {
              // Find and click "Read full text" or "Download PDF" button
              const buttons = document.querySelectorAll('a, button');
              for (const btn of buttons) {
                const text = (btn.innerText || btn.textContent || '').toLowerCase();
                if (text.includes('read full') || text.includes('download pdf') || text.includes('download full')) {
                  btn.click();
                  return true;
                }
              }
              return false;
            });

            if (buttonClicked) {
              console.log(`    ✅ Clicked full text/PDF button, waiting for content to load...`);
              await page.waitForTimeout(4000); // Wait for PDF/full text to load

              // Try to extract text from the page (might be PDF viewer or full text)
              const extractedText = await page.evaluate(() => {
                // Remove scripts and styles
                const scripts = document.querySelectorAll('script, style, noscript, nav, header, footer');
                scripts.forEach(el => el.remove());

                // Try to find main content area
                const mainContent = document.querySelector('main, article, .publication-content, [role="main"], .pdf-viewer, iframe[src*=".pdf"]') || document.body;
                const text = mainContent.innerText || mainContent.textContent || '';

                // If it's an iframe, try to access its content
                const pdfIframe = document.querySelector('iframe[src*=".pdf"], iframe[src*="/download/"]');
                if (pdfIframe && pdfIframe.contentDocument) {
                  const iframeText = pdfIframe.contentDocument.body.innerText || pdfIframe.contentDocument.body.textContent || '';
                  if (iframeText.length > text.length) {
                    return iframeText;
                  }
                }

                return text;
              });

              if (extractedText && extractedText.length > 500) {
                pdfText = extractedText;
                console.log(`    ✅ Full text extracted from page (${pdfText.length} characters)`);
              }
            }

            // If we don't have text yet, try to download PDF directly
            if (!pdfText) {
              try {
                const response = await page.goto(pdfUrlToUse, { waitUntil: 'networkidle', timeout: 20000 });

                // Capture screenshot of PDF page (real-time)
                await captureScreenshotOnNavigation(page, sessionId, screenshotsDir, 'ResearchGate PDF', pdfUrlToUse);

                if (response && response.ok()) {
                  const contentType = response.headers()['content-type'] || '';

                  if (contentType.includes('application/pdf')) {
                    // It's a PDF file
                    const pdfBuffer = await response.body();
                    if (pdfBuffer && pdfBuffer.length > 0) {
                      pdfContent = pdfBuffer.toString('base64');
                      console.log(`    ✅ PDF downloaded successfully (${pdfBuffer.length} bytes)`);

                      // Try to extract text from PDF
                      try {
                        let pdfParse;
                        try {
                          pdfParse = require('pdf-parse');
                        } catch (libError) {
                          console.log(`    ℹ️ pdf-parse library not available, trying alternative methods`);
                          pdfParse = null;
                        }

                        if (pdfParse) {
                          const pdfData = await pdfParse(Buffer.from(pdfBuffer));
                          pdfText = pdfData.text;
                          console.log(`    ✅ PDF text extracted successfully (${pdfText.length} characters)`);
                        } else {
                          // Alternative: use browser's PDF viewer if available
                          await page.waitForTimeout(3000);
                          const pdfPageText = await page.evaluate(() => {
                            const bodyText = document.body.innerText || document.body.textContent || '';
                            return bodyText.length > 500 ? bodyText : '';
                          });
                          if (pdfPageText && pdfPageText.length > 500) {
                            pdfText = pdfPageText;
                            console.log(`    ✅ PDF text extracted from viewer (${pdfText.length} characters)`);
                          }
                        }
                      } catch (parseError) {
                        console.log(`    ⚠️ Could not parse PDF text: ${parseError.message}`);
                      }
                    }
                  } else if (contentType.includes('text/html')) {
                    // It's an HTML page with full text
                    await page.waitForTimeout(3000);
                    const fullText = await page.evaluate(() => {
                      const scripts = document.querySelectorAll('script, style, noscript, nav, header, footer');
                      scripts.forEach(el => el.remove());
                      const mainContent = document.querySelector('main, article, .publication-content, [role="main"]') || document.body;
                      return (mainContent.innerText || mainContent.textContent || '').substring(0, 200000);
                    });
                    if (fullText && fullText.length > 500) {
                      pdfText = fullText;
                      console.log(`    ✅ Full text extracted from HTML page (${pdfText.length} characters)`);
                    }
                  }
                }
              } catch (downloadError) {
                console.log(`    ⚠️ Could not download from URL: ${downloadError.message}`);
              }
            }
          } catch (pdfError) {
            console.log(`    ⚠️ Error accessing full text/PDF: ${pdfError.message}`);
          }
        }

        // Combine all content sources: abstract, main content, and PDF text
        let fullContent = pageContent.content || '';
        if (pageContent.abstract) {
          fullContent = pageContent.abstract + '\n\n' + fullContent;
        }
        if (pdfText) {
          fullContent = fullContent + '\n\n[PDF Content]\n' + pdfText.substring(0, 50000); // Add PDF text
        }

        results.push({
          source: 'ResearchGate',
          topic: topic,
          url: resultLink.url,
          title: pageContent.title || resultLink.title,
          abstract: pageContent.abstract,
          authors: pageContent.authors,
          content: fullContent.substring(0, 100000), // Combined content from all sources
          pdfUrl: pageContent.pdfUrl,
          pdfContent: pdfContent,
          pdfText: pdfText ? pdfText.substring(0, 50000) : null, // Store PDF text separately
          timestamp: new Date().toISOString()
        });

        await page.waitForTimeout(800); // Reduced rate limiting for faster search

      } catch (error) {
        console.error(`  ❌ Error processing ResearchGate result ${i + 1}:`, error.message);
        // Continue with next result
      }
    }

    console.log(`✅ ResearchGate search completed: ${results.length} results extracted`);
    return results;

  } catch (error) {
    console.error(`❌ Error searching ResearchGate:`, error.message);
    return results;
  }
}

/**
 * Enhanced DuckDuckGo search with pagination - goes through multiple pages
 */
async function searchDuckDuckGo(topic, sessionId, page, screenshotsDir, maxPages = 5) {
  const results = [];
  try {
    console.log(`🦆 Searching DuckDuckGo for: ${topic} (max ${maxPages} pages)`);
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(topic)}`;

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });

    // Capture screenshot immediately after navigation (real-time)
    await captureScreenshotOnNavigation(page, sessionId, screenshotsDir, 'DuckDuckGo', searchUrl);

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      try {
        console.log(`  📄 Processing DuckDuckGo page ${pageNum}/${maxPages}...`);

        // Capture screenshot for current page (real-time)
        const currentUrl = page.url();
        await captureScreenshotOnNavigation(page, sessionId, screenshotsDir, 'DuckDuckGo', currentUrl);

        // Extract search results from current page
        const pageResults = await page.evaluate(() => {
          const results = [];
          // DuckDuckGo result selectors
          const resultElements = document.querySelectorAll('.result, .web-result, .links_main');

          resultElements.forEach((element, index) => {
            const titleEl = element.querySelector('a.result__a, .result__title, h2 a');
            const snippetEl = element.querySelector('.result__snippet, .result__body, .result__abstract');
            const linkEl = element.querySelector('a.result__a, .result__url, h2 a');

            if (titleEl && linkEl) {
              const title = titleEl.innerText || titleEl.textContent || '';
              const snippet = snippetEl ? (snippetEl.innerText || snippetEl.textContent) : '';
              const url = linkEl.href || linkEl.getAttribute('href');

              if (url && title.trim().length > 5) {
                results.push({
                  title: title.trim(),
                  snippet: snippet.trim(),
                  url: url
                });
              }
            }
          });

          return results;
        });

        console.log(`    ✅ Found ${pageResults.length} results on page ${pageNum}`);

        // Visit each result and extract content (increased to 8 results per page for faster comprehensive search)
        for (let i = 0; i < Math.min(pageResults.length, 8); i++) { // Increased to 8 results per page
          const result = pageResults[i];
          try {
            console.log(`    🔍 Extracting content from: ${result.title.substring(0, 50)}...`);

            // Navigate to result page with faster timeout
            await page.goto(result.url, { waitUntil: 'domcontentloaded', timeout: 8000 });

            // Capture screenshot immediately after navigation (real-time)
            await captureScreenshotOnNavigation(page, sessionId, screenshotsDir, 'DuckDuckGo', result.url);

            // Extract detailed content
            const detailedContent = await page.evaluate(() => {
              // Remove scripts and styles
              const scripts = document.querySelectorAll('script, style, noscript, nav, header, footer');
              scripts.forEach(el => el.remove());

              const mainContent = document.querySelector('main, article, .content, #content, [role="main"]')
                || document.body;

              return {
                title: document.title,
                content: mainContent ? (mainContent.innerText || mainContent.textContent || '').substring(0, 30000) : '', // Increased content limit
                url: window.location.href
              };
            });

            results.push({
              source: 'DuckDuckGo',
              topic: topic,
              url: result.url,
              title: detailedContent.title || result.title,
              snippet: result.snippet,
              content: detailedContent.content,
              pageNumber: pageNum,
              timestamp: new Date().toISOString()
            });

            await page.waitForTimeout(500); // Reduced rate limiting for faster search

          } catch (error) {
            console.error(`    ❌ Error extracting content from result ${i + 1}:`, error.message);
            // Add result with snippet only
            results.push({
              source: 'DuckDuckGo',
              topic: topic,
              url: result.url,
              title: result.title,
              snippet: result.snippet,
              content: result.snippet,
              pageNumber: pageNum,
              timestamp: new Date().toISOString()
            });
          }
        }

        // Try to go to next page
        if (pageNum < maxPages) {
          try {
            const nextPageInfo = await page.evaluate(() => {
              // Try multiple selectors for next page button
              const nextSelectors = [
                'a.result--more__btn',
                '.pagination__btn--next',
                'a[rel="next"]',
                'input[value="Next"]',
                'a:has-text("Next")',
                '.pagination a:last-child'
              ];

              for (const selector of nextSelectors) {
                const nextLink = document.querySelector(selector);
                if (nextLink) {
                  const href = nextLink.href || nextLink.getAttribute('href') || nextLink.getAttribute('value');
                  if (href) {
                    return { found: true, href: href };
                  }
                }
              }

              // Try to find next page by form submission
              const form = document.querySelector('form[method="post"]');
              if (form) {
                const inputs = form.querySelectorAll('input[name="s"]');
                if (inputs.length > 0) {
                  const currentPage = parseInt(inputs[inputs.length - 1].value) || 0;
                  return { found: true, nextPage: currentPage + 1, form: true };
                }
              }

              return { found: false };
            });

            if (nextPageInfo.found) {
              if (nextPageInfo.href) {
                const nextUrl = nextPageInfo.href.startsWith('http')
                  ? nextPageInfo.href
                  : `https://html.duckduckgo.com${nextPageInfo.href}`;
                await page.goto(nextUrl, { waitUntil: 'networkidle', timeout: 15000 });
                await page.waitForTimeout(2000);
              } else if (nextPageInfo.form) {
                // Handle form-based pagination
                await page.evaluate((nextPage) => {
                  const form = document.querySelector('form[method="post"]');
                  if (form) {
                    const input = form.querySelector('input[name="s"]');
                    if (input) {
                      input.value = nextPage;
                      form.submit();
                    }
                  }
                }, nextPageInfo.nextPage);
                await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 });

                // Capture screenshot after form navigation (real-time)
                const currentUrl = page.url();
                await captureScreenshotOnNavigation(page, sessionId, screenshotsDir, 'DuckDuckGo', currentUrl);
              }
            } else {
              console.log(`    ℹ️ No more pages available`);
              break;
            }
          } catch (nextPageError) {
            console.log(`    ⚠️ Could not navigate to next page: ${nextPageError.message}`);
            break;
          }
        }

      } catch (pageError) {
        console.error(`  ❌ Error processing DuckDuckGo page ${pageNum}:`, pageError.message);
        break;
      }
    }

    console.log(`✅ DuckDuckGo search completed: ${results.length} results from ${maxPages} pages`);
    return results;

  } catch (error) {
    console.error(`❌ Error searching DuckDuckGo:`, error.message);
    return results;
  }
}

/**
 * Search multiple websites for a topic with real-time screenshots
 */
// Track active searches to prevent duplicate calls
const activeSearches = new Set();

async function searchMultipleSources(topic, sessionId) {
  const searchKey = `${sessionId}-${topic.toLowerCase().trim()}`;

  // Prevent duplicate searches
  if (activeSearches.has(searchKey)) {
    console.log(`⚠️ Search already in progress for topic: "${topic}" in session: ${sessionId}`);
    return []; // Return empty array if already searching
  }

  activeSearches.add(searchKey);
  console.log(`\n🔎 searchMultipleSources called for topic: "${topic}" (Session: ${sessionId})`);

  const searchResults = [];

  let browser = null;

  try {
    const sources = [
      { name: 'Google Scholar', url: `https://scholar.google.com/scholar?q=${encodeURIComponent(topic)}` },
      { name: 'PubMed', url: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(topic)}` },
      { name: 'ArXiv', url: `https://arxiv.org/search/?query=${encodeURIComponent(topic)}&searchtype=all` },
      { name: 'IEEE Xplore', url: `https://ieeexplore.ieee.org/search/searchresult.jsp?queryText=${encodeURIComponent(topic)}` },
      { name: 'Wikipedia', url: `https://en.wikipedia.org/wiki/Special:Search/${encodeURIComponent(topic)}` },
      { name: 'Google Search', url: `https://www.google.com/search?q=${encodeURIComponent(topic)}` }
    ];

    // Create screenshots directory
    const screenshotsDir = path.join(__dirname, '../../uploads/screenshots', sessionId);
    try {
      await fs.mkdir(screenshotsDir, { recursive: true });
      console.log(`📁 Created screenshots directory: ${screenshotsDir}`);
    } catch (error) {
      console.log('Screenshots directory already exists or could not be created:', error.message);
    }

    // const browser = await chromium.launch({ headless: false }); // Set to true for production
    // const context = await browser.newContext({
    //   userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    //   viewport: { width: 1280, height: 720 } // Set consistent viewport for screenshots
    // });
    browser = await chromium.launch({
      headless: true, // Keep headless for better performance and CAPTCHA avoidance
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-javascript-harmony-shipping',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-dev-shm-usage',
        '--memory-pressure-off',
        '--max_old_space_size=4096',
        '--disable-ipc-flooding-protection'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
      locale: 'en-US',
      // Speed optimizations
      ignoreHTTPSErrors: true,
      bypassCSP: true
    });

    const page = await context.newPage();

    // try {
    //   // Enhanced ResearchGate search - clicks through multiple results
    //   console.log(`  🔬 Starting ResearchGate search for: "${topic}"`);
    //   const researchGateResults = await searchResearchGate(topic, sessionId, page, screenshotsDir);
    //   console.log(`  ✅ ResearchGate returned ${researchGateResults.length} results`);
    //   searchResults.push(...researchGateResults);
    // } catch (error) {
    //   console.error(`  ❌ Error in ResearchGate search for topic "${topic}":`, error.message);
    //   // Continue with other sources even if ResearchGate fails
    // }

    try {
      // Enhanced DuckDuckGo search with pagination (increased pages for more results)
      console.log(`  🦆 Starting DuckDuckGo search for: "${topic}"`);
      const duckDuckGoResults = await searchDuckDuckGo(topic, sessionId, page, screenshotsDir, 5);
      console.log(`  ✅ DuckDuckGo returned ${duckDuckGoResults.length} results`);
      searchResults.push(...duckDuckGoResults);
    } catch (error) {
      console.error(`  ❌ Error in DuckDuckGo search for topic "${topic}":`, error.message);
      // Continue with other sources even if DuckDuckGo fails
    }

    // Process other sources normally
    for (const source of sources) {
      try {
        console.log(`🔍 Searching ${source.name} for: ${topic}`);


        await page.goto(source.url, { waitUntil: 'networkidle', timeout: 15000 });

        // Capture screenshot immediately after navigation (real-time)
        await captureScreenshotOnNavigation(page, sessionId, screenshotsDir, source.name, source.url);

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

        // Significantly increased content size - extract ALL content
        content.content = content.content.substring(0, 50000); // Increased from 10000 to 50000
        content.links = content.links.slice(0, 30); // Increased links

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

  } catch (error) {
    console.error(`❌ Critical error in searchMultipleSources for topic "${topic}":`, error);
    // Return whatever results we have so far
  } finally {
    // Always close browser and remove from active searches
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error(`Error closing browser:`, closeError.message);
      }
    }
    activeSearches.delete(searchKey);
    console.log(`🔎 searchMultipleSources completed for topic: "${topic}" - Total results: ${searchResults.length}`);
  }

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
      content: content.content.substring(0, 50000), // Significantly increased - extract ALL content
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

**CRITICAL REQUIREMENTS:**
1. Create a professional thesis document with a minimum of 75-80 pages (when converted to Word/PDF) - approximately 120,000+ characters
2. Include proper academic structure: Abstract, Introduction, Literature Review, Methodology, Findings, Discussion, Conclusion, References
3. **USE ALL** the provided research materials - do not skip any sources. Synthesize information from every source provided
4. Write in a formal, academic tone with extensive detail
5. Include VERY detailed analysis, extensive examples, case studies, and evidence from ALL research materials
6. Ensure the thesis is comprehensive, well-argued, and academically sound
7. Include proper citations in APA or MLA format for EVERY source used
8. Add section numbers, headings, and subheadings throughout
9. Include tables, figures descriptions, data analysis, and examples where appropriate
10. Make sure each section is VERY substantial and detailed - expand extensively
11. **IMPORTANT**: If a topic appears to be a complete thesis title (e.g., "Implementation of X in Y - Location - Year"), treat it as ONE unified topic. Do NOT split it into parts.
12. Write extensively - aim for 120K+ characters. Be thorough and comprehensive.

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
    const usedContentHashes = new Set(); // Track used content to prevent repetition

    const sections = [
      { name: 'Title Page and Abstract', prompt: 'Generate ONLY ONE title page and abstract (300-400 words) for the thesis. Use the EXACT topic title provided - do not split or modify it. Generate this section ONLY ONCE.' },
      { name: 'Introduction', prompt: 'Write Chapter 1: Introduction (10-12 pages). Include extensive background, detailed problem statement, comprehensive objectives, and significance. Be very thorough.' },
      { name: 'Literature Review', prompt: 'Write Chapter 2: Literature Review (20-25 pages). Synthesize ALL the research materials provided, cite EVERY source properly, and organize by themes. Include extensive analysis of each source. Use content from abstracts, detailed content, and all provided materials.' },
      { name: 'Methodology', prompt: 'Write Chapter 3: Methodology (8-10 pages). Describe the research approach in detail, comprehensive data collection methods, and thorough analysis techniques.' },
      { name: 'Findings', prompt: 'Write Chapter 4: Findings/Results (15-20 pages). Present ALL key findings from the research materials with extensive analysis, examples, and evidence.' },
      { name: 'Discussion', prompt: 'Write Chapter 5: Discussion (12-15 pages). Interpret the findings extensively, discuss implications in detail, and relate comprehensively to existing literature.' },
      { name: 'Conclusion', prompt: 'Write Chapter 6: Conclusion (5-8 pages). Summarize key points comprehensively, discuss limitations thoroughly, and provide detailed future research directions.' },
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

      // Select relevant research chunks for this section - use ALL chunks for comprehensive content
      let relevantChunks = researchChunks;
      // Use ALL chunks for all sections to ensure maximum content usage
      relevantChunks = researchChunks;

      // Build research content for this section
      let sectionResearchContent = `# Research Materials for ${section.name}\n\n`;
      sectionResearchContent += `## Topics to Cover:\n${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n`;

      // Add relevant research chunks (limit content size)
      for (const chunk of relevantChunks) {
        sectionResearchContent += `### Topic: ${chunk.topic} (Chunk ${chunk.chunkIndex}/${chunk.totalChunks})\n\n`;
        chunk.results.forEach((result, idx) => {
          sectionResearchContent += `#### Source ${idx + 1}: ${result.source}\n`;
          sectionResearchContent += `**URL:** ${result.url}\n\n`;
          // Significantly increased content limits - use ALL available content
          const contentLimit = section.name === 'Literature Review' ? 15000 : 12000; // Increased from 4000/3000

          // Combine ALL content sources: abstract, detailedContent, content, pdfText
          let contentToUse = '';
          if (result.abstract) {
            contentToUse += `[Abstract]\n${result.abstract}\n\n`;
          }
          if (result.pdfText) {
            contentToUse += `[PDF Content]\n${result.pdfText.substring(0, 30000)}\n\n`;
          }
          if (result.detailedContent) {
            contentToUse += `[Detailed Content]\n${result.detailedContent}\n\n`;
          }
          if (result.content) {
            contentToUse += `[Main Content]\n${result.content}\n\n`;
          }

          // Use all content up to limit
          sectionResearchContent += `**Content:**\n${contentToUse.substring(0, contentLimit)}\n\n`;
          sectionResearchContent += `---\n\n`;
        });
      }

      // If research content is too large, chunk it further (significantly increased chunk size for more content)
      const researchChunksForSection = chunkContent(sectionResearchContent, 100000); // Increased from 60000 to 100000

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

          // Check for duplicate/repeated content
          const chunkHash = chunkContent.substring(0, 300).toLowerCase().replace(/\s+/g, '');
          if (usedContentHashes.has(chunkHash)) {
            console.log(`⚠️ Skipping duplicate chunk content in ${section.name}`);
            continue; // Skip duplicate chunk
          }
          usedContentHashes.add(chunkHash);

          if (chunkIdx === 0) {
            sectionContent = chunkContent;
          } else {
            // Merge chunk content intelligently (avoid repetition)
            const newContent = chunkContent;
            // Check if new content is too similar to existing content
            if (sectionContent.length > 0 && newContent.length > 100) {
              const similarity = calculateSimilarity(sectionContent.substring(sectionContent.length - 500), newContent.substring(0, 500));
              if (similarity > 0.8) {
                console.log(`⚠️ Skipping highly similar content in ${section.name} (similarity: ${similarity.toFixed(2)})`);
                continue;
              }
            }
            sectionContent += '\n\n' + newContent;
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

      // Add section to thesis (prevent duplicate title pages)
      if (sectionContent) {
        // Check if this is a duplicate title page
        if (section.name === 'Title Page and Abstract') {
          const titlePageHash = sectionContent.substring(0, 200).toLowerCase().replace(/\s+/g, '');
          if (usedContentHashes.has(titlePageHash)) {
            console.log(`⚠️ Skipping duplicate ${section.name} section`);
            continue; // Skip duplicate title page
          }
          usedContentHashes.add(titlePageHash);
        }

        // Check for repeated content patterns
        const contentHash = sectionContent.substring(0, 500).toLowerCase().replace(/\s+/g, '');
        if (usedContentHashes.has(contentHash) && section.name !== 'References') {
          console.log(`⚠️ Detected repeated content in ${section.name}, skipping duplicate`);
          continue;
        }
        usedContentHashes.add(contentHash);

        thesisContent += (thesisContent ? '\n\n' : '') + `# ${section.name}\n\n${sectionContent}`;
      }
    }

    // Final expansion pass if thesis is still too short (increased threshold)
    if (thesisContent.length < 80000) {
      const session = thesisSessions.get(sessionId);
      if (session) {
        session.progress = 95;
        session.message = 'Expanding thesis to meet length requirements...';
      }

      try {
        const expansionPrompt = `The thesis currently has ${(thesisContent.length / 1000).toFixed(1)}K characters. You MUST expand it to at least 120K characters (approximately 75-80 pages) by:
1. Adding MUCH more detailed analysis in each section - be very thorough
2. Including extensive examples, case studies, and real-world applications
3. Expanding the literature review with comprehensive synthesis of ALL research materials
4. Adding significant depth to findings and discussion sections
5. Including extensive citations and references from all provided sources
6. Adding detailed methodology explanations
7. Including tables, figures descriptions, and data analysis
8. Expanding each chapter to be substantial and comprehensive

IMPORTANT: Use ALL the research materials provided. Do not skip any sources. Make this a comprehensive, detailed academic thesis.

Continue from the current thesis and maintain academic quality. Write extensively.`;

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

      let { topics, chatId } = req.body;
      const userId = req.user.id;

      if (!topics || topics.length === 0) {
        return res.status(400).json({ error: 'At least one topic is required' });
      }

      // CRITICAL: If topics array has multiple items that look like parts of ONE topic (split by comma/dash),
      // merge them back into ONE topic
      // Example: ["Implementation of X", "Pisco - 2025"] should become ["Implementation of X - Pisco - 2025"]
      let mergedTopics = [];

      // First, check if any topic contains dashes/commas that might indicate it's a complete topic
      const hasCompleteTopic = topics.some(t => {
        const trimmed = t.trim();
        // Check for patterns like "Topic - Location - Year" or "Topic, Location, Year"
        return /^.+[-–—]\s*.+[-–—]\s*\d{4}/.test(trimmed) ||
          /^.+,\s*.+,\s*\d{4}/.test(trimmed) ||
          trimmed.length > 50; // Long topics are likely complete
      });

      if (topics.length > 1 && !hasCompleteTopic) {
        // Check if topics are actually parts of one topic (common patterns)
        const hasLocationYear = topics.some(t => /^\s*[-–—]\s*\d{4}\s*$/.test(t) || /^\s*[-–—]\s*[A-Za-z]+\s*[-–—]\s*\d{4}\s*$/.test(t));
        const hasLocation = topics.some(t => /^\s*[-–—]\s*[A-Za-z]+\s*$/.test(t));
        const hasYear = topics.some(t => /^\s*[-–—]\s*\d{4}\s*$/.test(t));
        const hasShortSuffix = topics.slice(1).every(t => t.trim().length < 20); // Short suffixes likely part of main topic

        // If last topic(s) look like location/year suffixes, merge with main topic
        if ((hasLocationYear || (hasLocation && hasYear)) || hasShortSuffix) {
          const mainTopic = topics[0].trim();
          const suffixes = topics.slice(1).map(t => t.trim()).filter(t => t.length > 0);
          if (suffixes.length > 0) {
            mergedTopics = [mainTopic + ' ' + suffixes.join(' ')];
            console.log(`🔗 Merged ${topics.length} topic parts into ONE topic: "${mergedTopics[0]}"`);
          } else {
            mergedTopics = [mainTopic];
          }
        } else {
          // Check if topics are very similar (might be duplicates with slight variations)
          const normalizedTopics = topics.map(t => t.trim().toLowerCase());
          const uniqueNormalized = [...new Set(normalizedTopics)];
          if (uniqueNormalized.length === 1) {
            // All topics are the same, use only one
            mergedTopics = [topics[0].trim()];
            console.log(`🔗 All ${topics.length} topics are identical, using ONE: "${mergedTopics[0]}"`);
          } else {
            // Keep as separate topics only if they're truly different
            mergedTopics = topics.map(t => t.trim());
          }
        }
      } else if (topics.length === 1) {
        // Only one topic provided - keep it as is
        mergedTopics = [topics[0].trim()];
        console.log(`✅ Single topic provided: "${mergedTopics[0]}"`);
      } else {
        // Multiple topics but one looks complete - use the longest/most complete one
        const longestTopic = topics.reduce((a, b) => a.trim().length > b.trim().length ? a : b);
        mergedTopics = [longestTopic.trim()];
        console.log(`🔗 Multiple topics provided, using the most complete one: "${mergedTopics[0]}"`);
      }

      // Remove duplicate topics (case-insensitive) from merged topics
      const uniqueTopicsSet = new Set();
      const deduplicatedTopics = [];
      for (const topic of mergedTopics) {
        const normalizedTopic = topic.trim().toLowerCase();
        if (normalizedTopic && !uniqueTopicsSet.has(normalizedTopic)) {
          uniqueTopicsSet.add(normalizedTopic);
          deduplicatedTopics.push(topic.trim());
        }
      }
      topics = deduplicatedTopics;

      // FINAL CHECK: If user provided what looks like ONE complete topic but it got split,
      // merge everything into ONE topic
      if (topics.length > 1) {
        const firstTopic = topics[0].trim();
        const otherTopics = topics.slice(1).map(t => t.trim()).join(' ');

        // If first topic is long (>30 chars) and others are short (<30 chars), likely one topic split
        if (firstTopic.length > 30 && otherTopics.length < 50) {
          topics = [firstTopic + ' ' + otherTopics];
          console.log(`🔗 Final merge: Combined into ONE topic: "${topics[0]}"`);
        }
      }

      console.log(`📋 Final topics after merging and deduplication: ${topics.length} - ${topics.join(' | ')}`);

      if (topics.length === 0) {
        return res.status(400).json({ error: 'No valid topics provided after removing duplicates' });
      }

      // Generate session ID
      const sessionId = `thesis-${userId}-${Date.now()}`;

      // Initialize session with all required fields
      const initialSession = {
        status: 'initializing',
        progress: 0,
        message: 'Starting thesis generation process...',
        userId: userId,
        topics: topics,
        searchResults: [],
        thesisContent: null,
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString()
      };

      thesisSessions.set(sessionId, initialSession);
      console.log(`✅ Session created: ${sessionId}`);
      console.log(`📊 Total active sessions: ${thesisSessions.size}`);

      // Return immediately and process in background
      res.json({
        success: true,
        sessionId: sessionId,
        message: 'Thesis generation started. Use /api/thesis/status/:sessionId to check progress.'
      });

      // Small delay to ensure session is saved before background process starts
      await new Promise(resolve => setTimeout(resolve, 100));

      // Process in background
      processThesisGeneration(sessionId, topics, userId, chatId).catch(error => {
        console.error('Background thesis generation error:', error);
        const errorSession = thesisSessions.get(sessionId);
        if (errorSession) {
          errorSession.status = 'error';
          errorSession.error = error.message;
          errorSession.message = `Error: ${error.message}`;
          errorSession.lastUpdated = new Date().toISOString();
        } else {
          // Recreate session if it was deleted
          thesisSessions.set(sessionId, {
            ...initialSession,
            status: 'error',
            error: error.message,
            message: `Error: ${error.message}`
          });
        }
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
  console.log(`\n🚀 Starting processThesisGeneration for session: ${sessionId}`);
  console.log(`📝 Topics received: ${topics.length} - ${topics.join(', ')}`);
  console.log(`📊 Active sessions before process: ${thesisSessions.size}`);

  try {
    // Ensure session exists - if not, create it
    let session = thesisSessions.get(sessionId);
    if (!session) {
      console.error(`❌ Session ${sessionId} not found when starting process, creating new session...`);
      session = {
        status: 'initializing',
        progress: 0,
        message: 'Session recreated, starting process...',
        userId: userId,
        topics: topics,
        searchResults: [],
        thesisContent: null,
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString()
      };
      thesisSessions.set(sessionId, session);
      console.log(`✅ Session recreated: ${sessionId}`);
    } else {
      // Update session to show it's starting
      session.status = 'initializing';
      session.progress = 5;
      session.message = 'Process starting...';
      session.lastUpdated = new Date().toISOString();
      console.log(`✅ Session found and updated: ${sessionId}`);
    }

    let allSearchResults = [];

    // Step 0: Ensure topics are not split - merge if needed
    // If topics look like they're parts of one topic, merge them
    let uniqueTopics = [];
    if (topics.length > 1) {
      // Check if topics are parts of one complete topic
      const allText = topics.join(' ').toLowerCase();
      const hasLocationYearPattern = topics.some(t => /^\s*[-–—]\s*\d{4}\s*$/.test(t) || /^\s*[-–—]\s*[A-Za-z]+\s*[-–—]\s*\d{4}\s*$/.test(t));

      if (hasLocationYearPattern) {
        // Merge all topics into one
        uniqueTopics = [topics.map(t => t.trim()).join(' ')];
        console.log(`🔗 Merged ${topics.length} topic parts into ONE: "${uniqueTopics[0]}"`);
      } else {
        // Remove duplicates
        const seenTopics = new Set();
        for (const topic of topics) {
          const normalizedTopic = topic.trim().toLowerCase();
          if (!seenTopics.has(normalizedTopic)) {
            seenTopics.add(normalizedTopic);
            uniqueTopics.push(topic.trim());
          }
        }
      }
    } else {
      // Only one topic - use it as is
      uniqueTopics = [topics[0].trim()];
    }

    console.log(`📋 Final unique topics: ${uniqueTopics.length} - ${uniqueTopics.join(' | ')}`);

    // Step 1: Search all unique topics
    const currentSession = thesisSessions.get(sessionId);
    if (currentSession) {
      currentSession.status = 'searching';
      currentSession.progress = 10;
      currentSession.message = 'Searching multiple sources for research materials...';
      currentSession.topics = uniqueTopics; // Update with deduplicated topics
      currentSession.lastUpdated = new Date().toISOString();
    } else {
      console.error(`⚠️ Session ${sessionId} lost during process, recreating...`);
      thesisSessions.set(sessionId, {
        status: 'searching',
        progress: 10,
        message: 'Searching multiple sources for research materials...',
        userId: userId,
        topics: uniqueTopics,
        searchResults: [],
        thesisContent: null,
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString()
      });
    }

    // Track unique URLs to avoid duplicates
    const seenUrls = new Set();
    // Track processed topics to prevent double processing
    const processedTopics = new Set();

    console.log(`🔍 Starting search for ${uniqueTopics.length} unique topic(s): ${uniqueTopics.join(', ')}`);

    for (let i = 0; i < uniqueTopics.length; i++) {
      const topic = uniqueTopics[i];
      const topicKey = topic.toLowerCase().trim();

      // Skip if already processed
      if (processedTopics.has(topicKey)) {
        console.log(`⚠️ Skipping duplicate topic: ${topic} (already processed)`);
        continue;
      }
      processedTopics.add(topicKey);

      const sessionUpdate = thesisSessions.get(sessionId);
      if (sessionUpdate) {
        sessionUpdate.message = `Searching sources for topic ${i + 1}/${uniqueTopics.length}: ${topic}`;
        sessionUpdate.progress = 10 + (i / uniqueTopics.length) * 30;
        sessionUpdate.lastUpdated = new Date().toISOString();
      } else {
        // Recreate session if lost
        console.error(`⚠️ Session ${sessionId} lost during search, recreating...`);
        thesisSessions.set(sessionId, {
          status: 'searching',
          progress: 10 + (i / uniqueTopics.length) * 30,
          message: `Searching sources for topic ${i + 1}/${uniqueTopics.length}: ${topic}`,
          userId: userId,
          topics: uniqueTopics,
          searchResults: allSearchResults,
          thesisContent: null,
          createdAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString()
        });
      }

      console.log(`\n📚 [${i + 1}/${uniqueTopics.length}] Searching topic: "${topic}"`);

      // Analyze topic and generate ONE optimized search query (not multiple)
      const optimizedQuery = await analyzeTopicAndGenerateQuery(topic);
      console.log(`🧠 Using optimized query: "${optimizedQuery}"`);

      // Search ONLY ONCE with the optimized query
      const searchResults = await searchMultipleSources(optimizedQuery, sessionId);
      console.log(`📊 Received ${searchResults.length} results for topic: "${topic}"`);

      // Filter out duplicate URLs
      const uniqueResults = searchResults.filter(result => {
        const urlKey = result.url.toLowerCase().trim();
        if (seenUrls.has(urlKey)) {
          return false; // Skip duplicate
        }
        seenUrls.add(urlKey);
        return true;
      });

      allSearchResults = allSearchResults.concat(uniqueResults);

      // Don't create separate messages - let frontend polling handle updates
      console.log(`✅ Found ${uniqueResults.length} unique sources for topic: ${topic} (${searchResults.length - uniqueResults.length} duplicates skipped)`);
    }

    console.log(`\n📈 Total unique results collected: ${allSearchResults.length} from ${processedTopics.size} topic(s)`);

    const sessionUpdate1 = thesisSessions.get(sessionId);
    if (sessionUpdate1) {
      sessionUpdate1.searchResults = allSearchResults;
      sessionUpdate1.status = 'extracting';
      sessionUpdate1.progress = 40;
      sessionUpdate1.message = `Extracted ${allSearchResults.length} unique research sources. Processing detailed content...`;
      sessionUpdate1.lastUpdated = new Date().toISOString();
    } else {
      // Recreate session if lost
      console.error(`⚠️ Session ${sessionId} lost, recreating...`);
      thesisSessions.set(sessionId, {
        status: 'extracting',
        progress: 40,
        message: `Extracted ${allSearchResults.length} unique research sources. Processing detailed content...`,
        userId: userId,
        topics: uniqueTopics,
        searchResults: allSearchResults,
        thesisContent: null,
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString()
      });
    }

    // Step 2: Extract detailed content only for results that don't already have detailed content
    // (ResearchGate and DuckDuckGo already extract detailed content, so skip those)
    const resultsNeedingExtraction = allSearchResults.filter(result => {
      // Skip if already has detailed content or is from ResearchGate/DuckDuckGo (already extracted)
      return !result.detailedContent &&
        !result.abstract &&
        result.source !== 'ResearchGate' &&
        result.source !== 'DuckDuckGo';
    });

    const topResults = resultsNeedingExtraction.slice(0, 20); // Limit to prevent timeout
    const detailedResults = [];

    if (topResults.length > 0) {
      console.log(`📄 Extracting detailed content from ${topResults.length} sources that need it...`);

      for (let i = 0; i < topResults.length; i++) {
        const result = topResults[i];
        const sessionUpdate2 = thesisSessions.get(sessionId);
        if (sessionUpdate2) {
          sessionUpdate2.message = `Extracting detailed content from source ${i + 1}/${topResults.length}...`;
          sessionUpdate2.progress = 40 + (i / topResults.length) * 20;
          sessionUpdate2.lastUpdated = new Date().toISOString();
        }

        const detailedContent = await extractContentFromUrl(result.url, result.topic);
        if (detailedContent) {
          detailedResults.push(detailedContent);
        }
      }

      // Combine search results with detailed content (only for those that needed extraction)
      allSearchResults = allSearchResults.map(result => {
        const detailed = detailedResults.find(d => d.url === result.url);
        if (detailed) {
          return { ...result, detailedContent: detailed.content, headings: detailed.headings };
        }
        return result;
      });
    } else {
      console.log(`✅ All results already have detailed content, skipping extraction step`);
    }

    // Step 3: Save all research materials
    const sessionUpdate3 = thesisSessions.get(sessionId);
    if (sessionUpdate3) {
      sessionUpdate3.status = 'saving';
      sessionUpdate3.progress = 60;
      sessionUpdate3.message = 'Saving research materials...';
      sessionUpdate3.lastUpdated = new Date().toISOString();
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

    // Don't create separate messages - let frontend polling handle updates
    console.log(`📚 Research Materials Saved: ${allSearchResults.length} sources found`);

    // Step 4: Generate thesis (use unique topics)
    const sessionUpdate4 = thesisSessions.get(sessionId);
    if (sessionUpdate4) {
      sessionUpdate4.status = 'generating';
      sessionUpdate4.progress = 70;
      sessionUpdate4.message = 'Generating comprehensive thesis using AI...';
      sessionUpdate4.lastUpdated = new Date().toISOString();
    }

    const thesisContent = await generateThesis(uniqueTopics, allSearchResults, userId, sessionId);

    const sessionUpdate5 = thesisSessions.get(sessionId);
    if (sessionUpdate5) {
      sessionUpdate5.thesisContent = thesisContent;
      sessionUpdate5.status = 'saving_document';
      sessionUpdate5.progress = 90;
      sessionUpdate5.message = 'Saving thesis as document...';
      sessionUpdate5.lastUpdated = new Date().toISOString();
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
      finalSession.lastUpdated = new Date().toISOString();
    } else {
      // Recreate session if lost
      console.error(`⚠️ Session ${sessionId} lost at completion, recreating...`);
      thesisSessions.set(sessionId, {
        status: 'completed',
        progress: 100,
        message: 'Thesis generation completed successfully!',
        userId: userId,
        topics: uniqueTopics,
        searchResults: allSearchResults,
        thesisContent: thesisContent,
        documentPath: filePath,
        documentFilename: safeFilename,
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString()
      });
    }

    // Save thesis message to chat - ONLY create the final completion message
    if (chatId) {
      await prisma.message.create({
        data: {
          chatId: chatId,
          role: 'ASSISTANT',
          content: `# ✅ Thesis Generation Completed!\n\n**Topics Covered:** ${uniqueTopics.length}\n**Research Sources:** ${allSearchResults.length}\n**Thesis Length:** ${(thesisContent.length / 1000).toFixed(1)}K characters\n\n**Document:** ${safeFilename}\n\nYour comprehensive thesis has been generated and saved. You can download it from the files section.`,
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
    console.error('Error stack:', error.stack);
    let session = thesisSessions.get(sessionId);
    if (session) {
      session.status = 'error';
      session.error = error.message;
      session.message = `Error: ${error.message}`;
      session.lastUpdated = new Date().toISOString();
    } else {
      // Recreate session with error state
      console.error(`⚠️ Session ${sessionId} lost during error, recreating with error state...`);
      thesisSessions.set(sessionId, {
        status: 'error',
        progress: 0,
        message: `Error: ${error.message}`,
        error: error.message,
        userId: userId,
        topics: topics,
        searchResults: [],
        thesisContent: null,
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString()
      });
    }
  } finally {
    console.log(`📊 Active sessions after process: ${thesisSessions.size}`);
    const finalCheck = thesisSessions.get(sessionId);
    if (finalCheck) {
      console.log(`✅ Session ${sessionId} exists with status: ${finalCheck.status}`);
    } else {
      console.error(`❌ Session ${sessionId} NOT FOUND after process completion!`);
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

    // Log all active session IDs for debugging
    if (thesisSessions.size > 0) {
      const activeSessionIds = Array.from(thesisSessions.keys());
      console.log(`📊 Active session IDs: ${activeSessionIds.join(', ')}`);
    }

    const session = thesisSessions.get(sessionId);

    if (!session) {
      console.log(`⚠️ Session not found: ${sessionId} (User: ${userId})`);
      console.log(`📊 Active sessions: ${thesisSessions.size}`);

      // Check if session ID format is correct
      if (!sessionId.startsWith('thesis-')) {
        return res.status(400).json({
          error: 'Invalid session ID format',
          message: 'Session ID must start with "thesis-"'
        });
      }

      return res.status(404).json({
        error: 'Session not found',
        message: 'Session may have expired or server was restarted. Please start a new thesis generation.',
        activeSessions: thesisSessions.size,
        requestedSessionId: sessionId
      });
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
      sourcesCount: session.searchResults?.length || 0,
      // Current browser activity
      currentSource: session.currentSource,
      currentUrl: session.currentUrl,
      currentScreenshot: session.currentScreenshot,
      // Screenshot history
      screenshots: session.screenshots || [],
      // Provide detailed search results for frontend to build links
      searchResults: session.status === 'searching' || session.status === 'completed'
        ? session.searchResults?.slice(0, 6).map(r => ({ source: r.source, url: r.url, topic: r.topic }))
        : undefined
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

    // Check if this is a preview request (for viewing in browser)
    const isPreview = req.query.preview === 'true';
    
    if (isPreview) {
      // For preview, serve with inline content disposition and proper headers
      const fileExtension = path.extname(session.documentFilename).toLowerCase();
      let contentType = 'application/octet-stream';
      
      // Set appropriate content type
      if (fileExtension === '.docx' || fileExtension === '.doc') {
        contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      } else if (fileExtension === '.pdf') {
        contentType = 'application/pdf';
      }
      
      // Set headers for preview (inline viewing)
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `inline; filename="${session.documentFilename}"`);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization');
      
      // Send file for preview
      const fileStream = fsSync.createReadStream(session.documentPath);
      fileStream.pipe(res);
    } else {
      // For download, use res.download
      res.download(session.documentPath, session.documentFilename);
    }

  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Download Thesis Document by Filename
 */
router.get('/files/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    let userId = null;

    // Check authentication - either from header or query parameter
    const authHeader = req.headers.authorization;
    const tokenFromQuery = req.query.token;

    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else if (tokenFromQuery) {
      token = tokenFromQuery;
    }

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Verify token (simplified - you may want to use your actual auth verification)
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
      userId = decoded.id;
    } catch (error) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // First, try to find the file in the user's documents directory
    // We need to search through the user's chat directories
    const uploadsDir = path.join(__dirname, '../../uploads/documents');

    let filePath = null;

    // Search through user's chat directories for the file
    try {
      const chatDirs = await fs.readdir(uploadsDir);
      for (const chatDir of chatDirs) {
        const chatDirPath = path.join(uploadsDir, chatDir);
        const stat = await fs.stat(chatDirPath);
        if (stat.isDirectory()) {
          const potentialFilePath = path.join(chatDirPath, filename);
          try {
            await fs.access(potentialFilePath);
            filePath = potentialFilePath;
            break;
          } catch (err) {
            // File not in this directory, continue searching
            continue;
          }
        }
      }
    } catch (searchError) {
      console.error('Error searching for file:', searchError);
    }

    // If not found in documents, try uploads root directory (fallback)
    if (!filePath) {
      const rootPath = path.join(__dirname, '../../uploads', filename);
      try {
        await fs.access(rootPath);
        filePath = rootPath;
      } catch (error) {
        return res.status(404).json({ error: 'File not found', filename });
      }
    }

    console.log(`📁 Serving thesis file: ${filename} from ${filePath}`);

    // Check if this is a preview request (for viewing in browser)
    const isPreview = req.query.preview === 'true';
    
    if (isPreview) {
      // For preview, serve with inline content disposition and proper headers
      const fileExtension = path.extname(filename).toLowerCase();
      let contentType = 'application/octet-stream';
      
      // Set appropriate content type
      if (fileExtension === '.docx' || fileExtension === '.doc') {
        contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      } else if (fileExtension === '.pdf') {
        contentType = 'application/pdf';
      }
      
      // Set headers for preview (inline viewing)
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization');
      
      // Send file for preview
      const fileStream = fsSync.createReadStream(filePath);
      fileStream.pipe(res);
    } else {
      // For download, use res.download
      res.download(filePath, filename);
    }

  } catch (error) {
    console.error('Download file error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

