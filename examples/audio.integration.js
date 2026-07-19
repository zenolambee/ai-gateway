/**
 * Integration test for the Audio API (POST /v1/audio/*).
 *
 * Run:  node examples/audio.integration.js
 *
 * Spins up a mock provider and drives the full stack:
 *   request -> AudioService -> RequestExecutor (retry + fallback)
 *   -> HttpClient -> mock -> normalize to OpenAI Audio format
 *
 * Covers:
 *   - speech: 200 + binary audio response (mp3), params forwarded
 *   - speech: json response_format -> JSON body
 *   - transcriptions: 200 (multipart upload), { text } response, params forwarded
 *   - translations: 200 (multipart upload), { text } response, no language field
 *   - unsupported provider (Anthropic-style) -> 400 audio_not_supported
 *   - validation: speech missing model/input/voice, bad response_format, bad speed
 *   - validation: transcription missing file/model, bad response_format, bad temperature
 *   - validation: translation rejects language field
 *   - stream:true rejected with 400 (audio never streams)
 *   - retry on transient 503
 *   - fallback to a second provider
 *   - normalization (bare-string transcript -> { text })
 *   - OpenAI compatibility (speech binary + transcription JSON shapes)
 *   - sibling endpoints still work
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const FormData = require('form-data');
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

// Per-provider behavior: map providerId -> { failTimes, failStatus, responseShape }
const providerBehavior = {};

// Records of the last received request per endpoint
let lastSpeechRequest = null;
let lastTranscriptionRequest = null;
let lastTranslationRequest = null;

// A minimal MP3 frame (not a real audio file, but enough bytes for multipart).
const MP3_BYTES = Buffer.from([
  0xff, 0xfb, 0x90, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x61, 0x75,
  0x64, 0x69, 0x6f, 0x21, 0x00, 0x00, 0x00, 0x00,
]);

function startMockProvider() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const url = req.url;
        const auth = req.headers.authorization || '';
        const ct = (req.headers['content-type'] || '').toLowerCase();

        let providerId = 'unknown';
        if (auth.includes('primary-key')) providerId = 'primary';
        else if (auth.includes('secondary-key')) providerId = 'secondary';
        else if (auth.includes('flaky-key')) providerId = 'flaky';
        else if (auth.includes('anthropic-key')) providerId = 'anthropic';

        if (url === '/audio/speech') {
          const behavior = providerBehavior[providerId] || {};
          if (behavior.failTimes && behavior.failTimes > 0) {
            behavior.failTimes -= 1;
            const status = behavior.failStatus || 503;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `Simulated ${status}` } }));
            return;
          }
          let received;
          try { received = JSON.parse(Buffer.concat(chunks).toString()); } catch { received = {}; }
          lastSpeechRequest = received;

          const fmt = received.response_format;
          if (fmt === 'json') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text: 'speech-json-audio' }));
            return;
          }
          if (fmt === 'verbose_json') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text: 'verbose', task: 'text-to-speech', duration: 1.5 }));
            return;
          }
          // Binary audio response
          res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
          res.end(MP3_BYTES);
          return;
        }

        if (url === '/audio/transcriptions') {
          const raw = Buffer.concat(chunks).toString();
          const fields = parseMultipartFields(raw, ct);
          lastTranscriptionRequest = fields;
          const shape = (providerBehavior[providerId] || {}).responseShape;
          if (shape === 'bareString') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('Hello world transcript');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text: 'Hello world transcript' }));
          return;
        }

        if (url === '/audio/translations') {
          const raw = Buffer.concat(chunks).toString();
          const fields = parseMultipartFields(raw, ct);
          lastTranslationRequest = fields;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text: 'Translated to English' }));
          return;
        }

        // Fallback endpoints for "still works" sanity checks.
        if (url === '/chat/completions') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-mock', object: 'chat.completion', created: 1700000000,
            model: 'mock-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }));
          return;
        }
        if (url === '/images/generations') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ created: 1700000000, data: [{ url: 'https://img.test/x.png' }] }));
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

/**
 * Minimal multipart/form-data field parser for the mock provider.
 */
function parseMultipartFields(raw, contentType) {
  const fields = {};
  const m = /boundary=([^;\s]+)/i.exec(contentType || '');
  if (!m) return fields;
  const boundary = '--' + m[1];
  const parts = raw.split(boundary);
  for (const part of parts) {
    if (!part || part === '--' || part === '--\r\n') continue;
    const nameMatch = /name="([^"]+)"/.exec(part);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    if (/filename="/.test(part)) {
      fields[name] = '[file]';
      continue;
    }
    const sep = part.indexOf('\r\n\r\n');
    if (sep === -1) continue;
    let value = part.slice(sep + 4);
    value = value.replace(/\r?\n$/, '');
    fields[name] = value;
  }
  return fields;
}

function writeProviderConfigs() {
  tmpProvidersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-audio-'));

  const primary = {
    id: 'primary',
    name: 'Primary Audio',
    enabled: true,
    adapter: 'openai',
    baseURL: `http://127.0.0.1:${mockPort}`,
    apiKeys: ['primary-key'],
    supportedModels: ['tts-1', 'whisper-1', 'shared-audio'],
    priority: 1,
    timeout: 5000,
  };
  const secondary = {
    id: 'secondary',
    name: 'Secondary Audio',
    enabled: true,
    adapter: 'openai',
    baseURL: `http://127.0.0.1:${mockPort}`,
    apiKeys: ['secondary-key'],
    supportedModels: ['shared-audio', 'secondary-only-audio'],
    priority: 2,
    timeout: 5000,
  };
  const flaky = {
    id: 'flaky',
    name: 'Flaky Audio',
    enabled: true,
    adapter: 'openai',
    baseURL: `http://127.0.0.1:${mockPort}`,
    apiKeys: ['flaky-key'],
    supportedModels: ['flaky-audio'],
    priority: 1,
    timeout: 5000,
  };
  const anthropicStyle = {
    id: 'anthropic-style',
    name: 'Anthropic Style',
    enabled: true,
    adapter: 'anthropic',
    baseURL: `http://127.0.0.1:${mockPort}`,
    apiKeys: ['anthropic-key'],
    supportedModels: ['claude-audio'],
    priority: 1,
    timeout: 5000,
    anthropicVersion: '2023-06-01',
  };

  fs.writeFileSync(path.join(tmpProvidersDir, 'primary.json'), JSON.stringify(primary));
  fs.writeFileSync(path.join(tmpProvidersDir, 'secondary.json'), JSON.stringify(secondary));
  fs.writeFileSync(path.join(tmpProvidersDir, 'flaky.json'), JSON.stringify(flaky));
  fs.writeFileSync(path.join(tmpProvidersDir, 'anthropic.json'), JSON.stringify(anthropicStyle));
}

function startExpressServer() {
  return new Promise((resolve) => {
    expressServer = app.listen(0, '127.0.0.1', () => {
      expressPort = expressServer.address().port;
      resolve();
    });
  });
}

function jsonRequest(pathStr, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: expressPort, method: 'POST', path: pathStr,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      const chunkArr = [];
      res.on('data', (c) => chunkArr.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunkArr);
        const ct = res.headers['content-type'] || '';
        if (ct.includes('application/json')) {
          let parsed;
          try { parsed = JSON.parse(buf.toString()); } catch { parsed = buf.toString(); }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        } else {
          // Binary response
          resolve({ status: res.statusCode, headers: res.headers, body: buf, binary: true });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function multipartRequest(pathStr, form) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: expressPort, method: 'POST', path: pathStr,
      headers: form.getHeaders(),
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    form.pipe(req);
  });
}

async function testSpeechBinary() {
  lastSpeechRequest = null;
  const res = await jsonRequest('/v1/audio/speech', {
    model: 'tts-1', input: 'Hello world', voice: 'alloy',
    response_format: 'mp3', speed: 1.0,
  });
  const ok =
    res.status === 200 &&
    res.binary === true &&
    Buffer.isBuffer(res.body) &&
    res.body.length > 0 &&
    (res.headers['content-type'] || '').includes('audio/mpeg');
  record('speech: 200 + binary audio (mp3)', ok, `status=${res.status}, ct=${res.headers['content-type']}, bytes=${res.body && res.body.length}`);
  const forwarded =
    lastSpeechRequest &&
    lastSpeechRequest.model === 'tts-1' &&
    lastSpeechRequest.input === 'Hello world' &&
    lastSpeechRequest.voice === 'alloy' &&
    lastSpeechRequest.response_format === 'mp3' &&
    lastSpeechRequest.speed === 1.0;
  record('speech: params forwarded to provider', forwarded, `model=${lastSpeechRequest && lastSpeechRequest.model}, voice=${lastSpeechRequest && lastSpeechRequest.voice}`);
}

async function testSpeechJson() {
  const res = await jsonRequest('/v1/audio/speech', {
    model: 'tts-1', input: 'Hello', voice: 'alloy', response_format: 'json',
  });
  const ok =
    res.status === 200 &&
    !res.binary &&
    res.body && typeof res.body === 'object' && res.body.text === 'speech-json-audio';
  record('speech: json response_format -> JSON body', ok, `status=${res.status}`);
}

async function testSpeechVerboseJson() {
  const res = await jsonRequest('/v1/audio/speech', {
    model: 'tts-1', input: 'Hello', voice: 'alloy', response_format: 'verbose_json',
  });
  const ok =
    res.status === 200 &&
    res.body && res.body.task === 'text-to-speech';
  record('speech: verbose_json response_format -> JSON body', ok, `status=${res.status}`);
}

async function testTranscription() {
  lastTranscriptionRequest = null;
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('language', 'en');
  form.append('prompt', 'context for transcription');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  form.append('file', MP3_BYTES, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
  const res = await multipartRequest('/v1/audio/transcriptions', form);
  const ok =
    res.status === 200 &&
    res.body && typeof res.body === 'object' &&
    res.body.text === 'Hello world transcript';
  record('transcription: 200 + { text } response', ok, `status=${res.status}, text=${res.body && res.body.text}`);
  const forwarded =
    lastTranscriptionRequest &&
    lastTranscriptionRequest.model === 'whisper-1' &&
    lastTranscriptionRequest.language === 'en' &&
    lastTranscriptionRequest.prompt === 'context for transcription' &&
    lastTranscriptionRequest.response_format === 'json' &&
    lastTranscriptionRequest.temperature === '0' &&
    lastTranscriptionRequest.file === '[file]';
  record('transcription: params + file forwarded', forwarded, `model=${lastTranscriptionRequest && lastTranscriptionRequest.model}, lang=${lastTranscriptionRequest && lastTranscriptionRequest.language}`);
}

async function testTranslation() {
  lastTranslationRequest = null;
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('response_format', 'text');
  form.append('file', MP3_BYTES, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
  const res = await multipartRequest('/v1/audio/translations', form);
  const ok =
    res.status === 200 &&
    res.body && res.body.text === 'Translated to English';
  record('translation: 200 + { text } response', ok, `status=${res.status}`);
  const noLanguage = lastTranslationRequest && lastTranslationRequest.language === undefined;
  record('translation: language NOT sent (always English)', noLanguage, `language=${lastTranslationRequest && lastTranslationRequest.language}`);
}

async function testUnsupportedProvider() {
  lastSpeechRequest = null;
  const res = await jsonRequest('/v1/audio/speech', {
    model: 'claude-audio', input: 'hi', voice: 'alloy',
  });
  const ok =
    res.status === 400 &&
    res.body && res.body.error &&
    res.body.error.code === 'audio_not_supported' &&
    lastSpeechRequest === null;
  record('unsupported provider -> 400 audio_not_supported (no provider call)', ok, `status=${res.status}, code=${res.body && res.body.error && res.body.error.code}`);
}

async function testSpeechMissingModel() {
  const res = await jsonRequest('/v1/audio/speech', { input: 'hi', voice: 'alloy' });
  const ok = res.status === 400 && res.body.error && /model/.test(res.body.error.message);
  record('speech: missing model -> 400', ok, `status=${res.status}`);
}

async function testSpeechMissingInput() {
  const res = await jsonRequest('/v1/audio/speech', { model: 'tts-1', voice: 'alloy' });
  const ok = res.status === 400 && res.body.error && /input/.test(res.body.error.message);
  record('speech: missing input -> 400', ok, `status=${res.status}`);
}

async function testSpeechMissingVoice() {
  const res = await jsonRequest('/v1/audio/speech', { model: 'tts-1', input: 'hi' });
  const ok = res.status === 400 && res.body.error && /voice/.test(res.body.error.message);
  record('speech: missing voice -> 400', ok, `status=${res.status}`);
}

async function testSpeechBadFormat() {
  const res = await jsonRequest('/v1/audio/speech', {
    model: 'tts-1', input: 'hi', voice: 'alloy', response_format: 'ogg',
  });
  const ok = res.status === 400 && res.body.error && /response_format/.test(res.body.error.message);
  record('speech: bad response_format -> 400', ok, `status=${res.status}`);
}

async function testSpeechBadSpeed() {
  const res = await jsonRequest('/v1/audio/speech', {
    model: 'tts-1', input: 'hi', voice: 'alloy', speed: 10,
  });
  const ok = res.status === 400 && res.body.error && /speed/.test(res.body.error.message);
  record('speech: bad speed -> 400', ok, `status=${res.status}`);
}

async function testTranscriptionMissingFile() {
  const form = new FormData();
  form.append('model', 'whisper-1');
  const res = await multipartRequest('/v1/audio/transcriptions', form);
  const ok = res.status === 400 && res.body.error && /file/.test(res.body.error.message);
  record('transcription: missing file -> 400', ok, `status=${res.status}`);
}

async function testTranscriptionMissingModel() {
  const form = new FormData();
  form.append('file', MP3_BYTES, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
  const res = await multipartRequest('/v1/audio/transcriptions', form);
  const ok = res.status === 400 && res.body.error && /model/.test(res.body.error.message);
  record('transcription: missing model -> 400', ok, `status=${res.status}`);
}

async function testTranscriptionBadFormat() {
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('response_format', 'ogg');
  form.append('file', MP3_BYTES, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
  const res = await multipartRequest('/v1/audio/transcriptions', form);
  const ok = res.status === 400 && res.body.error && /response_format/.test(res.body.error.message);
  record('transcription: bad response_format -> 400', ok, `status=${res.status}`);
}

async function testTranscriptionBadTemperature() {
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('temperature', '2.5');
  form.append('file', MP3_BYTES, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
  const res = await multipartRequest('/v1/audio/transcriptions', form);
  const ok = res.status === 400 && res.body.error && /temperature/.test(res.body.error.message);
  record('transcription: bad temperature -> 400', ok, `status=${res.status}`);
}

async function testTranslationRejectsLanguage() {
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('language', 'fr');
  form.append('file', MP3_BYTES, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
  const res = await multipartRequest('/v1/audio/translations', form);
  const ok = res.status === 400 && res.body.error && /language/.test(res.body.error.message);
  record('translation: language field rejected -> 400', ok, `status=${res.status}`);
}

async function testStreamRejected() {
  const res = await jsonRequest('/v1/audio/speech', {
    model: 'tts-1', input: 'hi', voice: 'alloy', stream: true,
  });
  const ok = res.status === 400 && res.body.error && /stream/i.test(res.body.error.message);
  record('stream:true rejected with 400 (audio never streams)', ok, `status=${res.status}`);
}

async function testUnknownModel() {
  const res = await jsonRequest('/v1/audio/speech', {
    model: 'no-such-model', input: 'hi', voice: 'alloy',
  });
  const ok = res.status === 404 && res.body.error && res.body.error.code === 'model_not_found';
  record('unknown model -> 404 model_not_found', ok, `status=${res.status}, code=${res.body && res.body.error && res.body.error.code}`);
}

async function testRetryOnTransientFailure() {
  providerBehavior.flaky = { failTimes: 1, failStatus: 503 };
  const res = await jsonRequest('/v1/audio/speech', {
    model: 'flaky-audio', input: 'hi', voice: 'alloy',
  });
  const ok = res.status === 200 && res.binary && Buffer.isBuffer(res.body);
  record('retry on transient 503 -> 200', ok, `status=${res.status}`);
  delete providerBehavior.flaky;
}

async function testFallbackToSecondaryProvider() {
  providerBehavior.primary = { failTimes: 99, failStatus: 503 };
  const res = await jsonRequest('/v1/audio/speech', {
    model: 'shared-audio', input: 'hi', voice: 'alloy',
  });
  const ok = res.status === 200 && res.binary && Buffer.isBuffer(res.body);
  record('fallback to secondary provider -> 200', ok, `status=${res.status}`);
  delete providerBehavior.primary;
  const { apiKeyManager } = require('../src/services');
  apiKeyManager.enableKey('primary', 'primary-key');
}

async function testBareStringNormalization() {
  // Provider returns a bare string instead of { text }
  providerBehavior.primary = { responseShape: 'bareString' };
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('file', MP3_BYTES, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
  const res = await multipartRequest('/v1/audio/transcriptions', form);
  delete providerBehavior.primary;
  const ok =
    res.status === 200 &&
    res.body && res.body.text === 'Hello world transcript';
  record('bare-string transcript normalized to { text }', ok, `status=${res.status}, text=${res.body && res.body.text}`);
  const { apiKeyManager } = require('../src/services');
  apiKeyManager.enableKey('primary', 'primary-key');
}

async function testOpenAICompatibility() {
  const res = await jsonRequest('/v1/audio/speech', {
    model: 'tts-1', input: 'compatibility test', voice: 'alloy', response_format: 'mp3',
  });
  const ok =
    res.status === 200 &&
    res.binary &&
    Buffer.isBuffer(res.body) &&
    (res.headers['content-type'] || '').includes('audio/');
  record('OpenAI-compatible speech binary response', ok, `status=${res.status}, ct=${res.headers['content-type']}`);
}

async function testChatCompletionsStillWorks() {
  const res = await jsonRequest('/v1/chat/completions', {
    model: 'tts-1',
    messages: [{ role: 'user', content: 'Hi' }],
  });
  const ok = res.status === 200 && res.body.object === 'chat.completion';
  record('chat completions still works', ok, `status=${res.status}`);
}

async function testImagesStillWorks() {
  const res = await jsonRequest('/v1/images/generations', {
    model: 'tts-1', prompt: 'a cat',
  });
  const ok = res.status === 200 && Array.isArray(res.body.data);
  record('images still works', ok, `status=${res.status}`);
}

async function testModelsEndpointStillWorks() {
  const res = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: expressPort, path: '/v1/models' }, (r) => {
      let c = ''; r.on('data', (d) => (c += d)); r.on('end', () => resolve({ status: r.statusCode, body: c }));
    }).on('error', reject);
  });
  const ok = res.status === 200;
  record('GET /v1/models still works', ok, `status=${res.status}`);
}

async function main() {
  console.log('=== Audio API Integration Tests ===\n');
  await startMockProvider();
  writeProviderConfigs();

  const { providerManager, apiKeyManager } = require('../src/services');
  providerManager.load(tmpProvidersDir);
  apiKeyManager.load(providerManager.listProviders());

  await startExpressServer();

  try {
    await testSpeechBinary();
    await testSpeechJson();
    await testSpeechVerboseJson();
    await testTranscription();
    await testTranslation();
    await testUnsupportedProvider();
    await testSpeechMissingModel();
    await testSpeechMissingInput();
    await testSpeechMissingVoice();
    await testSpeechBadFormat();
    await testSpeechBadSpeed();
    await testTranscriptionMissingFile();
    await testTranscriptionMissingModel();
    await testTranscriptionBadFormat();
    await testTranscriptionBadTemperature();
    await testTranslationRejectsLanguage();
    await testStreamRejected();
    await testUnknownModel();
    await testRetryOnTransientFailure();
    await testFallbackToSecondaryProvider();
    await testBareStringNormalization();
    await testOpenAICompatibility();
    await testChatCompletionsStillWorks();
    await testImagesStillWorks();
    await testModelsEndpointStillWorks();
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
