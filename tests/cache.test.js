const assert = require('assert');
const { AudioCache } = require('../lib/cache');

function testCacheOperations() {
  const cache = new AudioCache({ maxSizeBytes: 1000 }); // 1KB test
  const p1 = { text: 'Hello', voice: 'v1', format: 'wav' };
  const b1 = Buffer.alloc(400);

  assert.strictEqual(cache.get(p1), null, 'Ban đầu phải cache miss');
  cache.set(p1, b1);
  assert.strictEqual(cache.get(p1).length, 400, 'Phải cache hit sau khi set');

  // Kiểm tra eviction khi đầy
  const p2 = { text: 'World', voice: 'v1', format: 'wav' };
  const b2 = Buffer.alloc(800);
  cache.set(p2, b2); // Tổng 400 + 800 = 1200 > 1000, p1 phải bị evict

  assert.strictEqual(cache.get(p1), null, 'p1 phải bị đẩy ra khỏi cache');
  assert.strictEqual(cache.get(p2).length, 800, 'p2 phải tồn tại trong cache');
  console.log('✅ testCacheOperations passed');
}

testCacheOperations();

