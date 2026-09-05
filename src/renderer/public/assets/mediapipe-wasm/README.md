# MediaPipe wasm runtime (self-hosted)

Copied verbatim from `node_modules/@mediapipe/tasks-vision/wasm/`
(version pinned in package.json — re-copy after upgrading the package).

**Why self-hosted instead of the jsdelivr CDN:**

1. The app's CSP only allows `connect-src 'self'` + `127.0.0.1` — a CDN
   fetch is blocked outright.
2. The packaged app must work offline (`file://` renderer, no network
   dependency at model-load time).
3. CDN reachability is region-dependent (jsdelivr is unreliable in
   mainland China).

`FilesetResolver.forVisionTasks()` appends literal filenames to the base
URL passed by `src/renderer/src/lib/modelLoader.ts`, so all six files
must stay flat in this directory:

| File                              | Used when                    |
| --------------------------------- | ---------------------------- |
| `vision_wasm_internal.{js,wasm}`  | WASM SIMD available (normal) |
| `vision_wasm_nosimd_internal.*`   | no SIMD (defensive fallback) |
| `vision_wasm_module_internal.*`   | module-style loader variant  |
