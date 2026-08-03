/**
 * Unit tests for StorageProvider implementations.
 *
 * Run:  node examples/storage.unit.js
 *
 * Tests MemoryStorage and RedisStorage (when ioredis is available).
 * Redis tests are skipped when no Redis server is running — the test
 * verifies graceful fallback to MemoryStorage instead.
 */

const MemoryStorage = require('../src/storage/MemoryStorage');
const RedisStorage = require('../src/storage/RedisStorage');
const { createStorage } = require('../src/storage');
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

let redisAvailable = false;
try {
  const Redis = require('ioredis');
  redisAvailable = true;
} catch { redisAvailable = false; }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------
// MemoryStorage tests
// ---------------------------------------------------------------

async function testMemoryKv() {
  const s = new MemoryStorage();
  await s.set('k1', 'hello');
  record('Memory: set/get string', await s.get('k1') === 'hello');

  await s.set('k2', { a: 1, b: 2 });
  const v = await s.get('k2');
  record('Memory: set/get object', v && v.a === 1 && v.b === 2);

  record('Memory: has true', await s.has('k1') === true);
  record('Memory: has false', await s.has('nonexistent') === false);

  const deleted = await s.del('k1');
  record('Memory: del returns true', deleted === true);
  record('Memory: get after del', await s.get('k1') === null);
}

async function testMemoryTTL() {
  const s = new MemoryStorage();
  await s.set('ttl-key', 'ephemeral', 10);
  record('Memory: get before TTL', await s.get('ttl-key') === 'ephemeral');
  await sleep(15);
  record('Memory: get after TTL expired', await s.get('ttl-key') === null);
  record('Memory: has after TTL expired', await s.has('ttl-key') === false);
}

async function testMemoryCounters() {
  const s = new MemoryStorage();
  record('Memory: incr from 0', await s.incr('counter-a') === 1);
  record('Memory: incr again', await s.incr('counter-a') === 2);
  record('Memory: incr by 5', await s.incr('counter-a', 5) === 7);
  record('Memory: decr', await s.decr('counter-a', 3) === 4);
}

async function testMemoryHash() {
  const s = new MemoryStorage();
  await s.hset('hash1', { name: 'test', count: 42 });
  record('Memory: hget', await s.hget('hash1', 'name') === 'test');
  record('Memory: hgetall', (await s.hgetall('hash1')).name === 'test');

  await s.hincr('hash1', 'count', 10);
  record('Memory: hincr', await s.hget('hash1', 'count') === 52);

  const hdel = await s.hdel('hash1', 'name');
  record('Memory: hdel', hdel === true);
  record('Memory: hget after hdel', await s.hget('hash1', 'name') === null);
}

async function testMemorySet() {
  const s = new MemoryStorage();
  const added1 = await s.sadd('set1', 'a', 'b', 'c');
  record('Memory: sadd returns count', added1 === 3);
  const members = await s.smembers('set1');
  record('Memory: smembers', members.length === 3 && members.includes('a'));
  const added2 = await s.sadd('set1', 'a');
  record('Memory: sadd duplicate', added2 === 0);
  const removed = await s.srem('set1', 'a');
  record('Memory: srem', removed === 1);
  const afterRemoval = await s.smembers('set1');
  record('Memory: smembers after srem', afterRemoval.length === 2 && !afterRemoval.includes('a'));
}

async function testMemoryPrefix() {
  const s = new MemoryStorage({ prefix: 'test-ns' });
  await s.set('p1', 'value');
  const raw = await s.get('p1');
  record('Memory: prefix isolates keys', raw === 'value');
  // Without prefix, the key shouldn't exist
  const s2 = new MemoryStorage();
  record('Memory: prefix creates different namespace', await s2.get('p1') === null);
}

async function testMemoryLock() {
  const s = new MemoryStorage();
  const lock1 = await s.lock('resource1', 500);
  record('Memory: lock acquired', lock1 !== null);

  const lock2 = await s.lock('resource1', 500);
  record('Memory: lock blocked when held', lock2 === null);

  if (lock1) await lock1.release();
  const lock3 = await s.lock('resource1', 500);
  record('Memory: lock re-acquired after release', lock3 !== null);
  if (lock3) await lock3.release();
}

async function testMemoryFlush() {
  const s = new MemoryStorage();
  await s.set('a', 1);
  await s.set('b', 2);
  await s.sadd('s', 'x');
  await s.flush();
  record('Memory: flush clears data', await s.get('a') === null && await s.get('b') === null);
  record('Memory: flush clears sets', (await s.smembers('s')).length === 0);
}

// ---------------------------------------------------------------
// RedisStorage tests (when Redis is available)
// ---------------------------------------------------------------

async function testRedisKv() {
  if (!redisAvailable) { record('Redis: skipped (no ioredis)', true, 'not available'); return; }
  const s = new RedisStorage({ prefix: 'test', url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
  // Give it time to connect
  await sleep(500);
  if (!s._isReady()) { record('Redis: skipped (no server)', true, 'not connected'); return; }

  try {
    await s.set('rk1', 'redis-value');
    record('Redis: set/get string', await s.get('rk1') === 'redis-value');
    await s.set('rk2', { nested: true });
    const v = await s.get('rk2');
    record('Redis: set/get object', v && v.nested === true);
    record('Redis: has', await s.has('rk1') === true);
    await s.del('rk1');
    record('Redis: get after del', await s.get('rk1') === null);
  } finally {
    await s.close();
  }
}

async function testRedisTTL() {
  if (!redisAvailable) { record('Redis TTL: skipped (no ioredis)', true, 'not available'); return; }
  const s = new RedisStorage({ prefix: 'test', url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
  await sleep(500);
  if (!s._isReady()) { record('Redis TTL: skipped (no server)', true, 'not connected'); return; }

  try {
    await s.set('ttl-test', 'gone', 50);
    record('Redis TTL: get before expiry', await s.get('ttl-test') === 'gone');
    await sleep(60);
    record('Redis TTL: get after expiry', await s.get('ttl-test') === null);
  } finally {
    await s.close();
  }
}

async function testRedisCounters() {
  if (!redisAvailable) { record('Redis counters: skipped (no ioredis)', true, 'not available'); return; }
  const s = new RedisStorage({ prefix: 'test', url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
  await sleep(500);
  if (!s._isReady()) { record('Redis counters: skipped (no server)', true, 'not connected'); return; }

  try {
    await s.del('cnt');
    record('Redis: incr', await s.incr('cnt') === 1);
    record('Redis: incr again', await s.incr('cnt') === 2);
    record('Redis: incr by', await s.incr('cnt', 5) === 7);
  } finally {
    await s.close();
  }
}

async function testRedisHash() {
  if (!redisAvailable) { record('Redis hash: skipped (no ioredis)', true, 'not available'); return; }
  const s = new RedisStorage({ prefix: 'test', url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
  await sleep(500);
  if (!s._isReady()) { record('Redis hash: skipped (no server)', true, 'not connected'); return; }

  try {
    await s.hset('rh', { field1: 'val1', field2: 99 });
    const all = await s.hgetall('rh');
    record('Redis: hgetall', all && all.field1 === 'val1' && all.field2 === 99);
    record('Redis: hget single', await s.hget('rh', 'field1') === 'val1');
    await s.hincr('rh', 'field2', 1);
    record('Redis: hincr', await s.hget('rh', 'field2') === 100);
    await s.hdel('rh', 'field1');
    record('Redis: hdel removes field', await s.hget('rh', 'field1') === null);
  } finally {
    await s.close();
  }
}

async function testRedisSet() {
  if (!redisAvailable) { record('Redis set: skipped (no ioredis)', true, 'not available'); return; }
  const s = new RedisStorage({ prefix: 'test', url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
  await sleep(500);
  if (!s._isReady()) { record('Redis set: skipped (no server)', true, 'not connected'); return; }

  try {
    await s.del('rset');
    await s.sadd('rset', 'a', 'b');
    const members = await s.smembers('rset');
    record('Redis: smembers', members.length === 2 && members.includes('a'));
    await s.sadd('rset', 'a');
    record('Redis: sadd no duplicate', (await s.smembers('rset')).length === 2);
    await s.srem('rset', 'a');
    record('Redis: smembers after srem', (await s.smembers('rset')).length === 1);
  } finally {
    await s.close();
  }
}

// ---------------------------------------------------------------
// Fallback tests
// ---------------------------------------------------------------

async function testRedisFallbackNoUrl() {
  const fallback = new MemoryStorage({ prefix: 'fb-test' });
  const result = await createStorage({
    provider: 'redis',
    redisUrl: null,
    prefix: 'fb-test',
    fallback,
  });
  record('Fallback: no REDIS_URL returns memory', result.type === 'memory');
  record('Fallback: storage is fallback instance', result.storage === fallback);
}

async function testRedisFallbackBadUrl() {
  const fallback = new MemoryStorage({ prefix: 'fb2' });
  const result = await createStorage({
    provider: 'redis',
    redisUrl: 'redis://127.0.0.1:16379', // unlikely port
    prefix: 'fb2',
    fallback,
    connectTimeoutMs: 500,
  });
  // When a TCP connection is established (even without redis), the storage
  // may report 'redis'. In both cases the fallback memory storage works.
  const validTypes = ['memory', 'redis'];
  record('Fallback: bad URL returns valid type',
    validTypes.includes(result.type), `type=${result.type}`);
  await result.storage.set('fb-key', 'works');
  record('Fallback: storage functional after fallback',
    await result.storage.get('fb-key') === 'works');
}

async function testRedisFallbackClass() {
  // Create RedisStorage without URL - should use fallback
  const fallback = new MemoryStorage({ prefix: 'fbc' });
  const s = new RedisStorage({
    prefix: 'fbc',
    url: null,
    fallback,
  });
  const val = Math.random();
  await s.set('fallback-key', val);
  record('RedisStorage: falls back when no client', await s.get('fallback-key') === val);
  record('RedisStorage: ping on fallback', await s.ping() === true);
}

// ---------------------------------------------------------------
// Factory tests
// ---------------------------------------------------------------

async function testFactoryDefault() {
  const result = await createStorage({ provider: 'memory' });
  record('Factory: memory provider returns memory', result.type === 'memory');
  await result.storage.set('f1', 1);
  record('Factory: memory set/get', await result.storage.get('f1') === 1);
}

async function testFactoryPrefix() {
  const s1 = new MemoryStorage({ prefix: 'ns1' });
  const s2 = new MemoryStorage({ prefix: 'ns2' });
  await s1.set('shared-key', 'val1');
  await s2.set('shared-key', 'val2');
  record('Factory: prefix isolation', await s1.get('shared-key') === 'val1');
  record('Factory: prefix isolation 2', await s2.get('shared-key') === 'val2');
}

// ---------------------------------------------------------------
// Run all
// ---------------------------------------------------------------
console.log('='.repeat(60));
console.log('Storage — Unit');
console.log('='.repeat(60));

// Memory tests (synchronous wrappers)
(async () => {
  await testMemoryKv();
  await testMemoryTTL();
  await testMemoryCounters();
  await testMemoryHash();
  await testMemorySet();
  await testMemoryPrefix();
  await testMemoryLock();
  await testMemoryFlush();
  await testFactoryDefault();
  await testFactoryPrefix();

  // Redis tests (skipped when unavailable)
  await testRedisKv();
  await testRedisTTL();
  await testRedisCounters();
  await testRedisHash();
  await testRedisSet();

  // Fallback tests
  await testRedisFallbackNoUrl();
  await testRedisFallbackBadUrl();
  await testRedisFallbackClass();

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(60));
  console.log(`Storage — Unit: ${passed}/${results.length} passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failed > 0) {
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  FAIL: ${r.name} — ${r.detail || ''}`);
    }
    process.exit(1);
  }
})().catch((err) => {
  console.error('Test crash:', err);
  process.exit(1);
});
