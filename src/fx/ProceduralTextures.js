// Small procedural textures generated once at boot so the game ships with no
// binary assets. Drop real KTX2 textures into AssetLoader to replace these.

import * as THREE from 'three';
import { SimplexNoise } from '../world/Noise.js';

/** Tileable detail normal map derived from fBm — gives ground surface grain. */
export function makeDetailNormalMap(size = 256, seed = 99) {
  const n = new SimplexNoise(seed);
  const h = new Float32Array(size * size);
  const tile = 6; // noise cycles per tile edge → periodic when sampled on a torus
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Sample on a torus so the result tiles seamlessly.
      const a = (x / size) * Math.PI * 2;
      const b = (y / size) * Math.PI * 2;
      const nx = Math.cos(a) * tile;
      const ny = Math.sin(a) * tile;
      const nz = Math.cos(b) * tile;
      const nw = Math.sin(b) * tile;
      // 4D torus mapped to 2 stacked 2D lookups.
      h[y * size + x] = n.fbm(nx + nz, ny + nw, 4) * 0.5 + n.fbm(nx - nw, ny + nz, 3) * 0.5;
    }
  }
  const data = new Uint8Array(size * size * 4);
  const strength = 2.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x];
      const d = h[((y + 1) % size) * size + x];
      let vx = (l - r) * strength;
      let vy = (u - d) * strength;
      let vz = 1;
      const inv = 1 / Math.sqrt(vx * vx + vy * vy + vz * vz);
      vx *= inv;
      vy *= inv;
      vz *= inv;
      const i = (y * size + x) * 4;
      data[i] = (vx * 0.5 + 0.5) * 255;
      data[i + 1] = (vy * 0.5 + 0.5) * 255;
      data[i + 2] = (vz * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Tileable roughness/AO variation packed into one texture (R = rough, G = AO). */
export function makeRoughnessAOMap(size = 128, seed = 7) {
  const n = new SimplexNoise(seed);
  const data = new Uint8Array(size * size * 4);
  const tile = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = (x / size) * Math.PI * 2;
      const b = (y / size) * Math.PI * 2;
      const v = n.fbm(Math.cos(a) * tile + Math.cos(b) * tile, Math.sin(a) * tile + Math.sin(b) * tile, 3);
      const i = (y * size + x) * 4;
      data[i] = (0.78 + v * 0.18) * 255;      // roughness
      data[i + 1] = (0.82 + v * 0.16) * 255;  // AO
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Radial soft particle sprite. */
export function makeSoftParticle(size = 64) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Animated-water normal source: two tileable normal maps scrolled against each other. */
export function makeWaterNormal(size = 256, seed = 3) {
  return makeDetailNormalMap(size, seed);
}

function normalTexFromHeight(h, size, strength) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x];
      const d = h[((y + 1) % size) * size + x];
      let nx = (l - r) * strength, ny = (u - d) * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const i = (y * size + x) * 4;
      data[i] = (nx * inv * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      data[i + 2] = (inv * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

function torus(n, u, v, f, oct, ax = 1, ay = 1) {
  const a = u * Math.PI * 2, b = v * Math.PI * 2;
  return n.fbm((Math.cos(a) + Math.cos(b)) * f * ax, (Math.sin(a) + Math.sin(b)) * f * ay, oct);
}

/** Bark: deep vertical furrows with knots. */
export function makeBarkNormal(size = 256, seed = 41) {
  const n = new SimplexNoise(seed);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const furrow = torus(n, u, v, 12, 3, 1.0, 0.12);   // stretched vertically
    const knots = torus(n, u, v, 4, 2);
    h[y * size + x] = furrow * 0.8 + knots * 0.35;
  }
  return normalTexFromHeight(h, size, 3.0);
}

/** Lime plaster: fine grain, trowel sweeps, a few hairline cracks. */
export function makePlasterNormal(size = 256, seed = 43) {
  const n = new SimplexNoise(seed);
  const w = [0, 0];
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const grain = torus(n, u, v, 40, 2);
    const sweep = torus(n, u, v, 5, 2, 1.0, 0.35);
    const a = u * Math.PI * 2, b = v * Math.PI * 2;
    n.worley((Math.cos(a) + Math.cos(b)) * 3 + 20, (Math.sin(a) + Math.sin(b)) * 3 + 20, w);
    const crack = (w[1] - w[0]) < 0.02 ? -0.6 : 0;
    h[y * size + x] = grain * 0.35 + sweep * 0.25 + crack;
  }
  return normalTexFromHeight(h, size, 1.6);
}
