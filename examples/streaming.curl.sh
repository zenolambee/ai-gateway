#!/bin/bash
#
# Example curl requests for OpenAI-compatible SSE streaming.
#
# Usage:
#   ./examples/streaming.curl.sh
#
# Assumes the gateway is running on http://127.0.0.1:3000 (or $GATEWAY_URL).
# Replace the keys in your .env with real provider keys, or use any model
# configured in config/providers/*.json.

GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:3000}"

echo "=== 1. Chat Completions stream (basic) ==="
curl -N -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [
      { "role": "user", "content": "Count from 1 to 5." }
    ],
    "stream": true
  }'
echo
echo

echo "=== 2. Chat Completions stream with system message ==="
curl -N -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [
      { "role": "system", "content": "You answer in haiku." },
      { "role": "user", "content": "What is the ocean?" }
    ],
    "stream": true,
    "temperature": 0.8
  }'
echo
echo

echo "=== 3. Responses API stream ==="
curl -N -X POST "${GATEWAY_URL}/v1/responses" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "input": "Say hello in one sentence.",
    "instructions": "Be concise.",
    "stream": true
  }'
echo
echo

echo "=== 4. Responses API stream with array input ==="
curl -N -X POST "${GATEWAY_URL}/v1/responses" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "input": [
      "What is 2+2?",
      { "role": "assistant", "content": "4" },
      { "role": "user", "content": "Now multiply by 3." }
    ],
    "stream": true
  }'
echo
echo

echo "=== 5. Validation error (stream:true but missing model) returns JSON ==="
curl -s -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [ { "role": "user", "content": "hi" } ],
    "stream": true
  }' | python3 -m json.tool
echo

echo "=== 6. Non-streaming request (stream:false or omitted) returns JSON ==="
curl -s -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [ { "role": "user", "content": "Say hi" } ]
  }' -o /dev/null -w "HTTP %{http_code}, Content-Type: %{content_type}\n"

echo "=== 7. Stream with custom request id ==="
curl -N -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: stream-trace-001" \
  -d '{
    "model": "deepseek-chat",
    "messages": [ { "role": "user", "content": "ping" } ],
    "stream": true
  }' -i 2>/dev/null | head -5
echo
