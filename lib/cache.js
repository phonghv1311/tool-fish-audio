/**
 * lib/cache.js
 * Quản lý bộ nhớ đệm In-Memory LRU Cache an toàn cho Audio Buffers
 */

const crypto = require('crypto');

class AudioCache {
  constructor(options = {}) {
    this.maxSizeBytes = options.maxSizeBytes || 150 * 1024 * 1024; // Mặc định 150MB
    this.cache = new Map(); // key -> { buffer, size, accessedAt }
    this.currentSizeBytes = 0;
    this.hits = 0;
    this.misses = 0;
  }

  generateKey(params) {
    const payload = JSON.stringify({
      text: (params.text || '').trim(),
      voice: params.voice || '',
      model: params.model || 's2.1-pro-free',
      format: params.format || 'wav',
      speed: params.speed || 1.0,
      volume: params.volume || 0
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  get(params) {
    const key = this.generateKey(params);
    const item = this.cache.get(key);
    if (!item) {
      this.misses++;
      return null;
    }
    this.hits++;
    item.accessedAt = Date.now();
    // Re-insert để duy trì thứ tự LRU (cuối cùng là mới nhất)
    this.cache.delete(key);
    this.cache.set(key, item);
    return item.buffer;
  }

  set(params, buffer) {
    if (!buffer || !Buffer.isBuffer(buffer)) return;
    const key = this.generateKey(params);
    const itemSize = buffer.length;

    if (itemSize > this.maxSizeBytes) return;

    // Giải phóng mục cũ nhất theo LRU nếu vượt ngưỡng
    while (this.currentSizeBytes + itemSize > this.maxSizeBytes && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value;
      const oldestItem = this.cache.get(oldestKey);
      this.currentSizeBytes -= oldestItem.size;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      buffer,
      size: itemSize,
      accessedAt: Date.now()
    });
    this.currentSizeBytes += itemSize;
  }

  getStats() {
    return {
      itemsCount: this.cache.size,
      currentSizeMB: (this.currentSizeBytes / (1024 * 1024)).toFixed(2),
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0
        ? ((this.hits / (this.hits + this.misses)) * 100).toFixed(1) + '%'
        : '0%'
    };
  }

  clear() {
    this.cache.clear();
    this.currentSizeBytes = 0;
  }
}

// Singleton global cache
const globalAudioCache = new AudioCache();

module.exports = { AudioCache, globalAudioCache };

