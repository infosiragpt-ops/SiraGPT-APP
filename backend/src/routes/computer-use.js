const express = require('express');
const { chromium } = require('playwright');
const OpenAI = require('openai');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const prisma = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const {
  computerUseSafetyCheck,
  computerUseRateLimiter
} = require('../middleware/computer-use-safety');
const router = express.Router();

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Custom Computer Use Agent - simulates OpenAI's computer-use-preview
class CustomComputerUseAgent {
  constructor() {
    this.model = 'gpt-4o'; // Use available GPT-4 model
  }

  //   async analyzeScreenshotAndPlan(task, screenshot, previousAction = null) {
  //     const captchaGuidance = previousAction === 'captcha_retry' ?
  //       '\n\nIMPORTANT: Previous action detected CAPTCHA. The system will automatically handle it by:\n- Refreshing the page\n- Using alternative search engines (DuckDuckGo instead of Google)\n- Trying different approaches\n- You should focus on the main task and ignore CAPTCHA when detected' : '';

  //     const prompt = `You are a computer use agent. Analyze this screenshot and determine the next action to accomplish the task: "${task}"${captchaGuidance}

  // Current screenshot shows what's on the browser screen. Based on what you see, provide the next action in this JSON format:

  // {
  //   "reasoning": "Brief explanation of what you see and why you're taking this action",
  //   "action": {
  //     "type": "click|type|scroll|wait|navigate|completed|captcha_detected",
  //     "x": 100,
  //     "y": 200,
  //     "text": "text to type",
  //     "url": "url to navigate to",
  //     "scrollDirection": "up|down",
  //     "scrollAmount": 300
  //   },
  //   "completed": false,
  //   "captcha_detected": false
  // }

  // CAPTCHA HANDLING: If you see any CAPTCHA, reCAPTCHA, "I'm not a robot", verification challenges, or "unusual traffic" messages:
  // - Set "captcha_detected": true and "type": "captcha_detected"
  // - The system will automatically handle it by trying alternatives
  // - DO NOT try to solve the CAPTCHA manually

  // ALTERNATIVE STRATEGIES for search tasks:
  // - If Google shows CAPTCHA, system will switch to DuckDuckGo
  // - If one website blocks access, try similar websites
  // - Focus on completing the main objective using different paths

  // Actions available:
  // - click: Click at coordinates {x, y}
  // - type: Type text into focused element
  // - scroll: Scroll page up/down
  // - navigate: Go to a URL
  // - wait: Wait for page to load
  // - completed: Task is finished
  // - captcha_detected: CAPTCHA detected (will be handled automatically)

  // Be precise with coordinates. Look for search boxes, buttons, links, forms etc. If the task is completed, set completed: true.

  // Task: ${task}`;

  //     try {
  //       const response = await openai.chat.completions.create({
  //         model: this.model,
  //         messages: [
  //           {
  //             role: "user",
  //             content: [
  //               { type: "text", text: prompt },
  //               {
  //                 type: "image_url",
  //                 image_url: {
  //                   url: `data:image/png;base64,${screenshot}`
  //                 }
  //               }
  //             ]
  //           }
  //         ],
  //         max_tokens: 500,
  //         temperature: 0.1
  //       });

  //       const content = response.choices[0].message.content;
  //       // Extract JSON from response
  //       const jsonMatch = content.match(/\{[\s\S]*\}/);
  //       if (jsonMatch) {
  //         const result = JSON.parse(jsonMatch[0]);

  //         // Additional CAPTCHA detection based on common patterns
  //         const reasoningText = result.reasoning?.toLowerCase() || '';
  //         if (reasoningText.includes('captcha') ||
  //           reasoningText.includes('robot') ||
  //           reasoningText.includes('verify') ||
  //           reasoningText.includes('unusual traffic') ||
  //           reasoningText.includes('verification') ||
  //           reasoningText.includes('security check') ||
  //           reasoningText.includes('prove you are human')) {
  //           result.captcha_detected = true;
  //           result.action.type = 'captcha_detected';
  //         }

  //         return result;
  //       }

  //       // Fallback if no JSON found
  //       return {
  //         reasoning: "Unable to parse action from response",
  //         action: { type: "wait" },
  //         completed: false,
  //         captcha_detected: false
  //       };
  //     } catch (error) {
  //       console.error('Error analyzing screenshot:', error);
  //       return {
  //         reasoning: `Error: ${error.message}`,
  //         action: { type: "wait" },
  //         completed: false,
  //         captcha_detected: false
  //       };
  //     }
  //   }
  // CustomComputerUseAgent class ke andar, purane function ki jagah yeh naya function daalein

  async analyzeDomAndPlan(task, simplifiedDom, currentUrl) {
    const prompt = `You are an expert web automation agent. Your task is to: "${task}".
You are currently on the page: ${currentUrl}

Based on the current state of the webpage, which is represented by the following list of interactive elements in JSON format, decide the next action.

Interactive Elements:
${JSON.stringify(simplifiedDom, null, 2)}

Provide your response in the following JSON format ONLY:
{
  "reasoning": "A brief explanation of why you chose this action.",
  "action": {
    "type": "click|type|completed",
    "selector": "#ai-element-15",
    "text": "text to type here"
  },
  "completed": false
}

Actions available:
- click: Click on an element using its 'selector'. Use this for buttons, links, and submit inputs.
- type: Type text into an input element. ONLY use this for elements with tag 'input' and an 'inputType' of 'text', 'search', 'email', 'password', or for 'textarea' elements.
- completed: Use this when the task is finished.

IMPORTANT: Before taking an action, assess if the task is already complete.
- If the current page (${currentUrl}) seems to be the final destination or shows the results you were looking for, the task is likely complete.
- If you have already performed the main search and navigated away from the initial search engine, you should look for the information on the current page, not search again.
- If you see the final results, all items have been loaded, or there are no more 'next' or 'load more' buttons, set "completed": true to finish the task.

Choose the best element from the list and determine the next action to complete the task.`;

    try {
      const response = await openai.chat.completions.create({
        model: this.model, // 'gpt-4o'
        messages: [{ role: "user", content: prompt }],
        max_tokens: 400,
        temperature: 0.1,
        response_format: { type: "json_object" }, // Yeh response ko hamesha JSON mein dega
      });

      const content = JSON.parse(response.choices[0].message.content);
      return content;

    } catch (error) {
      console.error('Error analyzing DOM:', error);
      return {
        reasoning: `Error: ${error.message}`,
        action: { type: "wait" },
        completed: false,
      };
    }
  }
  async generateInitialPlan(task) {
    const prompt = `You are a computer use agent. Create a step-by-step plan to accomplish this task: "${task}"

Provide a plan in this JSON format:
{
  "reasoning": "Understanding of the task and approach",
  "steps": [
    "Step 1: Navigate to appropriate website",
    "Step 2: Find search box or relevant elements", 
    "Step 3: Perform search or action",
    "Step 4: Review results"
  ],
  "startingUrl": "https://www.google.com"
}

Task: ${task}`;

    try {
      const response = await openai.chat.completions.create({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 300,
        temperature: 0.1
      });

      const content = response.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }

      return {
        reasoning: "I'll help you accomplish this task step by step",
        steps: ["Navigate to relevant website", "Perform required actions"],
        startingUrl: "https://www.google.com"
      };
    } catch (error) {
      console.error('Error generating plan:', error);
      return {
        reasoning: "Starting with a basic approach",
        steps: ["Navigate to Google", "Search for information"],
        startingUrl: "https://www.google.com"
      };
    }
  }
}

// Store active sessions
const activeSessions = new Map();

function getSessionForUser(sessionId, userId) {
  if (!sessionId || !userId) return null;
  const session = activeSessions.get(sessionId);
  if (!session || session.userId !== userId) return null;
  return session;
}

// WebSocket server for real-time updates
let wss = null;

const initializeWebSocketServer = (server) => {
  wss = new WebSocket.Server({ server, path: '/ws/computer-use' });

  wss.on('connection', (ws, req) => {
    console.log('Computer Use WebSocket connected');

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        if (data.type === 'join-session') {
          if (!data.token) {
            ws.close(1008, 'Authentication required');
            return;
          }
          let decoded;
          try {
            decoded = jwt.verify(data.token, process.env.JWT_SECRET);
          } catch (_err) {
            ws.close(1008, 'Invalid authentication');
            return;
          }
          ws.sessionId = data.sessionId;
          ws.userId = decoded.userId || decoded.id;
          console.log(`Client joined session: ${data.sessionId}`);
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });

    ws.on('close', () => {
      console.log('Computer Use WebSocket disconnected');
    });
  });
};


// Broadcast to specific session
const broadcastToSession = (sessionId, data) => {
  if (!wss) return;
  const session = activeSessions.get(sessionId);

  wss.clients.forEach((client) => {
    if (client.sessionId === sessionId && client.readyState === WebSocket.OPEN) {
      if (session?.userId && client.userId !== session.userId) return;
      client.send(JSON.stringify(data));
    }
  });
};

// All HTTP Computer Use endpoints require an authenticated app user.
// The feature can drive a remote browser and persist extracted data,
// so every session is scoped to req.user.id below.
router.use(authenticateToken);



// Yeh function page se zaroori elements nikal kar unhein label dega
async function getSimplifiedDom(page) {
  return await page.evaluate(() => {
    // Sirf woh elements select karein jin par user action le sakta hai
    const interactiveElements = Array.from(
      document.querySelectorAll('a, button, input, [role="button"], [role="link"], textarea, select')
    );

    let simplifiedStructure = [];
    let elementCounter = 1;

    interactiveElements.forEach(el => {
      // Sirf dikhai dene wale (visible) elements ko shamil karein
      if (!el.offsetParent || el.offsetWidth === 0 || el.offsetHeight === 0) return;

      const uniqueId = `ai-element-${elementCounter++}`;
      el.setAttribute('data-ai-id', uniqueId); // Element ko ek temporary ID dein

      const elementInfo = {
        id: uniqueId,
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || el.placeholder || '').trim().substring(0, 150)
      };

      if (el.tagName.toLowerCase() === 'input') {
        elementInfo.inputType = el.type;
      }

      simplifiedStructure.push(elementInfo);
    });

    return simplifiedStructure;
  });
}
// Get screenshot from Playwright page
async function getScreenshot(page) {
  return await page.screenshot({ fullPage: false });
}

// Custom Computer Use Loop
// async function customComputerUseLoop(sessionId, browser, page, agent, task) {
//   let stepCount = 0;
//   const maxSteps = 20; // Prevent infinite loops

//   try {
//     while (stepCount < maxSteps) {
//       stepCount++;

//       // Check that session still exists and is running
//       const session = activeSessions.get(sessionId);
//       if (!session) {
//         console.log(`Session ${sessionId} not found, stopping loop.`);
//         broadcastToSession(sessionId, {
//           type: 'task-stopped',
//           data: { message: 'Session removed or stopped externally', step: stepCount }
//         });
//         break;
//       }

//       if (session.status !== 'running') {
//         console.log(`Session ${sessionId} status is '${session.status}', exiting loop.`);
//         broadcastToSession(sessionId, {
//           type: 'task-paused',
//           data: { message: `Session ${session.status}`, step: stepCount }
//         });
//         break;
//       }

//       // Take screenshot of current state (guard against closed page/browser)
//       let screenshotBytes;
//       try {
//         screenshotBytes = await getScreenshot(page);
//       } catch (screenshotErr) {
//         console.error('Screenshot failed, likely browser/page closed:', screenshotErr);
//         broadcastToSession(sessionId, {
//           type: 'error',
//           data: { error: `Screenshot failed: ${screenshotErr.message}`, step: stepCount }
//         });
//         break; // Exit loop gracefully
//       }

//       const screenshotBase64 = screenshotBytes.toString('base64');

//       // Send current screenshot to frontend
//       broadcastToSession(sessionId, {
//         type: 'screenshot',
//         data: {
//           image: `data:image/png;base64,${screenshotBase64}`,
//           step: stepCount
//         }
//       });

//       // Analyze screenshot and get next action
//       const currentSession = activeSessions.get(sessionId);
//       const previousAction = currentSession?.lastCaptchaRetry ? 'captcha_retry' : null;
//       const response = await agent.analyzeDomAndPlan(task, previousAction);

//       // Send reasoning to frontend
//       broadcastToSession(sessionId, {
//         type: 'reasoning',
//         data: {
//           reasoning: response.reasoning,
//           step: stepCount,
//           action: response.action?.type || 'thinking'
//         }
//       });

//       // Check for CAPTCHA detection
//       if (response.captcha_detected || response.action?.type === 'captcha_detected') {
//         console.log('CAPTCHA detected, trying automatic solutions...');

//         broadcastToSession(sessionId, {
//           type: 'reasoning',
//           data: {
//             reasoning: 'CAPTCHA detected. Trying automatic solutions: refreshing page, using alternative search engines, or trying different approaches...',
//             step: stepCount,
//             action: 'captcha_handling'
//           }
//         });

//         // Try automatic CAPTCHA solutions
//         try {
//           // Solution 1: Refresh the page and try again
//           console.log('Attempting page refresh to bypass CAPTCHA...');
//           await page.reload({ waitUntil: 'networkidle' });
//           await page.waitForTimeout(3000);

//           broadcastToSession(sessionId, {
//             type: 'reasoning',
//             data: {
//               reasoning: 'Refreshed page to bypass CAPTCHA. Continuing with task...',
//               step: stepCount,
//               action: 'refresh'
//             }
//           });

//         } catch (refreshError) {
//           console.log('Page refresh failed, trying alternative approach...');

//           // Solution 2: Try alternative search engine or approach
//           try {
//             if (task.toLowerCase().includes('search') || task.toLowerCase().includes('google')) {
//               console.log('Trying DuckDuckGo as alternative search engine...');
//               await page.goto('https://duckduckgo.com', { waitUntil: 'networkidle' });
//               await page.waitForTimeout(2000);

//               broadcastToSession(sessionId, {
//                 type: 'reasoning',
//                 data: {
//                   reasoning: 'Google showed CAPTCHA, switching to DuckDuckGo search engine to continue the task...',
//                   step: stepCount,
//                   action: 'alternative_approach'
//                 }
//               });
//             } else {
//               // For non-search tasks, wait and retry
//               console.log('Waiting 10 seconds and retrying...');
//               await page.waitForTimeout(10000);

//               broadcastToSession(sessionId, {
//                 type: 'reasoning',
//                 data: {
//                   reasoning: 'CAPTCHA encountered. Waiting and retrying with different approach...',
//                   step: stepCount,
//                   action: 'retry'
//                 }
//               });
//             }
//           } catch (alternativeError) {
//             console.log('Alternative approach failed, continuing with modified task...');
//           }
//         }

//         stepCount++;
//         continue;
//       }

//       // Check if task is completed
//       if (response.completed) {
//         console.log('Task completed successfully!');
//         broadcastToSession(sessionId, {
//           type: 'task-completed',
//           data: {
//             message: 'Task completed successfully!',
//             finalScreenshot: `data:image/png;base64,${screenshotBase64}`,
//             totalSteps: stepCount
//           }
//         });
//         break;
//       }

//       // Execute the planned action
//       if (response.action) {
//         try {
//           await executeActionWithSelector(page, response.action);

//           // Wait for page to update
//           await new Promise(resolve => setTimeout(resolve, 2000));

//           // After action, confirm session still present
//           if (!activeSessions.has(sessionId)) {
//             console.log(`Session ${sessionId} removed during action execution, exiting.`);
//             break;
//           }

//         } catch (actionError) {
//           console.error('Action execution error:', actionError);
//           broadcastToSession(sessionId, {
//             type: 'reasoning',
//             data: {
//               reasoning: `Error executing action: ${actionError.message}`,
//               step: stepCount,
//               action: 'error'
//             }
//           });
//         }
//       }

//       // Safety check - if we've been on same page too long
//       if (stepCount >= maxSteps) {
//         broadcastToSession(sessionId, {
//           type: 'task-completed',
//           data: {
//             message: 'Task stopped after maximum steps reached',
//             finalScreenshot: `data:image/png;base64,${screenshotBase64}`,
//             totalSteps: stepCount
//           }
//         });
//         break;
//       }
//     }
//   } catch (error) {
//     console.error('Computer use loop error:', error);
//     broadcastToSession(sessionId, {
//       type: 'error',
//       data: { error: error.message }
//     });
//   }
// }
// Purane customComputerUseLoop ko is naye code se badal dein
// Extract relevant webpage content based on user query
async function extractWebpageContent(page, userQuery, currentUrl) {
  try {
    console.log(`Extracting detailed content from ${currentUrl} based on query: ${userQuery}`);

    // Get page title
    const title = await page.title().catch(() => currentUrl);

    // Enhanced content extraction for detailed scraping
    const pageContent = await page.evaluate(() => {
      // Remove script and style elements
      const scripts = document.querySelectorAll('script, style, noscript');
      scripts.forEach(el => el.remove());

      // Enhanced product/content extraction
      const extractedItems = [];

      // Amazon product extraction
      if (window.location.href.includes('amazon')) {
        const products = document.querySelectorAll('[data-component-type="s-search-result"], .s-result-item, .a-section');
        products.forEach((product, index) => {
          const titleEl = product.querySelector('h2 a span, .a-size-base-plus, .a-size-medium');
          const priceEl = product.querySelector('.a-price-whole, .a-price .a-offscreen');
          const imageEl = product.querySelector('img');
          const linkEl = product.querySelector('h2 a, .a-link-normal');
          const ratingEl = product.querySelector('[aria-label*="stars"], .a-icon-alt');

          if (titleEl && titleEl.textContent.trim()) {
            extractedItems.push({
              type: 'product',
              title: titleEl.textContent.trim(),
              price: priceEl ? priceEl.textContent.trim() : 'Price not available',
              image: imageEl ? imageEl.src : null,
              link: linkEl ? 'https://amazon.com' + linkEl.getAttribute('href') : null,
              rating: ratingEl ? ratingEl.textContent.trim() : null,
              index: index + 1
            });
          }
        });
      }

      // LinkedIn job extraction
      else if (window.location.href.includes('linkedin')) {
        const jobs = document.querySelectorAll('.job-search-card, .jobs-search__results-list li, .scaffold-layout__list-container li');
        jobs.forEach((job, index) => {
          const titleEl = job.querySelector('.job-search-card__title, .base-search-card__title');
          const companyEl = job.querySelector('.job-search-card__subtitle, .base-search-card__subtitle');
          const locationEl = job.querySelector('.job-search-card__location, .job-search-card__metadata-item');
          const linkEl = job.querySelector('a[href*="/jobs/view"]');
          const timeEl = job.querySelector('time, .job-search-card__listdate');

          if (titleEl && titleEl.textContent.trim()) {
            extractedItems.push({
              type: 'job',
              title: titleEl.textContent.trim(),
              company: companyEl ? companyEl.textContent.trim() : 'Company not specified',
              location: locationEl ? locationEl.textContent.trim() : 'Location not specified',
              link: linkEl ? linkEl.href : null,
              posted: timeEl ? timeEl.textContent.trim() : null,
              index: index + 1
            });
          }
        });
      }

      // Generic content extraction for other sites
      else {
        const contentItems = document.querySelectorAll('article, .product, .item, .card, .listing, .result');
        contentItems.forEach((item, index) => {
          const titleEl = item.querySelector('h1, h2, h3, .title, .name');
          const descEl = item.querySelector('p, .description, .summary');
          const linkEl = item.querySelector('a');
          const imageEl = item.querySelector('img');

          if (titleEl && titleEl.textContent.trim().length > 10) {
            extractedItems.push({
              type: 'content',
              title: titleEl.textContent.trim(),
              description: descEl ? descEl.textContent.trim().substring(0, 200) : '',
              link: linkEl ? linkEl.href : null,
              image: imageEl ? imageEl.src : null,
              index: index + 1
            });
          }
        });
      }

      // Fallback to general content if no structured items found
      let generalContent = '';
      const contentSelectors = [
        'main', 'article', '[role="main"]', '.main-content',
        '#main-content', '.content', '#content', '.post-content',
        '.entry-content', '.article-content'
      ];

      for (const selector of contentSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          generalContent = element.innerText || element.textContent || '';
          break;
        }
      }

      if (!generalContent) {
        generalContent = document.body.innerText || document.body.textContent || '';
      }

      return {
        title: document.title,
        url: window.location.href,
        extractedItems: extractedItems,
        generalContent: generalContent.substring(0, 5000),
        itemCount: extractedItems.length,
        lastUpdated: new Date().toISOString()
      };
    });

    // Format extracted data into structured response
    let formattedContent = '';

    if (pageContent.extractedItems && pageContent.extractedItems.length > 0) {
      if (pageContent.extractedItems[0].type === 'product') {
        formattedContent = `# 🛍️ Found ${pageContent.itemCount} Products\n\n`;
        pageContent.extractedItems.forEach(item => {
          formattedContent += `## ${item.index}. ${item.title}\n`;
          formattedContent += `**Price:** ${item.price}\n`;
          if (item.rating) formattedContent += `**Rating:** ${item.rating}\n`;
          if (item.link) formattedContent += `**Product Link:** ${item.link}\n`;
          if (item.image) formattedContent += `**Image:** ${item.image}\n`;
          formattedContent += `\n---\n\n`;
        });
      } else if (pageContent.extractedItems[0].type === 'job') {
        formattedContent = `# 💼 Found ${pageContent.itemCount} Job Listings\n\n`;
        pageContent.extractedItems.forEach(item => {
          formattedContent += `## ${item.index}. ${item.title}\n`;
          formattedContent += `**Company:** ${item.company}\n`;
          formattedContent += `**Location:** ${item.location}\n`;
          if (item.posted) formattedContent += `**Posted:** ${item.posted}\n`;
          if (item.link) formattedContent += `**Job Link:** ${item.link}\n`;
          formattedContent += `\n---\n\n`;
        });
      } else {
        formattedContent = `# 📄 Found ${pageContent.itemCount} Content Items\n\n`;
        pageContent.extractedItems.forEach(item => {
          formattedContent += `## ${item.index}. ${item.title}\n`;
          if (item.description) formattedContent += `${item.description}\n`;
          if (item.link) formattedContent += `**Link:** ${item.link}\n`;
          formattedContent += `\n---\n\n`;
        });
      }
    } else {
      // Use AI for general content extraction when no structured data found
      const extractionPrompt = `Extract and organize the key information from this webpage content. Focus on providing detailed, actionable data rather than summaries.

User Query: "${userQuery}"
Webpage: ${currentUrl}

Content:
${pageContent.generalContent.substring(0, 3000)}

Provide specific details, prices, names, links, and any relevant data points. Format as structured information with clear headings and bullet points.`;

      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: extractionPrompt }],
        max_tokens: 1500,
        temperature: 0.1
      });

      formattedContent = response.choices[0].message.content;
    }

    return {
      success: true,
      url: currentUrl,
      title: title,
      extractedInfo: formattedContent,
      rawItems: pageContent.extractedItems || [],
      itemCount: pageContent.itemCount || 0,
      rawContent: pageContent.generalContent.substring(0, 3000),
      timestamp: new Date().toISOString(),
      userQuery: userQuery
    };

  } catch (error) {
    console.error('Error extracting webpage content:', error);
    return {
      success: false,
      error: error.message,
      url: currentUrl,
      timestamp: new Date().toISOString()
    };
  }
}

async function customComputerUseLoop(sessionId, browser, page, agent, task) {
  let stepCount = 0;
  const maxSteps = 20;

  try {
    while (stepCount < maxSteps) {
      stepCount++;
      const session = activeSessions.get(sessionId);
      if (!session || session.status !== 'running') {
        console.log(`Session ${sessionId} ruka hua hai ya mojood nahi.`);
        break;
      }

      // Page ke load hone ka intezar karein
      await page.waitForLoadState('networkidle', { timeout: 7000 }).catch(() => console.log("Page idle nahi hua, lekin aage barh rahe hain."));

      // 1. Screenshot sirf frontend ke liye lein
      const screenshotBytes = await getScreenshot(page);
      const screenshotBase64 = screenshotBytes.toString('base64');
      broadcastToSession(sessionId, {
        type: 'screenshot',
        data: { image: `data:image/png;base64,${screenshotBase64}`, step: stepCount }
      });

      // 2. AI ke liye Screenshot ke bajaye Simplified DOM hasil karein
      const simplifiedDom = await getSimplifiedDom(page);

      // Agar page par koi interactive elements nahi, to thora intezar karein ya refresh karein
      if (simplifiedDom.length === 0) {
        console.log("Koi interactive elements nahi mile. 2 second intezar kar rahe hain.");
        await page.waitForTimeout(2000);
        continue; // Loop ka agla step shuru karein
      }

      // 3. AI ko DOM bhej kar agla action poochein (Naya function call)
      const currentUrl = page.url();
      const response = await agent.analyzeDomAndPlan(task, simplifiedDom, currentUrl);

      broadcastToSession(sessionId, {
        type: 'reasoning',
        data: {
          reasoning: response.reasoning,
          step: stepCount,
          action: response.action?.type || 'thinking'
        }
      });

      // Task complete ho gaya to loop rokein
      if (response.completed || response.action?.type === 'completed') {
        console.log('Task mukammal ho gaya!');

        // Extract webpage content before completing
        const currentUrl = page.url();
        const session = activeSessions.get(sessionId);
        console.log('Session data during completion:', {
          sessionId,
          hasSession: !!session,
          chatId: session?.chatId,
          userId: session?.userId,
          currentUrl
        });
        let extractedData = null;

        if (session && session.chatId) {
          console.log('Extracting webpage content for chat integration...', {
            chatId: session.chatId,
            userId: session.userId,
            task: session.originalTask || task
          });
          extractedData = await extractWebpageContent(page, session.originalTask || task, currentUrl);

          if (extractedData.success) {
            // Save extracted information to chat
            try {
              await saveExtractedDataToChat(session.chatId, session.originalTask || task, extractedData, session.userId);
              console.log('Extracted data saved to chat successfully');
            } catch (error) {
              console.error('Error saving extracted data to chat:', error);
              console.error('Error details:', error.stack);
            }
          } else {
            console.error('Extraction failed:', extractedData.error);
          }
        } else {
          console.log('No chat context found for extraction:', {
            hasSession: !!session,
            sessionKeys: session ? Object.keys(session) : [],
            chatId: session?.chatId,
            userId: session?.userId
          });
        }

        const completionMessage = extractedData?.success
          ? 'Task completed successfully! Information extracted and saved to chat.'
          : 'Task completed successfully!';

        broadcastToSession(sessionId, {
          type: 'task-completed',
          data: {
            message: completionMessage,
            extractedData: extractedData,
            finalUrl: currentUrl,
            hasExtraction: extractedData?.success || false
          }
        });

        // Broadcast extraction completion to all clients for chat refresh
        if (wss && extractedData?.success) {
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'extraction-completed',
                data: {
                  chatId: session?.chatId,
                  sessionId: sessionId,
                  message: 'Computer Use task completed - chat updated'
                }
              }));
            }
          });
        }
        break;
      }

      // 4. Naye function se action anjam dein
      if (response.action && response.action.selector) {
        await executeActionWithSelector(page, response.action);
      } else {
        console.log('AI ne koi valid selector nahi diya. Dobara koshish kar rahe hain.');
        await page.waitForTimeout(1000); // Thora wait karein
      }

      if (stepCount >= maxSteps) {
        console.log('Max steps tak pahunch gaye. Loop rok rahe hain.');

        // Extract content even when max steps reached
        const currentUrl = page.url();
        const session = activeSessions.get(sessionId);
        console.log('Session data at max steps:', {
          sessionId,
          hasSession: !!session,
          chatId: session?.chatId,
          userId: session?.userId,
          currentUrl
        });
        let extractedData = null;

        if (session && session.chatId) {
          console.log('Max steps - extracting content for chat integration...');
          extractedData = await extractWebpageContent(page, session.originalTask || task, currentUrl);
          if (extractedData.success) {
            try {
              await saveExtractedDataToChat(session.chatId, session.originalTask || task, extractedData, session.userId);
              console.log('Max steps - extracted data saved successfully');
            } catch (error) {
              console.error('Max steps - error saving extracted data:', error);
            }
          }
        } else {
          console.log('Max steps - no chat context for extraction');
        }

        broadcastToSession(sessionId, {
          type: 'task-completed',
          data: {
            message: 'Task stopped after maximum steps.',
            extractedData: extractedData,
            finalUrl: currentUrl
          }
        });
        break;
      }
    }
  } catch (error) {
    console.error('Computer use loop mein error:', error);
    broadcastToSession(sessionId, { type: 'error', data: { error: error.message } });
  }
}

// Save extracted webpage data to chat history
async function saveExtractedDataToChat(chatId, originalQuery, extractedData, userId) {
  try {
    // Verify chat exists (should already be created by chat-integration endpoint)
    const chat = await prisma.chat.findUnique({
      where: { id: chatId }
    });

    if (!chat) {
      throw new Error(`Chat ${chatId} not found - should have been created before extraction`);
    }

    // Create simple response - no content shown in chat, only download option
    let responseContent = `# Computer Use Task Completed ✅

**Task:** ${originalQuery}

**Results:** Successfully extracted ${extractedData.itemCount || 'multiple'} items from ${extractedData.url}

📥 **Download HTML Report** to view detailed results with clickable links

*Completed at: ${new Date(extractedData.timestamp).toLocaleString()}*`;

    // Prepare file data for download - matching the expected structure
    const fileData = {
      type: 'computer_use_extraction',
      originalQuery: originalQuery,
      url: extractedData.url,
      title: extractedData.title,
      extractedInfo: extractedData.extractedInfo,
      rawContent: extractedData.rawContent,
      metaData: extractedData.metaData,
      timestamp: extractedData.timestamp,
      success: extractedData.success,
      userQuery: originalQuery
    };

    // Save assistant message with extracted data
    await prisma.message.create({
      data: {
        chatId: chatId,
        role: 'ASSISTANT',
        content: responseContent,
        files: JSON.stringify([fileData]),
        tokens: 1000 // Estimated tokens
      }
    });

    // Update chat timestamp
    await prisma.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() }
    });

    console.log(`Extracted data saved to chat ${chatId}`);

  } catch (error) {
    console.error('Error saving extracted data to chat:', error);
    throw error;
  }
}

// Generate HTML report using AI for complete professional formatting
async function generateHtmlReport(extractedData, originalQuery) {
  try {
    // Prepare data for AI HTML generation
    const dataForAI = {
      query: originalQuery,
      url: extractedData.url,
      title: extractedData.title,
      timestamp: extractedData.timestamp,
      items: extractedData.rawItems || [],
      itemCount: extractedData.itemCount || 0,
      extractedContent: extractedData.extractedInfo || extractedData.rawContent || '',
      success: extractedData.success
    };

    // Create comprehensive prompt for AI HTML generation
    const htmlPrompt = `Generate a complete, professional HTML report for a Computer Use extraction task. The report should be modern, clean, and fully functional.

TASK DETAILS:
- Original Query: "${originalQuery}"
- Source URL: ${extractedData.url}
- Page Title: ${extractedData.title}
- Items Found: ${extractedData.itemCount || 0}
- Timestamp: ${new Date(extractedData.timestamp).toLocaleString()}

EXTRACTED DATA:
${extractedData.rawItems && extractedData.rawItems.length > 0 ?
        JSON.stringify(extractedData.rawItems.slice(0, 30), null, 2) :
        extractedData.extractedInfo || extractedData.rawContent || 'No specific items extracted'
      }
TOTAL ITEMS TO PROCESS: ${extractedData.rawItems ? extractedData.rawItems.length : 0}
IMPORTANT: Process ALL items provided in the extracted data, not just a sample.

REQUIREMENTS:
1. Create a complete HTML document with <!DOCTYPE html>, <head>, and <body>
2. Use modern, professional CSS (embedded in <style> tags)
3. Design should be clean, minimal, and business-appropriate
4. Use a professional color scheme (blues, grays, whites)
5. Make it fully responsive for mobile and desktop
6. Include proper typography and spacing
7. NO emojis or casual elements
8. If items have links, make them clickable buttons that open in new tabs
9. For products: show title, price, rating (if available), and "View Product" button
10. For jobs: show job title, company, location, posted date, and "View Job" button
11. Use CSS Grid or Flexbox for modern layouts
12. Include hover effects and smooth transitions
13. Make sure all URLs are properly formatted and clickable
14. Add a professional header with the task completion status
15. Include a footer with generation details
16. CRITICAL: Process and display ALL items from the extracted data - do not limit or truncate
17. If there are many items, use efficient CSS and HTML structure
18. For large datasets, consider pagination or collapsible sections
19. Ensure the HTML file size is reasonable but complete

DESIGN STYLE:
- Modern corporate/business look
- Clean card-based layout for items
- Professional button styling
- Subtle shadows and rounded corners
- Proper white space and typography hierarchy
- Mobile-first responsive design

Generate ONLY the complete HTML code (no explanations or markdown). The HTML should be ready to save as a .html file and open in a browser.`;

    // Generate HTML using OpenAI
    const response = await openai.chat.completions.create({
      model: 'gpt-4o', // Use the better model for HTML generation
      messages: [{
        role: 'system',
        content: 'You are an expert HTML generator. Create complete, professional HTML reports that include ALL provided data items. Never truncate or limit the number of items processed.'
      }, {
        role: 'user',
        content: htmlPrompt
      }],
      max_tokens: 8000, // Increased for larger datasets
      temperature: 0.1
    });

    let generatedHtml = response.choices[0].message.content;

    // Clean up the response to ensure it's pure HTML
    generatedHtml = generatedHtml.replace(/^```html\s*/, '').replace(/\s*```$/, '');
    generatedHtml = generatedHtml.replace(/^```\s*/, '').replace(/\s*```$/, '');

    // Ensure it starts with DOCTYPE
    if (!generatedHtml.trim().startsWith('<!DOCTYPE')) {
      generatedHtml = `<!DOCTYPE html>\n${generatedHtml}`;
    }

    return generatedHtml;

  } catch (error) {
    console.error('Error generating AI HTML report:', error);

    // Fallback to simple HTML if AI generation fails
    return generateFallbackHtml(extractedData, originalQuery);
  }
}

// Fallback HTML generation if AI fails
function generateFallbackHtml(extractedData, originalQuery) {
  // Use actual extracted items if available
  let structuredContent = '';

  if (extractedData.rawItems && extractedData.rawItems.length > 0) {
    // Generate content from actual extracted items
    structuredContent = '<div class="content-grid">';

    extractedData.rawItems.forEach((item, index) => {
      const itemType = item.type || 'content';
      structuredContent += `<div class="item-card ${itemType}-card">`;

      if (item.type === 'product') {
        structuredContent += `<div class="product-header">
          <h3 class="product-title">${item.title}</h3>
          <span class="price-badge">${item.price}</span>
        </div>`;
        if (item.rating) structuredContent += `<div class="rating">★ ${item.rating}</div>`;
        if (item.image) {
          structuredContent += `<img src="${item.image}" alt="${item.title}" class="product-image">`;
        }
        if (item.link && item.link.startsWith('http')) {
          structuredContent += `<a href="${item.link}" target="_blank" class="view-btn">View on Amazon</a>`;
        }
      } else if (item.type === 'job') {
        structuredContent += `<div class="job-header">
          <h3 class="job-title">${item.title}</h3>
          <span class="company-name">${item.company}</span>
        </div>`;
        structuredContent += `<div class="job-details">
          <span class="location">${item.location}</span>
          ${item.posted ? `<span class="posted">${item.posted}</span>` : ''}
        </div>`;
        if (item.link) {
          // Ensure proper LinkedIn URL
          let cleanLink = item.link;
          if (cleanLink.includes('linkedin.com') && !cleanLink.startsWith('http')) {
            cleanLink = 'https://linkedin.com' + (cleanLink.startsWith('/') ? cleanLink : '/' + cleanLink);
          }
          if (cleanLink.startsWith('http')) {
            structuredContent += `<a href="${cleanLink}" target="_blank" class="view-btn job-btn">View Job</a>`;
          }
        }
      } else {
        structuredContent += `<div class="item-description"><strong>${item.title}</strong></div>`;
        if (item.description) structuredContent += `<div class="features">${item.description}</div>`;
        if (item.link) {
          structuredContent += `<div class="action-link">
            <a href="${item.link}" target="_blank" class="interactive-btn">
              🔗 Visit Link
              <span class="btn-text">Click to Open</span>
            </a>
          </div>`;
        }
      }

      structuredContent += '</div>';
    });

    structuredContent += '</div>';
  } else {
    // Fallback to parsing extracted info text
    const content = extractedData.extractedInfo || extractedData.rawContent || 'No content extracted';

    // Advanced content detection and structuring
    structuredContent = content;

    // Enhanced detection for different content types
    if (content.includes('Price:') || content.includes('Features:') || content.includes('$') ||
      content.includes('Job:') || content.includes('Company:') || content.includes('Salary:') ||
      content.includes('Location:') || content.includes('Experience:') || content.includes('LinkedIn')) {

      const lines = content.split('\n').filter(line => line.trim());
      let htmlContent = '<div class="content-grid">';
      let currentItem = '';
      let itemType = 'product';

      // Detect content type for appropriate styling
      if (content.toLowerCase().includes('job') || content.toLowerCase().includes('linkedin') ||
        content.toLowerCase().includes('career') || content.toLowerCase().includes('developer') ||
        content.toLowerCase().includes('position') || content.toLowerCase().includes('remote')) {
        itemType = 'job';
      }

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine && trimmedLine.length > 3) {
          // Enhanced parsing for different data types
          if (trimmedLine.includes('Price:') || trimmedLine.includes('$')) {
            if (currentItem) {
              htmlContent += `<div class="item-card ${itemType}-card">${currentItem}</div>`;
              currentItem = '';
            }
            currentItem += `<div class="price-badge">${trimmedLine.replace('Price:', '').trim()}</div>`;
          }
          else if (trimmedLine.includes('Job:') || trimmedLine.includes('Position:') || trimmedLine.includes('Title:')) {
            if (currentItem) {
              htmlContent += `<div class="item-card ${itemType}-card">${currentItem}</div>`;
              currentItem = '';
            }
            currentItem += `<h3 class="job-title">${trimmedLine.replace(/^(Job:|Position:|Title:)\s*/, '')}</h3>`;
          }
          else if (trimmedLine.includes('Company:') || trimmedLine.includes('Employer:')) {
            currentItem += `<div class="company-name">${trimmedLine.replace(/^(Company:|Employer:)\s*/, '')}</div>`;
          }
          else if (trimmedLine.includes('Location:') || trimmedLine.includes('Remote') || trimmedLine.includes('Hybrid')) {
            currentItem += `<div class="location">${trimmedLine.replace(/^Location:\s*/, '')}</div>`;
          }
          else if (trimmedLine.includes('Salary:') || trimmedLine.includes('Pay:') || trimmedLine.includes('/year') ||
            trimmedLine.includes('/hour') || trimmedLine.includes('compensation')) {
            currentItem += `<div class="price-badge">${trimmedLine.replace(/^(Salary:|Pay:)\s*/, '')}</div>`;
          }
          else if (trimmedLine.includes('Experience:') || trimmedLine.includes('Level:') ||
            trimmedLine.includes('years') || trimmedLine.includes('Senior') || trimmedLine.includes('Junior')) {
            currentItem += `<div class="posted">${trimmedLine.replace(/^Experience:\s*/, '')}</div>`;
          }
          else if (trimmedLine.includes('Features:') || trimmedLine.includes('Specifications:') ||
            trimmedLine.includes('Requirements:') || trimmedLine.includes('Skills:')) {
            currentItem += `<div class="item-description">${trimmedLine.replace(/^(Features:|Specifications:|Requirements:|Skills:)\s*/, '')}</div>`;
          }
          else if (trimmedLine.includes('Rating:') || trimmedLine.includes('Reviews:')) {
            currentItem += `<div class="rating">${trimmedLine.replace(/^Rating:\s*/, '').replace(/⭐/g, '★')}</div>`;
          }
          else if (trimmedLine.startsWith('http') || (trimmedLine.includes('.com') && trimmedLine.includes('/'))) {
            let cleanUrl = trimmedLine;
            // Clean up any malformed URLs
            if (!cleanUrl.startsWith('http')) {
              if (cleanUrl.includes('amazon.com')) {
                cleanUrl = 'https://' + cleanUrl;
              } else if (cleanUrl.includes('linkedin.com')) {
                cleanUrl = 'https://' + cleanUrl;
              }
            }
            // Remove any "Product Link:" or similar prefixes
            cleanUrl = cleanUrl.replace(/^.*?https?:\/\//, 'https://').trim();

            if (cleanUrl.startsWith('http')) {
              const buttonText = cleanUrl.includes('amazon') ? 'View Product' :
                cleanUrl.includes('linkedin') ? 'View Job' : 'Visit Link';
              const buttonClass = cleanUrl.includes('linkedin') ? 'view-btn job-btn' : 'view-btn';
              currentItem += `<a href="${cleanUrl}" target="_blank" class="${buttonClass}">${buttonText}</a>`;
            }
          }
          else if (trimmedLine.length > 5) {
            currentItem += `<div class="item-description">${trimmedLine}</div>`;
          }
        }
      }

      if (currentItem) {
        htmlContent += `<div class="item-card ${itemType}-card">${currentItem}</div>`;
      }
      htmlContent += '</div>';

      if (htmlContent.includes('<div class="item-card')) {
        structuredContent = htmlContent;
      }
    } else {
      // Enhanced regular content formatting
      structuredContent = content
        .split('\n')
        .map(line => {
          const trimmed = line.trim();
          if (!trimmed) return '<br>';

          // Enhanced URL handling
          if (trimmed.startsWith('http') || trimmed.includes('.com')) {
            const displayUrl = trimmed.length > 80 ? trimmed.substring(0, 80) + '...' : trimmed;
            return `<div class="action-link">
            <a href="${trimmed}" target="_blank" class="interactive-btn">
              🔗 ${displayUrl}
              <span class="btn-text">Visit Link</span>
            </a>
          </div>`;
          }

          // Format section headers
          if (trimmed.includes(':') && trimmed.length < 100 && !trimmed.includes('http')) {
            return `<h3 style="color: #1976d2; font-size: 1.3em; margin: 20px 0 15px; border-bottom: 2px solid #e3f2fd; padding-bottom: 8px;">${trimmed}</h3>`;
          }

          return `<p style="margin: 12px 0; line-height: 1.6;">${trimmed}</p>`;
        })
        .join('');
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Computer Use Extraction Report - ${originalQuery}</title>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;
            max-width: 1200px;
            margin: 0 auto;
            padding: 0;
            line-height: 1.6;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #2c3e50;
            min-height: 100vh;
        }
        .container {
            background: #ffffff;
            margin: 0;
            min-height: 100vh;
            box-shadow: none;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-align: center;
            padding: 40px 20px;
            margin: 0;
            border: none;
        }
        h1 {
            color: white;
            margin: 0;
            font-size: 2.5em;
            font-weight: 300;
            letter-spacing: -0.5px;
        }
        .meta-info {
            background: #f8fafc;
            padding: 30px;
            margin: 0;
            border: none;
            border-bottom: 1px solid #e2e8f0;
        }
        .meta-info h3 {
            color: #4a5568;
            font-size: 1.1em;
            font-weight: 600;
            margin: 0 0 8px 0;
        }
        .meta-info p {
            color: #718096;
            margin: 0;
        }
        .content {
            padding: 40px 30px;
        }
        h2 {
            color: #2d3748;
            font-size: 1.8em;
            font-weight: 600;
            margin: 0 0 30px 0;
            text-align: center;
        }
        .content-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
            gap: 25px;
            margin: 0;
        }
        .item-card {
            background: #ffffff;
            border: 1px solid #e2e8f0;
            border-radius: 12px;
            padding: 25px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
            transition: all 0.3s ease;
            position: relative;
            overflow: hidden;
        }
        .item-card:hover {
            transform: translateY(-4px);
            box-shadow: 0 20px 25px rgba(0, 0, 0, 0.1);
            border-color: #cbd5e0;
        }
        .product-header, .job-header {
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 1px solid #f1f5f9;
        }
        .product-title, .job-title {
            font-size: 1.25em;
            font-weight: 600;
            color: #2d3748;
            margin: 0 0 10px 0;
            line-height: 1.4;
        }
        .price-badge {
            background: linear-gradient(135deg, #ff6b6b 0%, #ee5a24 100%);
            color: white;
            padding: 6px 12px;
            border-radius: 20px;
            font-weight: 600;
            font-size: 0.9em;
            display: inline-block;
            box-shadow: 0 2px 4px rgba(238, 90, 36, 0.3);
        }
        .company-name {
            color: #718096;
            font-weight: 500;
            font-size: 1.05em;
        }
        .job-details {
            margin: 15px 0;
            display: flex;
            flex-wrap: wrap;
            gap: 15px;
        }
        .location, .posted {
            color: #4a5568;
            font-size: 0.95em;
            background: #f7fafc;
            padding: 4px 8px;
            border-radius: 4px;
        }
        .rating {
            color: #f6ad55;
            margin: 10px 0;
            font-weight: 600;
            background: #fffbf0;
            padding: 4px 8px;
            border-radius: 4px;
            display: inline-block;
        }
        .product-image {
            width: 100%;
            max-width: 250px;
            height: auto;
            border-radius: 8px;
            margin: 15px 0;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }
        .view-btn {
            display: inline-block;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-decoration: none;
            padding: 12px 24px;
            border-radius: 8px;
            font-weight: 600;
            margin-top: 15px;
            transition: all 0.3s ease;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
            text-transform: uppercase;
            font-size: 0.9em;
            letter-spacing: 0.5px;
        }
        .view-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6);
            text-decoration: none;
            color: white;
        }
        .job-btn {
            background: linear-gradient(135deg, #0077b5 0%, #00a0dc 100%);
            box-shadow: 0 4px 15px rgba(0, 119, 181, 0.4);
        }
        .job-btn:hover {
            box-shadow: 0 6px 20px rgba(0, 119, 181, 0.6);
        }
        .item-title {
            font-size: 1.2em;
            font-weight: 600;
            color: #2d3748;
            margin: 0 0 10px 0;
        }
        .item-description {
            color: #4a5568;
            margin: 10px 0;
            line-height: 1.5;
        }
        .footer {
            background: #f8fafc;
            text-align: center;
            padding: 30px;
            margin: 0;
            border-top: 1px solid #e2e8f0;
            color: #718096;
            font-size: 0.9em;
        }
        @media (max-width: 768px) {
            .content-grid {
                grid-template-columns: 1fr;
                gap: 20px;
            }
            .content {
                padding: 20px 15px;
            }
            .header {
                padding: 30px 20px;
            }
            h1 {
                font-size: 2em;
            }
            .meta-info {
                padding: 20px;
            }
            .item-card {
                padding: 20px;
            }
            .job-details {
                flex-direction: column;
                gap: 8px;
            }
        }
            background: linear-gradient(135deg, #1976d2 0%, #42a5f5 100%);
            color: white;
            font-size: 1.2em;
            font-weight: 700;
            margin: -24px -24px 15px -24px;
            padding: 15px 24px;
            border-radius: 16px 16px 0 0;
            text-shadow: 0 1px 2px rgba(0,0,0,0.2);
        }
        .price-tag {
            background: linear-gradient(135deg, #d32f2f 0%, #f44336 100%);
            color: white;
            font-size: 1.25em;
            font-weight: 700;
            margin: -24px -24px 15px -24px;
            padding: 15px 24px;
            border-radius: 16px 16px 0 0;
            text-shadow: 0 1px 2px rgba(0,0,0,0.2);
        }
        .company {
            color: #1565c0;
            margin: 12px 0;
            padding: 10px 15px;
            background: linear-gradient(135deg, #e3f2fd 0%, #f3e5f5 100%);
            border-radius: 8px;
            font-weight: 500;
            border-left: 4px solid #1976d2;
        }
        .location {
            color: #2e7d32;
            margin: 12px 0;
            padding: 10px 15px;
            background: linear-gradient(135deg, #e8f5e8 0%, #f1f8e9 100%);
            border-radius: 8px;
            font-weight: 500;
            border-left: 4px solid #4caf50;
        }
        .salary {
            color: #f57c00;
            margin: 12px 0;
            padding: 12px 15px;
            background: linear-gradient(135deg, #fff3e0 0%, #ffe8cc 100%);
            border-radius: 8px;
            font-weight: 600;
            font-size: 1.05em;
            border-left: 4px solid #ff9800;
        }
        .experience {
            color: #7b1fa2;
            margin: 12px 0;
            padding: 10px 15px;
            background: linear-gradient(135deg, #f3e5f5 0%, #fce4ec 100%);
            border-radius: 8px;
            font-weight: 500;
            border-left: 4px solid #9c27b0;
        }
        .features {
            color: #1976d2;
            margin: 12px 0;
            padding: 12px 15px;
            background: linear-gradient(135deg, #e3f2fd 0%, #f3e5f5 100%);
            border-radius: 8px;
            font-size: 0.95em;
            line-height: 1.5;
            border-left: 4px solid #2196f3;
        }
        .rating {
            color: #f57c00;
            margin: 12px 0;
            padding: 10px 15px;
            background: linear-gradient(135deg, #fff8e1 0%, #ffecb3 100%);
            border-radius: 8px;
            font-weight: 600;
            border-left: 4px solid #ffc107;
        }
        .action-link {
            margin: 15px 0;
            padding: 0;
        }
        .interactive-btn {
            display: inline-block;
            background: linear-gradient(135deg, #1976d2 0%, #42a5f5 100%);
            color: white !important;
            text-decoration: none;
            padding: 12px 20px;
            border-radius: 25px;
            font-weight: 600;
            font-size: 0.95em;
            transition: all 0.3s ease;
            box-shadow: 0 4px 15px rgba(25, 118, 210, 0.3);
            position: relative;
            overflow: hidden;
            min-width: 160px;
            text-align: center;
            word-break: break-word;
        }
        .interactive-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(25, 118, 210, 0.4);
            background: linear-gradient(135deg, #1565c0 0%, #1976d2 100%);
            text-decoration: none;
        }
        .btn-text {
            display: block;
            font-size: 0.8em;
            opacity: 0.9;
            margin-top: 2px;
        }
        .footer { 
            margin-top: 50px; 
            text-align: center;
            font-size: 0.9em; 
            color: #666; 
            padding-top: 25px;
            border-top: 1px solid #eee;
        }
        h1 { color: #1976d2; margin: 0; font-size: 2.2em; }
        h2, h3 { color: #333; }
        .timestamp { color: #666; font-size: 0.95em; margin: 15px 0; }
        .url-link { 
            color: #1976d2; 
            text-decoration: none; 
            word-break: break-all;
        }
        .url-link:hover { text-decoration: underline; }
        .badge { 
            background: #4caf50; 
            color: white; 
            padding: 8px 16px; 
            border-radius: 25px; 
            font-size: 0.9em;
            margin: 15px 0;
            display: inline-block;
            font-weight: 500;
        }
        p {
            margin: 10px 0;
            text-align: justify;
        }
        @media (max-width: 768px) {
            .meta-info {
                grid-template-columns: 1fr;
            }
            .products-grid {
                grid-template-columns: 1fr;
            }
            .container {
                padding: 20px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Computer Use Report</h1>
            <p style="margin: 10px 0 0 0; font-size: 1.1em; opacity: 0.9;">Task Completed Successfully</p>
            <p style="margin: 5px 0 0 0; opacity: 0.8;">Generated: ${new Date(extractedData.timestamp).toLocaleString()}</p>
        </div>
        
        <div class="meta-info">
            <div>
                <h3>Original Query</h3>
                <p><strong>${originalQuery}</strong></p>
            </div>
            <div>
                <h3>Page Title</h3>
                <p>${extractedData.title}</p>
            </div>
            <div style="grid-column: 1 / -1;">
                <h3>Source URL</h3>
                <p><a href="${extractedData.url}" target="_blank" style="color: #667eea; text-decoration: none; font-weight: 500;">${extractedData.url}</a></p>
            </div>
        </div>
        
        <div class="content">
            <h2>Results</h2>
            ${structuredContent}
        </div>
        
        <div class="footer">
            <p>This report was automatically generated by the Computer Use Agent</p>
            <p>Generated: ${new Date(extractedData.timestamp).toLocaleString()} | Format: HTML Report</p>
        </div>
    </div>
</body>
</html>`;
}

// Fallback HTML generation if AI fails
function generateFallbackHtml(extractedData, originalQuery) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Computer Use Report - ${originalQuery}</title>
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #f5f7fa; }
        .container { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header { text-align: center; margin-bottom: 30px; padding-bottom: 20px; border-bottom: 2px solid #007bff; }
        h1 { color: #007bff; margin: 0; }
        .content { margin: 20px 0; }
        .item { background: #f8f9fa; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #007bff; }
        .btn { display: inline-block; background: #007bff; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px; margin: 5px 0; }
        .btn:hover { background: #0056b3; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Computer Use Report</h1>
            <p>Task: ${originalQuery}</p>
            <p>Completed: ${new Date(extractedData.timestamp).toLocaleString()}</p>
        </div>
        <div class="content">
            <div class="item">
                <strong>Source:</strong> <a href="${extractedData.url}" target="_blank">${extractedData.title}</a>
            </div>
            <div class="item">
                <strong>Results:</strong><br>
                ${extractedData.extractedInfo || extractedData.rawContent || 'No content extracted'}
            </div>
        </div>
    </div>
</body>
</html>`;
}


// Execute custom actions
// async function executeCustomAction(page, action) {
//   console.log(`Executing action:`, action);

//   switch (action.type) {
//     case 'click':
//       if (action.x && action.y) {
//         await page.mouse.click(action.x, action.y);
//       }
//       break;

//     case 'type':
//       if (action.text) {
//         await page.keyboard.type(action.text);
//       }
//       break;

//     case 'scroll':
//       const scrollAmount = action.scrollAmount || 300;
//       if (action.scrollDirection === 'down') {
//         await page.evaluate(`window.scrollBy(0, ${scrollAmount})`);
//       } else {
//         await page.evaluate(`window.scrollBy(0, -${scrollAmount})`);
//       }
//       break;

//     case 'navigate':
//       if (action.url) {
//         await page.goto(action.url);
//         await page.waitForLoadState('networkidle');
//       }
//       break;

//     case 'wait':
//       await page.waitForTimeout(2000);
//       break;

//     case 'keypress':
//       if (action.key) {
//         await page.keyboard.press(action.key);
//       }
//       break;

//     default:
//       console.log('Unknown action type:', action.type);
//   }
// }

// Purane executeActionWithSelector function ki jagah yeh poora naya function daalein

async function executeActionWithSelector(page, action) {
  console.log(`Executing action with selector:`, action);
  const selector = `[data-ai-id="${action.selector.replace('#', '')}"]`;

  try {
    // 1. Element ko dhoondein aur uske load hone ka intezar karein
    const elementHandle = await page.waitForSelector(selector, { state: 'attached', timeout: 10000 });

    if (!elementHandle) {
      console.error(`Element with selector ${selector} nahi mila.`);
      return;
    }

    // 2. Element ko scroll karke screen par samne layein
    await elementHandle.scrollIntoViewIfNeeded();

    // 3. Page ko settle hone ke liye thora waqt dein (buhat zaroori)
    await page.waitForTimeout(500); // Aadha second ka intezar

    // 4. Execute action with proper error handling
    switch (action.type) {
      case 'click':
        console.log(`Clicking element: ${selector}`);
        await elementHandle.click({ force: true, timeout: 5000 });
        // Wait for potential navigation or page update
        try {
          await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
            console.log('Page load timeout - continuing anyway');
          });
        } catch (e) {
          console.log('Network idle check failed - continuing');
        }
        break;

      case 'type':
        await elementHandle.fill(action.text);
        // Form submit karne ke liye Enter press karein
        await elementHandle.press('Enter');
        break;
    }
  } catch (error) {
    console.error(`Action anjam dene mein error: ${error.message}`);
    // Frontend ko error ke bare mein batayein taake woh dobara koshish kar sake
    const session = activeSessions.get(page.sessionId);
    if (session) {
      broadcastToSession(page.sessionId, {
        type: 'reasoning',
        data: {
          reasoning: `Error: Element '${action.selector}' par click nahi ho saka. Shayad woh chupa hua hai. Dobara koshish kar raha hoon.`,
          action: 'error'
        }
      });
    }
  }
}
// Is naye function ko apne code mein add karein
// async function executeActionWithSelector(page, action) {
//   console.log(`Executing action with selector:`, action);
//   // Element ko uske temporary attribute se dhoondein
//   const selector = `[data-ai-id="${action.selector.replace('#', '')}"]`;

//   try {
//     switch (action.type) {
//       case 'click':
//         // click karne se pehle element ke load hone ka intezar karein
//         await page.waitForSelector(selector, { state: 'visible', timeout: 5000 });
//         // await page.click(selector);
//         await page.click(selector, { force: true });
//         break;

//       case 'type':
//         await page.waitForSelector(selector, { state: 'visible', timeout: 5000 });
//         // La función .fill() es más rápida y mejor que .type()
//         await page.fill(selector, action.text);
//         // Agar text ke baad Enter dabana hai (form submit karne ke liye)
//         await page.press(selector, 'Enter');
//         break;
//     }
//   } catch (error) {
//     console.error(`Action anjam dene mein error: ${error.message}`);
//     // Agar error aye to frontend ko batayein
//     broadcastToSession(page.sessionId, { // page.sessionId ko set karna hoga
//       type: 'reasoning',
//       data: {
//         reasoning: `Error executing action: Could not find element with selector ${action.selector}. Retrying.`,
//         action: 'error'
//       }
//     });
//   }
// }


// Start Computer Use session
router.post('/start', computerUseRateLimiter, computerUseSafetyCheck, async (req, res) => {
  try {
    const { task, sessionId } = req.body;

    if (!task || !sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Task and sessionId are required'
      });
    }

    const existingSession = activeSessions.get(sessionId);
    if (existingSession?.userId && existingSession.userId !== req.user.id) {
      return res.status(409).json({
        success: false,
        error: 'Session id is already in use'
      });
    }

    // Initialize custom agent
    const agent = new CustomComputerUseAgent();

    // Generate initial plan
    const plan = await agent.generateInitialPlan(task);
    // Launch browser with optimized settings for speed and CAPTCHA avoidance
    const browser = await chromium.launch({
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
      viewport: { width: 1024, height: 768 },
      locale: 'en-US',
      // Speed optimizations
      ignoreHTTPSErrors: true,
      bypassCSP: true
    });

    const page = await context.newPage();
    page.sessionId = sessionId; // Attach sessionId for error reporting

    // Anti-detection measures
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
    });

    // Speed optimizations - allow more resources for better functionality
    await page.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      // Only block heavy media files, allow images and styles for better UX
      if (['media', 'font'].includes(resourceType)) {
        route.abort();
      } else {
        route.continue();
      }
    });
    await page.setViewportSize({ width: 1024, height: 768 });

    // Set faster timeouts for better performance
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(15000);

    // Store session - preserve existing chat context if available
    const preservedSession = existingSession || {};
    activeSessions.set(sessionId, {
      ...preservedSession, // Preserve chat context
      browser,
      page,
      task,
      agent,
      userId: req.user.id,
      status: 'running',
      createdAt: preservedSession.createdAt || Date.now(),
      lastActivity: Date.now()
    });

    console.log('Session stored with context:', {
      sessionId,
      hasChatId: !!preservedSession.chatId,
      hasUserId: true,
      chatId: preservedSession.chatId,
      userId: req.user.id,
      task
    });

    // Dynamic and intelligent URL routing based on task content
    // let startingUrl = 'https://www.google.com'; // Default to Google
    const taskLower = task.toLowerCase();

    // // Launch browser
    // const browser = await chromium.launch({ 
    //   headless: true,
    //   args: ['--no-sandbox', '--disable-setuid-sandbox']
    // });

    // const page = await browser.newPage();
    // await page.setViewportSize({ width: 1024, height: 768 });

    // // Store session
    // activeSessions.set(sessionId, {
    //   browser,
    //   page,
    //   task,
    //   agent,
    //   plan,
    //   status: 'running',
    //   createdAt: Date.now(),
    //   lastActivity: Date.now()
    // });

    // // Navigate to starting URL from plan
    const startingUrl = plan.startingUrl || 'https://www.google.com';
    await page.goto(startingUrl);
    await page.waitForLoadState('networkidle');

    // Take initial screenshot
    const initialScreenshot = await getScreenshot(page);
    const initialScreenshotBase64 = initialScreenshot.toString('base64');

    // Send initial state to frontend
    broadcastToSession(sessionId, {
      type: 'session-started',
      data: {
        sessionId,
        task,
        plan: plan,
        initialScreenshot: `data:image/png;base64,${initialScreenshotBase64}`
      }
    });

    // Send initial reasoning
    broadcastToSession(sessionId, {
      type: 'reasoning',
      data: {
        reasoning: plan.reasoning,
        step: 0,
        action: 'planning'
      }
    });

    // Start the custom computer use loop
    setTimeout(() => {
      customComputerUseLoop(sessionId, browser, page, agent, task).catch(error => {
        console.error('Computer use loop error:', error);
        broadcastToSession(sessionId, {
          type: 'error',
          data: { error: error.message }
        });
      });
    }, 1000); // Small delay to ensure frontend is ready

    res.json({
      success: true,
      sessionId,
      message: 'Custom Computer Use session started',
      plan: plan
    });

  } catch (error) {
    console.error('Error starting Computer Use session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Resume paused session (for safety/user intervention)
router.post('/resume', async (req, res) => {
  try {
    const { sessionId } = req.body;

    const session = getSessionForUser(sessionId, req.user.id);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    // Resume the computer use loop if paused
    if (session.status === 'paused') {
      session.status = 'running';
      session.lastActivity = Date.now();

      // Continue the loop
      customComputerUseLoop(sessionId, session.browser, session.page, session.agent, session.task).catch(error => {
        console.error('Computer use loop error after resume:', error);
        broadcastToSession(sessionId, {
          type: 'error',
          data: { error: error.message }
        });
      });
    }

    res.json({
      success: true,
      message: 'Session resumed'
    });

  } catch (error) {
    console.error('Error resuming session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Stop Computer Use session
router.post('/stop', async (req, res) => {
  try {
    const { sessionId } = req.body;

    const session = getSessionForUser(sessionId, req.user.id);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    // Close browser
    if (session.browser) {
      await session.browser.close();
    }

    // Remove session
    activeSessions.delete(sessionId);

    // Notify frontend
    broadcastToSession(sessionId, {
      type: 'session-stopped',
      data: { sessionId }
    });

    res.json({
      success: true,
      message: 'Computer Use session stopped'
    });

  } catch (error) {
    console.error('Error stopping Computer Use session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get session status
router.get('/status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = getSessionForUser(sessionId, req.user.id);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    res.json({
      success: true,
      sessionId,
      status: session.status,
      task: session.task
    });

  } catch (error) {
    console.error('Error getting session status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Chat integration endpoint
router.post('/chat-integration', async (req, res) => {
  try {
    const { message, chatId, sessionId } = req.body;
    const userId = req.user.id;

    if (!message || !chatId) {
      return res.status(400).json({
        success: false,
        error: 'Message and chatId are required'
      });
    }

    // First, ensure the chat exists for the authenticated user and
    // never trust a client-provided userId for persistence.
    let chat = await prisma.chat.findFirst({
      where: { id: chatId, userId }
    });

    if (!chat) {
      console.log(`Creating new chat ${chatId} for computer use...`);
      chat = await prisma.chat.create({
        data: {
          id: chatId,
          userId: userId,
          title: message.length > 50 ? message.substring(0, 50) + '...' : message,
          model: 'computer-use-agent'
        }
      });
    }

    // Save the user message first
    await prisma.message.create({
      data: {
        chatId: chatId,
        role: 'USER',
        content: message,
        tokens: 0
      }
    });

    console.log('User message saved to chat:', chatId);

    // Generate unique session ID if not provided
    const computeSessionId = sessionId || `chat-${chatId}-${Date.now()}`;

    // Store chat information in session for later use
    console.log('Storing chat context:', { computeSessionId, chatId, userId, message });
    const sessionData = {
      chatId: chatId,
      userId: userId,
      originalTask: message,
      status: 'initializing',
      lastActivity: Date.now()
    };
    activeSessions.set(computeSessionId, sessionData);
    console.log('Session stored:', activeSessions.get(computeSessionId));

    // Start computer use session
    console.log("CHECKING ENV VAR:", process.env.BASE_URL); // Yeh line add karein

    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;

    console.log("USING THIS URL FOR FETCH:", baseUrl); // Yeh line bhi add karein
    const startResponse = await fetch(`${baseUrl}/api/computer-use/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${req.token}`,
      },
      body: JSON.stringify({
        task: message,
        sessionId: computeSessionId
      })
    });

    console.log('Start response status:', startResponse.status);

    if (!startResponse.ok) {
      throw new Error('Failed to start computer use session');
    }

    const result = await startResponse.json();

    res.json({
      success: true,
      sessionId: computeSessionId,
      message: 'Computer Use task started',
      chatId: chatId,
      task: message
    });

  } catch (error) {
    console.error('Error in chat integration:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Acknowledge safety checks endpoint
router.post('/acknowledge-safety', async (req, res) => {
  try {
    const { sessionId, callId, acknowledgedChecks } = req.body;

    if (!sessionId || !callId) {
      return res.status(400).json({
        success: false,
        error: 'SessionId and callId are required'
      });
    }

    console.log(`Safety checks acknowledged for session ${sessionId}, call ${callId}`);

    // Update session state to indicate acknowledgment
    const session = getSessionForUser(sessionId, req.user.id);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }
    if (session && session.captchaDetected) {
      session.captchaAcknowledged = true;
      console.log('CAPTCHA acknowledgment flag set for session:', sessionId);
    }

    // Broadcast acknowledgment to session
    broadcastToSession(sessionId, {
      type: 'safety-acknowledged',
      data: {
        callId,
        acknowledgedChecks,
        message: 'CAPTCHA acknowledgment received. Please solve the CAPTCHA manually if visible, then the task will continue automatically.'
      }
    });

    res.json({
      success: true,
      message: 'Safety checks acknowledged',
      sessionId,
      callId
    });

  } catch (error) {
    console.error('Error acknowledging safety checks:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// HTML generation endpoint
router.post('/generate-html', async (req, res) => {
  try {
    const { extractedData } = req.body;

    if (!extractedData) {
      return res.status(400).json({
        success: false,
        error: 'Extracted data is required'
      });
    }

    console.log('Generating AI-powered HTML report...');
    console.log('Items count to process:', extractedData.rawItems ? extractedData.rawItems.length : 0);

    // Use the AI HTML generation function with original query
    const htmlContent = await generateHtmlReport(extractedData, extractedData.userQuery || extractedData.originalQuery);

    res.json({
      success: true,
      htmlContent: htmlContent
    });

  } catch (error) {
    console.error('Error generating HTML report:', error);

    // Fallback to basic HTML generation
    try {
      const fallbackHtml = generateFallbackHtml(extractedData, extractedData.userQuery || extractedData.originalQuery);
      res.json({
        success: true,
        htmlContent: fallbackHtml,
        fallback: true
      });
    } catch (fallbackError) {
      console.error('Fallback HTML generation also failed:', fallbackError);
      res.status(500).json({
        success: false,
        error: 'Failed to generate HTML report'
      });
    }
  }
});

module.exports = {
  router,
  initializeWebSocketServer,
  CustomComputerUseAgent,
  activeSessions
};
