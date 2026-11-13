const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const { globalTaskManager } = require('../lib/task-manager');

async function testTaskManagerCreationAndEvents() {
  console.log('🧪 Starting Task Engine Integration Test...');

  const sampleText = 'Đoạn văn thứ nhất để kiểm tra hệ thống. Đoạn văn thứ hai để kiểm tra hệ thống đa luồng.';
  const taskRes = await globalTaskManager.createTask({
    text: sampleText,
    apiKey: 'sk-test-dummy-key',
    model: 's2.1-pro-free',
    format: 'mp3',
    chunkSize: 40,
    concurrency: 2,
    title: 'Test_Integration_Audio'
  });

  assert(taskRes.taskId, 'Task ID must be created');
  assert.strictEqual(taskRes.format, 'mp3');
  assert(taskRes.totalChunks >= 2, 'Total chunks should be >= 2');
  console.log(`✅ Task created successfully: ${taskRes.taskId} (${taskRes.totalChunks} chunks)`);

  // Check metadata saved on disk
  const meta = await globalTaskManager.readMetadata(taskRes.taskId);
  assert(meta, 'Metadata file must exist on disk');
  assert.strictEqual(meta.id, taskRes.taskId);
  assert.strictEqual(meta.title, 'Test_Integration_Audio');
  console.log('✅ Metadata persisted on disk');

  // Test Pause
  const pauseRes = await globalTaskManager.pauseTask(taskRes.taskId);
  assert.strictEqual(pauseRes.status, 'paused');
  console.log('✅ Pause action passed');

  // Test Resume
  const resumeRes = await globalTaskManager.resumeTask(taskRes.taskId);
  assert.strictEqual(resumeRes.status, 'processing');
  console.log('✅ Resume action passed');

  // Test Cancel
  const cancelRes = await globalTaskManager.cancelTask(taskRes.taskId);
  assert.strictEqual(cancelRes.status, 'cancelled');
  console.log('✅ Cancel action passed');

  // Clean up test task folder
  const taskDir = globalTaskManager.getTaskDir(taskRes.taskId);
  if (fs.existsSync(taskDir)) {
    fs.rmSync(taskDir, { recursive: true, force: true });
  }

  console.log('🎉 Task Engine Integration Test completed successfully!');
}

testTaskManagerCreationAndEvents().catch(err => {
  console.error('❌ Integration test failed:', err);
  process.exit(1);
});
