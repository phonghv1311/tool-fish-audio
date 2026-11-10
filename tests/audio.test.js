const assert = require('assert');
const { splitTextIntoSentences, createWavHeader, extractPcmFromWav, formatSrtTime, fastPcmConcat } = require('../lib/audio');

function testAudioUtils() {
  // 1. Kiểm tra tách câu
  const text = 'Câu 1. Câu 2? Câu 3!';
  const chunks = splitTextIntoSentences(text, 220);
  assert.strictEqual(chunks.length, 3, 'Phải tách được 3 câu');

  // 2. Kiểm tra Header và tính toán thời lượng PCM
  const pcm = Buffer.alloc(88200); // 1 giây tại 44.1kHz 16-bit mono
  const header = createWavHeader(pcm.length, 44100, 1, 16);
  const fullWav = Buffer.concat([header, pcm]);
  const extracted = extractPcmFromWav(fullWav);
  assert.strictEqual(extracted.durationSec, 1.0, 'Thời lượng trích xuất phải đúng 1.0s');

  // 3. Kiểm tra định dạng SRT
  assert.strictEqual(formatSrtTime(3661.5), '01:01:01,500', 'SRT time format phải chính xác');

  // 4. Kiểm tra ghép nối Zero-Copy
  const combined = fastPcmConcat([pcm, pcm]);
  assert.strictEqual(combined.length, 176400, 'Tổng PCM sau khi gộp phải đúng 176400 bytes');

  console.log('✅ testAudioUtils passed');
}

testAudioUtils();
