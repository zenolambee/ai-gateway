#!/bin/bash
#
# Example curl requests for the OpenAI-compatible Responses API endpoint.
#
# Usage:
#   ./examples/responses.curl.sh
#
# Assumes the gateway is running on http://127.0.0.1:3000 (or $GATEWAY_URL).
# Replace the keys in your .env with real provider keys, or use any model
# configured in config/providers/*.json.

GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:3000}"

echo "=== 1. Basic response with string input ==="
curl -s -X POST "${GATEWAY_URL}/v1/responses" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "input": "Say hello in one sentence."
  }' | python3 -m json.tool
echo

echo "=== 2. Response with instructions + temperature + max_output_tokens ==="
curl -s -X POST "${GATEWAY_URL}/v1/responses" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "input": "Give me three random color names.",
    "instructions": "You are a concise assistant. Answer briefly.",
    "temperature": 0.8,
    "max_output_tokens": 100
  }' | python3 -m json.tool
echo

echo "=== 3. Response with array input (multi-turn) ==="
curl -s -X POST "${GATEWAY_URL}/v1/responses" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "input": [
      "What is 2+2?",
      { "role": "assistant", "content": "4" },
      { "role": "user", "content": "Now multiply that by 3." }
    ]
  }' | python3 -m json.tool
echo

echo "=== 4. With custom request id ==="
curl -s -X POST "${GATEWAY_URL}/v1/responses" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: responses-trace-001" \
  -d '{
    "model": "deepseek-chat",
    "input": "ping"
  }' -i | grep -iE 'x-request-id|HTTP/'
echo

echo "=== 5. Validation error: missing model ==="
curl -s -X POST "${GATEWAY_URL}/v1/responses" \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Hello"
  }' | python3 -m json.tool
echo

echo "=== 6. Validation error: missing input ==="
curl -s -X POST "${GATEWAY_URL}/v1/responses" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat"
  }' | python3 -m json.tool
echo

echo "=== 7. Unknown model -> 404 ==="
curl -s -X POST "${GATEWAY_URL}/v1/responses" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "this-model-does-not-exist",
    "input": "Hi"
  }' | python3 -m json.tool
echo

echo "=== 8. Responses + Chat Completions share the same provider ==="
echo "--- /v1/responses ---"
curl -s -X POST "${GATEWAY_URL}/v1/responses" \
  -H "Content-Type: application/json" \
  -d '{ "model": "deepseek-chat", "input": "Say hi" }' \
  -o /dev/null -w "responses: HTTP %{http_code}\n"
echo "--- /v1/chat/completions ---"
curl -s -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{ "model": "deepseek-chat", "messages": [{ "role": "user", "content": "Say hi" }] }' \
  -o /dev/null -w "chat: HTTP %{http_code}\n"
echo "--- GET /v1/models ---"
curl -s "${GATEWAY_URL}/v1/models" -o /dev/null -w "models: HTTP %{http_code}\n"
echo
