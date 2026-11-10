/**
 * Fish Audio Web Application Server
 * Built with native Node.js (Zero external dependencies)
 * Tích hợp Keep-Alive Agent Connection Pool, LRU Memory Cache, Progressive Streaming & Zero-Copy Audio Assembly.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const { getKeepAliveAgent, fetchTtsChunk } = require('./lib/network');
const { globalAudioCache } = require('./lib/cache');
const {
  splitTextIntoSentences,
  createWavHeader,
  extractPcmFromWav,
  formatSrtTime,
  fastPcmConcat
} = require('./lib/audio');

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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, model, X-Requested-With',
    'Access-Control-Expose-Headers': 'X-Cache, X-Response-Time'
  });
  res.end(body);
}

/**
 * Bộ điều phối luồng song song (Concurrency Worker Pool)
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
 * Handle TTS generation proxy (Đoạn đơn) có tích hợp LRU Cache & Keep-Alive
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

    const apiKey = (payload.apiKey && payload.apiKey.trim()) ? payload.apiKey.trim() : DEFAULT_API_KEY;
    const model = payload.model || 's2.1-pro-free';
    const format = payload.format || 'mp3';
    const voice = payload.reference_id ? payload.reference_id.trim() : '';
    const speed = payload.prosody && typeof payload.prosody.speed === 'number' ? payload.prosody.speed : 1.0;
    const volume = payload.prosody && typeof payload.prosody.volume === 'number' ? payload.prosody.volume : 0;

    const cacheParams = { text, voice, model, format, speed, volume };

    // 1. Kiểm tra Cache
    const cachedBuffer = globalAudioCache.get(cacheParams);
    if (cachedBuffer) {
      const contentType = format === 'wav' ? 'audio/wav' : 'audio/mpeg';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': cachedBuffer.length,
        'Content-Disposition': `inline; filename="speech.${format}"`,
        'Access-Control-Allow-Origin': '*',
        'X-Cache': 'HIT'
      });
      return res.end(cachedBuffer);
    }

    // 2. Cache Miss: Gọi API qua Keep-Alive Agent
    try {
      const audioBuffer = await fetchTtsChunk(text, {
        apiKey,
        model,
        format,
        voice,
        speed,
        volume
      });

      // Lưu vào cache
      globalAudioCache.set(cacheParams, audioBuffer);

      const contentType = format === 'wav' ? 'audio/wav' : 'audio/mpeg';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': audioBuffer.length,
        'Content-Disposition': `inline; filename="speech.${format}"`,
        'Access-Control-Allow-Origin': '*',
        'X-Cache': 'MISS'
      });
      res.end(audioBuffer);
    } catch (err) {
      console.error('Lỗi khi gọi Fish Audio TTS:', err);
      sendJSON(res, 502, { error: 'Không thể kết nối tới Fish Audio API', details: err.message });
    }
  });
}

/**
 * Handle Batch Full Bài & SRT generation proxy (10 luồng song song + Cache)
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
    const concurrency = Math.min(Math.max(parseInt(payload.concurrency || '10', 10), 1), 25);

    const chunks = splitTextIntoSentences(text, chunkSize, true);
    if (!chunks.length) {
      return sendJSON(res, 400, { error: 'Không có câu hợp lệ để tạo giọng nói.' });
    }

    try {
      let cacheHitsCount = 0;

      // Xử lý song song N luồng bảo toàn thứ tự kết quả
      const processedResults = await processConcurrently(
        chunks,
        concurrency,
        async (chunkText, index) => {
          const cacheParams = { text: chunkText, voice, model, format, speed, volume };
          const cached = globalAudioCache.get(cacheParams);

          if (cached) {
            cacheHitsCount++;
            return { index, text: chunkText, buffer: cached, fromCache: true };
          }

          const audioBuffer = await fetchTtsChunk(chunkText, {
            format, apiKey, model, voice, speed, volume
          }, 3);

          globalAudioCache.set(cacheParams, audioBuffer);
          return { index, text: chunkText, buffer: audioBuffer, fromCache: false };
        }
      );

      const pcmList = [];
      const srtEntries = [];
      let currentTime = 0;
      let masterSampleRate = 44100;
      let masterChannels = 1;
      let masterBits = 16;

      // Ghép nối tuần tự theo đúng chỉ số 0 -> N-1
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
        const totalPcm = fastPcmConcat(pcmList);
        const header = createWavHeader(totalPcm.length, masterSampleRate, masterChannels, masterBits);
        finalAudioBuffer = Buffer.concat([header, totalPcm]);
      } else {
        finalAudioBuffer = fastPcmConcat(pcmList);
      }

      const srtText = srtEntries.join('\n');

      sendJSON(res, 200, {
        success: true,
        format: format,
        duration: currentTime,
        formattedDuration: formatSrtTime(currentTime),
        chunksCount: chunks.length,
        concurrency: concurrency,
        cacheHitsCount: cacheHitsCount,
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
 * Handle Progressive Streaming (NDJSON Stream để phát ngay câu 1)
 */
function handleBatchStream(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);

  req.on('end', async () => {
    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch (e) {
      return sendJSON(res, 400, { error: 'JSON không hợp lệ' });
    }

    const text = (payload.text || '').trim();
    if (!text) {
      return sendJSON(res, 400, { error: 'Vui lòng cung cấp nội dung văn bản.' });
    }

    const format = (payload.format || 'wav').toLowerCase();
    const apiKey = (payload.apiKey && payload.apiKey.trim()) ? payload.apiKey.trim() : DEFAULT_API_KEY;
    const model = payload.model || 's2.1-pro-free';
    const voice = payload.reference_id ? payload.reference_id.trim() : '';
    const speed = payload.prosody && typeof payload.prosody.speed === 'number' ? payload.prosody.speed : 1.0;
    const volume = payload.prosody && typeof payload.prosody.volume === 'number' ? payload.prosody.volume : 0;
    const chunkSize = payload.chunkSize || 220;
    const concurrency = Math.min(Math.max(parseInt(payload.concurrency || '10', 10), 1), 25);

    const chunks = splitTextIntoSentences(text, chunkSize, true);

    // Kích hoạt Chunked NDJSON stream
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=UTF-8',
      'Transfer-Encoding': 'chunked',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });

    const pcmList = new Array(chunks.length);
    const durations = new Array(chunks.length);
    let masterSampleRate = 44100;
    let masterChannels = 1;
    let masterBits = 16;

    try {
      await processConcurrently(chunks, concurrency, async (chunkText, index) => {
        const cacheParams = { text: chunkText, voice, model, format, speed, volume };
        let buffer = globalAudioCache.get(cacheParams);
        let fromCache = true;

        if (!buffer) {
          fromCache = false;
          buffer = await fetchTtsChunk(chunkText, { format, apiKey, model, voice, speed, volume }, 3);
          globalAudioCache.set(cacheParams, buffer);
        }

        let chunkDuration = 0;
        if (format === 'wav') {
          const wavInfo = extractPcmFromWav(buffer);
          pcmList[index] = wavInfo.pcmData;
          masterSampleRate = wavInfo.sampleRate;
          masterChannels = wavInfo.numChannels;
          masterBits = wavInfo.bitsPerSample;
          chunkDuration = wavInfo.durationSec;
        } else {
          pcmList[index] = buffer;
          chunkDuration = buffer.length / 16000;
        }
        durations[index] = chunkDuration;

        // Bắn ngay chunk về cho Client (Phát ngay câu đầu!)
        const chunkEvent = {
          type: 'chunk',
          index: index,
          text: chunkText,
          duration: chunkDuration,
          fromCache: fromCache,
          audioBase64: buffer.toString('base64'),
          format: format
        };
        res.write(JSON.stringify(chunkEvent) + '\n');
      });

      // Tạo SRT và Audio gộp hoàn chỉnh
      const srtEntries = [];
      let currentTime = 0;
      for (let i = 0; i < chunks.length; i++) {
        const startStr = formatSrtTime(currentTime);
        const endTime = currentTime + (durations[i] || 0);
        const endStr = formatSrtTime(endTime);
        srtEntries.push(`${i + 1}\n${startStr} --> ${endStr}\n${chunks[i]}\n`);
        currentTime = endTime;
      }

      let finalAudioBuffer;
      if (format === 'wav') {
        const totalPcm = fastPcmConcat(pcmList);
        const header = createWavHeader(totalPcm.length, masterSampleRate, masterChannels, masterBits);
        finalAudioBuffer = Buffer.concat([header, totalPcm]);
      } else {
        finalAudioBuffer = fastPcmConcat(pcmList);
      }

      const completeEvent = {
        type: 'complete',
        format: format,
        duration: currentTime,
        formattedDuration: formatSrtTime(currentTime),
        chunksCount: chunks.length,
        srt: srtEntries.join('\n'),
        fullAudioBase64: finalAudioBuffer.toString('base64'),
        cacheStats: globalAudioCache.getStats()
      };
      res.write(JSON.stringify(completeEvent) + '\n');
      res.end();
    } catch (err) {
      res.write(JSON.stringify({ type: 'error', error: err.message }) + '\n');
      res.end();
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
    agent: getKeepAliveAgent(),
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
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, model, X-Requested-With',
        'Access-Control-Expose-Headers': 'X-Cache, X-Response-Time'
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

    if (pathname === '/api/batch-stream' && req.method === 'POST') {
      return handleBatchStream(req, res);
    }

    if (pathname === '/api/models' && req.method === 'GET') {
      return handleModels(req, res, parsedUrl.query);
    }

    if (pathname === '/api/cache-stats' && req.method === 'GET') {
      return sendJSON(res, 200, globalAudioCache.getStats());
    }

    if (pathname === '/api/cache-clear' && req.method === 'POST') {
      globalAudioCache.clear();
      return sendJSON(res, 200, { status: 'cleared' });
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
        console.error(`❌ Không tìm thấy cổng khả dụng.`);
        process.exit(1);
      }
    } else {
      console.error('❌ Lỗi máy chủ:', err);
      process.exit(1);
    }
  });

  server.listen(port, () => {
    console.log(`====================================================`);
    console.log(`🚀 Fish Audio TTS Studio (Enhanced) is running!`);
    console.log(`📍 URL: http://localhost:${port}`);
    console.log(`⚡ Keep-Alive Pool: Enabled (Max 32 Sockets)`);
    console.log(`💾 LRU Memory Cache: Enabled (150MB Limit)`);
    console.log(`====================================================`);
  });

  process.on('SIGINT', () => server.close(() => process.exit(0)));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

startServer(INITIAL_PORT);
