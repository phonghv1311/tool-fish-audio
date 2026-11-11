/**
 * lib/network.js
 * Quản lý kết nối HTTP Keep-Alive Agent Connection Pool và gọi API Fish Audio
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

function fetchTtsChunk(text, options, retries = 5) {
  return new Promise((resolve, reject) => {
    function attempt(remainingAttempts) {
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
          'Authorization': `Bearer ${options.apiKey}`,
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
            resolve(buffer);
          } else if ((res.statusCode === 429 || res.statusCode >= 500) && remainingAttempts > 0) {
            // Exponential Backoff + Jitter để chống nghẽn Rate Limit 429 khi chạy nhiều luồng
            const factor = Math.max(1, 6 - remainingAttempts);
            const baseWait = Math.min(1000 * Math.pow(1.6, factor), 8000);
            const jitter = Math.floor(Math.random() * 500);
            const waitTime = baseWait + jitter;
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

module.exports = { getKeepAliveAgent, fetchTtsChunk };

