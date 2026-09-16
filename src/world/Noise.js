// Seeded 2D simplex noise. Self-contained (no dependency) so that the exact
// same code runs on the main thread and inside the terrain worker — identical
// seed must give identical terrain, or leaderboard runs aren't comparable.

import { mulberry32 } from '../core/MathUtils.js';

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

// 12 gradient directions projected to 2D (standard simplex gradient set).
const GRAD2 = new Float32Array([
  1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 1, 0, -1, 0, 0, 1, 0, -1, 0, 1, 0, -1,
]);

export class SimplexNoise {
  constructor(seed = 0) {
    this.seed = seed >>> 0;
    const rand = mulberry32(this.seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    // Fisher-Yates with the seeded PRNG.
    for (let i = 255; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0;
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    // Doubled permutation table avoids a modulo in the hot path.
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  /** Returns noise in roughly [-1, 1]. No allocations. */
  noise2D(xin, yin) {
    const perm = this.perm;
    const permMod12 = this.permMod12;

    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);

    let i1, j1;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    } else {
      i1 = 0;
      j1 = 1;
    }

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;

    let n0 = 0,
      n1 = 0,
      n2 = 0;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      const gi0 = permMod12[ii + perm[jj]] * 2;
      t0 *= t0;
      n0 = t0 * t0 * (GRAD2[gi0] * x0 + GRAD2[gi0 + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      const gi1 = permMod12[ii + i1 + perm[jj + j1]] * 2;
      t1 *= t1;
      n1 = t1 * t1 * (GRAD2[gi1] * x1 + GRAD2[gi1 + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      const gi2 = permMod12[ii + 1 + perm[jj + 1]] * 2;
      t2 *= t2;
      n2 = t2 * t2 * (GRAD2[gi2] * x2 + GRAD2[gi2 + 1] * y2);
    }

    return 70 * (n0 + n1 + n2);
  }

  /** Noise remapped to [0, 1]. */
  noise01(x, y) {
    return this.noise2D(x, y) * 0.5 + 0.5;
  }

  /** Fractal Brownian motion, `octaves` layers of decreasing amplitude. */
  fbm(x, y, octaves, lacunarity = 2.0, gain = 0.5) {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise2D(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /**
   * Worley (cellular) noise, F1 and F2 distances. Writes into `out` = [f1, f2].
   * Used for pebbles, cracks and cell-like surface breakup.
   */
  worley(x, y, out) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let f1 = 8;
    let f2 = 8;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const cx = xi + i;
        const cy = yi + j;
        const h = this.perm[(cx & 255) + this.perm[cy & 255]];
        const h2 = this.perm[(cy & 255) + this.perm[(cx + 37) & 255]];
        const px = cx + h / 255;
        const py = cy + h2 / 255;
        const dx = px - x;
        const dy = py - y;
        const d = dx * dx + dy * dy;
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) f2 = d;
      }
    }
    out[0] = Math.sqrt(f1);
    out[1] = Math.sqrt(f2);
    return out;
  }

  /** Ridged noise — sharp crests, used for rocky hill biomes. */
  ridged(x, y) {
    const n = 1 - Math.abs(this.noise2D(x, y));
    return n * n;
  }
}
