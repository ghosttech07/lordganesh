// Single source of truth for world-space constants. Imported by both the main
// thread and the terrain worker — keep it free of any DOM/three.js reference.

export const CHUNK_SIZE = 128;        // world units per chunk edge
export const CHUNK_RES = 64;          // quads per edge → 65x65 vertices, 2u spacing
export const VIEW_RADIUS = 2;         // 2 ⇒ 5x5 active grid around the player
export const WATER_LEVEL = 0.0;

// Height layers. Amplitudes are in world units; scales are wavelengths.
export const H_CONTINENT = { scale: 1400, amp: 52 };
export const H_HILL = { scale: 330, amp: 15 };
export const H_DETAIL = { scale: 68, amp: 2.4 };
export const H_MICRO = { scale: 9.5, amp: 0.28 }; // ground micro-relief
export const H_RIVER = { scale: 900, depth: 16, width: 0.09 };

export const BASE_ELEVATION = 9.0;    // lifts the average terrain above water

// Climate field wavelengths.
export const MOISTURE_SCALE = 760;
export const TEMPERATURE_SCALE = 1020;

// Sub-seeds derived from the world seed so each noise field is independent.
export const SEED_OFFSETS = {
  continent: 0x1a2b,
  hill: 0x3c4d,
  detail: 0x5e6f,
  river: 0x7081,
  moisture: 0x9293,
  temperature: 0xa4a5,
  scatter: 0xb6b7,
};

export const MAX_SLOPE_WALKABLE = 0.62; // cos-free: |gradient| magnitude limit

// Mount Kailash: a fixed landmark every seed shares. A broad highland plateau
// rises toward a striated peak; snow begins at SNOW_LINE (world y).
export const KAILASH = { x: -640, z: -880, peakRadius: 340, peakHeight: 165, plateauRadius: 900, plateauHeight: 34 };
export const SNOW_LINE = 72;
