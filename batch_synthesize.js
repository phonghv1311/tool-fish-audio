#!/usr/bin/env node
/**
 * Fish Audio Batch Synthesizer - Xử lý song song 10 luồng (Concurrency: 10)
 * Tăng tốc độ tạo giọng nói gấp 8-10 lần, bảo toàn tuyệt đối thứ tự âm thanh và mốc thời gian SRT.
 * 
 * Usage:
 *   node batch_synthesize.js --file story.txt --format wav --concurrency 10
 *   node batch_synthesize.js --text "Nội dung rất dài..." --concurrency 10
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const DEFAULT_API_KEY = process.env.FISH_API_KEY || 'sk-fish-XCsvD6WOqXziDuBmyCXUD-lDIujXF9aB2-dIysL4IyY';

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    file: '',
    text: '',
    out: '',
    srt: '',
    format: 'wav',
    voice: '',
    model: 's2.1-pro-free',
    speed: 1.0,
    volume: 0,
    chunkSize: 220,
    concurrency: 10, // Mặc định 10 luồng song song theo yêu cầu
    maxRetries: 3,
    apiKey: DEFAULT_API_KEY
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--file' || arg === '-f') options.file = args[++i];
    else if (arg === '--text' || arg === '-t') options.text = args[++i];
    else if (arg === '--out' || arg === '-o') options.out = args[++i];
    else if (arg === '--srt') options.srt = args[++i];
    else if (arg === '--format') options.format = (args[++i] || 'wav').toLowerCase();
    else if (arg === '--voice' || arg === '-v') options.voice = args[++i];
    else if (arg === '--model' || arg === '-m') options.model = args[++i];
    else if (arg === '--speed' || arg === '-s') options.speed = parseFloat(args[++i]);
    else if (arg === '--volume') options.volume = parseInt(args[++i], 10);
    else if (arg === '--chunk-size') options.chunkSize = parseInt(args[++i], 10);
    else if (arg === '--concurrency' || arg === '-c') options.concurrency = parseInt(args[++i], 10) || 10;
    else if (arg === '--key' || arg === '-k') options.apiKey = args[++i];
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  const ext = options.format === 'wav' ? 'wav' : 'mp3';
  if (!options.out) options.out = `full_speech_${Date.now()}.${ext}`;
  if (!options.srt) {
    const baseName = options.out.replace(/\.[^/.]+$/, '');
    options.srt = `${baseName}.srt`;
  }

  return options;
}

function printHelp() {
  console.log(`
⚡ Fish Audio Batch Synthesizer - Xử lý song song đa luồng (Multi-Threaded)

Cách sử dụng:
  node batch_synthesize.js [options]

Các tùy chọn:
  -f, --file <path>          Đường dẫn file văn bản (.txt, .md)
  -t, --text <string>        Nội dung văn bản trực tiếp
  -o, --out <path>           File âm thanh xuất ra (Mặc định: full_speech_<time>.wav)
      --srt <path>           File phụ đề SRT xuất ra (Mặc định: cùng tên file audio .srt)
      --format <string>      Định dạng: wav hoặc mp3 (Mặc định: wav)
  -c, --concurrency <number> Số luồng xử lý API song song đồng thời (Mặc định: 10 luồng)
  -v, --voice <id>           Voice Reference ID (Ví dụ: 66467d32ee2f42a89281e019630309ed)
  -m, --model <name>         Mô hình: s2.1-pro-free, s2.1-pro, s2-pro, drama-3
  -s, --speed <number>       Tốc độ nói (0.5 - 2.0, Mặc định: 1.0)
      --volume <number>      Âm lượng (-20 đến +20 dB, Mặc định: 0)
      --chunk-size <num>     Độ dài tối đa mỗi câu (Mặc định: 220 ký tự)
  -k, --key <string>         API Key tùy chỉnh
  -h, --help                 Hiển thị hướng dẫn
`);
}

/**
 * Tách văn bản thành các câu tự nhiên
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
 * Tạo Header WAV chuẩn 44-byte cho khối PCM
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
  buffer.writeUInt16LE(1, 20); // PCM
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
 * Trích xuất raw PCM và tính thời lượng thực tế
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

  const pcmData = (dataIndex !== -1 && dataIndex + 8 <= wavBuffer.length)
    ? wavBuffer.slice(dataIndex + 8)
    : wavBuffer.slice(44);

  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const durationSec = byteRate > 0 ? pcmData.length / byteRate : 0;

  return { pcmData, sampleRate, numChannels, bitsPerSample, durationSec };
}

/**
 * Định dạng thời gian chuẩn SRT (HH:MM:SS,mmm)
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
 * Gọi API Fish Audio tổng hợp 1 chunk kèm cơ chế tự động thử lại (Retry) khi gặp 429 hoặc lỗi mạng
 */
function fetchTtsChunkWithRetry(text, options, retries = 3) {
  return new Promise((resolve, reject) => {
    function attempt(remainingAttempts) {
      const requestBody = {
        text: text,
        format: options.format,
        latency: 'balanced',
        prosody: { speed: options.speed, volume: options.volume }
      };
      if (options.format === 'mp3') requestBody.mp3_bitrate = 128;
      if (options.voice) requestBody.reference_id = options.voice;

      const postData = JSON.stringify(requestBody);
      const apiOptions = {
        hostname: 'api.fish.audio',
        port: 443,
        path: '/v1/tts',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
          'model': options.model,
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(apiOptions, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const fullBuffer = Buffer.concat(chunks);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(fullBuffer);
          } else if ((res.statusCode === 429 || res.statusCode >= 500) && remainingAttempts > 0) {
            // Rate limit hoặc server bận: Chờ với độ trễ tăng dần rồi thử lại
            const waitTime = (4 - remainingAttempts) * 1000 + Math.floor(Math.random() * 500);
            setTimeout(() => attempt(remainingAttempts - 1), waitTime);
          } else {
            reject(new Error(`API Error (${res.statusCode}): ${fullBuffer.toString()}`));
          }
        });
      });

      req.on('error', err => {
        if (remainingAttempts > 0) {
          setTimeout(() => attempt(remainingAttempts - 1), 1000);
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
 * Bộ điều phối luồng song song (Concurrency Worker Pool)
 * Bảo đảm đúng tối đa `concurrency` request chạy cùng lúc,
 * và lưu kết quả đúng chỉ số ban đầu (Preserve original order).
 */
async function processConcurrently(items, concurrency, workerFn, onProgress) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let completedCount = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) break;

      const item = items[currentIndex];
      const res = await workerFn(item, currentIndex);
      results[currentIndex] = res;

      completedCount++;
      if (onProgress) onProgress(completedCount, items.length);
    }
  }

  const threadCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: threadCount }, () => worker());
  await Promise.all(workers);
  return results;
}

function renderProgressBar(current, total, concurrency, barLength = 25) {
  const percent = Math.round((current / total) * 100);
  const filled = Math.round((barLength * current) / total);
  const empty = barLength - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  process.stdout.write(`\r⚡ [${bar}] ${percent}% (${current}/${total} câu) - Đang chạy song song ${concurrency} luồng`);
}

async function main() {
  const options = parseArgs();
  let text = options.text;
  if (!text && options.file) {
    if (!fs.existsSync(options.file)) {
      console.error(`❌ Không tìm thấy file: ${options.file}`);
      process.exit(1);
    }
    text = fs.readFileSync(options.file, 'utf8');
  }

  if (!text || !text.trim()) {
    console.error('❌ Vui lòng cung cấp văn bản qua --file hoặc --text');
    process.exit(1);
  }

  const chunks = splitTextIntoSentences(text, options.chunkSize);
  const actualThreads = Math.min(options.concurrency, chunks.length);

  console.log('====================================================');
  console.log(`🚀 Fish Audio Multi-Threaded Synthesizer`);
  console.log(`📝 Tổng ký tự:     ${text.length} ký tự`);
  console.log(`🧩 Số câu/đoạn:     ${chunks.length}`);
  console.log(`⚡ Luồng song song: ${actualThreads} luồng`);
  console.log(`🎵 Định dạng:       ${options.format.toUpperCase()}`);
  console.log(`💾 File Audio xuất: ${options.out}`);
  console.log(`📄 File SRT xuất:   ${options.srt}`);
  console.log('====================================================');

  const startTime = Date.now();
  renderProgressBar(0, chunks.length, actualThreads);

  // Xử lý song song 10 luồng
  const processedResults = await processConcurrently(
    chunks,
    actualThreads,
    async (chunkText, index) => {
      const audioBuffer = await fetchTtsChunkWithRetry(chunkText, options, options.maxRetries);
      return {
        index,
        text: chunkText,
        buffer: audioBuffer
      };
    },
    (completed, total) => {
      renderProgressBar(completed, total, actualThreads);
    }
  );

  const totalTimeSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n\n⏱️  Hoàn tất tải về ${chunks.length} câu trong: ${totalTimeSec}s (Tốc độ: ${(chunks.length / totalTimeSec).toFixed(1)} câu/s)`);
  console.log('🔗 Đang ghép nối âm thanh tuần tự và tính toán phụ đề SRT...');

  const pcmList = [];
  const srtEntries = [];
  let currentTime = 0;
  let masterSampleRate = 44100;
  let masterChannels = 1;
  let masterBits = 16;

  // Lặp qua danh sách kết quả theo đúng thứ tự 0 -> N-1
  for (let i = 0; i < processedResults.length; i++) {
    const item = processedResults[i];
    let chunkDuration = 0;

    if (options.format === 'wav') {
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

    const startStr = formatSrtTime(currentTime);
    const endTime = currentTime + chunkDuration;
    const endStr = formatSrtTime(endTime);

    srtEntries.push(`${i + 1}\n${startStr} --> ${endStr}\n${item.text}\n`);
    currentTime = endTime;
  }

  // 1. Ghi file audio full bài
  if (options.format === 'wav') {
    const totalPcm = Buffer.concat(pcmList);
    const header = createWavHeader(totalPcm.length, masterSampleRate, masterChannels, masterBits);
    fs.writeFileSync(options.out, Buffer.concat([header, totalPcm]));
  } else {
    fs.writeFileSync(options.out, Buffer.concat(pcmList));
  }

  // 2. Ghi file phụ đề SRT
  fs.writeFileSync(options.srt, srtEntries.join('\n'), 'utf8');

  const audioStats = fs.statSync(options.out);
  console.log('====================================================');
  console.log(`🎉 XUẤT BẢN THÀNH CÔNG!`);
  console.log(`🎵 Audio Full Bài: ${path.resolve(options.out)} (${(audioStats.size / 1024).toFixed(1)} KB)`);
  console.log(`📄 Phụ đề SRT:     ${path.resolve(options.srt)}`);
  console.log(`⏱️  Tổng thời lượng âm thanh: ${formatSrtTime(currentTime)}`);
  console.log(`⚡ Thời gian thực thi:        ${totalTimeSec}s (Xử lý đồng thời ${actualThreads} luồng)`);
  console.log('====================================================');
}

main().catch(err => {
  console.error('\n❌ Lỗi thực thi:', err.message);
  process.exit(1);
});
