// Renderer + frame loop.
//
// Fixed-timestep simulation at 60 Hz with an accumulator; rendering runs at
// whatever the display gives and interpolates with `alpha`. A 120 Hz display
// therefore renders two smooth frames per physics step; a hitch never changes
// what the simulation does.
//
// Renderer: WebGL2 by default. WebGPU is available as an experimental path
// (settings → renderer) — three's WebGPURenderer ignores GLSL onBeforeCompile
// patches and the EffectComposer chain, so that path renders without post
// effects, CSM, wind or per-vertex emissive. It is exposed for testing, not
// as the shipping default.

import * as THREE from 'three';

export const FIXED_DT = 1 / 60;
const MAX_STEPS = 5;

export async function createRenderer(canvas, settings, quality) {
  const wantWebGPU = settings.get('renderer') === 'webgpu' && !!navigator.gpu;
  if (wantWebGPU) {
    try {
      const mod = await import('three/webgpu');
      const r = new mod.WebGPURenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
      await r.init();
      r.__kind = 'webgpu';
      configure(r, quality);
      return r;
    } catch (err) {
      console.warn('WebGPU init failed, falling back to WebGL2:', err);
    }
  }
  const r = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // SMAA in the post chain
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
  });
  r.__kind = 'webgl2';
  configure(r, quality);
  return r;
}

function configure(r, quality) {
  r.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatioCap));
  r.shadowMap.enabled = quality.shadows;
  r.shadowMap.type = THREE.PCFShadowMap;
  // Shadow maps are rendered exactly once per frame (see Engine._frame), not
  // on every renderer.render() — the AO pre-pass would otherwise redraw them.
  r.shadowMap.autoUpdate = false;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 0.62; // Sky shader output is physically bright
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.info.autoReset = false;
}

export class Engine {
  constructor(renderer, camera) {
    this.renderer = renderer;
    this.camera = camera;
    this.accumulator = 0;
    this.lastTime = 0;
    this.running = false;
    this.onFixed = null;  // (dt) => void
    this.onFrame = null;  // (dt, alpha) => void
    this.onRender = null; // (dt) => void
    this.stats = {
      fps: 60,
      frameMs: 0,
      simMs: 0,
      renderMs: 0,
      calls: 0,
      triangles: 0,
      programs: 0,
      heap: '—',
    };
    this._raf = 0;
    this._tick = (t) => this._frame(t);
    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.lastTime = 0;
    });
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Used by the LOD system for screen-space size; in device pixels.
    this.camera.__viewportHeight = h * this.renderer.getPixelRatio();
    this.onResize?.(w, h);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = 0;
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }

  _frame(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._tick);
    if (this.lastTime === 0) {
      this.lastTime = now;
      return;
    }
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (dt > 0.1) dt = 0.1; // tab switch / hitch: never spiral
    const s = this.stats;
    s.fps += (1 / Math.max(dt, 1e-4) - s.fps) * 0.08;

    const t0 = performance.now();
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS) {
      this.onFixed?.(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS) this.accumulator = 0;
    const alpha = this.accumulator / FIXED_DT;
    this.onFrame?.(dt, alpha);
    const t1 = performance.now();

    this.renderer.info.reset();
    if (this.renderer.shadowMap) this.renderer.shadowMap.needsUpdate = true;
    this.onRender?.(dt);
    const t2 = performance.now();

    s.simMs += (t1 - t0 - s.simMs) * 0.1;
    s.renderMs += (t2 - t1 - s.renderMs) * 0.1;
    s.frameMs += (t2 - t0 - s.frameMs) * 0.1;
    const info = this.renderer.info;
    s.calls = info.render.calls;
    s.triangles = info.render.triangles;
    s.programs = info.programs ? info.programs.length : 0;
    if (performance.memory) s.heap = `${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)}MB`;
  }
}
