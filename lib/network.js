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
      maxSockets: 32,
      maxFreeSockets: 10,
      timeout: 60000,
      keepAliveMsecs: 30000
    });
  }
  return sharedAgent;
}

function fetchTtsChunk(text, options, retries = 3) {
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
            const waitTime = (4 - remainingAttempts) * 800 + Math.floor(Math.random() * 400);
            setTimeout(() => attempt(remainingAttempts - 1), waitTime);
          } else {
            reject(new Error(`API Error (${res.statusCode}): ${buffer.toString()}`));
          }
        });
      });

      req.on('error', err => {
        if (remainingAttempts > 0) {
          setTimeout(() => attempt(remainingAttempts - 1), 800);
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

