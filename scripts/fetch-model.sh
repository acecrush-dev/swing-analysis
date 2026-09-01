#!/usr/bin/env bash
# Ensure every model file backend/core/{analyze_swing,gen_skeleton_anim}.py
# needs is present and not a Git LFS pointer.
#
# Three model families:
#   1. backend/models/pose_landmarker_lite.task   (5.5 MB, committed directly)
#   2. backend/models/rtmdet-m-487628.onnx        (104 MB, Git LFS)
#   3. backend/models/rtmpose-m-27c0e6.onnx       ( 52 MB, Git LFS)
#
# (1) is shipped in the repo so a fresh clone runs out of the box. (2) and (3)
# live in Git LFS — `git clone` without `git lfs pull` gives you a 134-byte
# pointer text file, not the real ONNX binary, and the loaders will fail.
# This script:
#   - always refreshes (1) from MediaPipe's CDN if it's missing
#   - always checks (2)/(3) for LFS pointers and runs `git lfs pull` to
#     materialise them. If git-lfs isn't installed, prints a clear instruction.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
MODELS_DIR="$ROOT/backend/models"
mkdir -p "$MODELS_DIR"

LITE="$MODELS_DIR/pose_landmarker_lite.task"
RTMDET="$MODELS_DIR/rtmdet-m-487628.onnx"
RTMPOSE="$MODELS_DIR/rtmpose-m-27c0e6.onnx"

# ── 1. MediaPipe lite ────────────────────────────────────────────────────
if [[ -f "$LITE" ]] && [[ $(stat -f%z "$LITE" 2>/dev/null || echo 0) -gt 1000000 ]]; then
    echo "[fetch-model] MediaPipe lite 已就位 $LITE ($(du -h "$LITE" | cut -f1))"
else
    URL="https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"
    echo "[fetch-model] 下载 MediaPipe lite ← $URL"
    curl -fL --retry 3 -o "$LITE" "$URL"
    echo "[fetch-model] 写入 $LITE ($(du -h "$LITE" | cut -f1))"
fi

# ── 2 & 3. RTMDet + RTMPose ONNX (Git LFS) ──────────────────────────────
# An LFS pointer text file is ~130 bytes and starts with
# "version https://git-lfs.github.com/spec/v1". If we see one, the file
# hasn't been fetched via LFS yet.
is_lfs_pointer() {
    local f="$1"
    [[ ! -f "$f" ]] && return 1
    local sz
    sz=$(stat -f%z "$f" 2>/dev/null || echo 0)
    if [[ "$sz" -lt 100000 ]]; then
        head -1 "$f" 2>/dev/null | grep -q "git-lfs.github.com/spec/v1" && return 0
    fi
    return 1
}

needs_lfs=0
for f in "$RTMDET" "$RTMPOSE"; do
    if is_lfs_pointer "$f"; then
        echo "[fetch-model] $f 是 LFS 指针文本 ($(stat -f%z "$f") bytes) — 需要 git lfs pull"
        needs_lfs=1
    fi
done

if [[ "$needs_lfs" -eq 1 ]]; then
    if ! command -v git-lfs >/dev/null 2>&1 && ! git lfs version >/dev/null 2>&1; then
        echo ""
        echo "ERROR: 检测到 LFS 指针文件但 git-lfs 未安装。"
        echo "  安装: brew install git-lfs  (或 apt-get install git-lfs)"
        echo "  然后: git lfs install && git lfs pull"
        echo "  或手动下载 RTMDet-M + RTMPose-M 的 .onnx 放到 $MODELS_DIR/"
        exit 1
    fi
    echo "[fetch-model] 运行 git lfs pull..."
    (cd "$ROOT" && git lfs pull --include="backend/models/*.onnx")
    echo "[fetch-model] git lfs pull 完成"
fi

# ── 总结 ──────────────────────────────────────────────────────────────────
echo ""
echo "[fetch-model] 模型状态:"
for f in "$LITE" "$RTMDET" "$RTMPOSE"; do
    if [[ -f "$f" ]]; then
        sz=$(du -h "$f" | cut -f1)
        if is_lfs_pointer "$f"; then
            echo "  ✗ $f  ($sz)  ← 仍是 LFS pointer,git lfs pull 未生效"
        else
            echo "  ✓ $f  ($sz)"
        fi
    else
        echo "  ✗ $f  (missing)"
    fi
done