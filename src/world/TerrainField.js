// The world as a pure mathematical function of (x, z).
//
// Everything about the terrain — height, climate, biome membership, prop
// placement — is derived analytically from the seed. Nothing is stored.
// That gives three things at once:
//   1. Infinite world with no memory growth.
//   2. Determinism: same seed ⇒ same world, on any machine, in any thread.
//   3. The character controller can query exact ground height at the player's
//      position instantly, without waiting on the streamed chunk mesh.

import { SimplexNoise } from './Noise.js';
import {
  H_CONTINENT,
  H_HILL,
  H_DETAIL,
  H_MICRO,
  H_RIVER,
  BASE_ELEVATION,
  MOISTURE_SCALE,
  TEMPERATURE_SCALE,
  SEED_OFFSETS,
  WATER_LEVEL,
  MAX_SLOPE_WALKABLE,
  KAILASH,
} from './WorldConfig.js';
import { BIOMES, BIOME_COUNT, PROP_INDEX } from './Biomes.js';
import { hash2, saturate, smoothstep, clamp } from '../core/MathUtils.js';

// Scratch buffers reused by every call — this module allocates nothing at runtime.
const _weights = new Float32Array(BIOME_COUNT);

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
// Biome palettes converted to linear once; vertex colours are linear.
const GROUND_LIN = BIOMES.map((b) => ({
  ground: b.ground.map(srgbToLinear),
  groundAlt: b.groundAlt.map(srgbToLinear),
}));
const SHORE_LIN = [0.52, 0.47, 0.36].map(srgbToLinear);

export class TerrainField {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.nContinent = new SimplexNoise(this.seed ^ SEED_OFFSETS.continent);
    this.nHill = new SimplexNoise(this.seed ^ SEED_OFFSETS.hill);
    this.nDetail = new SimplexNoise(this.seed ^ SEED_OFFSETS.detail);
    this.nRiver = new SimplexNoise(this.seed ^ SEED_OFFSETS.river);
    this.nMoisture = new SimplexNoise(this.seed ^ SEED_OFFSETS.moisture);
    this.nTemperature = new SimplexNoise(this.seed ^ SEED_OFFSETS.temperature);
  }

  // ---------------------------------------------------------------- height

  /**
   * Terrain height at a world position. Three noise octaves as specified —
   * continent, hill, detail — plus a river carve that cuts valleys down
   * toward the water plane.
   */
  heightAt(x, z) {
    const continent = this.nContinent.fbm(x / H_CONTINENT.scale, z / H_CONTINENT.scale, 3);
    const hill = this.nHill.fbm(x / H_HILL.scale, z / H_HILL.scale, 3);
    const detail = this.nDetail.fbm(x / H_DETAIL.scale, z / H_DETAIL.scale, 2);

    // Hills are suppressed in low continental areas so valleys stay open.
    const continentMask = saturate(continent * 0.5 + 0.65);

    const micro = this.nDetail.noise2D(x / H_MICRO.scale + 31.7, z / H_MICRO.scale - 12.3);

    let h =
      BASE_ELEVATION +
      continent * H_CONTINENT.amp +
      hill * H_HILL.amp * continentMask +
      detail * H_DETAIL.amp +
      micro * H_MICRO.amp;

    // River carve: a ridge line of the river noise near zero becomes a valley.
    const r = this.nRiver.noise2D(x / H_RIVER.scale, z / H_RIVER.scale);
    const bank = 1 - smoothstep(0, H_RIVER.width, Math.abs(r));
    if (bank > 0) {
      // Blend down to just below the water plane at the channel centre.
      const target = WATER_LEVEL - 1.6;
      h = h + (target - h) * bank * bank;
    }

    // Kailash: plateau + peak. The peak profile has gentle terraces (the
    // mountain's famous horizontal striations) and a rounded dome top.
    const kdx = x - KAILASH.x;
    const kdz = z - KAILASH.z;
    const kd = Math.sqrt(kdx * kdx + kdz * kdz);
    if (kd < KAILASH.plateauRadius) {
      const plateau = 1 - smoothstep(KAILASH.plateauRadius * 0.45, KAILASH.plateauRadius, kd);
      // Rivers don't cut the highland; lift the base and fade the valley carve.
      h += plateau * KAILASH.plateauHeight + (WATER_LEVEL + 6 - h) * plateau * bank;
      if (kd < KAILASH.peakRadius) {
        const k = 1 - kd / KAILASH.peakRadius;
        let peak = Math.pow(k, 1.35);
        // Terraces: soft steps every ~18 u of height, angular breakup from noise.
        const terr = Math.sin(peak * 9.0 + this.nHill.noise2D(x / 90, z / 90) * 1.2) * 0.035;
        peak += terr * smoothstep(0.15, 0.6, k) * (1 - smoothstep(0.85, 1.0, k));
        h += peak * KAILASH.peakHeight;
      }
    }
    return h;
  }

  /** Central-difference gradient. `out` is a 2-element array, written in place. */
  gradientAt(x, z, out, eps = 0.75) {
    const hx = this.heightAt(x + eps, z) - this.heightAt(x - eps, z);
    const hz = this.heightAt(x, z + eps) - this.heightAt(x, z - eps);
    out[0] = hx / (2 * eps);
    out[1] = hz / (2 * eps);
    return out;
  }

  /** Slope magnitude (rise over run). 0 = flat. */
  slopeAt(x, z, out) {
    this.gradientAt(x, z, out);
    return Math.hypot(out[0], out[1]);
  }

  /** Ground the player (and modaks) can legitimately stand on. */
  isWalkable(x, z, scratch) {
    const h = this.heightAt(x, z);
    if (h < WATER_LEVEL + 0.35) return false;
    return this.slopeAt(x, z, scratch) <= MAX_SLOPE_WALKABLE;
  }

  // --------------------------------------------------------------- climate

  moistureAt(x, z) {
    return saturate(this.nMoisture.fbm(x / MOISTURE_SCALE, z / MOISTURE_SCALE, 2) * 0.62 + 0.5);
  }

  temperatureAt(x, z) {
    return saturate(
      this.nTemperature.fbm(x / TEMPERATURE_SCALE, z / TEMPERATURE_SCALE, 2) * 0.62 + 0.5
    );
  }

  // ---------------------------------------------------------------- biomes

  /**
   * Normalised membership weight per biome, written into `out` (length 5).
   * Because weights are a continuous falloff from each biome's climate centre
   * and then normalised, adjacent biomes always interpolate — no hard cut is
   * representable in this scheme.
   */
  biomeWeightsAt(x, z, out) {
    const m = this.moistureAt(x, z);
    const t = this.temperatureAt(x, z);
    const h = this.heightAt(x, z);
    // Map height to a 0..1.6 elevation band for biome selection (snow above ~1).
    const e = clamp((h - WATER_LEVEL) / 70, 0, 1.6);

    let total = 0;
    for (let i = 0; i < BIOME_COUNT; i++) {
      const b = BIOMES[i];
      const dm = (m - b.moisture) / b.spread;
      const dt = (t - b.temperature) / b.spread;
      const de = (e - b.elevation) / (b.spread * 1.5);
      const d2 = dm * dm + dt * dt + de * de;
      // Inverse-square-ish falloff: smooth, always positive, never zero, so
      // normalisation is always well-defined.
      const w = 1 / (1 + d2 * d2);
      out[i] = w;
      total += w;
    }
    const inv = 1 / total;
    for (let i = 0; i < BIOME_COUNT; i++) out[i] *= inv;
    return out;
  }

  /** Index of the strongest biome at a point (for audio/footstep selection). */
  dominantBiomeAt(x, z) {
    this.biomeWeightsAt(x, z, _weights);
    let best = 0;
    let bestW = -1;
    for (let i = 0; i < BIOME_COUNT; i++) {
      if (_weights[i] > bestW) {
        bestW = _weights[i];
        best = i;
      }
    }
    return best;
  }

  /** Blended ground colour, written into `out` (length 3, linear RGB). */
  groundColorAt(x, z, out) {
    this.biomeWeightsAt(x, z, _weights);
    let r = 0,
      g = 0,
      b = 0;
    // A second low-frequency noise picks between each biome's two palette
    // entries, which breaks up flat colour without any texture fetch.
    const mix = this.nDetail.noise01(x / 34, z / 34);
    for (let i = 0; i < BIOME_COUNT; i++) {
      const w = _weights[i];
      if (w < 0.004) continue;
      const c0 = GROUND_LIN[i].ground;
      const c1 = GROUND_LIN[i].groundAlt;
      r += w * (c0[0] + (c1[0] - c0[0]) * mix);
      g += w * (c0[1] + (c1[1] - c0[1]) * mix);
      b += w * (c0[2] + (c1[2] - c0[2]) * mix);
    }

    // Wet sand darkens near the waterline; steep faces show bare rock.
    const h = this.heightAt(x, z);
    const shore = 1 - smoothstep(WATER_LEVEL, WATER_LEVEL + 3.2, h);
    if (shore > 0) {
      r += (SHORE_LIN[0] - r) * shore * 0.8;
      g += (SHORE_LIN[1] - g) * shore * 0.8;
      b += (SHORE_LIN[2] - b) * shore * 0.8;
    }
    out[0] = r;
    out[1] = g;
    out[2] = b;
    return out;
  }

  // --------------------------------------------------------------- scatter

  /**
   * Deterministic blue-noise prop placement.
   *
   * A true Bridson Poisson-disc can't be computed per-chunk without seams, so
   * this uses grid-priority dart throwing: exactly one candidate per grid cell
   * at a hashed offset, kept only if no higher-priority candidate in the 8
   * neighbouring cells falls within the disc radius. The result has the same
   * minimum-spacing guarantee as Poisson-disc, is seamless across chunk
   * borders (a cell's outcome depends only on its 3x3 neighbourhood), and is
   * reproducible from the seed alone.
   *
   * Acceptance is additionally scaled by the biome weight at the candidate, so
   * prop populations fade across biome borders instead of stopping at a line.
   *
   * @param callback (propIndex, x, y, z, rotY, scale) — called per accepted prop.
   */
  scatterChunk(chunkX, chunkZ, chunkSize, callback) {
    const originX = chunkX * chunkSize;
    const originZ = chunkZ * chunkSize;
    const slopeScratch = [0, 0];

    for (let bi = 0; bi < BIOME_COUNT; bi++) {
      const biome = BIOMES[bi];
      for (let si = 0; si < biome.scatter.length; si++) {
        const rule = biome.scatter[si];
        const radius = rule.radius;
        const cell = radius;
        // Turn the authored density (props per 100x100) into an acceptance
        // probability. One candidate per cell, of which ~35% survive the dart
        // rejection below (measured for this scheme), so the achievable
        // maximum is cells × 0.35.
        const maxPer100 = (100 / cell) * (100 / cell) * 0.35;
        const acceptBase = Math.min(1, rule.density / maxPer100);
        const propIdx = PROP_INDEX[rule.prop];
        // A salt per (biome, prop) so different rules don't co-locate.
        const salt = (this.seed ^ SEED_OFFSETS.scatter ^ (bi * 131 + si * 977)) >>> 0;
        const cluster = rule.cluster || null; // { scale, threshold }: villages, groves

        const c0x = Math.floor(originX / cell);
        const c1x = Math.floor((originX + chunkSize) / cell);
        const c0z = Math.floor(originZ / cell);
        const c1z = Math.floor((originZ + chunkSize) / cell);

        for (let cz = c0z; cz <= c1z; cz++) {
          for (let cx = c0x; cx <= c1x; cx++) {
            const px = (cx + hash2(cx, cz, salt)) * cell;
            const pz = (cz + hash2(cx, cz, salt + 7919)) * cell;
            // Only this chunk owns points inside its own bounds.
            if (px < originX || px >= originX + chunkSize) continue;
            if (pz < originZ || pz >= originZ + chunkSize) continue;

            const prio = hash2(cx, cz, salt + 104729);

            // Dart rejection against the 3x3 neighbourhood.
            let rejected = false;
            for (let nz = cz - 1; nz <= cz + 1 && !rejected; nz++) {
              for (let nx = cx - 1; nx <= cx + 1; nx++) {
                if (nx === cx && nz === cz) continue;
                const nprio = hash2(nx, nz, salt + 104729);
                if (nprio <= prio) continue; // lower priority yields to us
                const qx = (nx + hash2(nx, nz, salt)) * cell;
                const qz = (nz + hash2(nx, nz, salt + 7919)) * cell;
                const dx = qx - px;
                const dz = qz - pz;
                if (dx * dx + dz * dz < radius * radius) {
                  rejected = true;
                  break;
                }
              }
            }
            if (rejected) continue;

            // Density + biome membership gate (+ cluster field for villages).
            this.biomeWeightsAt(px, pz, _weights);
            let w = _weights[bi];
            if (cluster) {
              const cn = this.nMoisture.noise01(px / cluster.scale + 500, pz / cluster.scale - 500);
              w *= smoothstep(cluster.threshold, cluster.threshold + 0.08, cn);
              if (w <= 0) continue;
            }
            const roll = hash2(cx, cz, salt + 15485863);
            if (roll > acceptBase * w) continue;

            // Terrain suitability.
            const y = this.heightAt(px, pz);
            const isAquatic = rule.prop === 'lotus' || rule.prop === 'reeds';
            if (isAquatic) {
              // Water plants want the shallows, not dry land or deep water.
              if (y > WATER_LEVEL + 0.6 || y < WATER_LEVEL - 2.2) continue;
            } else {
              if (y < WATER_LEVEL + 0.5) continue;
              const slope = this.slopeAt(px, pz, slopeScratch);
              const slopeLimit = rule.prop === 'rock' || rule.prop === 'cave' ? 1.4 : rule.maxSlope ?? 0.55;
              if (slope > slopeLimit) continue;
            }

            let rotY = hash2(cx, cz, salt + 22801763) * Math.PI * 2;
            // Buildings share a village orientation grid with a little jitter,
            // and all face the same way, so no doorway opens onto a neighbour's wall.
            if (rule.align) rotY = Math.round(hash2(0, 0, salt) * 4) * (Math.PI / 2) + (hash2(cx, cz, salt + 3301) - 0.5) * 0.25;
            const scale = (rule.scaleMin ?? 0.78) + hash2(cx, cz, salt + 31013) * (rule.scaleVar ?? 0.52);
            callback(propIdx, px, isAquatic ? WATER_LEVEL - 0.05 : y, pz, rotY, scale);
          }
        }
      }
    }
  }
}
