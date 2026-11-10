# Fish Audio Text-to-Speech (TTS) Studio 🎙️

Hệ sinh thái ứng dụng chuyển đổi văn bản thành giọng nói chất lượng cao sử dụng **Fish Audio API** (`POST https://api.fish.audio/v1/tts`). Hỗ trợ xuất âm thanh phòng thu **WAV full bài** và file **phụ đề SRT** khớp thời gian chính xác từng khung hình.

---

## 📁 Cấu trúc dự án

```text
Tools/
├── server.js              # Backend proxy hỗ trợ tạo đơn & tạo full bài nối WAV + SRT
├── batch_synthesize.js    # CLI xuất âm thanh WAV/MP3 full bài kèm phụ đề SRT
├── cli.js                 # CLI tạo nhanh từng câu hoặc file ngắn
├── start.sh               # Script 1-click khởi chạy và mở ngay trên trình duyệt
├── Dockerfile             # File Docker đóng gói ứng dụng
├── public/
│   └── index.html         # Web UI Studio: Audio Player, Xem trước & Tải SRT, Thư viện giọng
├── package.json           # Cấu hình dự án & script khởi chạy
└── README.md              # Hướng dẫn chi tiết
```

---

## ✨ Tính năng mới: Xuất WAV Full Bài & Phụ đề SRT

1. **Chuẩn hóa ghép nối file WAV (RIFF/PCM 44.1kHz 16-bit):**
   - Tự động bóc tách luồng raw PCM từ các phân đoạn và tái cấu trúc Header 44-byte chuẩn xác tuyệt đối.
   - Không bị lỗi độ dài file hoặc giật lag khi nhập vào Premiere, CapCut, DaVinci Resolve, Audacity hay phát trên VLC.
2. **Xuất file phụ đề SRT (`.srt`) đồng bộ mili-giây:**
   - Tự động tính toán thời lượng phát từ số mẫu PCM (`bytes / byteRate`) cho độ chính xác 100%.
   - Định dạng chuẩn SubRip: `00:00:00,000 --> 00:00:03,120`.

---

## 🚀 Hướng dẫn sử dụng

### 1. Trên Giao diện Web Studio:
Khởi chạy server:
```bash
node server.js
```
👉 Truy cập: **[http://localhost:3000](http://localhost:3000)** (tự động chuyển sang 3001 nếu cổng 3000 bận)
- Nhập văn bản hoặc dán bài viết dài.
- Chọn **"Xuất Full Bài + SRT (.wav)"**.
- Sau khi xử lý xong, bạn có thể:
  - 🎵 Bấm **"Tải Audio (.wav)"** để tải file âm thanh full bài chất lượng cao.
  - 📄 Bấm **"Tải Phụ đề SRT (.srt)"** để tải phụ đề khớp chính xác với âm thanh.

### 2. Sử dụng dòng lệnh CLI (`batch_synthesize.js`):
Dành cho tự động hoá xử lý sách, truyện hoặc kịch bản video dài:
```bash
# Đọc file văn bản, xuất file WAV full bài và file SRT
node batch_synthesize.js -f script.txt --format wav -o full_audio.wav --srt subtitle.srt

# Sử dụng giọng đọc mẫu tiếng Việt (Lanh Cao) với tốc độ 1.1x
node batch_synthesize.js -t "Xin chào bạn. Đây là bài test xuất file WAV và SRT." -v 66467d32ee2f42a89281e019630309ed --format wav
```

---

## 🔑 Cấu hình API Key
- API Key mặc định: `sk-fish-XCsvD6WOqXziDuBmyCXUD-lDIujXF9aB2-dIysL4IyY`.
- Có thể thay đổi trực tiếp trên thanh công cụ Web hoặc cấu hình biến môi trường:
```bash
export FISH_API_KEY="sk-fish-your-key-here"
```
