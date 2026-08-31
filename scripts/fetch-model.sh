#!/usr/bin/env bash
# Fetch pose_landmarker_lite.task into backend/models/.
# Prefers copying from ace-crush-lab (no download); falls back to MediaPipe CDN.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
MODELS_DIR="$ROOT/backend/models"
mkdir -p "$MODELS_DIR"

DEST="$MODELS_DIR/pose_landmarker_lite.task"
SRC="/Users/leo/Documents/codes/ai/ace-crush-lab/app/scripts/pose_landmarker_lite.task"

if [[ -f "$DEST" ]]; then
    echo "[fetch-model] 已存在 $DEST"
    exit 0
fi

if [[ -f "$SRC" ]]; then
    echo "[fetch-model] 从 ace-crush-lab 拷贝 lite 模型"
    cp "$SRC" "$DEST"
    exit 0
fi

URL="https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"
echo "[fetch-model] 下载 $URL"
curl -fL --retry 3 -o "$DEST" "$URL"
echo "[fetch-model] 写入 $DEST"