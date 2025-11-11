const express = require('express');
const { chromium } = require('playwright');
const OpenAI = require('openai');
const WebSocket = require('ws');
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

  async analyzeScreenshotAndPlan(task, screenshot, previousAction = null) {
    const captchaGuidance = previousAction === 'captcha_retry' ? 
      '\n\nIMPORTANT: Previous action detected CAPTCHA. The system will automatically handle it by:\n- Refreshing the page\n- Using alternative search engines (DuckDuckGo instead of Google)\n- Trying different approaches\n- You should focus on the main task and ignore CAPTCHA when detected' : '';

    const prompt = `You are a computer use agent. Analyze this screenshot and determine the next action to accomplish the task: "${task}"${captchaGuidance}

Current screenshot shows what's on the browser screen. Based on what you see, provide the next action in this JSON format:

{
  "reasoning": "Brief explanation of what you see and why you're taking this action",
  "action": {
    "type": "click|type|scroll|wait|navigate|completed|captcha_detected",
    "x": 100,
    "y": 200,
    "text": "text to type",
    "url": "url to navigate to",
    "scrollDirection": "up|down",
    "scrollAmount": 300
  },
  "completed": false,
  "captcha_detected": false
}

CAPTCHA HANDLING: If you see any CAPTCHA, reCAPTCHA, "I'm not a robot", verification challenges, or "unusual traffic" messages:
- Set "captcha_detected": true and "type": "captcha_detected"
- The system will automatically handle it by trying alternatives
- DO NOT try to solve the CAPTCHA manually

ALTERNATIVE STRATEGIES for search tasks:
- If Google shows CAPTCHA, system will switch to DuckDuckGo
- If one website blocks access, try similar websites
- Focus on completing the main objective using different paths

Actions available:
- click: Click at coordinates {x, y}
- type: Type text into focused element
- scroll: Scroll page up/down
- navigate: Go to a URL
- wait: Wait for page to load
- completed: Task is finished
- captcha_detected: CAPTCHA detected (will be handled automatically)

Be precise with coordinates. Look for search boxes, buttons, links, forms etc. If the task is completed, set completed: true.

Task: ${task}`;

    try {
      const response = await openai.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${screenshot}`
                }
              }
            ]
          }
        ],
        max_tokens: 500,
        temperature: 0.1
      });

      const content = response.choices[0].message.content;
      // Extract JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        
        // Additional CAPTCHA detection based on common patterns
        const reasoningText = result.reasoning?.toLowerCase() || '';
        if (reasoningText.includes('captcha') || 
            reasoningText.includes('robot') || 
            reasoningText.includes('verify') ||
            reasoningText.includes('unusual traffic') ||
            reasoningText.includes('verification') ||
            reasoningText.includes('security check') ||
            reasoningText.includes('prove you are human')) {
          result.captcha_detected = true;
          result.action.type = 'captcha_detected';
        }
        
        return result;
      }
      
      // Fallback if no JSON found
      return {
        reasoning: "Unable to parse action from response",
        action: { type: "wait" },
        completed: false,
        captcha_detected: false
      };
    } catch (error) {
      console.error('Error analyzing screenshot:', error);
      return {
        reasoning: `Error: ${error.message}`,
        action: { type: "wait" },
        completed: false,
        captcha_detected: false
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
          ws.sessionId = data.sessionId;
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
  
  wss.clients.forEach((client) => {
    if (client.sessionId === sessionId && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
};


// Get screenshot from Playwright page
async function getScreenshot(page) {
  return await page.screenshot({ fullPage: false });
}

// Custom Computer Use Loop
async function customComputerUseLoop(sessionId, browser, page, agent, task) {
  let stepCount = 0;
  const maxSteps = 20; // Prevent infinite loops
  
  try {
    while (stepCount < maxSteps) {
      stepCount++;

      // Check that session still exists and is running
      const session = activeSessions.get(sessionId);
      if (!session) {
        console.log(`Session ${sessionId} not found, stopping loop.`);
        broadcastToSession(sessionId, {
          type: 'task-stopped',
          data: { message: 'Session removed or stopped externally', step: stepCount }
        });
        break;
      }

      if (session.status !== 'running') {
        console.log(`Session ${sessionId} status is '${session.status}', exiting loop.`);
        broadcastToSession(sessionId, {
          type: 'task-paused',
          data: { message: `Session ${session.status}`, step: stepCount }
        });
        break;
      }

      // Take screenshot of current state (guard against closed page/browser)
      let screenshotBytes;
      try {
        screenshotBytes = await getScreenshot(page);
      } catch (screenshotErr) {
        console.error('Screenshot failed, likely browser/page closed:', screenshotErr);
        broadcastToSession(sessionId, {
          type: 'error',
          data: { error: `Screenshot failed: ${screenshotErr.message}`, step: stepCount }
        });
        break; // Exit loop gracefully
      }

      const screenshotBase64 = screenshotBytes.toString('base64');

      // Send current screenshot to frontend
      broadcastToSession(sessionId, {
        type: 'screenshot',
        data: {
          image: `data:image/png;base64,${screenshotBase64}`,
          step: stepCount
        }
      });

      // Analyze screenshot and get next action
      const currentSession = activeSessions.get(sessionId);
      const previousAction = currentSession?.lastCaptchaRetry ? 'captcha_retry' : null;
      const response = await agent.analyzeScreenshotAndPlan(task, screenshotBase64, previousAction);

      // Send reasoning to frontend
      broadcastToSession(sessionId, {
        type: 'reasoning',
        data: {
          reasoning: response.reasoning,
          step: stepCount,
          action: response.action?.type || 'thinking'
        }
      });

      // Check for CAPTCHA detection
      if (response.captcha_detected || response.action?.type === 'captcha_detected') {
        console.log('CAPTCHA detected, trying automatic solutions...');
        
        broadcastToSession(sessionId, {
          type: 'reasoning',
          data: {
            reasoning: 'CAPTCHA detected. Trying automatic solutions: refreshing page, using alternative search engines, or trying different approaches...',
            step: stepCount,
            action: 'captcha_handling'
          }
        });
        
        // Try automatic CAPTCHA solutions
        try {
          // Solution 1: Refresh the page and try again
          console.log('Attempting page refresh to bypass CAPTCHA...');
          await page.reload({ waitUntil: 'networkidle' });
          await page.waitForTimeout(3000);
          
          broadcastToSession(sessionId, {
            type: 'reasoning',
            data: {
              reasoning: 'Refreshed page to bypass CAPTCHA. Continuing with task...',
              step: stepCount,
              action: 'refresh'
            }
          });
          
        } catch (refreshError) {
          console.log('Page refresh failed, trying alternative approach...');
          
          // Solution 2: Try alternative search engine or approach
          try {
            if (task.toLowerCase().includes('search') || task.toLowerCase().includes('google')) {
              console.log('Trying DuckDuckGo as alternative search engine...');
              await page.goto('https://duckduckgo.com', { waitUntil: 'networkidle' });
              await page.waitForTimeout(2000);
              
              broadcastToSession(sessionId, {
                type: 'reasoning',
                data: {
                  reasoning: 'Google showed CAPTCHA, switching to DuckDuckGo search engine to continue the task...',
                  step: stepCount,
                  action: 'alternative_approach'
                }
              });
            } else {
              // For non-search tasks, wait and retry
              console.log('Waiting 10 seconds and retrying...');
              await page.waitForTimeout(10000);
              
              broadcastToSession(sessionId, {
                type: 'reasoning',
                data: {
                  reasoning: 'CAPTCHA encountered. Waiting and retrying with different approach...',
                  step: stepCount,
                  action: 'retry'
                }
              });
            }
          } catch (alternativeError) {
            console.log('Alternative approach failed, continuing with modified task...');
          }
        }
        
        stepCount++;
        continue;
      }

      // Check if task is completed
      if (response.completed) {
        console.log('Task completed successfully!');
        broadcastToSession(sessionId, {
          type: 'task-completed',
          data: {
            message: 'Task completed successfully!',
            finalScreenshot: `data:image/png;base64,${screenshotBase64}`,
            totalSteps: stepCount
          }
        });
        break;
      }

      // Execute the planned action
      if (response.action) {
        try {
          await executeCustomAction(page, response.action);

          // Wait for page to update
          await new Promise(resolve => setTimeout(resolve, 2000));

          // After action, confirm session still present
          if (!activeSessions.has(sessionId)) {
            console.log(`Session ${sessionId} removed during action execution, exiting.`);
            break;
          }

        } catch (actionError) {
          console.error('Action execution error:', actionError);
          broadcastToSession(sessionId, {
            type: 'reasoning',
            data: {
              reasoning: `Error executing action: ${actionError.message}`,
              step: stepCount,
              action: 'error'
            }
          });
        }
      }

      // Safety check - if we've been on same page too long
      if (stepCount >= maxSteps) {
        broadcastToSession(sessionId, {
          type: 'task-completed',
          data: {
            message: 'Task stopped after maximum steps reached',
            finalScreenshot: `data:image/png;base64,${screenshotBase64}`,
            totalSteps: stepCount
          }
        });
        break;
      }
    }
  } catch (error) {
    console.error('Computer use loop error:', error);
    broadcastToSession(sessionId, {
      type: 'error',
      data: { error: error.message }
    });
  }
}

// Execute custom actions
async function executeCustomAction(page, action) {
  console.log(`Executing action:`, action);
  
  switch (action.type) {
    case 'click':
      if (action.x && action.y) {
        await page.mouse.click(action.x, action.y);
      }
      break;
      
    case 'type':
      if (action.text) {
        await page.keyboard.type(action.text);
      }
      break;
      
    case 'scroll':
      const scrollAmount = action.scrollAmount || 300;
      if (action.scrollDirection === 'down') {
        await page.evaluate(`window.scrollBy(0, ${scrollAmount})`);
      } else {
        await page.evaluate(`window.scrollBy(0, -${scrollAmount})`);
      }
      break;
      
    case 'navigate':
      if (action.url) {
        await page.goto(action.url);
        await page.waitForLoadState('networkidle');
      }
      break;
      
    case 'wait':
      await page.waitForTimeout(2000);
      break;
      
    case 'keypress':
      if (action.key) {
        await page.keyboard.press(action.key);
      }
      break;
      
    default:
      console.log('Unknown action type:', action.type);
  }
}

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
    
    // Store session
    activeSessions.set(sessionId, {
      browser,
      page,
      task,
      agent,
      status: 'running',
      createdAt: Date.now(),
      lastActivity: Date.now()
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
    
    const session = activeSessions.get(sessionId);
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
    
    const session = activeSessions.get(sessionId);
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
    
    const session = activeSessions.get(sessionId);
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
    
    if (!message || !chatId) {
      return res.status(400).json({
        success: false,
        error: 'Message and chatId are required'
      });
    }
    
    // Generate unique session ID if not provided
    const computeSessionId = sessionId || `chat-${chatId}-${Date.now()}`;
    
    // Start computer use session
    const startResponse = await fetch(`http://localhost:5000/api/computer-use/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: message,
        sessionId: computeSessionId
      })
    });
    
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
    const session = activeSessions.get(sessionId);
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

module.exports = { 
  router, 
  initializeWebSocketServer,
  CustomComputerUseAgent 
};