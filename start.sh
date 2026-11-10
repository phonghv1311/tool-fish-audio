#!/usr/bin/env bash
# Quick launcher script for Fish Audio TTS Studio

echo "=================================================="
echo "🎙️  Starting Fish Audio TTS Studio..."
echo "=================================================="

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed. Please install Node.js."
    exit 1
fi

# Change to script directory
cd "$(dirname "$0")"

# Check if port 3000 is already in use
PORT=${PORT:-3000}
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
    echo "⚠️  Port $PORT is already in use (server might already be running)."
else
    echo "🚀 Starting Node server on port $PORT..."
    node server.js &
    SERVER_PID=$!
    sleep 1
fi

echo "🌐 Opening http://localhost:$PORT in browser..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    open "http://localhost:$PORT"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    xdg-open "http://localhost:$PORT" &> /dev/null || true
fi

echo "✨ Ready! Press Ctrl+C in terminal to stop."

