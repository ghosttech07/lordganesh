// Small procedural surface maps for the rig: fur (directional strands), elephant
// skin (cellular wrinkles), gold scratches. Generated once at boot.

import * as THREE from 'three';
import { SimplexNoise } from '../world/Noise.js';

function normalFromHeight(h, size, strength) {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x];
      const d = h[((y + 1) % size) * size + x];
      let nx = (l - r) * strength;
      let ny = (u - d) * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const i = (y * size + x) * 4;
      out[i] = (nx * inv * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      out[i + 2] = (inv * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(out, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

function torusFbm(n, u, v, freq, oct, ax = 1, ay = 1) {
  const a = u * Math.PI * 2;
  const b = v * Math.PI * 2;
  return n.fbm((Math.cos(a) + Math.cos(b)) * freq * ax, (Math.sin(a) + Math.sin(b)) * freq * ay, oct);
}

/** Fur: long thin strands with micro-fuzz and natural flow. */
export function makeFurNormal(size = 256, seed = 11) {
  const n = new SimplexNoise(seed);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Stretched strands along v with fine micro-noise
      const strand = torusFbm(n, u, v, 28, 4, 0.08, 1.2);
      const micro = torusFbm(n, u, v, 60, 2, 0.15, 1.0) * 0.35;
      const clump = torusFbm(n, u, v, 6, 2, 0.3, 0.8) * 0.45;
      h[y * size + x] = strand * 0.7 + micro + clump;
    }
  }
  return normalFromHeight(h, size, 3.2);
}

/** Mouse skin: subtle epidermal rings for tail and delicate soft pores for ears and paws. */
export function makeMouseSkinNormal(size = 128, seed = 42) {
  const n = new SimplexNoise(seed);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Tail skin rings along v
      const rings = Math.sin(v * Math.PI * 32) * 0.25;
      const pores = torusFbm(n, u, v, 36, 2) * 0.2;
      h[y * size + x] = rings + pores;
    }
  }
  return normalFromHeight(h, size, 1.5);
}

/** Elephant skin: cellular wrinkle network with fine pores. */
export function makeSkinNormal(size = 256, seed = 23) {
  const n = new SimplexNoise(seed);
  const w = [0, 0];
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const a = u * Math.PI * 2;
      const b = v * Math.PI * 2;
      n.worley((Math.cos(a) + Math.cos(b)) * 9 + 50, (Math.sin(a) + Math.sin(b)) * 9 + 50, w);
      const crease = Math.min(1, (w[1] - w[0]) * 6);        // 0 at cell borders
      const pores = torusFbm(n, u, v, 30, 2) * 0.15;
      h[y * size + x] = crease * 0.9 + pores;
    }
  }
  return normalFromHeight(h, size, 1.6);
}

/** Gold: brushed micro-scratches. Returns a roughness map (R). */
export function makeGoldRoughness(size = 128, seed = 5) {
  const n = new SimplexNoise(seed);
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = torusFbm(n, x / size, y / size, 20, 2, 1.0, 0.08) * 0.5 + 0.5;
      const i = (y * size + x) * 4;
      const r = (0.18 + s * 0.16) * 255;
      out[i] = r;
      out[i + 1] = r;
      out[i + 2] = r;
      out[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(out, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}
