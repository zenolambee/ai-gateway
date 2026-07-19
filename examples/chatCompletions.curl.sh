#!/bin/bash
#
# Example curl requests for the OpenAI-compatible Chat Completions endpoint.
#
# Usage:
#   ./examples/chatCompletions.curl.sh
#
# Assumes the gateway is running on http://127.0.0.1:3000 (or $GATEWAY_URL).
# Replace $DEEPSEEK_API_KEY / $OPENAI_API_KEY in your .env with real keys, or
# use any model configured in config/providers/*.json.

GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:3000}"

echo "=== 1. Basic chat completion (deepseek-chat) ==="
curl -s -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user", "content": "Say hello in one sentence." }
    ]
  }' | python3 -m json.tool
echo

echo "=== 2. Chat with parameters (gpt-4o-mini, temperature, max_tokens) ==="
curl -s -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [
      { "role": "user", "content": "Give me three random color names." }
    ],
    "temperature": 0.8,
    "max_tokens": 50
  }' | python3 -m json.tool
echo

echo "=== 3. With custom request id ==="
curl -s -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: my-trace-id-001" \
  -d '{
    "model": "deepseek-chat",
    "messages": [
      { "role": "user", "content": "ping" }
    ]
  }' -i | grep -iE 'x-request-id|HTTP/' 
echo

echo "=== 4. Validation error: missing model ==="
curl -s -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [ { "role": "user", "content": "hi" } ]
  }' | python3 -m json.tool
echo

echo "=== 5. Validation error: empty messages ==="
curl -s -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": []
  }' | python3 -m json.tool
echo

echo "=== 6. Unknown model -> 404 ==="
curl -s -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "this-model-does-not-exist",
    "messages": [ { "role": "user", "content": "hi" } ]
  }' | python3 -m json.tool
echo
