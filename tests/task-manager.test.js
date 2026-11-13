const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ApiKeyPool } = require('../lib/network');
const {
  splitTextIntoSentences,
  createWavHeader,
  extractPcmFromWav,
  stripId3v2,
  streamMergePcmToWav,
  streamMergeMp3Files
} = require('../lib/audio');
const { TaskManager } = require('../lib/task-manager');

async function runTests() {
  console.log('🧪 Starting Task Manager & Stream Merge Tests...');

  // 1. Test ApiKeyPool
  const pool = new ApiKeyPool('key_1, key_2, key_3');
  assert.strictEqual(pool.getKeyCount(), 3, 'Key count must be 3');
  assert.strictEqual(pool.getNextKey(), 'key_1');
  assert.strictEqual(pool.getNextKey(), 'key_2');
  assert.strictEqual(pool.getNextKey(), 'key_3');
  assert.strictEqual(pool.getNextKey(), 'key_1');

  // Test Cooldown
  pool.reportRateLimit('key_1', 1000);
  assert.strictEqual(pool.getStats().coolingKeys, 1);
  const next = pool.getNextKey();
  assert(next === 'key_2' || next === 'key_3', 'Should skip cooling key_1');
  console.log('✅ ApiKeyPool passed');

  // 2. Test stripId3v2
  const dummyPcm = Buffer.from('hello audio world');
  assert.strictEqual(stripId3v2(dummyPcm), dummyPcm);

  // Fake ID3 tag (10 bytes header: 'ID3', ver 3, rev 0, flags 0, size 4 syncsafe = 4 bytes tag body)
  const fakeId3 = Buffer.alloc(14);
  fakeId3.write('ID3', 0);
  fakeId3[3] = 3;
  fakeId3[9] = 4; // 4 bytes body
  fakeId3.write('TIT2', 10);
  const fullWithId3 = Buffer.concat([fakeId3, dummyPcm]);
  const stripped = stripId3v2(fullWithId3);
  assert.strictEqual(stripped.toString(), dummyPcm.toString());
  console.log('✅ stripId3v2 passed');

  // 3. Test Stream Disk Merge WAV
  const testDir = path.join(__dirname, 'temp_test_audio');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

  const chunk1Path = path.join(testDir, 'chunk1.raw');
  const chunk2Path = path.join(testDir, 'chunk2.raw');
  const outWavPath = path.join(testDir, 'merged.wav');

  const pcm1 = Buffer.alloc(1000, 0x11);
  const pcm2 = Buffer.alloc(2000, 0x22);
  fs.writeFileSync(chunk1Path, pcm1);
  fs.writeFileSync(chunk2Path, pcm2);

  const mergeRes = await streamMergePcmToWav([chunk1Path, chunk2Path], outWavPath, 44100, 1, 16);
  assert.strictEqual(mergeRes.totalDataLength, 3000);

  const mergedStat = fs.statSync(outWavPath);
  assert.strictEqual(mergedStat.size, 3044); // 44 bytes header + 3000 bytes PCM

  const wavInfo = extractPcmFromWav(fs.readFileSync(outWavPath));
  assert.strictEqual(wavInfo.pcmData.length, 3000);
  console.log('✅ streamMergePcmToWav passed');

  // 4. Test Stream Disk Merge MP3
  const chunkMp3_1 = path.join(testDir, 'chunk1.mp3');
  const chunkMp3_2 = path.join(testDir, 'chunk2.mp3');
  const outMp3Path = path.join(testDir, 'merged.mp3');

  fs.writeFileSync(chunkMp3_1, Buffer.from('mp3-frame-part-1'));
  fs.writeFileSync(chunkMp3_2, Buffer.concat([fakeId3, Buffer.from('-part-2')]));

  await streamMergeMp3Files([chunkMp3_1, chunkMp3_2], outMp3Path);
  const mergedMp3Content = fs.readFileSync(outMp3Path).toString();
  assert.strictEqual(mergedMp3Content, 'mp3-frame-part-1-part-2');
  console.log('✅ streamMergeMp3Files passed');

  // Dọn dẹp temp test
  fs.rmSync(testDir, { recursive: true, force: true });

  console.log('🎉 All Task Manager & Stream Merge tests passed successfully!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
