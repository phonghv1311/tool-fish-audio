const assert = require('assert');
const { splitTextIntoSentences, createWavHeader, extractPcmFromWav, formatSrtTime, fastPcmConcat } = require('../lib/audio');

function testAudioUtils() {
  // 1. Kiểm tra tách câu
  const text = 'Câu 1. Câu 2? Câu 3!';
  const chunksIndividual = splitTextIntoSentences(text, 220, true);
  assert.strictEqual(chunksIndividual.length, 3, 'Phải tách được 3 câu riêng biệt');

  const chunksGrouped = splitTextIntoSentences(text, 220, false);
  assert.strictEqual(chunksGrouped.length, 1, 'Câu ngắn gộp chung được 1 đoạn');

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

  // 5. Kiểm tra xử lý văn bản khổng lồ (95,000+ ký tự)
  const sentenceTemplate = 'Đây là một câu kiểm tra hiệu năng hệ thống xử lý giọng nói văn bản dài. ';
  const repeatCount = Math.ceil(95305 / sentenceTemplate.length);
  const largeText = sentenceTemplate.repeat(repeatCount);
  assert.ok(largeText.length >= 95305, 'Văn bản phải đạt ít nhất 95,305 ký tự');

  const chunks220 = splitTextIntoSentences(largeText, 220);
  const chunks350 = splitTextIntoSentences(largeText, 350);
  const chunks500 = splitTextIntoSentences(largeText, 500);

  assert.ok(chunks220.length > 400, 'Chunk 220 phải có trên 400 đoạn');
  assert.ok(chunks350.length < chunks220.length, 'Chunk 350 phải giảm số lượng đoạn so với 220');
  assert.ok(chunks500.length < chunks350.length, 'Chunk 500 phải giảm số lượng đoạn hơn nữa');

  console.log(`✅ testAudioUtils passed (95k chars tested: 220 => ${chunks220.length} chunks, 350 => ${chunks350.length} chunks, 500 => ${chunks500.length} chunks)`);
}

testAudioUtils();

