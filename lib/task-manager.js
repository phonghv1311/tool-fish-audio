/**
 * lib/task-manager.js
 * Quản lý tác vụ tạo âm thanh quy mô lớn (> 2 Giờ), Checkpoint/Resume,
 * Streaming Disk Merge và Realtime Progress SSE Broadcast.
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const {
  splitTextIntoSentences,
  extractPcmFromWav,
  formatSrtTime,
  streamMergePcmToWav,
  streamMergeMp3Files
} = require('./audio');
const { ApiKeyPool, fetchTtsChunk } = require('./network');

class TaskManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.tasksDir = options.tasksDir || path.join(__dirname, '..', 'public', 'outputs', 'tasks');
    this.activeTasks = new Map(); // taskId -> { isPaused, isCancelled, ... }
    this.sseListeners = new Map(); // taskId -> Set<callback>

    if (!fs.existsSync(this.tasksDir)) {
      fs.mkdirSync(this.tasksDir, { recursive: true });
    }
  }

  getTaskDir(taskId) {
    return path.join(this.tasksDir, taskId);
  }

  getMetadataPath(taskId) {
    return path.join(this.getTaskDir(taskId), 'metadata.json');
  }

  async readMetadata(taskId) {
    try {
      const metaPath = this.getMetadataPath(taskId);
      if (!fs.existsSync(metaPath)) return null;
      const content = await fs.promises.readFile(metaPath, 'utf8');
      return JSON.parse(content);
    } catch (e) {
      return null;
    }
  }

  async writeMetadata(taskId, metadata) {
    try {
      metadata.updatedAt = Date.now();
      const metaPath = this.getMetadataPath(taskId);
      await fs.promises.writeFile(metaPath, JSON.stringify(metadata, null, 2), 'utf8');
    } catch (e) {
      console.warn(`Lỗi ghi metadata task ${taskId}:`, e.message);
    }
  }

  subscribe(taskId, listener) {
    if (!this.sseListeners.has(taskId)) {
      this.sseListeners.set(taskId, new Set());
    }
    this.sseListeners.get(taskId).add(listener);

    return () => {
      const set = this.sseListeners.get(taskId);
      if (set) {
        set.delete(listener);
        if (set.size === 0) this.sseListeners.delete(taskId);
      }
    };
  }

  emitTaskEvent(taskId, eventType, data) {
    const payload = { type: eventType, taskId, timestamp: Date.now(), ...data };
    this.emit(eventType, payload);

    const listeners = this.sseListeners.get(taskId);
    if (listeners && listeners.size > 0) {
      for (const fn of listeners) {
        try { fn(payload); } catch (e) {}
      }
    }
  }

  /**
   * Tạo task mới hoặc khởi động lại task đang dở
   */
  async createTask(params) {
    const text = (params.text || '').trim();
    if (!text) throw new Error('Văn bản không được để trống.');

    const taskId = params.taskId || `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const taskDir = this.getTaskDir(taskId);
    const chunksDir = path.join(taskDir, 'chunks');

    await fs.promises.mkdir(chunksDir, { recursive: true });

    const format = (params.format || 'mp3').toLowerCase();
    const model = params.model || 's2.1-pro-free';
    const voice = params.reference_id ? params.reference_id.trim() : '';
    const speed = params.prosody && typeof params.prosody.speed === 'number' ? params.prosody.speed : 1.0;
    const volume = params.prosody && typeof params.prosody.volume === 'number' ? params.prosody.volume : 0;
    const chunkSize = parseInt(params.chunkSize || '450', 10);
    const concurrency = Math.min(Math.max(parseInt(params.concurrency || '15', 10), 1), 50);
    const title = (params.title || '').trim() || 'Fish_Audio_Output';

    // Xử lý Multi-Key Pool
    const rawKeys = params.apiKeys || params.apiKey || process.env.FISH_API_KEY || '';
    const keyPool = new ApiKeyPool(rawKeys);

    // Tách văn bản thành danh sách chunks
    const chunkTexts = splitTextIntoSentences(text, chunkSize, false);
    if (!chunkTexts.length) throw new Error('Không thể phân tích đoạn văn bản.');

    let metadata = await this.readMetadata(taskId);
    if (!metadata) {
      metadata = {
        id: taskId,
        title,
        status: 'pending',
        format,
        model,
        voice,
        speed,
        volume,
        chunkSize,
        concurrency,
        totalChunks: chunkTexts.length,
        completedChunks: 0,
        failedChunks: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        audioUrl: null,
        srtUrl: null,
        duration: 0,
        fileSize: 0,
        chunks: chunkTexts.map((txt, idx) => ({
          index: idx,
          text: txt,
          status: 'pending',
          file: `chunks/chunk_${String(idx).padStart(4, '0')}.${format === 'wav' ? 'raw' : 'mp3'}`,
          duration: 0,
          size: 0
        }))
      };
      await this.writeMetadata(taskId, metadata);
    }

    // Đánh dấu active task
    this.activeTasks.set(taskId, {
      isPaused: false,
      isCancelled: false,
      keyPool,
      concurrency,
      startTime: Date.now()
    });

    // Kích hoạt worker xử lý nền không chặn luồng chính
    this._runTaskWorker(taskId, metadata).catch(err => {
      console.error(`Lỗi thực thi task ${taskId}:`, err);
      this.emitTaskEvent(taskId, 'error', { error: err.message });
    });

    return {
      taskId,
      totalChunks: chunkTexts.length,
      format,
      concurrency,
      keyCount: keyPool.getKeyCount()
    };
  }

  async pauseTask(taskId) {
    const active = this.activeTasks.get(taskId);
    if (active) active.isPaused = true;

    const meta = await this.readMetadata(taskId);
    if (meta && meta.status === 'processing') {
      meta.status = 'paused';
      await this.writeMetadata(taskId, meta);
      this.emitTaskEvent(taskId, 'status', { status: 'paused' });
    }
    return { success: true, status: 'paused' };
  }

  async resumeTask(taskId) {
    let active = this.activeTasks.get(taskId);
    const meta = await this.readMetadata(taskId);
    if (!meta) throw new Error('Task không tồn tại.');

    if (active) {
      active.isPaused = false;
      active.isCancelled = false;
    } else {
      const keyPool = new ApiKeyPool(meta.apiKeys || meta.apiKey || process.env.FISH_API_KEY || '');
      active = {
        isPaused: false,
        isCancelled: false,
        keyPool,
        concurrency: meta.concurrency || 15,
        startTime: Date.now()
      };
      this.activeTasks.set(taskId, active);
      this._runTaskWorker(taskId, meta).catch(err => {
        this.emitTaskEvent(taskId, 'error', { error: err.message });
      });
    }

    meta.status = 'processing';
    await this.writeMetadata(taskId, meta);
    this.emitTaskEvent(taskId, 'status', { status: 'processing' });
    return { success: true, status: 'processing' };
  }

  async cancelTask(taskId) {
    const active = this.activeTasks.get(taskId);
    if (active) {
      active.isCancelled = true;
      active.isPaused = false;
    }

    const meta = await this.readMetadata(taskId);
    if (meta) {
      meta.status = 'cancelled';
      await this.writeMetadata(taskId, meta);
      this.emitTaskEvent(taskId, 'status', { status: 'cancelled' });
    }
    this.activeTasks.delete(taskId);
    return { success: true, status: 'cancelled' };
  }

  /**
   * Bộ xử lý cốt lõi: Concurrency Worker + Checkpoint Resume + Stream Merge
   */
  async _runTaskWorker(taskId, metadata) {
    const active = this.activeTasks.get(taskId);
    if (!active) return;

    metadata.status = 'processing';
    await this.writeMetadata(taskId, metadata);
    this.emitTaskEvent(taskId, 'status', { status: 'processing', totalChunks: metadata.totalChunks });

    const taskDir = this.getTaskDir(taskId);
    const chunks = metadata.chunks;
    const keyPool = active.keyPool;
    const concurrency = active.concurrency;

    let masterSampleRate = 44100;
    let masterChannels = 1;
    let masterBits = 16;
    let nextIndex = 0;
    let completedCount = 0;
    const startTime = Date.now();

    // 1. Kiểm tra các chunks đã xong từ trước (Checkpoint Check)
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const filePath = path.join(taskDir, c.file);
      if (fs.existsSync(filePath)) {
        try {
          const stat = fs.statSync(filePath);
          if (stat.size > 0) {
            c.status = 'completed';
            c.size = stat.size;
            completedCount++;
          }
        } catch (e) {}
      }
    }

    metadata.completedChunks = completedCount;
    await this.writeMetadata(taskId, metadata);

    // 2. Định nghĩa Worker luồng
    const worker = async () => {
      while (true) {
        if (active.isCancelled) break;
        while (active.isPaused) {
          await new Promise(r => setTimeout(r, 500));
          if (active.isCancelled) return;
        }

        const currentIndex = nextIndex++;
        if (currentIndex >= chunks.length) break;

        const chunkItem = chunks[currentIndex];
        const chunkFilePath = path.join(taskDir, chunkItem.file);

        // Nếu chunk đã tồn tại trên đĩa cứng từ trước -> Bỏ qua, tận dụng Checkpoint!
        if (chunkItem.status === 'completed' && fs.existsSync(chunkFilePath)) {
          continue;
        }

        try {
          // Gọi API TTS qua KeyPool với cơ chế failover
          const audioBuffer = await fetchTtsChunk(chunkItem.text, {
            format: metadata.format,
            model: metadata.model,
            voice: metadata.voice,
            speed: metadata.speed,
            volume: metadata.volume,
            keyPool: keyPool
          }, 5);

          let chunkDuration = 0;
          if (metadata.format === 'wav') {
            const wavInfo = extractPcmFromWav(audioBuffer);
            masterSampleRate = wavInfo.sampleRate;
            masterChannels = wavInfo.numChannels;
            masterBits = wavInfo.bitsPerSample;
            chunkDuration = wavInfo.durationSec;
            // Ghi trực tiếp PCM thô ra đĩa (không lưu buffer trong RAM)
            await fs.promises.writeFile(chunkFilePath, wavInfo.pcmData);
          } else {
            // Định dạng MP3: Ghi trực tiếp ra file
            await fs.promises.writeFile(chunkFilePath, audioBuffer);
            chunkDuration = audioBuffer.length / 16000; // ~128kbps estimate
          }

          chunkItem.status = 'completed';
          chunkItem.duration = chunkDuration;
          chunkItem.size = audioBuffer.length;
          completedCount++;

          // Tính toán số liệu thống kê realtime
          const elapsedSec = (Date.now() - startTime) / 1000;
          const speed = completedCount / (elapsedSec || 1);
          const remainingChunks = chunks.length - completedCount;
          const etaSec = speed > 0 ? Math.round(remainingChunks / speed) : 0;
          const percent = Math.round((completedCount / chunks.length) * 100);

          metadata.completedChunks = completedCount;

          // Phát sự kiện SSE cho client
          this.emitTaskEvent(taskId, 'progress', {
            chunkIndex: currentIndex,
            completed: completedCount,
            total: chunks.length,
            percent,
            speed: speed.toFixed(2),
            eta: etaSec,
            keyStats: keyPool.getStats(),
            textPreview: chunkItem.text.substring(0, 60) + '...'
          });

          // Lưu metadata định kỳ mỗi 5 chunk
          if (completedCount % 5 === 0 || completedCount === chunks.length) {
            await this.writeMetadata(taskId, metadata);
          }
        } catch (err) {
          console.error(`Lỗi chunk ${currentIndex} task ${taskId}:`, err.message);
          chunkItem.status = 'failed';
          metadata.failedChunks = (metadata.failedChunks || 0) + 1;
        }
      }
    };

    // Chạy đồng thời N workers
    const threadCount = Math.min(concurrency, chunks.length);
    const workers = Array.from({ length: threadCount }, () => worker());
    await Promise.all(workers);

    if (active.isCancelled) {
      return;
    }

    if (active.isPaused) {
      return;
    }

    // 3. Sau khi hoàn thành toàn bộ chunks: Tiến hành STREAM DISK MERGE (Zero-RAM Overhead)
    this.emitTaskEvent(taskId, 'merging', { message: 'Đang hợp nhất file âm thanh cực nhanh trực tiếp trên SSD...' });

    const safeTitle = (metadata.title || 'speech').replace(/[^a-zA-Z0-9_\-\u00C0-\u024F\u1EA0-\u1EF9]/g, '_');
    const finalAudioName = `${safeTitle}_${taskId}.${metadata.format}`;
    const finalSrtName = `${safeTitle}_${taskId}.srt`;

    const finalAudioPath = path.join(path.dirname(this.tasksDir), finalAudioName);
    const finalSrtPath = path.join(path.dirname(this.tasksDir), finalSrtName);

    const chunkFiles = chunks
      .sort((a, b) => a.index - b.index)
      .map(c => path.join(taskDir, c.file));

    // A. Ghép Audio không tràn RAM
    let totalAudioSize = 0;
    if (metadata.format === 'wav') {
      const result = await streamMergePcmToWav(chunkFiles, finalAudioPath, masterSampleRate, masterChannels, masterBits);
      totalAudioSize = result.totalDataLength + 44;
    } else {
      const result = await streamMergeMp3Files(chunkFiles, finalAudioPath);
      totalAudioSize = result.totalSize;
    }

    // B. Tạo file phụ đề SRT
    const srtLines = [];
    let currentTime = 0;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const startStr = formatSrtTime(currentTime);
      const endTime = currentTime + (c.duration || 0);
      const endStr = formatSrtTime(endTime);
      srtLines.push(`${i + 1}\n${startStr} --> ${endStr}\n${c.text}\n`);
      currentTime = endTime;
    }
    const srtContent = srtLines.join('\n');
    await fs.promises.writeFile(finalSrtPath, srtContent, 'utf8');

    // C. Cập nhật hoàn tất vào Metadata
    metadata.status = 'completed';
    metadata.duration = currentTime;
    metadata.formattedDuration = formatSrtTime(currentTime);
    metadata.fileSize = totalAudioSize;
    metadata.audioUrl = `/outputs/${finalAudioName}`;
    metadata.srtUrl = `/outputs/${finalSrtName}`;
    await this.writeMetadata(taskId, metadata);

    this.activeTasks.delete(taskId);

    // D. Phát sự kiện Complete
    this.emitTaskEvent(taskId, 'completed', {
      audioUrl: metadata.audioUrl,
      srtUrl: metadata.srtUrl,
      duration: metadata.duration,
      formattedDuration: metadata.formattedDuration,
      fileSize: metadata.fileSize,
      totalChunks: metadata.totalChunks
    });
  }

  /**
   * Tự động dọn dẹp task cũ hơn maxAgeMs (mặc định 24h)
   */
  async cleanOldTasks(maxAgeMs = 24 * 60 * 60 * 1000) {
    try {
      if (!fs.existsSync(this.tasksDir)) return;
      const entries = await fs.promises.readdir(this.tasksDir);
      const now = Date.now();

      for (const entry of entries) {
        const full = path.join(this.tasksDir, entry);
        try {
          const stat = await fs.promises.stat(full);
          if (stat.isDirectory() && now - stat.mtimeMs > maxAgeMs) {
            await fs.promises.rm(full, { recursive: true, force: true });
          }
        } catch (e) {}
      }
    } catch (err) {
      console.warn('Lỗi khi dọn dẹp tasks cũ:', err.message);
    }
  }
}

// Singleton global task manager
const globalTaskManager = new TaskManager();

module.exports = { TaskManager, globalTaskManager };
