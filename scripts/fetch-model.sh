#!/usr/bin/env bash
# Ensure backend/models/pose_landmarker_lite.task is present.
# The file is committed to the repo (5.5 MB) — this script is only a fallback
# for fresh clones that somehow lost it, or for users who want to refresh from
# upstream MediaPipe CDN.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
MODELS_DIR="$ROOT/backend/models"
mkdir -p "$MODELS_DIR"

DEST="$MODELS_DIR/pose_landmarker_lite.task"
SRC="/Users/leo/Documents/codes/ai/ace-crush-lab/app/scripts/pose_landmarker_lite.task"

if [[ -f "$DEST" ]]; then
    echo "[fetch-model] 已就位 $DEST ($(du -h "$DEST" | cut -f1))"
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