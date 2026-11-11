/**
 * lib/audio.js
 * Tiện ích xử lý âm thanh PCM, WAV Header và đồng bộ phụ đề SRT
 */

function splitTextIntoSentences(text, maxChunkLen = 350, individualSentences = false) {
  const paragraphs = text.split(/\n+/);
  const chunks = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    const rawSentences = trimmed.match(/[^.!?…;]+[.!?…;]+|[^.!?…;]+$/g) || [trimmed];

    if (individualSentences) {
      for (const raw of rawSentences) {
        const sentence = raw.trim();
        if (!sentence) continue;
        if (sentence.length > maxChunkLen) {
          const parts = sentence.match(new RegExp(`.{1,${maxChunkLen}}(\\s+|$)|.{1,${maxChunkLen}}`, 'g')) || [sentence];
          for (const p of parts) {
            if (p.trim()) chunks.push(p.trim());
          }
        } else {
          chunks.push(sentence);
        }
      }
    } else {
      let current = '';
      for (const raw of rawSentences) {
        const sentence = raw.trim();
        if (!sentence) continue;

        if (sentence.length > maxChunkLen) {
          if (current) {
            chunks.push(current);
            current = '';
          }
          const parts = sentence.match(new RegExp(`.{1,${maxChunkLen}}(\\s+|$)|.{1,${maxChunkLen}}`, 'g')) || [sentence];
          for (const p of parts) {
            if (p.trim()) chunks.push(p.trim());
          }
        } else if ((current + ' ' + sentence).trim().length <= maxChunkLen) {
          current = (current + ' ' + sentence).trim();
        } else {
          if (current) chunks.push(current);
          current = sentence;
        }
      }
      if (current) chunks.push(current);
    }
  }

  return chunks;
}

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

function formatSrtTime(totalSeconds) {
  const pad = (n, width) => String(n).padStart(width, '0');
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const milliseconds = Math.floor((totalSeconds % 1) * 1000);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(milliseconds, 3)}`;
}

/**
 * Ghép nối danh sách Buffer nhanh chóng với 1 lần cấp phát duy nhất (Zero-Copy)
 */
function fastPcmConcat(bufferList) {
  const totalLength = bufferList.reduce((acc, b) => acc + b.length, 0);
  const result = Buffer.allocUnsafe(totalLength);
  let offset = 0;
  for (let i = 0; i < bufferList.length; i++) {
    bufferList[i].copy(result, offset);
    offset += bufferList[i].length;
  }
  return result;
}

module.exports = {
  splitTextIntoSentences,
  createWavHeader,
  extractPcmFromWav,
  formatSrtTime,
  fastPcmConcat
};
