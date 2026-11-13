/**
 * Fish Audio Web Application Server
 * Built with native Node.js (Zero external dependencies)
 * Tích hợp Keep-Alive Agent Connection Pool, LRU Memory Cache, Progressive Streaming & Zero-Copy Audio Assembly.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const { getKeepAliveAgent, ApiKeyPool, fetchTtsChunk } = require('./lib/network');
const { globalAudioCache } = require('./lib/cache');
const { globalTaskManager } = require('./lib/task-manager');
const {
  splitTextIntoSentences,
  createWavHeader,
  extractPcmFromWav,
  formatSrtTime,
  fastPcmConcat,
  streamMergePcmToWav,
  streamMergeMp3Files
} = require('./lib/audio');

const INITIAL_PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const OUTPUTS_DIR = path.join(PUBLIC_DIR, 'outputs');
const DEFAULT_API_KEY = process.env.FISH_API_KEY || 'sk-fish-XCsvD6WOqXziDuBmyCXUD-lDIujXF9aB2-dIysL4IyY';

// Đảm bảo thư mục lưu trữ file xuất âm thanh luôn sẵn sàng
if (!fs.existsSync(OUTPUTS_DIR)) {
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
}

/**
 * Tự động dọn dẹp các file âm thanh tạm cũ hơn 24 giờ để giải phóng dung lượng ổ đĩa
 */
function cleanOldOutputs(maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    if (!fs.existsSync(OUTPUTS_DIR)) return;
    const now = Date.now();
    const files = fs.readdirSync(OUTPUTS_DIR);
    for (const f of files) {
      if (f === '.gitkeep' || f === 'tasks') continue;
      const fullPath = path.join(OUTPUTS_DIR, f);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory() && (now - stat.mtimeMs > maxAgeMs)) {
          fs.unlinkSync(fullPath);
        }
      } catch (e) {}
    }
    // Dọn dẹp các thư mục tác vụ cũ
    globalTaskManager.cleanOldTasks(maxAgeMs).catch(() => {});
  } catch (err) {
    console.warn('Cảnh báo khi dọn dẹp outputs cũ:', err.message);
  }
}

// Chạy dọn dẹp khi khởi động
cleanOldOutputs();

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
    const chunkSize = payload.chunkSize || 350;
    const concurrency = Math.min(Math.max(parseInt(payload.concurrency || '10', 10), 1), 50);

    const chunks = splitTextIntoSentences(text, chunkSize, false);
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
          }, 5);

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

      // Lưu file âm thanh và phụ đề trực tiếp ra đĩa cứng tại public/outputs
      const fileId = `tts_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const audioFileName = `${fileId}.${format}`;
      const srtFileName = `${fileId}.srt`;
      const audioFilePath = path.join(OUTPUTS_DIR, audioFileName);
      const srtFilePath = path.join(OUTPUTS_DIR, srtFileName);

      await fs.promises.writeFile(audioFilePath, finalAudioBuffer);
      await fs.promises.writeFile(srtFilePath, srtText, 'utf8');

      // V8 string limit safe: Chỉ tạo base64 nếu file nhỏ (<= 10MB) để tránh crash ERR_STRING_TOO_LONG
      const safeAudioBase64 = finalAudioBuffer.length <= 10 * 1024 * 1024
        ? finalAudioBuffer.toString('base64')
        : null;

      sendJSON(res, 200, {
        success: true,
        format: format,
        duration: currentTime,
        formattedDuration: formatSrtTime(currentTime),
        chunksCount: chunks.length,
        concurrency: concurrency,
        cacheHitsCount: cacheHitsCount,
        fileSize: finalAudioBuffer.length,
        audioUrl: `/outputs/${audioFileName}`,
        srtUrl: `/outputs/${srtFileName}`,
        audioBase64: safeAudioBase64,
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
    const chunkSize = payload.chunkSize || 350;
    const concurrency = Math.min(Math.max(parseInt(payload.concurrency || '10', 10), 1), 50);

    const chunks = splitTextIntoSentences(text, chunkSize, false);

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
          buffer = await fetchTtsChunk(chunkText, { format, apiKey, model, voice, speed, volume }, 5);
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

      const fileId = `tts_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const audioFileName = `${fileId}.${format}`;
      const srtFileName = `${fileId}.srt`;
      const audioFilePath = path.join(OUTPUTS_DIR, audioFileName);
      const srtFilePath = path.join(OUTPUTS_DIR, srtFileName);
      const srtContent = srtEntries.join('\n');

      await fs.promises.writeFile(audioFilePath, finalAudioBuffer);
      await fs.promises.writeFile(srtFilePath, srtContent, 'utf8');

      const safeAudioBase64 = finalAudioBuffer.length <= 10 * 1024 * 1024
        ? finalAudioBuffer.toString('base64')
        : null;

      const completeEvent = {
        type: 'complete',
        format: format,
        duration: currentTime,
        formattedDuration: formatSrtTime(currentTime),
        chunksCount: chunks.length,
        fileSize: finalAudioBuffer.length,
        audioUrl: `/outputs/${audioFileName}`,
        srtUrl: `/outputs/${srtFileName}`,
        srt: srtContent,
        fullAudioBase64: safeAudioBase64,
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
 * Handle Task creation (Large scale long-form audio > 2 hours)
 */
function handleCreateTask(req, res) {
  let body = '';
  const MAX_SIZE = 50 * 1024 * 1024; // 50MB text limit

  req.on('data', chunk => {
    body += chunk;
    if (body.length > MAX_SIZE) {
      sendJSON(res, 413, { error: 'Payload quá lớn (Tối đa 50MB)' });
      req.destroy();
    }
  });

  req.on('end', async () => {
    try {
      const payload = JSON.parse(body || '{}');
      if (!payload.text || !payload.text.trim()) {
        return sendJSON(res, 400, { error: 'Vui lòng cung cấp nội dung văn bản (text).' });
      }
      const taskResult = await globalTaskManager.createTask(payload);
      sendJSON(res, 200, { success: true, ...taskResult });
    } catch (err) {
      console.error('Lỗi khởi tạo Task:', err);
      sendJSON(res, 500, { error: 'Lỗi khởi tạo Task âm thanh', details: err.message });
    }
  });
}

/**
 * Handle Task Realtime SSE Stream
 */
async function handleTaskStream(req, res, taskId) {
  const metadata = await globalTaskManager.readMetadata(taskId);
  if (!metadata) {
    return sendJSON(res, 404, { error: 'Task không tồn tại' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=UTF-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no'
  });

  // Gửi trạng thái hiện tại ngay khi kết nối
  res.write(`data: ${JSON.stringify({ type: 'init', metadata })}\n\n`);

  if (metadata.status === 'completed') {
    res.write(`data: ${JSON.stringify({ type: 'completed', ...metadata })}\n\n`);
    return res.end();
  }

  const unsubscribe = globalTaskManager.subscribe(taskId, event => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'completed' || event.type === 'cancelled') {
      setTimeout(() => {
        try { res.end(); } catch (e) {}
      }, 500);
    }
  });

  req.on('close', () => {
    unsubscribe();
  });
}

/**
 * Handle Task Control Actions: pause, resume, cancel
 */
async function handleTaskAction(req, res, taskId, action) {
  try {
    if (action === 'pause') {
      const result = await globalTaskManager.pauseTask(taskId);
      return sendJSON(res, 200, result);
    } else if (action === 'resume') {
      const result = await globalTaskManager.resumeTask(taskId);
      return sendJSON(res, 200, result);
    } else if (action === 'cancel') {
      const result = await globalTaskManager.cancelTask(taskId);
      return sendJSON(res, 200, result);
    }
    sendJSON(res, 400, { error: 'Hành động không hợp lệ' });
  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
}

/**
 * Handle Get Task Status
 */
async function handleGetTask(req, res, taskId) {
  const metadata = await globalTaskManager.readMetadata(taskId);
  if (!metadata) {
    return sendJSON(res, 404, { error: 'Task không tồn tại' });
  }
  sendJSON(res, 200, metadata);
}

/**
 * Serve static files safely & Stream large audio with HTTP Range (206 Partial Content)
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
    const range = req.headers.range;

    // Hỗ trợ HTTP Range Request cho phép trình duyệt tua âm thanh lớn mượt mà
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;

      if (isNaN(start) || start >= stats.size || end >= stats.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
        return res.end();
      }

      const chunkSize = (end - start) + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      });
      const stream = fs.createReadStream(resolvedPath, { start, end });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stats.size,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*'
      });
      const stream = fs.createReadStream(resolvedPath);
      stream.pipe(res);
    }
  });
}

/**
 * Start server with auto-port retry & WHATWG URL compliance
 */
function startServer(port, retriesLeft = 10) {
  const server = http.createServer((req, res) => {
    // Sử dụng chuẩn WHATWG URL thay vì url.parse() deprecated
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = reqUrl.pathname;
    const queryParams = Object.fromEntries(reqUrl.searchParams.entries());

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

    // Task Routes for Large Long-Form Audio (> 2 hours)
    if (pathname === '/api/tasks' && req.method === 'POST') {
      return handleCreateTask(req, res);
    }

    if (pathname.startsWith('/api/tasks/')) {
      const parts = pathname.replace('/api/tasks/', '').split('/');
      const taskId = parts[0];
      const action = parts[1];

      if (action === 'stream' && req.method === 'GET') {
        return handleTaskStream(req, res, taskId);
      }
      if (action === 'pause' && req.method === 'POST') {
        return handleTaskAction(req, res, taskId, 'pause');
      }
      if (action === 'resume' && req.method === 'POST') {
        return handleTaskAction(req, res, taskId, 'resume');
      }
      if (action === 'cancel' && req.method === 'POST') {
        return handleTaskAction(req, res, taskId, 'cancel');
      }
      if (!action && req.method === 'GET') {
        return handleGetTask(req, res, taskId);
      }
    }

    if (pathname === '/api/models' && req.method === 'GET') {
      return handleModels(req, res, queryParams);
    }

    if (pathname === '/api/cache-stats' && req.method === 'GET') {
      return sendJSON(res, 200, globalAudioCache.getStats());
    }

    if (pathname === '/api/cache-clear' && req.method === 'POST') {
      globalAudioCache.clear();
      return sendJSON(res, 200, { status: 'cleared' });
    }

    if (pathname === '/api/delete-output' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { audioUrl, srtUrl, taskId } = JSON.parse(body || '{}');
          const toDelete = [];
          if (audioUrl && typeof audioUrl === 'string' && audioUrl.startsWith('/outputs/')) {
            const fileName = path.basename(audioUrl);
            toDelete.push(path.join(OUTPUTS_DIR, fileName));
          }
          if (srtUrl && typeof srtUrl === 'string' && srtUrl.startsWith('/outputs/')) {
            const fileName = path.basename(srtUrl);
            toDelete.push(path.join(OUTPUTS_DIR, fileName));
          }
          for (const f of toDelete) {
            try {
              if (fs.existsSync(f)) await fs.promises.unlink(f);
            } catch (e) {}
          }
          if (taskId && typeof taskId === 'string') {
            try {
              const safeTaskId = path.basename(taskId);
              const taskDir = globalTaskManager.getTaskDir(safeTaskId);
              if (fs.existsSync(taskDir)) {
                await fs.promises.rm(taskDir, { recursive: true, force: true });
              }
            } catch (e) {}
          }
          sendJSON(res, 200, { success: true });
        } catch (e) {
          sendJSON(res, 400, { error: e.message });
        }
      });
      return;
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
    console.log(`⚡ Keep-Alive Pool: Enabled (Max 128 Sockets)`);
    console.log(`🔑 Multi-Key Pool & Failover: Enabled`);
    console.log(`💾 LRU Memory Cache: Enabled (150MB Limit)`);
    console.log(`🎧 Long-Audio Engine (> 2h, Zero-RAM Stream): Ready`);
    console.log(`📂 Outputs Storage: ${OUTPUTS_DIR}`);
    console.log(`====================================================`);
  });

  process.on('SIGINT', () => server.close(() => process.exit(0)));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

startServer(INITIAL_PORT);
