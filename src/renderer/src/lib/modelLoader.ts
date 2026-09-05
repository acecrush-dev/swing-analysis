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

// Point onnxruntime-web at the local /assets/ort-wasm.wasm rather
// than its default CDN. Without this, ORT tries to fetch
// `https://cdn.jsdelivr.net/...ort-wasm-simd-threaded.jsep.wasm`,
// which is blocked or unreachable in sandboxed / offline Electron
// environments. We bundle the wasm via the renderer build (see
// electron.vite.config.ts assetFileNames), so /assets/ort-wasm.wasm
// is always available.
ort.env.wasm.wasmPaths = new URL('/assets/', window.location.href).toString();

export type ModelName = 'rtmdet' | 'rtmpose' | 'mediapipe';
export type ModelState = 'pending' | 'loading' | 'ready' | 'failed';

interface ModelPaths {
  /** URL or relative path Vite serves to the renderer at runtime. */
  url: string;
}

const PATHS: Record<ModelName, ModelPaths> = {
  rtmdet:    { url: '/assets/models/rtmdet-m-487628.onnx' },
  rtmpose:   { url: '/assets/models/rtmpose-m-27c0e6.onnx' },
  mediapipe: { url: '/assets/models/pose_landmarker_lite.task' },
};

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
          if (buf.byteLength >= 1) return minBytes + 1;  // sentinel: pass check
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
    setState('rtmdet', { state: 'ready', runner: session, bytes });
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
    setState('rtmpose', { state: 'ready', runner: session, bytes });
  } catch (e) {
    setState('rtmpose', { state: 'failed', error: errToString(e) });
  }
}

// ── MediaPipe loader ──────────────────────────────────────────────────────
// MediaPipe's Tasks Vision needs its wasm bundle from a CDN (or self-hosted
// under /assets/ — for Phase 2 we use the official jsdelivr CDN). It also
// needs an ImageBitmap-capable HTMLCanvasElement for the GPU delegate.
async function loadMediapipe(): Promise<void> {
  if (_state.mediapipe.state === 'ready') return;
  setState('mediapipe', { state: 'loading' });
  try {
    const url = PATHS.mediapipe.url;
    const bytes = await probeSize(url, 256 * 1024);
    const fileset = await FilesetResolver.forVisionTasks(
      // jsdelivr serves the wasm/js bundle. Pin the version so a
      // upstream change can't break us; align with the npm version
      // declared in package.json (@mediapipe/tasks-vision).
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
    );
    const landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: url,
        // GPU delegate when WebGL2 is available; falls back to CPU.
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
    setState('mediapipe', { state: 'ready', runner: landmarker, bytes });
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
