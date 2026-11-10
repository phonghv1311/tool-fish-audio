# Thiết kế Kỹ thuật: Tối ưu hóa Toàn diện Tốc độ Tạo Voice (Fish Audio TTS)

- **Ngày thiết kế:** 2026-11-10
- **Trạng thái:** Chờ phê duyệt (Pending Approval)
- **Tác giả:** Senior AI Developer

---

## 1. Mục tiêu & Chỉ số Hiệu năng (Performance Metrics)

| Chỉ số (Metric) | Hiện tại | Mục tiêu sau tối ưu | Tác động |
|---|---|---|---|
| **Thời gian bắt đầu nghe (TTFB - Time to First Audio)** | 3s - 8s (đợi full bài) | **< 0.6s** (phát ngay câu 1) | Trải nghiệm tức thì, không cảm giác chờ đợi |
| **Chi phí kết nối TLS/TCP mỗi câu** | 200ms - 350ms / request | **< 5ms** (tái sử dụng socket) | Giảm 90% độ trễ mạng |
| **Tốc độ tạo câu lặp lại (Cache Hit)** | ~1.5s (gọi lại API) | **< 1ms** | Tiết kiệm 100% quota và độ trễ = 0 |
| **Băng thông & Serialization** | Base64 (+33% overhead) | **Binary Stream / Native PCM** | Tiết kiệm RAM và CPU serialization |

---

## 2. Kiến trúc 4 Tầng Tối ưu Hóa

```
[Người dùng / Web UI / CLI]
           │
           ▼
┌─────────────────────────────────────────────────────────────┐
│  TẦNG 2: BỘ NHỚ ĐỆM LRU CACHE (RAM & Local File)            │
│  - Kiểm tra SHA-256(text + voice + model + speed + format)  │
│  - Nếu Cache Hit: Trả về Buffer âm thanh ngay (0ms)         │
└──────────────────────────┬──────────────────────────────────┘
                           │ (Cache Miss)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  TẦNG 1: HTTP KEEP-ALIVE CONNECTION POOL                    │
│  - Reusable https.Agent (maxSockets: 32, keepAlive: 60s)    │
│  - Giữ sẵn các đường hầm TLS 1.3 mở tới api.fish.audio      │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  TẦNG 3: PROGRESSIVE PIPELINING (STREAM & PHÁT NGAY)        │
│  - Web UI nhận Audio Chunk 1 và phát ngay lập tức           │
│  - Các Chunk 2..N tiếp tục tải ngầm song song 10 luồng      │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  TẦNG 4: ZERO-COPY BUFFER STITCHING & SRT REALTIME          │
│  - Bóc tách PCM và gộp 1 lần qua Buffer.allocUnsafe         │
│  - Tính toán SRT song song theo từng đoạn PCM đã hoàn thành │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Chi tiết Kỹ thuật từng Tầng

### 3.1. Tầng 1: HTTP Keep-Alive Agent Pool
- **Vấn đề:** Mặc định `https.request` tạo mới socket và chứng chỉ TLS cho mỗi HTTP request. Với 10-20 câu, mất 10-20 lần bắt tay TLS (~300ms mỗi lần).
- **Giải pháp:** Khởi tạo một singleton `https.Agent`:
  ```javascript
  const keepAliveAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 32,
    maxFreeSockets: 10,
    timeout: 60000,
    keepAliveMsecs: 30000
  });
  ```
- **Kết quả:** Các request song song chia sẻ các kết nối SSL ấm (warm sockets), giảm độ trễ mỗi chunk xuống chỉ còn độ trễ tính toán của Fish Audio API.

### 3.2. Tầng 2: Bộ nhớ đệm thông minh (LRU Memory Cache)
- **Cơ chế Hash:** Khóa cache là `sha256(JSON.stringify({ text, voice, model, format, speed, volume }))`.
- **Dung lượng an toàn:** Giới hạn tối đa 200 items hoặc 150MB trong bộ nhớ RAM để đảm bảo không xảy ra Out-of-Memory (OOM).
- **Thuật toán:** Least Recently Used (LRU) - tự động giải phóng mục ít dùng nhất khi đầy bộ đệm.
- **Tác dụng:** Khi người dùng đổi tốc độ hay thử lại câu vừa tạo, âm thanh xuất hiện tức thì trong 1 mili-giây.

### 3.3. Tầng 3: Progressive Audio Streaming (Phát ngay câu đầu)
- **Endpoint mới:** `POST /api/batch-stream` (sử dụng `Transfer-Encoding: chunked` hoặc NDJSON stream).
- **Dữ liệu truyền theo luồng:**
  - Ngay khi câu 1 hoàn tất -> Client nhận chunk 1 kèm thời lượng.
  - Client tự động xếp vào hàng đợi phát âm thanh tuần tự qua `AudioContext` hoặc danh sách phát liền mạch.
  - Phụ đề SRT cũng được cập nhật từng câu theo thời gian thực (Realtime Subtitle Feed).

### 3.4. Tầng 4: Ghép nối Buffer hiệu năng cao (Zero-Copy WAV Assembly)
- Tính toán trước tổng dung lượng PCM: `const totalLen = pcmList.reduce((acc, b) => acc + b.length, 0)`.
- Tạo một Buffer duy nhất và copy trực tiếp (`totalPcm.set(...)` / `copy`), tránh phân mảnh bộ nhớ của V8 Engine.

---

## 4. Đánh giá Bảo mật & Độ tin cậy (Security & Safety)

1. **Bảo mật Thông tin & Bí mật (Secrets Safety):**
   - Khóa cache SHA-256 không lưu API key.
   - Toàn bộ kết nối TLS tới `api.fish.audio` được xác thực chứng chỉ nghiêm ngặt.
2. **Chống cạn kiệt tài nguyên (Resource Exhaustion / DoS):**
   - LRU Cache có giới hạn trần cứng (150MB).
   - Giới hạn payload đầu vào tối đa 10MB và tối đa 15 luồng song song để tránh bị nhà cung cấp khóa IP.
3. **Độ ổn định khi có lỗi mạng:**
   - Cơ chế tự động thử lại 3 lần với Exponential Backoff khi gặp mã `429 Too Many Requests`.

---

## 5. Kế hoạch Kiểm thử & Đo lường (Verification & Benchmarks)

1. **Benchmark tốc độ:** Đo thời gian tạo văn bản 10 câu trước và sau tối ưu.
2. **Kiểm tra tính đúng đắn:** Xác nhận file WAV sau khi tối ưu vẫn mở hoàn hảo trên Premiere/CapCut/VLC.
3. **Kiểm tra tính đồng bộ SRT:** Đảm bảo thời gian phụ đề khớp chính xác từng mili-giây.

