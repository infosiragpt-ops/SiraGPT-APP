#!/bin/bash

echo "🚀 Starting Computer Use Agent Integration"
echo "=========================================="

# Check if required environment variables are set
if [ -z "$OPENAI_API_KEY" ]; then
    echo "⚠️  Warning: OPENAI_API_KEY not set"
    echo "   Please add your OpenAI API key to the .env file"
fi

echo "📦 Installing Playwright browsers..."
cd backend
npx playwright install chromium

echo "🖥️  Starting backend server..."
npm run dev &
BACKEND_PID=$!

echo "⏱️  Waiting for backend to start..."
sleep 5

echo "🌐 Starting frontend server..."
cd ../
npm run dev &
FRONTEND_PID=$!

echo ""
echo "✅ Computer Use Agent is ready!"
echo "   Frontend: http://localhost:3000"
echo "   Backend:  http://localhost:5000"
echo "   WebSocket: ws://localhost:5000/ws/computer-use"
echo ""
echo "🎯 How to test:"
echo "   1. Open the frontend URL"
echo "   2. Click the '+' button in chat"
echo "   3. Select 'Computer Use Agent'"
echo "   4. Type a task like 'Go to google.com and search for AI news'"
echo "   5. Watch the magic happen in the preview area!"
echo ""
echo "Press Ctrl+C to stop both servers"

# Wait for interrupt signal
trap "kill $BACKEND_PID $FRONTEND_PID; exit" INT
wait