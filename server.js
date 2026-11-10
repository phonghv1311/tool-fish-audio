/**
 * Fish Audio Web Application Server
 * Built with native Node.js (Zero external dependencies)
 * Hỗ trợ xuất âm thanh đơn, xuất full bài WAV/MP3 chuẩn RIFF PCM và phụ đề SRT đồng bộ.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const INITIAL_PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_API_KEY = process.env.FISH_API_KEY || 'sk-fish-XCsvD6WOqXziDuBmyCXUD-lDIujXF9aB2-dIysL4IyY';

// MIME types for static files
const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.opus': 'audio/opus',
  '.srt': 'text/plain; charset=UTF-8'
};

/**
 * Send JSON response
 */
function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=UTF-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, model'
  });
  res.end(body);
}

/**
 * Phân tách văn bản dài thành các câu tự nhiên
 */
function splitTextIntoSentences(text, maxChunkLen = 220) {
  const paragraphs = text.split(/\n+/);
  const chunks = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    const rawSentences = trimmed.match(/[^.!?…;]+[.!?…;]+|[^.!?…;]+$/g) || [trimmed];
    let current = '';

    for (const raw of rawSentences) {
      const sentence = raw.trim();
      if (!sentence) continue;

      if ((current + ' ' + sentence).trim().length <= maxChunkLen) {
        current = (current + ' ' + sentence).trim();
      } else {
        if (current) chunks.push(current);
        if (sentence.length > maxChunkLen) {
          const parts = sentence.match(new RegExp(`.{1,${maxChunkLen}}(\\s+|$)|.{1,${maxChunkLen}}`, 'g')) || [sentence];
          for (const p of parts) {
            if (p.trim()) chunks.push(p.trim());
          }
          current = '';
        } else {
          current = sentence;
        }
      }
    }

    if (current) chunks.push(current);
  }

  return chunks;
}

/**
 * Tạo chuẩn 44-byte WAV header cho luồng PCM
 */
function createWavHeader(dataLength, sampleRate = 44100, numChannels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);

  return buffer;
}

/**
 * Trích xuất raw PCM và thông số từ buffer WAV trả về từ Fish Audio
 */
function extractPcmFromWav(wavBuffer) {
  let dataIndex = wavBuffer.indexOf(Buffer.from('data'));
  let sampleRate = 44100;
  let numChannels = 1;
  let bitsPerSample = 16;

  if (wavBuffer.length >= 36) {
    numChannels = wavBuffer.readUInt16LE(22) || 1;
    sampleRate = wavBuffer.readUInt32LE(24) || 44100;
    bitsPerSample = wavBuffer.readUInt16LE(34) || 16;
  }

  let pcmData;
  if (dataIndex !== -1 && dataIndex + 8 <= wavBuffer.length) {
    pcmData = wavBuffer.slice(dataIndex + 8);
  } else {
    pcmData = wavBuffer.slice(44);
  }

  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const durationSec = byteRate > 0 ? pcmData.length / byteRate : 0;

  return { pcmData, sampleRate, numChannels, bitsPerSample, byteRate, durationSec };
}

/**
 * Định dạng số giây sang chuẩn SRT (HH:MM:SS,mmm)
 */
function formatSrtTime(totalSeconds) {
  const pad = (n, width) => String(n).padStart(width, '0');
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const milliseconds = Math.floor((totalSeconds % 1) * 1000);

  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(milliseconds, 3)}`;
}

/**
 * Gọi đơn lẻ 1 chunk TTS từ Fish Audio kèm cơ chế Retry khi gặp 429
 */
function fetchSingleTTS(text, opts, retries = 3) {
  return new Promise((resolve, reject) => {
    function attempt(remainingAttempts) {
      const requestBody = {
        text: text,
        format: opts.format || 'wav',
        latency: 'balanced',
        prosody: {
          speed: opts.speed || 1.0,
          volume: opts.volume || 0
        }
      };

      if (opts.format === 'mp3') {
        requestBody.mp3_bitrate = 128;
      }

      if (opts.voice) {
        requestBody.reference_id = opts.voice;
      }

      const postData = JSON.stringify(requestBody);

      const apiOptions = {
        hostname: 'api.fish.audio',
        port: 443,
        path: '/v1/tts',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
          'model': opts.model || 's2.1-pro-free',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(apiOptions, res => {
        const dataChunks = [];
        res.on('data', c => dataChunks.push(c));
        res.on('end', () => {
          const fullBuffer = Buffer.concat(dataChunks);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(fullBuffer);
          } else if ((res.statusCode === 429 || res.statusCode >= 500) && remainingAttempts > 0) {
            const waitTime = (4 - remainingAttempts) * 800 + Math.floor(Math.random() * 400);
            setTimeout(() => attempt(remainingAttempts - 1), waitTime);
          } else {
            reject(new Error(`API Error (${res.statusCode}): ${fullBuffer.toString()}`));
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

/**
 * Xử lý song song N luồng bảo toàn thứ tự kết quả
 */
async function processConcurrently(items, concurrency, workerFn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) break;
      results[currentIndex] = await workerFn(items[currentIndex], currentIndex);
    }
  }

  const threadCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: threadCount }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Handle TTS generation proxy (Đơn lẻ)
 */
function handleTTS(req, res) {
  let body = '';
  const MAX_SIZE = 5 * 1024 * 1024; // 5MB limit

  req.on('data', chunk => {
    body += chunk;
    if (body.length > MAX_SIZE) {
      sendJSON(res, 413, { error: 'Payload quá lớn (Tối đa 5MB)' });
      req.destroy();
    }
  });

  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch (e) {
      return sendJSON(res, 400, { error: 'JSON payload không hợp lệ' });
    }

    if (!payload.text || typeof payload.text !== 'string' || !payload.text.trim()) {
      return sendJSON(res, 400, { error: 'Vui lòng cung cấp nội dung văn bản (text).' });
    }

    const apiKey = (payload.apiKey && payload.apiKey.trim()) ? payload.apiKey.trim() : DEFAULT_API_KEY;
    const model = payload.model || 's2.1-pro-free';

    const requestBody = {
      text: payload.text.trim(),
      format: payload.format || 'mp3'
    };

    if (payload.reference_id && payload.reference_id.trim()) {
      requestBody.reference_id = payload.reference_id.trim();
    }

    if (payload.mp3_bitrate && requestBody.format === 'mp3') {
      requestBody.mp3_bitrate = parseInt(payload.mp3_bitrate, 10);
    }

    if (payload.prosody && typeof payload.prosody === 'object') {
      requestBody.prosody = {
        speed: typeof payload.prosody.speed === 'number' ? payload.prosody.speed : 1.0,
        volume: typeof payload.prosody.volume === 'number' ? payload.prosody.volume : 0
      };
    }

    if (payload.latency) requestBody.latency = payload.latency;
    if (typeof payload.normalize === 'boolean') requestBody.normalize = payload.normalize;
    if (typeof payload.temperature === 'number') requestBody.temperature = payload.temperature;
    if (typeof payload.top_p === 'number') requestBody.top_p = payload.top_p;

    const postData = JSON.stringify(requestBody);

    const apiOptions = {
      hostname: 'api.fish.audio',
      port: 443,
      path: '/v1/tts',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'model': model,
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const apiReq = https.request(apiOptions, apiRes => {
      const contentType = apiRes.headers['content-type'] || (requestBody.format === 'wav' ? 'audio/wav' : 'audio/mpeg');
      const statusCode = apiRes.statusCode;

      if (statusCode >= 200 && statusCode < 300) {
        res.writeHead(statusCode, {
          'Content-Type': contentType,
          'Content-Disposition': `inline; filename="speech.${requestBody.format}"`,
          'Access-Control-Allow-Origin': '*'
        });
        apiRes.pipe(res);
      } else {
        let errBody = '';
        apiRes.on('data', chunk => { errBody += chunk; });
        apiRes.on('end', () => {
          let parsedErr;
          try {
            parsedErr = JSON.parse(errBody);
          } catch (e) {
            parsedErr = { raw: errBody };
          }
          sendJSON(res, statusCode, {
            error: `Fish Audio API error (${statusCode})`,
            details: parsedErr
          });
        });
      }
    });

    apiReq.on('error', err => {
      console.error('Lỗi khi gọi Fish Audio TTS:', err);
      sendJSON(res, 502, { error: 'Không thể kết nối tới Fish Audio API', details: err.message });
    });

    apiReq.write(postData);
    apiReq.end();
  });
}

/**
 * Handle Batch Full Bài & SRT generation proxy
 */
function handleBatchTTS(req, res) {
  let body = '';
  const MAX_SIZE = 10 * 1024 * 1024; // 10MB limit

  req.on('data', chunk => {
    body += chunk;
    if (body.length > MAX_SIZE) {
      sendJSON(res, 413, { error: 'Payload quá lớn (Tối đa 10MB)' });
      req.destroy();
    }
  });

  req.on('end', async () => {
    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch (e) {
      return sendJSON(res, 400, { error: 'JSON payload không hợp lệ' });
    }

    const text = (payload.text || '').trim();
    if (!text) {
      return sendJSON(res, 400, { error: 'Vui lòng cung cấp nội dung văn bản (text).' });
    }

    const format = (payload.format || 'wav').toLowerCase();
    const apiKey = (payload.apiKey && payload.apiKey.trim()) ? payload.apiKey.trim() : DEFAULT_API_KEY;
    const model = payload.model || 's2.1-pro-free';
    const voice = payload.reference_id ? payload.reference_id.trim() : '';
    const speed = payload.prosody && typeof payload.prosody.speed === 'number' ? payload.prosody.speed : 1.0;
    const volume = payload.prosody && typeof payload.prosody.volume === 'number' ? payload.prosody.volume : 0;
    const chunkSize = payload.chunkSize || 220;

    const chunks = splitTextIntoSentences(text, chunkSize);
    if (!chunks.length) {
      return sendJSON(res, 400, { error: 'Không có câu hợp lệ để tạo giọng nói.' });
    }

    const concurrency = Math.min(parseInt(payload.concurrency || '10', 10), 15);

    try {
      // Xử lý song song 10 luồng
      const processedResults = await processConcurrently(
        chunks,
        concurrency,
        async (chunkText, index) => {
          const audioBuffer = await fetchSingleTTS(chunkText, {
            format, apiKey, model, voice, speed, volume
          }, 3);
          return { index, text: chunkText, buffer: audioBuffer };
        }
      );

      const pcmList = [];
      const srtEntries = [];
      let currentTime = 0;
      let masterSampleRate = 44100;
      let masterChannels = 1;
      let masterBits = 16;

      // Ghép nối theo đúng thứ tự 0 -> N-1
      for (let i = 0; i < processedResults.length; i++) {
        const item = processedResults[i];
        let chunkDuration = 0;

        if (format === 'wav') {
          const wavInfo = extractPcmFromWav(item.buffer);
          pcmList.push(wavInfo.pcmData);
          masterSampleRate = wavInfo.sampleRate;
          masterChannels = wavInfo.numChannels;
          masterBits = wavInfo.bitsPerSample;
          chunkDuration = wavInfo.durationSec;
        } else {
          pcmList.push(item.buffer);
          chunkDuration = item.buffer.length / 16000;
        }

        const startTimeStr = formatSrtTime(currentTime);
        const endTime = currentTime + chunkDuration;
        const endTimeStr = formatSrtTime(endTime);

        srtEntries.push(`${i + 1}\n${startTimeStr} --> ${endTimeStr}\n${item.text}\n`);
        currentTime = endTime;
      }

      let finalAudioBuffer;
      if (format === 'wav') {
        const totalPcm = Buffer.concat(pcmList);
        const header = createWavHeader(totalPcm.length, masterSampleRate, masterChannels, masterBits);
        finalAudioBuffer = Buffer.concat([header, totalPcm]);
      } else {
        finalAudioBuffer = Buffer.concat(pcmList);
      }

      const srtText = srtEntries.join('\n');

      sendJSON(res, 200, {
        success: true,
        format: format,
        duration: currentTime,
        formattedDuration: formatSrtTime(currentTime),
        chunksCount: chunks.length,
        concurrency: concurrency,
        audioBase64: finalAudioBuffer.toString('base64'),
        srt: srtText
      });
    } catch (err) {
      console.error('Lỗi khi tổng hợp full bài song song:', err);
      sendJSON(res, 502, { error: 'Lỗi tổng hợp âm thanh full bài song song', details: err.message });
    }
  });
}

/**
 * Handle listing voice models proxy
 */
function handleModels(req, res, queryParams) {
  const apiKey = queryParams.apiKey || DEFAULT_API_KEY;
  const params = new URLSearchParams();

  if (queryParams.page_size) params.append('page_size', queryParams.page_size);
  if (queryParams.page_number) params.append('page_number', queryParams.page_number);
  if (queryParams.language) params.append('language', queryParams.language);
  if (queryParams.title) params.append('title', queryParams.title);
  if (queryParams.sort_by) params.append('sort_by', queryParams.sort_by);

  const apiPath = `/model?${params.toString()}`;

  const apiOptions = {
    hostname: 'api.fish.audio',
    port: 443,
    path: apiPath,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json'
    }
  };

  const apiReq = https.request(apiOptions, apiRes => {
    let data = '';
    apiRes.on('data', chunk => { data += chunk; });
    apiRes.on('end', () => {
      res.writeHead(apiRes.statusCode, {
        'Content-Type': 'application/json; charset=UTF-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(data);
    });
  });

  apiReq.on('error', err => {
    console.error('Lỗi khi tải danh sách models:', err);
    sendJSON(res, 502, { error: 'Lỗi kết nối tới Fish Audio models API', details: err.message });
  });

  apiReq.end();
}

/**
 * Serve static files safely
 */
function serveStatic(req, res, pathname) {
  let safePath = pathname === '/' ? '/index.html' : pathname;
  const resolvedPath = path.resolve(PUBLIC_DIR, '.' + safePath);

  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=UTF-8' });
    return res.end('403 Forbidden');
  }

  fs.stat(resolvedPath, (err, stats) => {
    if (err || !stats.isFile()) {
      const fallbackPath = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(fallbackPath, (errFallback, content) => {
        if (errFallback) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
          return res.end('404 Not Found');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
        res.end(content);
      });
      return;
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    const stream = fs.createReadStream(resolvedPath);
    stream.pipe(res);
  });
}

/**
 * Start server with auto-port retry
 */
function startServer(port, retriesLeft = 10) {
  const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, model'
      });
      return res.end();
    }

    // API Routes
    if (pathname === '/api/tts' && req.method === 'POST') {
      return handleTTS(req, res);
    }

    if (pathname === '/api/batch' && req.method === 'POST') {
      return handleBatchTTS(req, res);
    }

    if (pathname === '/api/models' && req.method === 'GET') {
      return handleModels(req, res, parsedUrl.query);
    }

    if (pathname === '/api/health') {
      return sendJSON(res, 200, { status: 'ok', port, time: new Date().toISOString() });
    }

    // Static files
    if (req.method === 'GET') {
      return serveStatic(req, res, pathname);
    }

    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`⚠️  Cổng ${port} đang bận (EADDRINUSE).`);
      if (retriesLeft > 0) {
        const nextPort = port + 1;
        console.log(`🔄 Tự động thử cổng kế tiếp: http://localhost:${nextPort} ...`);
        startServer(nextPort, retriesLeft - 1);
      } else {
        console.error(`❌ Không tìm thấy cổng khả dụng sau nhiều lần thử.`);
        console.log(`💡 Mẹo: Giải phóng cổng ${INITIAL_PORT} bằng lệnh: kill -9 $(lsof -ti :${INITIAL_PORT})`);
        process.exit(1);
      }
    } else {
      console.error('❌ Lỗi máy chủ:', err);
      process.exit(1);
    }
  });

  server.listen(port, () => {
    console.log(`====================================================`);
    console.log(`🚀 Fish Audio TTS Studio is running!`);
    console.log(`📍 URL: http://localhost:${port}`);
    console.log(`🔑 Preloaded API Key: ${DEFAULT_API_KEY.slice(0, 12)}...${DEFAULT_API_KEY.slice(-4)}`);
    console.log(`====================================================`);
  });

  process.on('SIGINT', () => server.close(() => process.exit(0)));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

startServer(INITIAL_PORT);
