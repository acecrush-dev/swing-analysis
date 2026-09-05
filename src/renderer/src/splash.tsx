/** Splash screen — shown while the Python sidecar warms up pose models.
 *
 * Layout (top → bottom):
 *   1. Brand label   "ACECRUSH"
 *   2. App title     "Swing-Analysis"
 *   3. 3D tennis ball bouncing (Three.js, procedural texture)
 *   4. Status tagline (e.g. "Initializing service …")
 *   5. Per-model status rows (rtmdet / rtmpose / mediapipe) with pulsing
 *      dots during loading, solid green when ready, red on failure
 *   6. Live log feed (last 100 stderr lines from the sidecar)
 *
 * All data arrives via the preload `window.api.onSidecarLog` /
 * `onSidecarStatus` channels (set up in src/preload/index.ts); main
 * forwards sidecar stderr and a 500 ms /api/status poll while the
 * splash is visible. When all models report `ready`, the main process
 * closes this window and brings up the main UI.
 */
import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import * as THREE from 'three';

// ── types (mirror backend/service/warmup.py) ──────────────────────────
type ModelState = 'pending' | 'loading' | 'ready' | 'failed';
type ModelName = 'rtmdet' | 'rtmpose' | 'mediapipe';

interface StatusSnapshot {
  sidecar: 'starting' | 'ready' | 'failed';
  models: Record<ModelName, ModelState>;
  default_backend: string;
  models_dir: string;
  version: string;
  all_ready: boolean;
}

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

  // Seam lines — two S-curves that cross the ball horizontally. The
  // offset in y between them is what makes a tennis ball look like a
  // tennis ball instead of a planet. Round caps + slight shadow.
  const drawSeam = (phase: number) => {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 16;
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.beginPath();
    for (let u = 0; u <= 1.001; u += 0.005) {
      const x = u * W;
      // 3 sin cycles across the texture → matches the canonical
      // tennis-ball seam pattern (one full S per ~120°).
      const y = H * 0.5 + phase * H * 0.32 * Math.sin(u * Math.PI * 3);
      if (u === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  };
  drawSeam(+1);
  drawSeam(-1);

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
function ModelRow({ name, state }: { name: ModelName; state: ModelState }) {
  return (
    <div className={`status-row state-${state}`}>
      <span className="status-name">{name}</span>
      <span className="status-dot" />
      <span className="status-state">{state}</span>
    </div>
  );
}

// Derive a friendly one-line phase message from the live warmup
// state. Used as the splash's bottom tooltip — like MATLAB's
// bottom status bar. Ordered so the most specific phase wins: a
// currently-loading model name beats a generic "Loading models…".
function friendlyAction(snap: StatusSnapshot | null): string {
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

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<StatusSnapshot | null>(null);

  useBouncingTennisBall(canvasRef);

  useEffect(() => {
    const api = window.api;
    if (!api) return;
    const offStatus = api.onSidecarStatus((snap) => {
      setStatus(snap as StatusSnapshot);
    });
    return () => {
      offStatus();
    };
  }, []);

  const models: ModelName[] = ['rtmdet', 'rtmpose', 'mediapipe'];
  const tagline = friendlyAction(status);

  return (
    <div className="splash">
      <div className="splash-content">
        <div className="splash-brand">ACECRUSH</div>
        <div className="splash-title">Swing-Analysis</div>
        <div className="splash-ball"><canvas ref={canvasRef} /></div>
        <div className="splash-tagline">{tagline}</div>
        <div className="splash-status">
          {models.map((m) => (
            <ModelRow key={m} name={m} state={status?.models[m] ?? 'pending'} />
          ))}
        </div>
        {/* One-line tooltip — friendly action derived from live status.
            Subtitle (above) already shows the action; this is a
            dedicated line for screen-readers / future extension. */}
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
