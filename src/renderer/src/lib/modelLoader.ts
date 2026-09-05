/**
 * Renderer-side model loader for TS backend mode (Phase 2+).
 *
 * `SWING_BACKEND=ts` skips the Python sidecar entirely; this module is
 * the in-renderer replacement. It loads the same ONNX / MediaPipe files
 * the Python backend uses (via symlinks under `public/assets/models/`),
 * exposes a tiny event API for the StatusBar to subscribe to, and
 * provides ready-to-call runners for the actual inference operations
 * (Phase 3 will land the segmentation algorithm port that uses them).
 *
 * Loader contract — three independent loaders, each:
 *   - Sets its model state to 'loading' → runs the async load
 *   - On success: 'ready', and stores the runner in `_runs[name]`
 *   - On failure: 'failed', stores the error message
 *   - Fires `notify()` after every state change so subscribers update
 *
 * Concurrency: loadAll() runs the three loaders in parallel via
 * Promise.allSettled (we don't want mediapipe's wasm download failure
 * to block rtmdet). Each loader is idempotent — calling loadX()
 * twice is safe; the second call short-circuits if the runner is
 * already cached.
 *
 * Phase 1 only wires the StatusBar to the loading state. Phase 2+ will
 * add a video-frame extraction step (WebCodecs API) and the actual
 * detection calls (rtmdet.detect(frame), rtmpose.pose(frame, box),
 * mediapipe.pose(frame, tsMs)).
 */
import * as ort from 'onnxruntime-web';
import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
// Explicit `?url` imports make Vite emit the ORT runtime binaries as
// assets and hand us their runtime URLs — in dev they point at the
// served node_modules file, in the packaged build at ./assets/*. Both
// work offline; nothing is fetched from a CDN. (The sub-paths are
// exported by the package's exports map WITHOUT the dist/ prefix; the
// assetFileNames override in electron.vite.config.ts keeps the emitted
// filenames stable/unhashed.)
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';

// ── Asset URL resolution ──────────────────────────────────────────────────
// Every runtime asset URL MUST be resolved against `document.baseURI`,
// never written as a root-absolute "/assets/..." path. The packaged app
// loads its renderer via `file://` (see loadMainWindow → loadFile); on a
// file:// page a root-absolute path resolves to `file:///assets/...`
// (filesystem root) and fetch() rejects it — every model would fail with
// "Failed to fetch". Document-relative URLs work in BOTH dev (vite dev
// server serves public/ at the origin root) and packaged (public/ is
// copied next to index.html, so ./assets/... is a real sibling).
// Verified empirically on Electron 44: relative file:// fetch → 200,
// root-absolute → "Failed to fetch".
const ASSETS_BASE = new URL('assets/', document.baseURI);

// ORT resolves its loader module and wasm binary through wasmPaths. The
// object form pins BOTH files explicitly: the .mjs is dynamically
// imported by ORT, and the .wasm is located via locateFile(). Resolved
// against document.baseURI so they work under file:// too.
ort.env.wasm.wasmPaths = {
  mjs: new URL(ortMjsUrl, document.baseURI).href,
  wasm: new URL(ortWasmUrl, document.baseURI).href,
};

export type ModelName = 'rtmdet' | 'rtmpose' | 'mediapipe';
export type ModelState = 'pending' | 'loading' | 'ready' | 'failed';

interface ModelPaths {
  /** Absolute runtime URL (resolved against document.baseURI). */
  url: string;
}

const PATHS: Record<ModelName, ModelPaths> = {
  rtmdet:    { url: new URL('models/rtmdet-m-487628.onnx', ASSETS_BASE).toString() },
  rtmpose:   { url: new URL('models/rtmpose-m-27c0e6.onnx', ASSETS_BASE).toString() },
  mediapipe: { url: new URL('models/pose_landmarker_lite.task', ASSETS_BASE).toString() },
};

// MediaPipe's wasm glue + binary, self-hosted from public/assets/
// mediapipe-wasm/ (copied from node_modules/@mediapipe/tasks-vision/wasm
// — see that directory's README). A CDN is not an option: the app's CSP
// only allows connect-src 'self' + 127.0.0.1, and the app must work
// offline anyway. FilesetResolver.forVisionTasks appends the literal
// filenames `vision_wasm[_module|_nosimd]_internal.{js,wasm}` to this
// base, so all six dist files must exist there.
const MEDIAPIPE_WASM_BASE = new URL('mediapipe-wasm/', ASSETS_BASE).toString();

// ── State ──────────────────────────────────────────────────────────────────
interface ModelEntry {
  state: ModelState;
  // For ONNX: the InferenceSession. For mediapipe: the PoseLandmarker.
  runner?: any;
  // Error message if state === 'failed'.
  error?: string;
  // Bytes the model consumed (informational; helps the user see if
  // something came down way too small — e.g. an HTML error page
  // served in place of a 200 OK).
  bytes?: number;
}

const _state: Record<ModelName, ModelEntry> = {
  rtmdet:    { state: 'pending' },
  rtmpose:   { state: 'pending' },
  mediapipe: { state: 'pending' },
};

const _listeners = new Set<(s: Record<ModelName, ModelEntry>) => void>();

function notify() {
  // Snapshot so subscribers can compare without race risk.
  const snap: Record<ModelName, ModelEntry> = {
    rtmdet:    { ..._state.rtmdet },
    rtmpose:   { ..._state.rtmpose },
    mediapipe: { ..._state.mediapipe },
  };
  for (const cb of _listeners) cb(snap);
}

function setState(name: ModelName, patch: Partial<ModelEntry>) {
  _state[name] = { ..._state[name], ...patch };
  // One console line per transition — the ts-mode pipeline has no
  // sidecar stderr to grep, so this is the primary diagnostics trail
  // (visible via ELECTRON_ENABLE_LOGGING=1 and devtools).
  const e = _state[name];
  const detail = e.error ? ` — ${e.error}` : e.bytes ? ` (${(e.bytes / 1048576).toFixed(1)} MB)` : '';
  console.info(`[modelLoader] ${name}: ${e.state}${detail}`);
  notify();
}

export function subscribe(cb: (s: Record<ModelName, ModelEntry>) => void): () => void {
  _listeners.add(cb);
  // Push current snapshot immediately so the subscriber doesn't have to
  // wait for the next load to render anything.
  cb({
    rtmdet:    { ..._state.rtmdet },
    rtmpose:   { ..._state.rtmpose },
    mediapipe: { ..._state.mediapipe },
  });
  return () => { _listeners.delete(cb); };
}

export function getEntry(name: ModelName): ModelEntry {
  return { ..._state[name] };
}

export function getRunner<T = any>(name: ModelName): T | undefined {
  return _state[name].runner as T | undefined;
}

// ── HEAD probe ─────────────────────────────────────────────────────────────
// Probe with HEAD to check the file is reachable + above the LFS-pointer
// size floor (134 B). Vite's dev server can be flaky about returning
// Content-Length on HEAD for symlinked files — fall back to a tiny GET
// range read if Content-Length is missing or zero.
async function probeSize(url: string, minBytes = 256 * 1024): Promise<number> {
  // Try HEAD first — the cheap path when the server cooperates.
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (head.ok) {
      const len = Number(head.headers.get('content-length') ?? '0');
      if (len >= minBytes) return len;
      // Content-Length missing or too small — try a small range GET
      // before declaring failure. Vite dev sometimes returns 0 even
      // for real files; the range probe confirms reality.
      if (len === 0) {
        const r = await fetch(url, { headers: { Range: 'bytes=0-15' } });
        if (r.ok) {
          const buf = await r.arrayBuffer();
          if (buf.byteLength >= 1) return 0;  // pass — a range probe can't know the real size; report unknown rather than a fake number
        }
      }
    }
  } catch {
    // HEAD failed — fall through to GET probe.
  }
  // Final fallback: GET the first chunk and see if we get bytes.
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  const buf = await r.arrayBuffer();
  if (buf.byteLength < minBytes) {
    throw new Error(
      `fetch ${url} returned ${buf.byteLength}B (expected >${minBytes}B) — ` +
      `file missing, symlink broken, or it's a 134-byte LFS pointer. ` +
      `Run \`git lfs pull\` (or \`bash scripts/fetch-model.sh\`).`,
    );
  }
  return buf.byteLength;
}

/**
 * Best-effort Error → string. Plain `String(err)` collapses most
 * custom errors to `[object Object]` (mediapipe Tasks Vision does
 * this), so we walk .message / .name / .stack and pick the most
 * informative string available. Output is always a single line so it
 * fits in the splash's row layout.
 */
function errToString(e: unknown): string {
  const err = e as { name?: string; message?: string; stack?: string; code?: string | number } | null | undefined;
  if (err == null) return 'unknown error';
  const name = err.name || 'Error';
  let msg = err.message;
  // Reject empty + "[object Object]" — common when a library throws a
  // structured error whose .message is the stringified fallback.
  if (typeof msg !== 'string' || msg.trim() === '' || msg === '[object Object]') {
    // Fall back to top-of-stack frame for context.
    if (typeof err.stack === 'string' && err.stack.length > 0) {
      const firstLine = err.stack.split('\n')[0].trim();
      msg = firstLine.length > 0 ? firstLine : undefined;
    }
  }
  if (msg == null) {
    // Last resort: stringify via Object so at least the user sees the
    // key names. Still avoids the bare [object Object] when possible.
    try {
      const seen = new WeakSet();
      msg = JSON.stringify(
        err,
        (_k, v) => {
          if (typeof v === 'object' && v !== null) {
            if (seen.has(v)) return '[Circular]';
            seen.add(v);
          }
          if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
          return v;
        },
        2,
      ) ?? String(err);
    } catch {
      msg = String(err);
    }
  }
  const code = err.code !== undefined ? ` (code=${err.code})` : '';
  // Cap at a reasonable length so the splash row can render it. Full
  // message is preserved on the row's title= attribute (hover tooltip).
  const MAX = 240;
  const out = msg.length > MAX ? msg.slice(0, MAX - 1) + '…' : msg;
  return `${name}: ${out}${code}`;
}

// ── ONNX loaders ───────────────────────────────────────────────────────────
// onnxruntime-web's API has changed across versions; the surface we use
// is `InferenceSession.create(uri, options)` returning a session with
// `inputNames` / `outputNames` arrays. The 1.x API doesn't expose input
// shape metadata as cleanly as the Python API, so for the dummy inference
// validation we hardcode the shapes that match the trained models and
// let the runtime complain if they don't.
const RTMDET_INPUT_SHAPE  = [1, 3, 640, 640] as const;  // BCHW float32
const RTMPOSE_INPUT_SHAPE = [1, 3, 256, 192] as const;  // (B, C, H, W) — SimCC

async function _dummyOnnxRun(session: ort.InferenceSession, shape: readonly number[]): Promise<void> {
  // Catches "session creates but every call raises" failures that a
  // bare create() check would miss.
  const total = shape.reduce((a: number, b: number) => a * b, 1);
  const data = new Float32Array(total);  // all zeros
  const tensor = new ort.Tensor('float32', data, shape as unknown as number[]);
  const feed: Record<string, ort.Tensor> = { [session.inputNames[0]]: tensor };
  await session.run(feed);
}

async function loadRtmdet(): Promise<void> {
  if (_state.rtmdet.state === 'ready') return;
  setState('rtmdet', { state: 'loading' });
  try {
    const url = PATHS.rtmdet.url;
    const bytes = await probeSize(url);
    const session = await ort.InferenceSession.create(url, {
      // WASM is the only EP that works in browser; WebGL is faster but
      // missing ops for some models. CPU fallback always present.
      executionProviders: ['wasm'],
    });
    await _dummyOnnxRun(session, RTMDET_INPUT_SHAPE);
    setState('rtmdet', { state: 'ready', runner: session, bytes: bytes || undefined });
  } catch (e) {
    setState('rtmdet', { state: 'failed', error: errToString(e) });
  }
}

async function loadRtmpose(): Promise<void> {
  if (_state.rtmpose.state === 'ready') return;
  setState('rtmpose', { state: 'loading' });
  try {
    const url = PATHS.rtmpose.url;
    const bytes = await probeSize(url);
    const session = await ort.InferenceSession.create(url, {
      executionProviders: ['wasm'],
    });
    await _dummyOnnxRun(session, RTMPOSE_INPUT_SHAPE);
    setState('rtmpose', { state: 'ready', runner: session, bytes: bytes || undefined });
  } catch (e) {
    setState('rtmpose', { state: 'failed', error: errToString(e) });
  }
}

// ── MediaPipe loader ──────────────────────────────────────────────────────
// MediaPipe's Tasks Vision needs its wasm bundle (loader JS + binary).
// It is self-hosted under public/assets/mediapipe-wasm/ (see the README
// there — the files are copied from the pinned @mediapipe/tasks-vision
// version). A CDN is not usable here: the app CSP only allows
// connect-src 'self' + localhost, and packaged mode must work offline.
// It also needs an ImageBitmap-capable HTMLCanvasElement for the GPU
// delegate.
async function loadMediapipe(): Promise<void> {
  if (_state.mediapipe.state === 'ready') return;
  setState('mediapipe', { state: 'loading' });
  try {
    const url = PATHS.mediapipe.url;
    const bytes = await probeSize(url, 256 * 1024);
    const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE);
    const landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: url,
        // GPU delegate when WebGL2 is available; falls back to CPU.
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
    setState('mediapipe', { state: 'ready', runner: landmarker, bytes: bytes || undefined });
  } catch (e) {
    setState('mediapipe', { state: 'failed', error: errToString(e) });
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────────
export async function loadAll(): Promise<void> {
  // Parallel — one model's failure shouldn't block the others.
  await Promise.allSettled([loadRtmdet(), loadRtmpose(), loadMediapipe()]);
}

export function allReady(): boolean {
  return _state.rtmdet.state === 'ready'
      && _state.rtmpose.state === 'ready'
      && _state.mediapipe.state === 'ready';
}
