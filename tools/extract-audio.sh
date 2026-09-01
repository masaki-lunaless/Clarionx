#!/usr/bin/env bash
# 監視カメラからダウンロードした映像を、Whisper向けの音声に一括変換する。
# 使い方: ./tools/extract-audio.sh <入力ディレクトリ> [出力ディレクトリ]
#
# 16kHz・モノラルのWAVに落とす。70時間でも8GB程度に収まるが、Whisper APIは
# 1ファイル25MBまでなので、長い録画はセッション単位（-segment_time）で分割する。
set -euo pipefail

IN_DIR="${1:?入力ディレクトリを指定してください}"
OUT_DIR="${2:-./audio}"
SEGMENT_SECONDS="${SEGMENT_SECONDS:-900}"   # 15分ごとに分割（≒25MB以下）

mkdir -p "$OUT_DIR"

shopt -s nullglob nocaseglob
for src in "$IN_DIR"/*.{mp4,mov,mkv,avi}; do
  base="$(basename "${src%.*}")"
  echo "▶ $base"
  ffmpeg -hide_banner -loglevel error -i "$src" \
    -vn -acodec pcm_s16le -ar 16000 -ac 1 \
    -f segment -segment_time "$SEGMENT_SECONDS" -reset_timestamps 1 \
    "$OUT_DIR/${base}_%03d.wav"
done

echo "完了: $OUT_DIR"
ls -lh "$OUT_DIR" | tail -n +2 | head -20
