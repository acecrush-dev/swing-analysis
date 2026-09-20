# Changelog

> Keep a Changelog, simplified; semver tag convention. English edition — 中文版见 [CHANGELOG.md](CHANGELOG.md).
>
> GitHub Release bodies are extracted from the Chinese edition (CHANGELOG.md)
> by the `release` workflow; swap in this file manually when an English
> release body is wanted.

## [Unreleased]

Nothing yet.

## [1.0.0] — 2026-09-09 · Beta

### About this release

AceCrush Swing-Analysis is a **desktop app that automatically finds and cuts
tennis swings** from practice video. 1.0.0 is the first public beta: a
battle-tested segmentation pipeline wrapped into a full desktop application —
it detects every swing, cuts it into a standalone clip, and renders a
skeleton-overlay preview so you can review technique frame by frame.

**What you can do in this version:**

- **Automated segmentation** — MediaPipe pose tracking feeds a right-wrist
  velocity signal into peak picking: adjacent peaks auto-merged,
  duration-filtered, buffer-padded on both sides — no manual timeline
  scrubbing.
- **Skeleton overlay preview (viz)** — one-click mp4 per swing with the pose
  skeleton drawn over the original footage; play inline or download.
- **Clip export** — every detected swing is cut into its own H.264 mp4;
  `segments.json` carries the full timing data for further analysis.
- **Dual pipeline modes** — `SWING_BACKEND=python` (Python sidecar service)
  or `SWING_BACKEND=ts` (in-app TypeScript pipeline); both drive the same
  unified interface, so switching modes changes nothing about how you use
  the app.

**Privacy & data**: all analysis runs locally (local sidecar service or
in-app WASM pipeline) — videos are never uploaded.

**Availability**: installers via GitHub Releases — macOS (Apple silicon &
Intel), Windows 10/11 x64, Linux (AppImage / deb).

**Known beta limitations:**

- The macOS Intel build (`mac-x64.dmg`) is larger than it needs to be
  (~1 GB vs ~450 MB for Apple silicon) — harmless dead weight; it will slim
  down in the next release
- Features and behavior may change between releases during beta

### Added

- Automated swing segmentation from right-wrist velocity signal (MediaPipe pose at 30 fps, adjacent-peak merging, duration filtering, buffer padding)
- Skeleton overlay preview (viz): one-click pose-overlay mp4 per swing, playable inline or downloadable
- Clip export: each swing cut into its own H.264 mp4; `segments.json` carries full timing data
- Dual pipeline modes: `SWING_BACKEND=python` (Python sidecar) or `SWING_BACKEND=ts` (in-app TypeScript pipeline), same unified interface
- Cross-platform installers: macOS (Apple silicon & Intel dmg), Windows 10/11 x64, Linux (AppImage / deb)

### Notes

- The macOS Intel build (`mac-x64.dmg`) is larger than it needs to be (~1 GB vs ~450 MB for Apple silicon) — harmless dead weight inside the package; it will slim down in the next release

[Unreleased]: https://github.com/acecrush-dev/swing-analysis-app/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/acecrush-dev/swing-analysis-app/releases/tag/v1.0.0
