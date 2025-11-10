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

  async analyzeScreenshotAndPlan(task, screenshot) {
    const prompt = `You are a computer use agent. Analyze this screenshot and determine the next action to accomplish the task: "${task}"

Current screenshot shows what's on the browser screen. Based on what you see, provide the next action in this JSON format:

{
  "reasoning": "Brief explanation of what you see and why you're taking this action",
  "action": {
    "type": "click|type|scroll|wait|navigate|completed",
    "x": 100,
    "y": 200,
    "text": "text to type",
    "url": "url to navigate to",
    "scrollDirection": "up|down",
    "scrollAmount": 300
  },
  "completed": false
}

Actions available:
- click: Click at coordinates {x, y}
- type: Type text into focused element
- scroll: Scroll page up/down
- navigate: Go to a URL
- wait: Wait for page to load
- completed: Task is finished

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
        return JSON.parse(jsonMatch[0]);
      }
      
      // Fallback if no JSON found
      return {
        reasoning: "Unable to parse action from response",
        action: { type: "wait" },
        completed: false
      };
    } catch (error) {
      console.error('Error analyzing screenshot:', error);
      return {
        reasoning: `Error: ${error.message}`,
        action: { type: "wait" },
        completed: false
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

// Computer Use Action Handler
async function handleModelAction(page, action) {
  const actionType = action.type;
  
  try {
    switch (actionType) {
      case "click": {
        const { x, y, button = "left" } = action;
        console.log(`Action: click at (${x}, ${y}) with button '${button}'`);
        await page.mouse.click(x, y, { button });
        break;
      }
      
      case "scroll": {
        const { x, y, scrollX, scrollY } = action;
        console.log(`Action: scroll at (${x}, ${y}) with offsets (scrollX=${scrollX}, scrollY=${scrollY})`);
        await page.mouse.move(x, y);
        await page.evaluate(`window.scrollBy(${scrollX}, ${scrollY})`);
        break;
      }
      
      case "keypress": {
        const { keys } = action;
        for (const k of keys) {
          console.log(`Action: keypress '${k}'`);
          if (k.includes("ENTER")) {
            await page.keyboard.press("Enter");
          } else if (k.includes("SPACE")) {
            await page.keyboard.press(" ");
          } else {
            await page.keyboard.press(k);
          }
        }
        break;
      }
      
      case "type": {
        const { text } = action;
        console.log(`Action: type text '${text}'`);
        await page.keyboard.type(text);
        break;
      }
      
      case "wait": {
        console.log(`Action: wait`);
        await page.waitForTimeout(2000);
        break;
      }
      
      case "screenshot": {
        console.log(`Action: screenshot`);
        break;
      }
      
      default:
        console.log("Unrecognized action:", action);
    }
  } catch (e) {
    console.error("Error handling action", action, ":", e);
    throw e;
  }
}

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
      const response = await agent.analyzeScreenshotAndPlan(task, screenshotBase64);

      // Send reasoning to frontend
      broadcastToSession(sessionId, {
        type: 'reasoning',
        data: {
          reasoning: response.reasoning,
          step: stepCount,
          action: response.action?.type || 'thinking'
        }
      });

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
    
    // Launch browser
    const browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1024, height: 768 });
    
    // Store session
    activeSessions.set(sessionId, {
      browser,
      page,
      task,
      agent,
      plan,
      status: 'running',
      createdAt: Date.now(),
      lastActivity: Date.now()
    });
    
    // Navigate to starting URL from plan
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

module.exports = { 
  router, 
  initializeWebSocketServer,
  CustomComputerUseAgent 
};