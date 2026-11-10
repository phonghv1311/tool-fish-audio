#!/usr/bin/env node
/**
 * Fish Audio Batch Synthesizer - Xử lý song song 10 luồng (Concurrency: 10)
 * Tích hợp Keep-Alive Agent Connection Pool, LRU Cache & Zero-Copy Audio Assembly.
 */

const fs = require('fs');
const path = require('path');

const { fetchTtsChunk } = require('./lib/network');
const { globalAudioCache } = require('./lib/cache');
const {
  splitTextIntoSentences,
  createWavHeader,
  extractPcmFromWav,
  formatSrtTime,
  fastPcmConcat
} = require('./lib/audio');

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
    concurrency: 10,
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
⚡ Fish Audio Batch Synthesizer - Multi-Threaded & Keep-Alive Optimized

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
 * Bộ điều phối song song (Concurrency Worker Pool)
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
  process.stdout.write(`\r⚡ [${bar}] ${percent}% (${current}/${total} câu) - Đang chạy song song ${concurrency} luồng (Keep-Alive Pool)`);
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

  const chunks = splitTextIntoSentences(text, options.chunkSize, true);
  const actualThreads = Math.min(options.concurrency, chunks.length);

  console.log('====================================================');
  console.log(`🚀 Fish Audio Multi-Threaded Synthesizer (Optimized)`);
  console.log(`📝 Tổng ký tự:     ${text.length} ký tự`);
  console.log(`🧩 Số câu/đoạn:     ${chunks.length}`);
  console.log(`⚡ Luồng song song: ${actualThreads} luồng`);
  console.log(`🎵 Định dạng:       ${options.format.toUpperCase()}`);
  console.log(`💾 File Audio xuất: ${options.out}`);
  console.log(`📄 File SRT xuất:   ${options.srt}`);
  console.log('====================================================');

  const startTime = Date.now();
  renderProgressBar(0, chunks.length, actualThreads);

  let cacheHits = 0;

  // Xử lý song song N luồng với Cache & Keep-Alive Agent
  const processedResults = await processConcurrently(
    chunks,
    actualThreads,
    async (chunkText, index) => {
      const cacheParams = {
        text: chunkText,
        voice: options.voice,
        model: options.model,
        format: options.format,
        speed: options.speed,
        volume: options.volume
      };

      const cached = globalAudioCache.get(cacheParams);
      if (cached) {
        cacheHits++;
        return { index, text: chunkText, buffer: cached, fromCache: true };
      }

      const audioBuffer = await fetchTtsChunk(chunkText, options, options.maxRetries);
      globalAudioCache.set(cacheParams, audioBuffer);
      return { index, text: chunkText, buffer: audioBuffer, fromCache: false };
    },
    (completed, total) => {
      renderProgressBar(completed, total, actualThreads);
    }
  );

  const totalTimeSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n\n⏱️  Hoàn tất ${chunks.length} câu trong: ${totalTimeSec}s (Cache Hits: ${cacheHits}/${chunks.length})`);
  console.log('🔗 Đang ghép nối âm thanh tuần tự và tính toán phụ đề SRT...');

  const pcmList = [];
  const srtEntries = [];
  let currentTime = 0;
  let masterSampleRate = 44100;
  let masterChannels = 1;
  let masterBits = 16;

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

  // Ghép nối Buffer Zero-Copy
  if (options.format === 'wav') {
    const totalPcm = fastPcmConcat(pcmList);
    const header = createWavHeader(totalPcm.length, masterSampleRate, masterChannels, masterBits);
    fs.writeFileSync(options.out, Buffer.concat([header, totalPcm]));
  } else {
    fs.writeFileSync(options.out, fastPcmConcat(pcmList));
  }

  // Ghi file phụ đề SRT
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
