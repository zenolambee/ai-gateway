/**
 * Integration test for Tool Calling / Function Calling.
 *
 * Run:  node examples/toolCalling.integration.js
 *
 * Spins up two mock providers:
 *   - one that speaks OpenAI Chat Completions ("openai-compat")
 *   - one that speaks Anthropic Messages ("anthropic-style") with tool_use
 *
 * Verifies:
 *   - single tool call (OpenAI-compat pass-through + Anthropic mapping)
 *   - multiple / parallel tool calls
 *   - streaming tool calls (incremental deltas)
 *   - finish_reason = tool_calls
 *   - tool result message (role: tool) round-trip
 *   - tool_choice options (auto, required, specific function)
 *   - parallel_tool_calls forwarded
 *   - validation errors (bad tools, bad tool_choice, bad parallel_tool_calls,
 *     tool message missing tool_call_id)
 *   - unsupported provider (supportsTools:false) -> 400 tools_not_supported
 *   - fallback to a second provider
 *   - retry on transient failure
 *   - OpenAI compatibility (response shape)
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const app = require('../src/app');
const logger = require('../src/utils/logger');

logger.info = () => {};
logger.warn = () => {};
logger.error = () => {};

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  const tag = passed ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

let mockServer;
let mockPort;
let expressServer;
let expressPort;
let tmpProvidersDir;

const providerBehavior = {};

// Records of the last received request
let lastOpenAIRequest = null;
let lastAnthropicRequest = null;

function startMockProvider() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const url = req.url;
        const auth = req.headers.authorization || '';
        let providerId = 'unknown';
        if (auth.includes('oai-key')) providerId = 'openai-compat';
        else if (auth.includes('anthropic-key')) providerId = 'anthropic-style';
        else if (auth.includes('flaky-key')) providerId = 'flaky';
        else if (auth.includes('notools-key')) providerId = 'notools';
        else if (auth.includes('secondary-key')) providerId = 'secondary';

        const behavior = providerBehavior[providerId] || {};
        if (behavior.failTimes && behavior.failTimes > 0) {
          behavior.failTimes -= 1;
          const status = behavior.failStatus || 503;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Simulated ${status}` } }));
          return;
        }

        // --- OpenAI-compatible endpoints ---
        if (url === '/chat/completions') {
          let received;
          try { received = JSON.parse(body); } catch { received = {}; }
          lastOpenAIRequest = received;
          const isStream = received.stream === true;

          if (isStream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });
            res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"oai-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
            res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"oai-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n');
            res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"oai-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"loc"}}]},"finish_reason":null}]}\n\n');
            res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"oai-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ation\\":\\"Paris\\"}"}}]},"finish_reason":null}]}\n\n');
            res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"oai-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-openai',
            object: 'chat.completion',
            created: 1700000000,
            model: received.model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call_abc',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"location":"Paris"}' },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
          }));
          return;
        }

        // --- Anthropic-style endpoints ---
        if (url === '/messages') {
          let received;
          try { received = JSON.parse(body); } catch { received = {}; }
          lastAnthropicRequest = received;
          const isStream = received.stream === true;

          if (isStream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });
            res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[],"model":"claude-model","stop_reason":null}}\n\n');
            res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_123","name":"get_weather"}}\n\n');
            res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"loc"}}\n\n');
            res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"ation\\":\\"London\\"}"}}\n\n');
            res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
            res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}\n\n');
            res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
            res.end();
            return;
          }

          // Non-streaming: return tool_use for any request with tools
          const hasTools = Array.isArray(received.tools) && received.tools.length > 0;
          if (hasTools) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: 'msg_anthropic',
              type: 'message',
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'toolu_123', name: 'get_weather', input: { location: 'London' } },
              ],
              stop_reason: 'tool_use',
              usage: { input_tokens: 40, output_tokens: 12 },
            }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'msg_anthropic',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello from Anthropic!' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 8, output_tokens: 6 },
          }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Not found' } }));
      });
    });
    mockServer.listen(0, '127.0.0.1', () => {
      mockPort = mockServer.address().port;
      resolve();
    });
  });
}

function writeProviderConfigs() {
  tmpProvidersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-tools-'));
  const base = `http://127.0.0.1:${mockPort}`;

  const openaiCompat = {
    id: 'openai-compat', name: 'OpenAI Compatible', enabled: true,
    adapter: 'generic-openai', baseURL: base, apiKeys: ['oai-key'],
    supportedModels: ['oai-model', 'shared-tool-model'], priority: 1, timeout: 5000,
  };
  const anthropicStyle = {
    id: 'anthropic-style', name: 'Anthropic Style', enabled: true,
    adapter: 'anthropic', baseURL: base, apiKeys: ['anthropic-key'],
    supportedModels: ['claude-model', 'shared-tool-model'], priority: 2, timeout: 5000,
    anthropicVersion: '2023-06-01',
  };
  const notools = {
    id: 'notools', name: 'No Tools Provider', enabled: true,
    // Use generic-openai but we'll override capability via a custom adapter id.
    // TokenFaucet adapter declares supportsTools:false.
    adapter: 'tokenfaucet', baseURL: base, apiKeys: ['notools-key'],
    supportedModels: ['notools-model'], priority: 1, timeout: 5000,
  };
  const flaky = {
    id: 'flaky', name: 'Flaky', enabled: true,
    adapter: 'generic-openai', baseURL: base, apiKeys: ['flaky-key'],
    supportedModels: ['flaky-tool-model'], priority: 1, timeout: 5000,
  };
  const secondary = {
    id: 'secondary', name: 'Secondary', enabled: true,
    adapter: 'generic-openai', baseURL: base, apiKeys: ['secondary-key'],
    supportedModels: ['shared-tool-model', 'secondary-only-tool'], priority: 3, timeout: 5000,
  };

  fs.writeFileSync(path.join(tmpProvidersDir, 'openai.json'), JSON.stringify(openaiCompat));
  fs.writeFileSync(path.join(tmpProvidersDir, 'anthropic.json'), JSON.stringify(anthropicStyle));
  fs.writeFileSync(path.join(tmpProvidersDir, 'notools.json'), JSON.stringify(notools));
  fs.writeFileSync(path.join(tmpProvidersDir, 'flaky.json'), JSON.stringify(flaky));
  fs.writeFileSync(path.join(tmpProvidersDir, 'secondary.json'), JSON.stringify(secondary));
}

function startExpressServer() {
  return new Promise((resolve) => {
    expressServer = app.listen(0, '127.0.0.1', () => {
      expressPort = expressServer.address().port;
      resolve();
    });
  });
}

function request(pathStr, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: expressPort, method: 'POST', path: pathStr,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
        catch { resolve({ status: res.statusCode, body: chunks }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function streamRequest(pathStr, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: expressPort, method: 'POST', path: pathStr,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: chunks }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function parseSSEEvents(raw) {
  const events = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length) {
      const joined = dataLines.join('\n');
      events.push(joined === '[DONE]' ? '[DONE]' : (() => { try { return JSON.parse(joined); } catch { return joined; } })());
    }
  }
  return events;
}

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the weather for a location',
    parameters: {
      type: 'object',
      properties: { location: { type: 'string', description: 'City name' } },
      required: ['location'],
    },
  },
};

const CALCULATOR_TOOL = {
  type: 'function',
  function: {
    name: 'calculator',
    description: 'Perform arithmetic',
    parameters: { type: 'object', properties: { expr: { type: 'string' } }, required: ['expr'] },
  },
};

async function testOpenAISingleToolCall() {
  lastOpenAIRequest = null;
  const res = await request('/v1/chat/completions', {
    model: 'oai-model',
    messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
    tools: [WEATHER_TOOL],
    tool_choice: 'auto',
  });
  const ok =
    res.status === 200 &&
    res.body.choices[0].finish_reason === 'tool_calls' &&
    res.body.choices[0].message.tool_calls[0].function.name === 'get_weather' &&
    res.body.choices[0].message.tool_calls[0].function.arguments === '{"location":"Paris"}';
  record('OpenAI-compat: single tool call + finish_reason=tool_calls', ok, `status=${res.status}, finish=${res.body && res.body.choices && res.body.choices[0] && res.body.choices[0].finish_reason}`);
  const forwarded = lastOpenAIRequest && Array.isArray(lastOpenAIRequest.tools);
  record('OpenAI-compat: tools forwarded to provider', forwarded, `tools=${lastOpenAIRequest && lastOpenAIRequest.tools && lastOpenAIRequest.tools.length}`);
}

async function testOpenAIMultipleToolCalls() {
  const res = await request('/v1/chat/completions', {
    model: 'oai-model',
    messages: [{ role: 'user', content: 'Weather in Paris and calculate 2+2' }],
    tools: [WEATHER_TOOL, CALCULATOR_TOOL],
    parallel_tool_calls: true,
  });
  // Mock returns a single tool call; we verify the request was accepted and tools forwarded
  const ok = res.status === 200 && res.body.choices[0].finish_reason === 'tool_calls';
  record('OpenAI-compat: multiple tools + parallel_tool_calls accepted', ok, `status=${res.status}`);
  const ptc = lastOpenAIRequest && lastOpenAIRequest.parallel_tool_calls === true;
  record('OpenAI-compat: parallel_tool_calls forwarded', ptc, `parallel=${lastOpenAIRequest && lastOpenAIRequest.parallel_tool_calls}`);
}

async function testOpenAIToolResultRoundTrip() {
  lastOpenAIRequest = null;
  const res = await request('/v1/chat/completions', {
    model: 'oai-model',
    messages: [
      { role: 'user', content: 'Weather in Paris?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"location":"Paris"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temperature":22}' },
    ],
    tools: [WEATHER_TOOL],
  });
  const ok = res.status === 200;
  record('OpenAI-compat: tool result message round-trip', ok, `status=${res.status}`);
  // Verify the tool message was forwarded
  const hasToolMsg = lastOpenAIRequest && lastOpenAIRequest.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1');
  record('OpenAI-compat: tool role message forwarded', hasToolMsg, `messages=${lastOpenAIRequest && lastOpenAIRequest.messages.length}`);
}

async function testAnthropicSingleToolCall() {
  lastAnthropicRequest = null;
  const res = await request('/v1/chat/completions', {
    model: 'claude-model',
    messages: [{ role: 'user', content: 'What is the weather in London?' }],
    tools: [WEATHER_TOOL],
  });
  // Verify Anthropic request mapping: tools in Anthropic format
  const toolsOk = lastAnthropicRequest
    && Array.isArray(lastAnthropicRequest.tools)
    && lastAnthropicRequest.tools[0].name === 'get_weather'
    && lastAnthropicRequest.tools[0].input_schema;
  record('Anthropic: tools mapped to Anthropic format (name + input_schema)', toolsOk, `tools=${lastAnthropicRequest && lastAnthropicRequest.tools && lastAnthropicRequest.tools[0] && lastAnthropicRequest.tools[0].name}`);
  // Verify response: tool_use -> OpenAI tool_calls
  const resOk =
    res.status === 200 &&
    res.body.choices[0].finish_reason === 'tool_calls' &&
    res.body.choices[0].message.tool_calls[0].id === 'toolu_123' &&
    res.body.choices[0].message.tool_calls[0].function.name === 'get_weather' &&
    res.body.choices[0].message.tool_calls[0].function.arguments === '{"location":"London"}';
  record('Anthropic: tool_use mapped to OpenAI tool_calls', resOk, `status=${res.status}, finish=${res.body && res.body.choices && res.body.choices[0] && res.body.choices[0].finish_reason}`);
}

async function testAnthropicToolChoiceRequired() {
  lastAnthropicRequest = null;
  await request('/v1/chat/completions', {
    model: 'claude-model',
    messages: [{ role: 'user', content: 'Use a tool' }],
    tools: [WEATHER_TOOL],
    tool_choice: 'required',
  });
  const ok = lastAnthropicRequest && lastAnthropicRequest.tool_choice && lastAnthropicRequest.tool_choice.type === 'any';
  record('Anthropic: tool_choice "required" -> { type: "any" }', ok, `tc=${lastAnthropicRequest && lastAnthropicRequest.tool_choice && lastAnthropicRequest.tool_choice.type}`);
}

async function testAnthropicToolChoiceSpecific() {
  lastAnthropicRequest = null;
  await request('/v1/chat/completions', {
    model: 'claude-model',
    messages: [{ role: 'user', content: 'Weather' }],
    tools: [WEATHER_TOOL],
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
  });
  const ok = lastAnthropicRequest
    && lastAnthropicRequest.tool_choice
    && lastAnthropicRequest.tool_choice.type === 'tool'
    && lastAnthropicRequest.tool_choice.name === 'get_weather';
  record('Anthropic: tool_choice specific function -> { type: "tool", name }', ok, `tc=${lastAnthropicRequest && lastAnthropicRequest.tool_choice && lastAnthropicRequest.tool_choice.type}`);
}

async function testAnthropicToolResultMessage() {
  lastAnthropicRequest = null;
  const res = await request('/v1/chat/completions', {
    model: 'claude-model',
    messages: [
      { role: 'user', content: 'Weather in London?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_123', type: 'function', function: { name: 'get_weather', arguments: '{"location":"London"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_123', content: '{"temperature":15}' },
    ],
    tools: [WEATHER_TOOL],
  });
  // Verify the tool result was mapped to a tool_result block in a user message
  const msgs = lastAnthropicRequest && lastAnthropicRequest.messages;
  const hasToolResult = msgs && msgs.some((m) =>
    m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result' && c.tool_use_id === 'toolu_123')
  );
  record('Anthropic: tool result message -> tool_result content block', hasToolResult, `msgs=${msgs && msgs.length}`);
  const ok = res.status === 200;
  record('Anthropic: tool result round-trip succeeds', ok, `status=${res.status}`);
}

async function testAnthropicAssistantToolCallsForwarded() {
  lastAnthropicRequest = null;
  await request('/v1/chat/completions', {
    model: 'claude-model',
    messages: [
      { role: 'user', content: 'Weather?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"location":"NYC"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_1', content: '{"temp":20}' },
    ],
    tools: [WEATHER_TOOL],
  });
  const msgs = lastAnthropicRequest && lastAnthropicRequest.messages;
  // The assistant message with tool_calls should become an Anthropic assistant
  // message with a tool_use content block.
  const hasToolUse = msgs && msgs.some((m) =>
    m.role === 'assistant' && Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_use' && c.id === 'toolu_1' && c.name === 'get_weather')
  );
  record('Anthropic: assistant tool_calls -> tool_use content block', hasToolUse, `msgs=${msgs && msgs.length}`);
}

async function testStreamingToolCallsOpenAI() {
  const res = await streamRequest('/v1/chat/completions', {
    model: 'oai-model',
    messages: [{ role: 'user', content: 'Weather in Paris?' }],
    tools: [WEATHER_TOOL],
    stream: true,
  });
  const ctOk = res.headers['content-type'] && res.headers['content-type'].includes('text/event-stream');
  const events = parseSSEEvents(res.body);
  // Collect tool_call deltas
  const toolCallChunks = events.filter((e) => e && e.choices && e.choices[0] && e.choices[0].delta && Array.isArray(e.choices[0].delta.tool_calls));
  const args = toolCallChunks
    .map((e) => e.choices[0].delta.tool_calls[0].function.arguments || '')
    .join('');
  const hasId = toolCallChunks.some((e) => e.choices[0].delta.tool_calls[0].id === 'call_abc');
  const hasName = toolCallChunks.some((e) => e.choices[0].delta.tool_calls[0].function.name === 'get_weather');
  const hasFinish = events.some((e) => e && e.choices && e.choices[0] && e.choices[0].finish_reason === 'tool_calls');
  const hasDone = events.includes('[DONE]');
  record('OpenAI stream: text/event-stream', ctOk, `ct=${res.headers['content-type']}`);
  record('OpenAI stream: tool_call id + name in first delta', hasId && hasName, `id=${hasId}, name=${hasName}`);
  record('OpenAI stream: incremental argument deltas reconstruct JSON', args === '{"location":"Paris"}', `args="${args}"`);
  record('OpenAI stream: finish_reason=tool_calls', hasFinish);
  record('OpenAI stream: [DONE] terminator', hasDone);
}

async function testStreamingToolCallsAnthropic() {
  const res = await streamRequest('/v1/chat/completions', {
    model: 'claude-model',
    messages: [{ role: 'user', content: 'Weather in London?' }],
    tools: [WEATHER_TOOL],
    stream: true,
  });
  const events = parseSSEEvents(res.body);
  const toolCallChunks = events.filter((e) => e && e.choices && e.choices[0] && e.choices[0].delta && Array.isArray(e.choices[0].delta.tool_calls));
  const args = toolCallChunks
    .map((e) => e.choices[0].delta.tool_calls[0].function.arguments || '')
    .join('');
  const hasId = toolCallChunks.some((e) => e.choices[0].delta.tool_calls[0].id === 'toolu_123');
  const hasName = toolCallChunks.some((e) => e.choices[0].delta.tool_calls[0].function.name === 'get_weather');
  const hasFinish = events.some((e) => e && e.choices && e.choices[0] && e.choices[0].finish_reason === 'tool_calls');
  const hasDone = events.includes('[DONE]');
  record('Anthropic stream: tool_call id + name from content_block_start', hasId && hasName, `id=${hasId}, name=${hasName}`);
  record('Anthropic stream: input_json_delta -> incremental arguments', args === '{"location":"London"}', `args="${args}"`);
  record('Anthropic stream: finish_reason=tool_calls', hasFinish);
  record('Anthropic stream: [DONE] terminator', hasDone);
}

async function testValidationBadTools() {
  const res = await request('/v1/chat/completions', {
    model: 'oai-model',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'invalid' }],
  });
  const ok = res.status === 400 && res.body.error && /tools/.test(res.body.error.message);
  record('validation: bad tools -> 400', ok, `status=${res.status}`);
}

async function testValidationBadToolChoice() {
  const res = await request('/v1/chat/completions', {
    model: 'oai-model',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [WEATHER_TOOL],
    tool_choice: 'invalid',
  });
  const ok = res.status === 400 && res.body.error && /tool_choice/.test(res.body.error.message);
  record('validation: bad tool_choice -> 400', ok, `status=${res.status}`);
}

async function testValidationBadParallelToolCalls() {
  const res = await request('/v1/chat/completions', {
    model: 'oai-model',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [WEATHER_TOOL],
    parallel_tool_calls: 'yes',
  });
  const ok = res.status === 400 && res.body.error && /parallel_tool_calls/.test(res.body.error.message);
  record('validation: non-boolean parallel_tool_calls -> 400', ok, `status=${res.status}`);
}

async function testValidationToolMessageMissingId() {
  const res = await request('/v1/chat/completions', {
    model: 'oai-model',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'result' },
    ],
    tools: [WEATHER_TOOL],
  });
  const ok = res.status === 400 && res.body.error && /tool_call_id/.test(res.body.error.message);
  record('validation: tool message missing tool_call_id -> 400', ok, `status=${res.status}`);
}

async function testValidationBadFunctionName() {
  const res = await request('/v1/chat/completions', {
    model: 'oai-model',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { description: 'no name' } }],
  });
  const ok = res.status === 400 && res.body.error && /function.name/.test(res.body.error.message);
  record('validation: tool missing function.name -> 400', ok, `status=${res.status}`);
}

async function testUnsupportedProvider() {
  const res = await request('/v1/chat/completions', {
    model: 'notools-model',
    messages: [{ role: 'user', content: 'Use a tool' }],
    tools: [WEATHER_TOOL],
  });
  const ok =
    res.status === 400 &&
    res.body.error &&
    res.body.error.code === 'tools_not_supported';
  record('unsupported provider (supportsTools:false) -> 400 tools_not_supported', ok, `status=${res.status}, code=${res.body && res.body.error && res.body.error.code}`);
}

async function testRetryOnTransientFailure() {
  providerBehavior.flaky = { failTimes: 1, failStatus: 503 };
  const res = await request('/v1/chat/completions', {
    model: 'flaky-tool-model',
    messages: [{ role: 'user', content: 'Weather?' }],
    tools: [WEATHER_TOOL],
  });
  const ok = res.status === 200 && res.body.choices[0].finish_reason === 'tool_calls';
  record('retry on transient 503 -> 200 with tool_calls', ok, `status=${res.status}`);
  delete providerBehavior.flaky;
}

async function testFallbackToSecondaryProvider() {
  providerBehavior['openai-compat'] = { failTimes: 99, failStatus: 503 };
  const res = await request('/v1/chat/completions', {
    model: 'shared-tool-model',
    messages: [{ role: 'user', content: 'Weather?' }],
    tools: [WEATHER_TOOL],
  });
  // openai-compat fails -> fallback to anthropic-style (priority 2) which
  // supports tools
  const ok = res.status === 200 && res.body.choices[0].finish_reason === 'tool_calls';
  record('fallback to secondary (tools-capable) provider -> 200', ok, `status=${res.status}`);
  delete providerBehavior['openai-compat'];
  const { apiKeyManager } = require('../src/services');
  apiKeyManager.enableKey('openai-compat', 'oai-key');
}

async function testOpenAICompatibility() {
  const res = await request('/v1/chat/completions', {
    model: 'oai-model',
    messages: [{ role: 'user', content: 'Weather?' }],
    tools: [WEATHER_TOOL],
  });
  const tc = res.body.choices[0].message.tool_calls[0];
  const ok =
    res.body.object === 'chat.completion' &&
    tc.id && typeof tc.id === 'string' &&
    tc.type === 'function' &&
    typeof tc.function.name === 'string' &&
    typeof tc.function.arguments === 'string' &&
    res.body.choices[0].finish_reason === 'tool_calls';
  record('OpenAI-compatible response shape (id/type/function.name/arguments)', ok, `status=${res.status}`);
}

async function testChatWithoutToolsStillWorks() {
  const res = await request('/v1/chat/completions', {
    model: 'oai-model',
    messages: [{ role: 'user', content: 'Hi' }],
  });
  const ok = res.status === 200 && res.body.object === 'chat.completion';
  record('chat without tools still works', ok, `status=${res.status}`);
}

async function main() {
  console.log('=== Tool Calling Integration Tests ===\n');
  await startMockProvider();
  writeProviderConfigs();

  const { providerManager, apiKeyManager } = require('../src/services');
  providerManager.load(tmpProvidersDir);
  apiKeyManager.load(providerManager.listProviders());

  await startExpressServer();

  try {
    await testOpenAISingleToolCall();
    await testOpenAIMultipleToolCalls();
    await testOpenAIToolResultRoundTrip();
    await testAnthropicSingleToolCall();
    await testAnthropicToolChoiceRequired();
    await testAnthropicToolChoiceSpecific();
    await testAnthropicToolResultMessage();
    await testAnthropicAssistantToolCallsForwarded();
    await testStreamingToolCallsOpenAI();
    await testStreamingToolCallsAnthropic();
    await testValidationBadTools();
    await testValidationBadToolChoice();
    await testValidationBadParallelToolCalls();
    await testValidationToolMessageMissingId();
    await testValidationBadFunctionName();
    await testUnsupportedProvider();
    await testRetryOnTransientFailure();
    await testFallbackToSecondaryProvider();
    await testOpenAICompatibility();
    await testChatWithoutToolsStillWorks();
  } finally {
    await new Promise((r) => expressServer.close(r));
    await new Promise((r) => mockServer.close(r));
    fs.rmSync(tmpProvidersDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length > 0) {
    console.error('FAILED TESTS:');
    failed.forEach((f) => console.error(`  - ${f.name}: ${f.detail}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Integration test crashed:', err);
  process.exit(1);
});
