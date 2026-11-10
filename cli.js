#!/usr/bin/env node
/**
 * Fish Audio TTS CLI Tool
 * Chuyển đổi văn bản thành giọng nói trực tiếp từ Terminal
 * Usage:
 *   node cli.js --text "Xin chào bạn" --out output.mp3
 *   node cli.js --file script.txt --voice 66467d32ee2f42a89281e019630309ed --speed 1.2
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const DEFAULT_API_KEY = process.env.FISH_API_KEY || 'sk-fish-XCsvD6WOqXziDuBmyCXUD-lDIujXF9aB2-dIysL4IyY';

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const params = {
    text: '',
    file: '',
    out: '',
    voice: '',
    model: 's2.1-pro-free',
    format: 'mp3',
    speed: 1.0,
    volume: 0,
    apiKey: DEFAULT_API_KEY
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--text' || arg === '-t') params.text = args[++i];
    else if (arg === '--file' || arg === '-f') params.file = args[++i];
    else if (arg === '--out' || arg === '-o') params.out = args[++i];
    else if (arg === '--voice' || arg === '-v') params.voice = args[++i];
    else if (arg === '--model' || arg === '-m') params.model = args[++i];
    else if (arg === '--format') params.format = args[++i];
    else if (arg === '--speed' || arg === '-s') params.speed = parseFloat(args[++i]);
    else if (arg === '--volume') params.volume = parseInt(args[++i], 10);
    else if (arg === '--key' || arg === '-k') params.apiKey = args[++i];
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return params;
}

function printHelp() {
  console.log(`
🎙️  Fish Audio TTS CLI Utility

Cách sử dụng:
  node cli.js [options]

Các tùy chọn:
  -t, --text <string>     Văn bản cần đọc
  -f, --file <path>       Đường dẫn file văn bản (.txt) cần đọc
  -o, --out <path>        Đường dẫn file âm thanh xuất ra (Mặc định: output_<timestamp>.mp3)
  -v, --voice <id>        Voice Reference ID (Ví dụ: 66467d32ee2f42a89281e019630309ed cho Lanh Cao)
  -m, --model <name>      Mô hình TTS: s2.1-pro-free, s2.1-pro, s2-pro, drama-3 (Mặc định: s2.1-pro-free)
  -s, --speed <number>    Tốc độ đọc (0.5 - 2.0, Mặc định: 1.0)
      --volume <number>   Âm lượng (-20 đến 20 dB, Mặc định: 0)
      --format <string>   Định dạng: mp3, wav, opus (Mặc định: mp3)
  -k, --key <string>      API Key ghi đè (Mặc định: lấy từ FISH_API_KEY)
  -h, --help              Hiển thị trợ giúp này

Ví dụ:
  node cli.js -t "Xin chào Việt Nam!" -o hello.mp3
  node cli.js -f story.txt -v 66467d32ee2f42a89281e019630309ed -s 1.1 -o story.mp3
`);
}

async function main() {
  const params = parseArgs();

  let textToSynthesize = params.text;
  if (!textToSynthesize && params.file) {
    if (!fs.existsSync(params.file)) {
      console.error(`❌ Lỗi: File không tồn tại: ${params.file}`);
      process.exit(1);
    }
    textToSynthesize = fs.readFileSync(params.file, 'utf8').trim();
  }

  if (!textToSynthesize) {
    console.error('❌ Lỗi: Vui lòng cung cấp văn bản qua --text hoặc đường dẫn file qua --file');
    printHelp();
    process.exit(1);
  }

  const outputPath = params.out || path.join(process.cwd(), `output_${Date.now()}.${params.format}`);

  console.log('----------------------------------------------------');
  console.log(`📝 Nội dung: "${textToSynthesize.slice(0, 80)}${textToSynthesize.length > 80 ? '...' : ''}"`);
  console.log(`🤖 Model:    ${params.model}`);
  console.log(`🎙️  Voice:    ${params.voice || 'Mặc định (Default)'}`);
  console.log(`⚡ Speed:    ${params.speed}x | Volume: ${params.volume} dB`);
  console.log(`💾 File đích: ${outputPath}`);
  console.log('----------------------------------------------------');
  console.log('⏳ Đang kết nối tới Fish Audio API...');

  const requestBody = {
    text: textToSynthesize,
    format: params.format,
    prosody: {
      speed: params.speed,
      volume: params.volume
    }
  };

  if (params.voice) {
    requestBody.reference_id = params.voice;
  }

  const postData = JSON.stringify(requestBody);

  const reqOptions = {
    hostname: 'api.fish.audio',
    port: 443,
    path: '/v1/tts',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json',
      'model': params.model,
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const req = https.request(reqOptions, res => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const fileStream = fs.createWriteStream(outputPath);
      res.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        const stats = fs.statSync(outputPath);
        console.log(`✅ Hoàn tất! File âm thanh đã lưu thành công.`);
        console.log(`📊 Dung lượng: ${(stats.size / 1024).toFixed(1)} KB`);
        console.log(`🎧 Vị trí:     ${outputPath}`);
      });
    } else {
      let errData = '';
      res.on('data', chunk => errData += chunk);
      res.on('end', () => {
        console.error(`❌ Lỗi API (${res.statusCode}):`, errData);
        process.exit(1);
      });
    }
  });

  req.on('error', err => {
    console.error('❌ Lỗi kết nối:', err.message);
    process.exit(1);
  });

  req.write(postData);
  req.end();
}

main();

