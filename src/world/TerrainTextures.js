// Procedural PBR ground layers: grass, soil, rock, sand. Each layer is a
// tileable albedo (sRGB) + a normal map whose alpha carries roughness. Runs in
// textures.worker.js at load; pure functions, no DOM.
//
// Tiling is guaranteed by sampling every noise on a torus (two orthogonal
// circles of the tile period), so wrap seams don't exist by construction.

import { SimplexNoise } from './Noise.js';
import { clamp, lerp, smoothstep } from '../core/MathUtils.js';

export const LAYERS = ['grass', 'soil', 'rock', 'sand', 'snow'];

class Torus {
  constructor(seed, tiles) {
    this.n = new SimplexNoise(seed);
    this.nb = new SimplexNoise(seed ^ 0x9e37);
    this.tiles = tiles;
    this._w = [0, 0];
  }
  /** Tileable fbm at uv (0..1), `freq` cycles per tile. */
  fbm(u, v, freq, oct = 4, gain = 0.5) {
    const a = u * Math.PI * 2;
    const b = v * Math.PI * 2;
    const r = freq * this.tiles;
    // Two 2D samples on orthogonal torus circles, blended: tileable in both axes.
    const x1 = Math.cos(a) * r + Math.cos(b) * r;
    const y1 = Math.sin(a) * r + Math.sin(b) * r;
    const x2 = Math.cos(a) * r - Math.sin(b) * r;
    const y2 = Math.sin(a) * r + Math.cos(b) * r;
    return 0.5 * (this.n.fbm(x1, y1, oct, 2, gain) + this.nb.fbm(x2, y2, oct, 2, gain));
  }
  /** Tileable worley F1/F2. */
  worley(u, v, freq) {
    const a = u * Math.PI * 2;
    const b = v * Math.PI * 2;
    const r = freq * this.tiles;
    return this.n.worley(Math.cos(a) * r + Math.cos(b) * r + 100, Math.sin(a) * r + Math.sin(b) * r + 100, this._w);
  }
  /** Directional streaks (grass blades): anisotropic sampling. */
  streak(u, v, freq, aniso) {
    const a = u * Math.PI * 2;
    const b = v * Math.PI * 2;
    const r = freq * this.tiles;
    return this.nb.fbm((Math.cos(a) + Math.cos(b)) * r * aniso, (Math.sin(a) + Math.sin(b)) * r, 3, 2.1, 0.55);
  }
}

const srgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** height field → tangent normal map (RGB) with roughness in A. */
function heightToNormal(h, rough, size, strength, out) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x];
      const d = h[((y + 1) % size) * size + x];
      let nx = (l - r) * strength;
      let ny = (u - d) * strength;
      let nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      const i = (y * size + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = clamp(rough[y * size + x], 0, 1) * 255;
    }
  }
}

function writeAlbedo(out, i, r, g, b) {
  out[i] = srgb(clamp(r, 0, 1)) * 255;
  out[i + 1] = srgb(clamp(g, 0, 1)) * 255;
  out[i + 2] = srgb(clamp(b, 0, 1)) * 255;
  out[i + 3] = 255;
}

// ------------------------------------------------------------------ layers

function grass(T, size, albedo, height, rough) {
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;
      const macro = T.fbm(u, v, 1.5, 3) * 0.5 + 0.5;          // patches of lush/dry
      const blades = T.streak(u, v, 22, 0.18);                 // long thin blade streaks
      const blades2 = T.streak(v, u, 31, 0.15);
      const clump = T.fbm(u, v, 9, 4) * 0.5 + 0.5;
      const speck = T.worley(u, v, 40)[0];
      const dry = smoothstep(0.5, 0.78, macro);            // straw-coloured dry patches
      const bare = smoothstep(0.62, 0.8, T.fbm(v, u, 2.6, 3) * 0.5 + 0.5); // thin worn spots
      const lum = 0.5 + blades * 0.4 + blades2 * 0.25 + (clump - 0.5) * 0.35;
      // Olive, low-saturation greens: real turf is far less "lime" than it feels.
      let r = lerp(0.10, 0.27, lum) + dry * 0.2;
      let g = lerp(0.16, 0.33, lum) + dry * 0.1;
      let b = lerp(0.04, 0.1, lum) + dry * 0.01;
      r = lerp(r, 0.3, bare * 0.6); g = lerp(g, 0.24, bare * 0.6); b = lerp(b, 0.15, bare * 0.6);
      if (speck < 0.05) { r += 0.16; g += 0.1; } // tiny dry flecks
      writeAlbedo(albedo, i * 4, r, g, b);
      height[i] = blades * 0.6 + blades2 * 0.4 + clump * 0.5;
      rough[i] = 0.82 + (clump - 0.5) * 0.1;
    }
  }
  return 2.2;
}

function soil(T, size, albedo, height, rough) {
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;
      const base = T.fbm(u, v, 4, 5) * 0.5 + 0.5;
      const fine = T.fbm(u, v, 26, 3) * 0.5 + 0.5;
      const w = T.worley(u, v, 14);
      const pebble = 1 - smoothstep(0.0, 0.32, w[0]);            // round pebbles
      const crack = 0.8 + 0.2 * smoothstep(0.012, 0.05, w[1] - w[0]); // faint cracks between cells
      const wet = T.fbm(u, v, 2.2, 2) * 0.5 + 0.5;
      const lum = 0.35 + base * 0.35 + fine * 0.2;
      let r = lerp(0.22, 0.42, lum) * (1 - wet * 0.25);
      let g = lerp(0.15, 0.3, lum) * (1 - wet * 0.25);
      let b = lerp(0.09, 0.19, lum) * (1 - wet * 0.2);
      if (pebble > 0.3) { const p = pebble * 0.3; r = lerp(r, 0.45, p); g = lerp(g, 0.42, p); b = lerp(b, 0.38, p); }
      r *= crack; g *= crack; b *= crack;
      writeAlbedo(albedo, i * 4, r, g, b);
      height[i] = base * 0.5 + fine * 0.25 + pebble * 0.7 - (1 - crack) * 0.8;
      rough[i] = 0.9 - wet * 0.25 - pebble * 0.15;
    }
  }
  return 2.6;
}

function rock(T, size, albedo, height, rough) {
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;
      const strata = T.fbm(u * 0.35, v, 3, 4) * 0.5 + 0.5;         // stretched layering
      const ridge = 1 - Math.abs(T.fbm(u, v, 6, 4));               // ridged
      const w = T.worley(u, v, 5);
      const crack = smoothstep(0.015, 0.06, w[1] - w[0]);
      const fine = T.fbm(u, v, 34, 3) * 0.5 + 0.5;
      const lichen = smoothstep(0.62, 0.8, T.fbm(u, v, 7, 3) * 0.5 + 0.5);
      const lum = 0.35 + strata * 0.3 + ridge * 0.25 + fine * 0.15;
      let r = lerp(0.28, 0.55, lum);
      let g = lerp(0.27, 0.52, lum);
      let b = lerp(0.25, 0.47, lum);
      r = lerp(r, 0.32, lichen * 0.6); g = lerp(g, 0.42, lichen * 0.6); b = lerp(b, 0.2, lichen * 0.6);
      r *= 0.55 + 0.45 * crack; g *= 0.55 + 0.45 * crack; b *= 0.55 + 0.45 * crack;
      writeAlbedo(albedo, i * 4, r, g, b);
      height[i] = ridge * 1.2 + strata * 0.6 + fine * 0.2 - (1 - crack) * 1.4;
      rough[i] = 0.78 + fine * 0.15 - lichen * 0.1;
    }
  }
  return 4.0;
}

function sand(T, size, albedo, height, rough) {
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;
      const ripple = Math.sin((u * 9 + T.fbm(u, v, 3, 2) * 0.35) * Math.PI * 2) * 0.5 + 0.5;
      const grain = T.fbm(u, v, 48, 2) * 0.5 + 0.5;
      const patch = T.fbm(u, v, 2, 3) * 0.5 + 0.5;
      const lum = 0.55 + ripple * 0.18 + grain * 0.2 + patch * 0.1;
      writeAlbedo(albedo, i * 4, lerp(0.42, 0.72, lum), lerp(0.36, 0.62, lum), lerp(0.24, 0.44, lum));
      height[i] = ripple * 0.6 + grain * 0.35;
      rough[i] = 0.88 + grain * 0.08;
    }
  }
  return 1.6;
}

function snow(T, size, albedo, height, rough) {
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;
      const drift = T.fbm(u, v, 2.5, 3) * 0.5 + 0.5;            // soft wind drifts
      const grain = T.fbm(u, v, 40, 2) * 0.5 + 0.5;             // crystalline grain
      const crust = smoothstep(0.55, 0.7, T.fbm(v, u, 7, 3) * 0.5 + 0.5); // wind-packed crust patches
      const sparkle = T.worley(u, v, 64)[0] < 0.05 ? 0.12 : 0.0;
      const lum = 0.74 + drift * 0.12 + grain * 0.06 + sparkle - crust * 0.06;
      writeAlbedo(albedo, i * 4, lum * 0.97, lum * 0.985, lum * 1.0);
      height[i] = drift * 0.7 + grain * 0.15 + crust * 0.3;
      rough[i] = 0.55 + grain * 0.2 - sparkle;
    }
  }
  return 1.4;
}

const GEN = { grass, soil, rock, sand, snow };

/**
 * Build all layers. Returns { size, albedo: Uint8Array[], normal: Uint8Array[] }
 * with arrays ordered as LAYERS.
 */
export function buildTerrainTextures(seed, size) {
  const albedo = [];
  const normal = [];
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  for (let l = 0; l < LAYERS.length; l++) {
    const T = new Torus((seed ^ (l * 0x2f1b)) >>> 0, 1);
    const a = new Uint8Array(size * size * 4);
    const n = new Uint8Array(size * size * 4);
    const strength = GEN[LAYERS[l]](T, size, a, height, rough);
    heightToNormal(height, rough, size, strength * (size / 512), n);
    albedo.push(a);
    normal.push(n);
  }
  return { size, albedo, normal };
}
