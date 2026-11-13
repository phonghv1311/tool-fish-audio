/**
 * lib/network.js
 * Quản lý kết nối HTTP Keep-Alive Agent Connection Pool, Multi-API Key Pool & Failover
 */

const https = require('https');

let sharedAgent = null;

function getKeepAliveAgent() {
  if (!sharedAgent) {
    sharedAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 128,      // Nâng từ 32 lên 128 để giải tỏa nghẽn khi chạy 20-40 luồng song song
      maxFreeSockets: 32,
      timeout: 120000,     // 2 phút timeout cho các batch xử lý văn bản cực lớn
      keepAliveMsecs: 60000
    });
  }
  return sharedAgent;
}

/**
 * Multi-API Key Pool:
 * Phân bổ tải Round-Robin giữa nhiều API Key.
 * Tự động cách ly key dính Rate Limit 429 (Cooldown) và failover sang key khác ngay tức khắc.
 */
class ApiKeyPool {
  constructor(keys = []) {
    this.keys = [];
    this.keyState = new Map(); // key -> { cooldownUntil, failCount, successCount }
    this.index = 0;
    this.setKeys(keys);
  }

  setKeys(keys) {
    let list = [];
    if (typeof keys === 'string') {
      list = keys.split(/[\n,;]+/).map(k => k.trim()).filter(Boolean);
    } else if (Array.isArray(keys)) {
      list = keys.map(k => (typeof k === 'string' ? k.trim() : '')).filter(Boolean);
    }
    const unique = Array.from(new Set(list));
    this.keys = unique.length > 0 ? unique : [];
    for (const k of this.keys) {
      if (!this.keyState.has(k)) {
        this.keyState.set(k, { cooldownUntil: 0, failCount: 0, successCount: 0 });
      }
    }
  }

  hasKeys() {
    return this.keys.length > 0;
  }

  getKeyCount() {
    return this.keys.length;
  }

  getNextKey() {
    if (this.keys.length === 0) return null;
    const now = Date.now();
    const count = this.keys.length;

    // Ưu tiên key sẵn sàng (không cooldown)
    for (let i = 0; i < count; i++) {
      const idx = (this.index + i) % count;
      const key = this.keys[idx];
      const state = this.keyState.get(key) || { cooldownUntil: 0 };
      if (state.cooldownUntil <= now) {
        this.index = (idx + 1) % count;
        return key;
      }
    }

    // Nếu tất cả đang cooldown, chọn key có thời gian chờ ngắn nhất
    let earliestKey = this.keys[0];
    let earliestTime = (this.keyState.get(earliestKey) || {}).cooldownUntil || 0;
    for (let i = 1; i < count; i++) {
      const k = this.keys[i];
      const time = (this.keyState.get(k) || {}).cooldownUntil || 0;
      if (time < earliestTime) {
        earliestTime = time;
        earliestKey = k;
      }
    }
    return earliestKey;
  }

  reportSuccess(key) {
    const st = this.keyState.get(key);
    if (st) {
      st.failCount = 0;
      st.cooldownUntil = 0;
      st.successCount++;
    }
  }

  reportRateLimit(key, cooldownMs = 4000) {
    const st = this.keyState.get(key);
    if (st) {
      st.failCount++;
      const wait = Math.min(cooldownMs * Math.pow(1.5, Math.min(st.failCount, 4)), 30000);
      st.cooldownUntil = Date.now() + wait;
    }
  }

  getStats() {
    const now = Date.now();
    let readyCount = 0;
    let coolingCount = 0;
    for (const k of this.keys) {
      const st = this.keyState.get(k);
      if (st && st.cooldownUntil > now) {
        coolingCount++;
      } else {
        readyCount++;
      }
    }
    return {
      totalKeys: this.keys.length,
      readyKeys: readyCount,
      coolingKeys: coolingCount
    };
  }
}

function fetchTtsChunk(text, options, retries = 5) {
  return new Promise((resolve, reject) => {
    function attempt(remainingAttempts) {
      // Lựa chọn API Key từ KeyPool hoặc từ options.apiKey
      let currentKey = options.apiKey;
      if (options.keyPool && options.keyPool.hasKeys()) {
        currentKey = options.keyPool.getNextKey() || options.apiKey;
      }

      const requestBody = {
        text: text,
        format: options.format || 'wav',
        latency: 'balanced',
        prosody: {
          speed: options.speed || 1.0,
          volume: options.volume || 0
        }
      };

      if (options.format === 'mp3') {
        requestBody.mp3_bitrate = 128;
      }

      if (options.voice) {
        requestBody.reference_id = options.voice;
      }

      const postData = JSON.stringify(requestBody);

      const req = https.request({
        hostname: 'api.fish.audio',
        port: 443,
        path: '/v1/tts',
        method: 'POST',
        agent: getKeepAliveAgent(), // Tái sử dụng socket ấm
        headers: {
          'Authorization': `Bearer ${currentKey}`,
          'Content-Type': 'application/json',
          'model': options.model || 's2.1-pro-free',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            if (options.keyPool) options.keyPool.reportSuccess(currentKey);
            resolve(buffer);
          } else if (res.statusCode === 429 && remainingAttempts > 0) {
            // Key dính 429: Báo cho pool biết để cooldown và đổi key khác ngay
            if (options.keyPool) options.keyPool.reportRateLimit(currentKey, 4000);
            const waitTime = (options.keyPool && options.keyPool.getStats().readyKeys > 0)
              ? 50 // Có sẵn key khác rảnh rỗi: Thử lại ngay lập tức với key mới!
              : 2000 + Math.floor(Math.random() * 1000);
            setTimeout(() => attempt(remainingAttempts - 1), waitTime);
          } else if (res.statusCode >= 500 && remainingAttempts > 0) {
            const factor = Math.max(1, 6 - remainingAttempts);
            const waitTime = Math.min(1000 * Math.pow(1.5, factor), 6000) + Math.floor(Math.random() * 500);
            setTimeout(() => attempt(remainingAttempts - 1), waitTime);
          } else {
            reject(new Error(`API Error (${res.statusCode}): ${buffer.toString()}`));
          }
        });
      });

      req.on('error', err => {
        if (remainingAttempts > 0) {
          const waitTime = 1000 + Math.floor(Math.random() * 500);
          setTimeout(() => attempt(remainingAttempts - 1), waitTime);
        } else {
          reject(err);
        }
      });

      req.write(postData);
      req.end();
    }

    attempt(retries);
  });
}

module.exports = { getKeepAliveAgent, ApiKeyPool, fetchTtsChunk };
