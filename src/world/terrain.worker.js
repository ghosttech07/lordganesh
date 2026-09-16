// Terrain worker. Builds chunk vertex data + prop placements entirely off the
// main thread and hands back transferable typed arrays, so a chunk load costs
// the render thread one postMessage receive and one GPU upload — no hitch.

import { TerrainField } from './TerrainField.js';
import { CHUNK_SIZE, CHUNK_RES, WATER_LEVEL } from './WorldConfig.js';
import { PROP_TYPES, BIOME_COUNT } from './Biomes.js';
import { smoothstep } from '../core/MathUtils.js';

let field = null;
let fieldSeed = -1;

const VERTS = (CHUNK_RES + 1) * (CHUNK_RES + 1);
const STEP = CHUNK_SIZE / CHUNK_RES;
const grad = [0, 0];
const col = [0, 0, 0];
const bw = new Float32Array(BIOME_COUNT);

// Per-prop-type growable buffers, reused across chunks.
const propBuffers = PROP_TYPES.map(() => []);

function buildChunk(chunkX, chunkZ) {
  const positions = new Float32Array(VERTS * 3);
  const normals = new Float32Array(VERTS * 3);
  const colors = new Float32Array(VERTS * 3);
  const layers = new Float32Array(VERTS * 4); // grass, soil, rock, sand

  const originX = chunkX * CHUNK_SIZE;
  const originZ = chunkZ * CHUNK_SIZE;

  let minY = Infinity;
  let maxY = -Infinity;

  let vi = 0;
  for (let j = 0; j <= CHUNK_RES; j++) {
    const lz = j * STEP;
    const wz = originZ + lz;
    for (let i = 0; i <= CHUNK_RES; i++) {
      const lx = i * STEP;
      const wx = originX + lx;
      const y = field.heightAt(wx, wz);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      positions[vi] = lx;
      positions[vi + 1] = y;
      positions[vi + 2] = lz;

      // Analytic normals from the height gradient — continuous across chunk
      // borders by construction, so there is no lighting seam to hide.
      field.gradientAt(wx, wz, grad);
      const nx = -grad[0];
      const nz = -grad[1];
      const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
      normals[vi] = nx * inv;
      normals[vi + 1] = inv;
      normals[vi + 2] = nz * inv;

      field.groundColorAt(wx, wz, col);
      colors[vi] = col[0];
      colors[vi + 1] = col[1];
      colors[vi + 2] = col[2];

      // Ground layer weights: slope → rock, shoreline → sand, biome → grass/soil,
      // plus low-frequency patch noise so meadows have worn dirt patches.
      field.biomeWeightsAt(wx, wz, bw);
      const slope = Math.hypot(grad[0], grad[1]);
      const patch = field.nDetail.noise01(wx / 13, wz / 13);
      const patch2 = field.nDetail.noise01(wx / 41 + 7, wz / 41);
      let rock = smoothstep(0.4, 0.85, slope) + bw[4] * (0.25 + smoothstep(0.5, 0.75, patch) * 0.6);
      let sand = 1 - smoothstep(WATER_LEVEL + 0.3, WATER_LEVEL + 3.2, y);
      const worn = smoothstep(0.5, 0.64, patch) * 1.4 + smoothstep(0.56, 0.72, patch2) * 0.9;
      let grass = (bw[1] * 1.0 + bw[3] * 1.0 + bw[0] * 0.7 + bw[2] * 0.35 + bw[4] * 0.25) * (1 - Math.min(0.85, worn * 0.6));
      let soil = bw[2] * 0.8 + bw[0] * 0.4 + bw[4] * 0.5 + worn;
      rock = Math.min(1, rock);
      sand = Math.min(1, sand);
      const open = (1 - rock) * (1 - sand);
      grass *= open;
      soil *= open;
      const li = (vi / 3) * 4;
      layers[li] = grass;
      layers[li + 1] = soil;
      layers[li + 2] = rock;
      layers[li + 3] = sand;

      vi += 3;
    }
  }

  for (let t = 0; t < propBuffers.length; t++) propBuffers[t].length = 0;

  field.scatterChunk(chunkX, chunkZ, CHUNK_SIZE, (type, x, y, z, rotY, scale) => {
    const buf = propBuffers[type];
    buf.push(x - originX, y, z - originZ, rotY, scale);
  });

  // Water: per-vertex depth below the waterline for chunks that touch it.
  let waterDepth = null;
  if (minY < WATER_LEVEL + 0.6) {
    waterDepth = new Float32Array(VERTS);
    for (let v = 0; v < VERTS; v++) waterDepth[v] = WATER_LEVEL - positions[v * 3 + 1];
  }

  const props = [];
  const transfer = [positions.buffer, normals.buffer, colors.buffer, layers.buffer];
  if (waterDepth) transfer.push(waterDepth.buffer);
  for (let t = 0; t < propBuffers.length; t++) {
    if (propBuffers[t].length === 0) continue;
    const arr = Float32Array.from(propBuffers[t]);
    props.push({ type: t, data: arr });
    transfer.push(arr.buffer);
  }

  return {
    chunkX,
    chunkZ,
    positions,
    normals,
    colors,
    layers,
    minY,
    maxY,
    waterDepth,
    props,
    transfer,
  };
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    if (fieldSeed !== msg.seed) {
      field = new TerrainField(msg.seed);
      fieldSeed = msg.seed;
    }
    return;
  }
  if (msg.type === 'build') {
    if (!field) return;
    const result = buildChunk(msg.chunkX, msg.chunkZ);
    const transfer = result.transfer;
    delete result.transfer;
    result.type = 'chunk';
    result.requestId = msg.requestId;
    self.postMessage(result, transfer);
  }
};
