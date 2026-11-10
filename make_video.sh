#!/usr/bin/env bash
# ==============================================================================
# Script tạo Video MP4 tự động từ file Audio (.wav/.mp3) và Phụ đề (.srt)
# Hỗ trợ 2 tỷ lệ khung hình:
#   - 16:9 (1920x1080) cho YouTube / Facebook / Web
#   - 9:16 (1080x1920) cho TikTok / YouTube Shorts / Reels
# ==============================================================================

set -e

AUDIO_FILE=""
SRT_FILE=""
OUTPUT_FILE=""
RATIO="16:9" # 16:9 hoặc 9:16
BG_COLOR="0x0b0f17"
WAVE_COLOR="0x38bdf8"

print_usage() {
    echo "🎬 Fish Audio Video & Audiogram Generator"
    echo ""
    echo "Cách dùng:"
    echo "  ./make_video.sh -a <audio_file> [-s <srt_file>] [-o <output.mp4>] [-r <16:9|9:16>]"
    echo ""
    echo "Tùy chọn:"
    echo "  -a, --audio <path>    Đường dẫn file âm thanh (.wav hoặc .mp3)"
    echo "  -s, --srt <path>      Đường dẫn file phụ đề (.srt)"
    echo "  -o, --out <path>      File MP4 đầu ra (Mặc định: <tên_audio>.mp4)"
    echo "  -r, --ratio <ratio>   Tỷ lệ video: 16:9 hoặc 9:16 (Mặc định: 16:9)"
    echo "  -h, --help            Hiển thị trợ giúp"
    echo ""
    echo "Ví dụ:"
    echo "  ./make_video.sh -a speech.wav -s speech.srt -o video.mp4"
    echo "  ./make_video.sh -a speech.wav -s speech.srt -r 9:16 -o tiktok.mp4"
    exit 1
}

while [[ $# -gt 0 ]]; do
    case $1 in
        -a|--audio) AUDIO_FILE="$2"; shift 2 ;;
        -s|--srt)   SRT_FILE="$2"; shift 2 ;;
        -o|--out)   OUTPUT_FILE="$2"; shift 2 ;;
        -r|--ratio) RATIO="$2"; shift 2 ;;
        -h|--help)  print_usage ;;
        *) echo "Tùy chọn không hợp lệ: $1"; print_usage ;;
    esac
done

if [ -z "$AUDIO_FILE" ]; then
    echo "❌ Lỗi: Vui lòng chỉ định file âm thanh qua -a <file.wav>"
    print_usage
fi

if [ ! -f "$AUDIO_FILE" ]; then
    echo "❌ Lỗi: File âm thanh không tồn tại: $AUDIO_FILE"
    exit 1
fi

# Tự động tìm file SRT nếu không truyền
if [ -z "$SRT_FILE" ]; then
    BASE_NO_EXT="${AUDIO_FILE%.*}"
    if [ -f "${BASE_NO_EXT}.srt" ]; then
        SRT_FILE="${BASE_NO_EXT}.srt"
        echo "💡 Tự động phát hiện file phụ đề: $SRT_FILE"
    fi
fi

# Tên file xuất mặc định
if [ -z "$OUTPUT_FILE" ]; then
    BASE_NO_EXT="${AUDIO_FILE%.*}"
    OUTPUT_FILE="${BASE_NO_EXT}.mp4"
fi

# Cấu hình độ phân giải theo tỷ lệ
if [ "$RATIO" == "9:16" ]; then
    WIDTH=1080
    HEIGHT=1920
    WAVE_HEIGHT=400
else
    WIDTH=1920
    HEIGHT=1080
    WAVE_HEIGHT=300
fi

echo "=================================================="
echo "🎬 Đang tạo Video Audiogram..."
echo "🎵 Audio:      $AUDIO_FILE"
echo "📄 Phụ đề:     ${SRT_FILE:-Không kèm}"
echo "📐 Tỷ lệ:      $RATIO (${WIDTH}x${HEIGHT})"
echo "💾 Video đích: $OUTPUT_FILE"
echo "=================================================="

# Lệnh ffmpeg tạo sóng âm thanh sống động (Showwaves + Color Background)
if [ -n "$SRT_FILE" ] && [ -f "$SRT_FILE" ]; then
    # Xuất kèm phụ đề soft-sub hoặc hard-sub
    ffmpeg -y -i "$AUDIO_FILE" \
        -f lavfi -i "color=c=${BG_COLOR}:s=${WIDTH}x${HEIGHT}:r=30" \
        -filter_complex "[0:a]showwaves=s=${WIDTH}x${WAVE_HEIGHT}:mode=cline:colors=${WAVE_COLOR}:rate=30[waves]; [1:v][waves]overlay=(W-w)/2:(H-h)/2[v]" \
        -map "[v]" -map 0:a \
        -i "$SRT_FILE" -c:s mov_text \
        -c:v libx264 -preset fast -pix_fmt yuv420p \
        -c:a aac -b:a 192k \
        -shortest "$OUTPUT_FILE"
else
    ffmpeg -y -i "$AUDIO_FILE" \
        -f lavfi -i "color=c=${BG_COLOR}:s=${WIDTH}x${HEIGHT}:r=30" \
        -filter_complex "[0:a]showwaves=s=${WIDTH}x${WAVE_HEIGHT}:mode=cline:colors=${WAVE_COLOR}:rate=30[waves]; [1:v][waves]overlay=(W-w)/2:(H-h)/2[v]" \
        -map "[v]" -map 0:a \
        -c:v libx264 -preset fast -pix_fmt yuv420p \
        -c:a aac -b:a 192k \
        -shortest "$OUTPUT_FILE"
fi

echo "=================================================="
echo "🎉 Tạo Video MP4 thành công!"
echo "📁 Vị trí file: $(pwd)/$OUTPUT_FILE"
echo "=================================================="

