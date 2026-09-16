// Allocation-free math helpers. Everything here takes scalars or writes into
// caller-owned objects — nothing in this file allocates.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const saturate = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (e0, e1, x) => {
  const t = saturate((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

/**
 * Framerate-independent exponential damping.
 * `halfLife` is the time in seconds for the remaining gap to halve — this is
 * the parameter the design doc specifies (e.g. camera position damping 0.12s).
 */
export const damp = (current, target, halfLife, dt) => {
  if (halfLife <= 0) return target;
  return target + (current - target) * Math.pow(2, -dt / halfLife);
};

/** Same as damp() but wraps correctly across the -PI..PI seam. */
export const dampAngle = (current, target, halfLife, dt) => {
  return current + shortestAngle(current, target) * (1 - Math.pow(2, -dt / halfLife));
};

/** Signed shortest delta from angle a to angle b, in -PI..PI. */
export const shortestAngle = (a, b) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/** Move `current` toward `target` by at most `maxDelta`. */
export const moveTowards = (current, target, maxDelta) => {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
};

export const moveTowardsAngle = (current, target, maxDelta) => {
  const d = shortestAngle(current, target);
  if (Math.abs(d) <= maxDelta) return current + d;
  return current + Math.sign(d) * maxDelta;
};

/** Integer floor-division, correct for negative numerators (chunk indexing). */
export const floorDiv = (n, d) => Math.floor(n / d);

/** Cheap 2D hash → [0,1). Deterministic, used for per-instance jitter. */
export function hash2(x, y, seed) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1274126177;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Mulberry32 — small, fast, seedable PRNG. Same seed ⇒ same sequence. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convert an arbitrary string to a 32-bit seed (for shareable seed codes). */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
