# Computer Use Agent Integration

This document describes the Computer Use Agent feature integration into the SiraGPT-like web application.

## 🎯 Overview

The Computer Use Agent allows AI to perform real computer actions using OpenAI's computer-use-preview model and Playwright automation. Users can request tasks like "Search for latest AI news on Google" or "Book a flight to London", and the AI will:

1. Control a real browser through Playwright
2. Take screenshots and send them to OpenAI
3. Receive action instructions (click, type, scroll, etc.)
4. Execute actions and show progress in real-time
5. Stream live browser view to the frontend
6. Provide step-by-step reasoning

## 🏗️ Architecture

### Backend Components

1. **API Routes** (`/backend/src/routes/computer-use.js`)
   - `/api/computer-use/start` - Start new session
   - `/api/computer-use/stop` - Stop active session
   - `/api/computer-use/acknowledge-safety` - Handle safety checks
   - `/api/computer-use/status/:sessionId` - Get session status

2. **WebSocket Server** 
   - Real-time communication at `ws://localhost:5000/ws/computer-use`
   - Streams screenshots, reasoning, and status updates

3. **Safety Middleware** (`/backend/src/middleware/computer-use-safety.js`)
   - Rate limiting (5 requests per minute)
   - Keyword filtering for harmful tasks  
   - Session timeout management (30 minutes)
   - Automatic cleanup of expired sessions

4. **Playwright Integration**
   - Browser automation with Chromium
   - Screenshot capture at 1024x768 resolution
   - Action execution (click, type, scroll, keypress, wait)

### Frontend Components

1. **ComputerUseInterface** (`/components/ComputerUseInterface.tsx`)
   - Main interface with live browser preview
   - Real-time reasoning display
   - Safety check dialog handling
   - Session controls (start/stop)

2. **ComputerUseSettings** (`/components/ComputerUseSettings.tsx`)
   - Safety mode configuration (strict/balanced/permissive)
   - Performance settings (timeout, screenshot quality)
   - Logging and monitoring options

3. **Chat Integration** 
   - Seamlessly integrated into existing chat interface
   - Appears in preview area like other features
   - New chat type: 'computer-use'

## 🚀 Setup Instructions

### Prerequisites

1. OpenAI API key with access to `computer-use-preview` model
2. Node.js 18+ installed
3. Both frontend and backend dependencies installed

### Environment Variables

Add to your `.env` file:

```bash
# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key_here

# Optional: Custom API URL for frontend
NEXT_PUBLIC_API_URL=http://localhost:5000
```

### Installation

1. **Backend Setup:**
```bash
cd backend
npm install ws  # WebSocket support (already included in package.json)
npm install playwright  # Already installed
npx playwright install chromium  # Install browser binaries
```

2. **Frontend Setup:**
```bash
cd frontend
npm install ws  # WebSocket support
```

### Running the Application

1. **Start Backend:**
```bash
cd backend
npm run dev  # Runs on http://localhost:5000
```

2. **Start Frontend:**
```bash
cd frontend  
npm run dev  # Runs on http://localhost:3000 or 3001
```

## 🎮 How to Use

### Basic Usage

1. **Enable Computer Use Mode:**
   - Click the "+" button in the chat interface
   - Select "Computer Use Agent" from the dropdown
   - The purple "Computer Use" badge will appear

2. **Start a Task:**
   - Type your task in the chat input (e.g., "Search for restaurants in New York")
   - Press Enter or click Send
   - The Computer Use interface will appear in the preview area

3. **Monitor Progress:**
   - Watch the live browser view on the left
   - Follow AI reasoning steps on the right
   - See real-time status updates

### Advanced Features

1. **Safety Controls:**
   - Click "Computer Use Settings" to configure safety modes
   - Adjust session timeouts and action limits
   - Enable/disable automatic confirmations

2. **Safety Checks:**
   - AI may pause for safety confirmation
   - Review the warning and choose to continue or cancel
   - Common checks: malicious instructions, sensitive domains

3. **Session Management:**
   - Sessions automatically timeout after 30 minutes (configurable)
   - Max 50 actions per session (configurable)
   - Manual stop available anytime

## 🔒 Safety Features

### Built-in Protections

1. **Keyword Filtering:**
   - Blocks tasks with harmful keywords (delete, hack, etc.)
   - Prevents access to sensitive information

2. **Rate Limiting:**
   - Maximum 5 requests per minute per IP
   - Prevents abuse and excessive usage

3. **Domain Blocking:**
   - Optional blocking of banking/payment sites
   - Configurable sensitive domain list

4. **Session Limits:**
   - 30-minute maximum session duration
   - 50-action limit per session
   - Automatic cleanup of expired sessions

5. **OpenAI Safety Checks:**
   - Malicious instruction detection
   - Irrelevant domain warnings
   - Sensitive domain monitoring

### Safety Modes

- **Strict:** All actions require user confirmation
- **Balanced:** Safe actions proceed automatically (recommended)
- **Permissive:** Minimal checks (use with caution)

## 🛠️ API Reference

### Start Session

```javascript
POST /api/computer-use/start
{
  "task": "Search for latest AI news on Google",
  "sessionId": "unique-session-id"
}
```

### WebSocket Events

**Incoming Events:**
- `session-started` - Session initialization complete
- `reasoning` - AI reasoning step
- `screenshot` - New browser screenshot
- `safety-check` - Safety confirmation required
- `task-completed` - Task finished successfully
- `error` - Error occurred

**Outgoing Events:**
- `join-session` - Join specific session for updates

### Safety Check Acknowledgment

```javascript
POST /api/computer-use/acknowledge-safety
{
  "sessionId": "session-id",
  "callId": "call-id", 
  "acknowledgedChecks": [safety_check_objects]
}
```

## 🧪 Testing

### Manual Testing

1. **Basic Function Test:**
   - Task: "Go to google.com and search for 'AI news'"
   - Expected: Browser opens Google, performs search

2. **Safety Test:**
   - Task: "Delete all my files"
   - Expected: Blocked by keyword filter

3. **WebSocket Test:**
   - Monitor browser developer tools Network tab
   - Verify WebSocket connection established
   - Check real-time message flow

### Development Testing

```bash
# Test WebSocket connection
node -e "const ws = require('ws'); const client = new ws('ws://localhost:5000/ws/computer-use'); client.on('open', () => console.log('Connected')); client.on('error', console.error);"

# Test API endpoint
curl -X POST http://localhost:5000/api/computer-use/start \
  -H "Content-Type: application/json" \
  -d '{"task":"Test task","sessionId":"test-123"}'
```

## 🚨 Troubleshooting

### Common Issues

1. **WebSocket Connection Failed:**
   - Check if backend is running on port 5000
   - Verify no firewall blocking WebSocket connections
   - Ensure CORS is properly configured

2. **Playwright Browser Won't Start:**
   - Run `npx playwright install chromium`
   - Check system permissions for browser execution
   - Verify headless mode is working

3. **OpenAI API Errors:**
   - Confirm API key has computer-use-preview access
   - Check API rate limits and usage quotas
   - Verify model availability

4. **Session Timeouts:**
   - Check session cleanup logs
   - Adjust timeout settings if needed
   - Monitor browser memory usage

### Debug Logs

Enable detailed logging by setting environment variables:
```bash
DEBUG=computer-use:*
NODE_ENV=development
```

## 📝 File Structure

```
├── backend/
│   ├── src/
│   │   ├── routes/
│   │   │   └── computer-use.js          # Main API routes
│   │   └── middleware/
│   │       └── computer-use-safety.js   # Safety middleware
│   └── index.js                         # WebSocket server init
├── components/
│   ├── ComputerUseInterface.tsx         # Main interface
│   ├── ComputerUseSettings.tsx          # Settings dialog
│   └── chat-interface-enhanced.tsx      # Chat integration
├── lib/
│   └── chat-context-integrated.tsx      # Chat context updates
└── styles/
    └── computer-use.css                 # Component styles
```

## 🔮 Future Enhancements

1. **Multi-Browser Support:** Chrome, Firefox, Safari
2. **Session Recording:** Save and replay sessions
3. **Collaborative Sessions:** Multiple users viewing same session
4. **Custom Actions:** User-defined action templates
5. **Integration Testing:** Automated test suite for common tasks
6. **Performance Monitoring:** Action timing and success metrics
7. **Advanced Safety:** ML-based threat detection

## 📄 License & Usage

This Computer Use Agent integration is part of the SiraGPT web application. Use responsibly and ensure compliance with OpenAI's usage policies and terms of service.

**Important:** Computer Use capabilities should only be used in controlled environments with proper safety measures and user oversight.