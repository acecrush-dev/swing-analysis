/** Splash screen — shown during model-load phase regardless of backend.
 *
 * Two backend modes, one splash:
 *
 *   `python` (default) — main process spawned the PyInstaller sidecar
 *     in parallel. The sidecar warmup runs INSIDE that subprocess; main
 *     forwards sidecar stderr lines + a 500 ms /api/status poll to this
 *     window via the preload-exposed IPC channels.
 *
 *   `ts` — main did NOT spawn Python. The renderer is the runtime: we
 *     call `modelLoader.loadAll()` here, which fetches ONNX sessions
 *     through onnxruntime-web and the MediaPipe PoseLandmarker. Status
 *     updates come from `modelLoader.subscribe()`.
 *
 * When ALL models report `ready` (whichever path produced them), the
 * splash fires `window.api.splashReady()` and tells main to swap in the
 * real UI. No mode-specific close path on the main side — the splash
 * self-determines "ready" from the same shape of state in both modes.
 *
 * Layout (top → bottom):
 *   1. Brand label   "ACECRUSH" + backend-mode badge ("Python sidecar" / "WASM")
 *   2. App title     "Swing-Analysis"
 *   3. 3D tennis ball bouncing (Three.js, procedural texture)
 *   4. Status tagline ("Starting Python sidecar…" / "Loading WASM models…")
 *   5. Per-model status rows (rtmdet / rtmpose / mediapipe)
 *   6. One-line tooltip with the current action
 */
import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import * as THREE from 'three';
import {
  subscribe as subscribeModels,
  loadAll as loadAllModels,
  allReady as allModelsReady,
  getEntry,
  type ModelName as LoaderModelName,
  type ModelState as LoaderModelState,
} from './lib/modelLoader';

// ── types ────────────────────────────────────────────────────────────
type ModelState = LoaderModelState;
type ModelName = LoaderModelName;

interface SidecarStatusSnapshot {
  sidecar: 'starting' | 'ready' | 'failed';
  models: Record<ModelName, ModelState>;
  default_backend: string;
  models_dir: string;
  version: string;
  all_ready: boolean;
}

type BackendMode = 'python' | 'ts';

// ── preload bridge ────────────────────────────────────────────────────
// `window.api` shape is declared in src/renderer/src/api/electron-api.ts
// (side-effect import ensures the global is typed everywhere). We import
// it here purely for the type augmentation; no runtime values are used.
import './api/electron-api';

// ── procedural tennis-ball texture ────────────────────────────────────
// Yellow-green base + felt-fuzz dots + two crossing S-curve white
// seams, drawn on a 1024×512 canvas and wrapped onto a sphere via the
// default UV unwrap. No external assets.
function makeTennisBallTexture(): THREE.CanvasTexture {
  const W = 1024, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // Base — radial gradient gives the ball a soft 3D feel even before
  // lighting kicks in (lighting + roughness below does the rest).
  const base = ctx.createRadialGradient(W * 0.45, H * 0.4, 0, W * 0.5, H * 0.5, W * 0.55);
  base.addColorStop(0, '#e0ed5a');
  base.addColorStop(0.6, '#cad945');
  base.addColorStop(1, '#9eb533');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);

  // Felt fuzz — ~4000 tiny semi-transparent dots, scattered across the
  // surface. Cheap noise that reads as "tennis-ball texture" at a glance.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.07)';
  for (let i = 0; i < 4000; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    const r = 0.6 + Math.random() * 1.4;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Same in light spots for highlight breakup
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  for (let i = 0; i < 2000; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    ctx.beginPath();
    ctx.arc(x, y, 0.8, 0, Math.PI * 2);
    ctx.fill();
  }

  // Seam lines — two tilted great circles that meet at the top and
  // bottom poles and bow outward at the equator. This is the iconic
  // tennis-ball "split" pattern when viewed from the front. The math
  // behind it: a great circle NOT passing through the polar axis, when
  // projected onto an equirectangular texture, traces a sinusoidal
  // curve in (longitude, latitude). Two such seams opposite each other
  // (180° apart in longitude) and both bulging AWAY from the centre
  // give the classic ")" "(" silhouette.
  //
  // Parameters tuned for a 1024×512 unwrap: bulge amplitude 0.12
  // (≈12% of texture width) gives a noticeable curve without making
  // the seams look like rubber bands. Line width 18 + soft shadow
  // matches the visible thread thickness on a real ball at the
  // texture's native pixel density.
  const drawSeam = (baseU: number, bulge: number, direction: number) => {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 18;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.30)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.beginPath();
    for (let v = 0; v <= 1.001; v += 0.005) {
      // v = 0 → top pole (lat +π/2); v = 1 → bottom pole; v = 0.5 → equator
      // Seam at baseU longitude at the poles, deviating by `bulge` at the
      // equator. The single sin cycle matches one full great circle.
      const u = baseU + bulge * Math.sin(v * Math.PI) * direction;
      const x = ((u % 1) + 1) % 1 * W;  // wrap modulo defensively
      const y = v * H;
      if (v === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Clear shadow so subsequent strokes don't inherit it.
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  };
  // Two seams, 180° apart in longitude, both bowing OUTWARD.
  drawSeam(0.0, 0.12, +1);
  drawSeam(0.5, 0.12, -1);

  // Small white highlight at the "12 o'clock" position where the two
  // poles meet — sells the seam junction a bit more convincingly.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.beginPath();
  ctx.arc(0.5 * W, 4, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0.5 * W, H - 4, 3, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ── Three.js scene: bouncing tennis ball ─────────────────────────────
function useBouncingTennisBall(canvasRef: React.RefObject<HTMLCanvasElement>) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(180, 180, false);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
    camera.position.set(0, 0.2, 5.5);
    camera.lookAt(0, 0, 0);

    const ballTex = makeTennisBallTexture();
    const ballGeom = new THREE.SphereGeometry(1, 64, 64);
    const ballMat = new THREE.MeshStandardMaterial({
      map: ballTex,
      roughness: 0.55,
      metalness: 0.05,
    });
    const ball = new THREE.Mesh(ballGeom, ballMat);
    scene.add(ball);

    // Lighting — soft ambient + warm key + cool fill keeps the ball
    // shaded on every side without going flat.
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const key = new THREE.DirectionalLight(0xffe6b3, 1.1);
    key.position.set(3, 4, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x8aa0ff, 0.45);
    fill.position.set(-4, 1, 2);
    scene.add(fill);

    // Animation loop. Bounce is a parabola: y=0 at landing, peak at
    // mid-period. Squash on landing + spin during flight. Independent
    // of React state — RAF drives the visuals directly so the ball
    // stays smooth even if the main thread is busy parsing status.
    const PERIOD = 1.1;        // seconds per bounce
    const AMP = 1.35;          // peak height above ground
    const GROUND = -1.05;      // ball center when "on ground"
    let raf = 0;
    let t0 = performance.now();

    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      const phase = (t % PERIOD) / PERIOD;
      // 4 * phase * (1-phase) is 0 at endpoints, 1 at midpoint —
      // matches a parabolic bounce trajectory (free-fall under g).
      const bounce = 4 * phase * (1 - phase);
      const y = GROUND + AMP * bounce;
      const isLand = phase < 0.04 || phase > 0.96;
      const squash = isLand ? 0.62 : 1.0;
      ball.position.y = y;
      ball.scale.set(1 / Math.sqrt(squash), squash, 1 / Math.sqrt(squash));
      // Continuous forward + slight tilt spin (typical "tossed ball"
      // motion). Phase-locked so the squash frames look the same every
      // bounce.
      ball.rotation.x = t * 3.2;
      ball.rotation.z = Math.sin(t * Math.PI / PERIOD) * 0.18;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      renderer.dispose();
      ballGeom.dispose();
      ballMat.dispose();
      ballTex.dispose();
    };
  }, [canvasRef]);
}

// ── React UI ──────────────────────────────────────────────────────────
function ModelRow({ name, state, error }: { name: ModelName; state: ModelState; error?: string }) {
  return (
    <div className={`status-row state-${state}`}>
      <span className="status-name">{name}</span>
      <span className="status-dot" />
      <span className="status-state">{state}</span>
      {error && <span className="status-error" title={error}>{truncate(error, SPLASH_ERROR_MAX_CHARS)}</span>}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
// Splash row layout has limited horizontal space; the CSS handles word
// wrapping + a 3-line clamp for the actual visual. Truncate at a
// generous length (180 chars) so the clamp has plenty to work with and
// the user still gets the gist even when the message is huge.
const SPLASH_ERROR_MAX_CHARS = 180;

// Derive a friendly one-line phase message from the live warmup
// state. Used as the splash's bottom tooltip — like MATLAB's
// bottom status bar. Ordered so the most specific phase wins: a
// currently-loading model name beats a generic "Loading models…".
function friendlyActionPython(snap: SidecarStatusSnapshot | null): string {
  if (!snap) return 'Starting Python sidecar…';
  if (snap.sidecar === 'failed') return 'Service failed to start.';
  // Look for the model currently being loaded (in order, so the user
  // sees a deterministic name when multiple are queued).
  for (const m of ['rtmdet', 'rtmpose', 'mediapipe'] as const) {
    if (snap.models[m] === 'loading') return `Loading ${m}…`;
  }
  // All ready
  if (snap.all_ready) return 'Ready.';
  // Service is up but no model is in flight yet (or warmup hasn't
  // started the first model). Surface the most useful hint.
  if (snap.sidecar === 'starting') return 'Starting Python sidecar…';
  return 'Loading pose models…';
}

function friendlyActionTs(entries: Record<ModelName, { state: ModelState }>): string {
  for (const m of ['rtmdet', 'rtmpose', 'mediapipe'] as const) {
    if (entries[m].state === 'loading') return `Loading ${m}…`;
  }
  if (Object.values(entries).every((e) => e.state === 'ready')) return 'Ready.';
  if (Object.values(entries).some((e) => e.state === 'failed')) return 'Model load failed.';
  return 'Loading WASM models…';
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<BackendMode | null>(null);
  // Mode-specific state. Whichever one is null gets ignored at render time.
  const [sidecarStatus, setSidecarStatus] = useState<SidecarStatusSnapshot | null>(null);
  const [tsEntries, setTsEntries] = useState<Record<ModelName, { state: ModelState; error?: string }>>({
    rtmdet:    { state: 'pending' },
    rtmpose:   { state: 'pending' },
    mediapipe: { state: 'pending' },
  });
  // `ready` reflects "all models loaded", whichever path produced it.
  const [ready, setReady] = useState(false);

  useBouncingTennisBall(canvasRef);

  useEffect(() => {
    const api = window.api;
    if (!api) return;
    // Backend mode drives everything else — fetch it first, then
    // branch subscriptions.
    let cancelled = false;
    void api.getBackendMode().then((m) => {
      if (cancelled) return;
      setMode(m);
      if (m === 'ts') {
        // Subscribe to renderer-side loader + kick off the load.
        const off = subscribeModels((s) => {
          // Re-shape: modelLoader emits full entries (state, runner, bytes,
          // error); keep state + error so the splash can surface WHY a
          // model failed (the previous version dropped the error field,
          // so all the user saw was "failed" with no hint).
          const slim: Record<ModelName, { state: ModelState; error?: string }> = {
            rtmdet:    { state: s.rtmdet.state, error: s.rtmdet.error },
            rtmpose:   { state: s.rtmpose.state, error: s.rtmpose.error },
            mediapipe: { state: s.mediapipe.state, error: s.mediapipe.error },
          };
          setTsEntries(slim);
          setReady(allModelsReady());
        });
        void loadAllModels().then(() => setReady(allModelsReady()));
        return () => off();
      } else {
        // Python: subscribe to sidecar status forwarded from main.
        const off = api.onSidecarStatus((snap) => {
          const s = snap as SidecarStatusSnapshot;
          setSidecarStatus(s);
          if (s?.all_ready) setReady(true);
        });
        return () => off();
      }
    });
    return () => { cancelled = true; };
  }, []);

  // When ready, give main a beat to render "Ready." then signal + close.
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => {
      window.api?.splashReady();
    }, 400);
    return () => clearTimeout(t);
  }, [ready]);

  const models: ModelName[] = ['rtmdet', 'rtmpose', 'mediapipe'];
  const tagline =
    mode === 'ts'   ? friendlyActionTs(tsEntries) :
    mode === 'python' ? friendlyActionPython(sidecarStatus) :
    'Starting…';
  const modeBadge = mode === 'ts' ? 'WASM' : mode === 'python' ? 'Python sidecar' : '';

  return (
    <div className="splash">
      <div className="splash-content">
        <div className="splash-brand">
          ACECRUSH {modeBadge && <span className="splash-mode-badge">{modeBadge}</span>}
        </div>
        <div className="splash-title">Swing-Analysis</div>
        <div className="splash-ball"><canvas ref={canvasRef} /></div>
        <div className="splash-tagline">{tagline}</div>
        <div className="splash-status">
          {models.map((m) => {
            const state: ModelState =
              mode === 'ts'      ? tsEntries[m].state :
              mode === 'python' ? (sidecarStatus?.models[m] ?? 'pending') :
                                  'pending';
            const error =
              mode === 'ts' && tsEntries[m].state === 'failed' ? tsEntries[m].error : undefined;
            return <ModelRow key={m} name={m} state={state} error={error} />;
          })}
        </div>
        {/* One-line tooltip — friendly action derived from live status. */}
        <div className="splash-logs">
          <div className="log-line">{tagline}</div>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
